/**
 * [INPUT]: 受保护 prompt 全文、模型目的地（baseURL / wire / model / 账号不可逆指纹）、
 *          调用方显式给出的 cacheScope 与 promptVersion
 * [OUTPUT]: 精确键的持久缓存读取 / 写入 / 同键并发合并，以及本地命中证据（不写 model_call_usage）
 * [POS]: assistant-text 纯文本归纳的可选缓存层；默认完全不参与，只有显式 opt-in 的调用点才会读写。
 *        绝不保存密钥、原始资料或 URL 之外的身份推断；键变化即未命中
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { createHash } from 'node:crypto';
import { db } from '../db.js';

/** 缓存身份：任何一项变化都必须换键（未命中），scope 之间不能串用。 */
export type InternalTextCacheIdentity = {
  cacheScope: string;
  promptVersion: string;
  /** 完整受保护 prompt（含守卫前缀），不是 URL、不是截断摘要。 */
  prompt: string;
  baseUrl: string;
  wire: string;
  model: string;
  /** 账号身份的不可逆指纹，绝不能是密钥本身。 */
  accountFingerprint: string;
};

export type InternalTextCacheStats = {
  hits: number;
  misses: number;
  expired: number;
  stores: number;
  writeFailures: number;
  readFailures: number;
  oversize: number;
  joins: number;
  /** 出发后期间被 forceRefresh 抢先、主动丢弃的过期写入 */
  staleSkipped: number;
};

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const MAX_CONTENT_BYTES = 200_000;

const stats: InternalTextCacheStats = {
  hits: 0, misses: 0, expired: 0, stores: 0, writeFailures: 0, readFailures: 0, oversize: 0, joins: 0, staleSkipped: 0,
};

/** 进程内并发合并表：同键只发一次请求，结束后删除（forceRefresh 不进这张表）。 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * 键的代数：forceRefresh 落库后 +1。普通请求出发时记下当时的代数，
 * 回来时代数变了说明期间有人刷新过——它拿到的正文已经过期，绝不能覆盖新值。
 */
const generations = new Map<string, number>();
export function cacheGeneration(key: string): number { return generations.get(key) ?? 0; }
export function bumpCacheGeneration(key: string): void { generations.set(key, (generations.get(key) ?? 0) + 1); }

function iso(at: number): string { return new Date(at).toISOString(); }

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 账号身份指纹：sha256 截断，只用于区分账号，不可逆、不可当作凭据使用。 */
export function accountFingerprint(apiKey: string): string {
  return sha256(`account|${apiKey}`).slice(0, 16);
}

/**
 * 缓存键 = 固定顺序数组 JSON.stringify 后 sha256（v2）。
 * 用 JSON.stringify 而非逐行拼接，避免 scope 末尾换行与 version 前缀串扰：
 *   scope="a\nversion:b", version="c"  与
 *   scope="a",          version="b\nversion:c"
 * 在逐行拼接下会生成相同的合并串，从而命中同一份错误缓存；JSON 数组按元素定界，
 * 两组合成的字符串必然不同，彻底消除换行串扰带来的键碰撞。
 * 少任何一项都会造成「换了个模型/换了份资料还命中旧结果」。
 */
export function internalTextCacheKey(identity: InternalTextCacheIdentity): string {
  return sha256(JSON.stringify([
    'v2',
    identity.cacheScope,
    identity.promptVersion,
    sha256(identity.prompt),
    identity.baseUrl,
    identity.wire,
    identity.model,
    identity.accountFingerprint,
  ]));
}

/** 命中返回正文并留下本地证据；未命中/过期/读失败一律返回 null（调用方照常发请求）。 */
export function readInternalTextCache(identity: InternalTextCacheIdentity): string | null {
  const key = internalTextCacheKey(identity);
  try {
    const row = db.prepare('SELECT content, expires_at FROM internal_text_cache WHERE cache_key = ?')
      .get(key) as { content: string; expires_at: string } | undefined;
    if (!row) { stats.misses += 1; return null; }
    if (!(Date.parse(row.expires_at) > Date.now())) {
      stats.expired += 1;
      try { db.prepare('DELETE FROM internal_text_cache WHERE cache_key = ?').run(key); } catch { /* 清不掉也当成未命中 */ }
      return null;
    }
    const at = iso(Date.now());
    try {
      db.prepare('UPDATE internal_text_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE cache_key = ?').run(at, key);
      db.prepare('INSERT INTO internal_text_cache_hits (cache_key, hit_at, cache_scope) VALUES (?, ?, ?)')
        .run(key, at, identity.cacheScope);
    } catch { /* 命中证据写不进去不影响返回正文 */ }
    stats.hits += 1;
    return row.content;
  } catch {
    stats.readFailures += 1;
    return null;
  }
}

/**
 * 只在成功且正文可读之后调用。写失败、超限都不抛——已经生成的正文由调用方照常返回，
 * 缓存只是加速，绝不能反过来吞掉结果。
 */
export function writeInternalTextCache(
  identity: InternalTextCacheIdentity,
  text: string,
  options: { expectedGeneration?: number; bumpGeneration?: boolean } = {},
): boolean {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!text.trim() || bytes > MAX_CONTENT_BYTES) { stats.oversize += 1; return false; }
  const key = internalTextCacheKey(identity);
  // 出发时是旧代数、期间有人 forceRefresh 过：这一份正文已经过期，丢弃写入。
  if (options.expectedGeneration != null && cacheGeneration(key) !== options.expectedGeneration) {
    stats.staleSkipped += 1;
    return false;
  }
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM internal_text_cache WHERE expires_at <= ?').run(iso(Date.now()));
      db.prepare(`INSERT INTO internal_text_cache
        (cache_key, cache_scope, prompt_version, prompt_hash, destination_fingerprint, model, wire,
         content, content_bytes, hit_count, last_hit_at, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          cache_scope=excluded.cache_scope, prompt_version=excluded.prompt_version,
          prompt_hash=excluded.prompt_hash, destination_fingerprint=excluded.destination_fingerprint,
          model=excluded.model, wire=excluded.wire, content=excluded.content,
          content_bytes=excluded.content_bytes, hit_count=0, last_hit_at=NULL,
          created_at=excluded.created_at, expires_at=excluded.expires_at`)
        .run(key, identity.cacheScope, identity.promptVersion, sha256(identity.prompt),
          sha256(`${identity.baseUrl}|${identity.wire}|${identity.model}|${identity.accountFingerprint}`).slice(0, 16),
          identity.model, identity.wire, text, bytes, iso(Date.now()), iso(Date.now() + TTL_MS));
      const total = (db.prepare('SELECT COUNT(*) AS n FROM internal_text_cache').get() as { n: number }).n;
      if (total > MAX_ENTRIES) {
        db.prepare(`DELETE FROM internal_text_cache WHERE cache_key IN (
          SELECT cache_key FROM internal_text_cache ORDER BY created_at ASC, cache_key ASC LIMIT ?)`)
          .run(total - MAX_ENTRIES);
      }
    })();
    stats.stores += 1;
    if (options.bumpGeneration) bumpCacheGeneration(key);
    return true;
  } catch {
    stats.writeFailures += 1;
    return false;
  }
}

/** 同键并发合并成一次请求；forceRefresh 调用不进这张表，也不读别人的结果。 */
export function joinInternalTextCache<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) { stats.joins += 1; return existing as Promise<T>; }
  const task = run().finally(() => { if (inflight.get(key) === task) inflight.delete(key); });
  inflight.set(key, task);
  return task;
}

export function inflightInternalTextCacheKeys(): string[] { return [...inflight.keys()]; }

export function internalTextCacheStats(): InternalTextCacheStats { return { ...stats }; }

export function resetInternalTextCacheStats(): void {
  stats.hits = 0; stats.misses = 0; stats.expired = 0; stats.stores = 0;
  stats.writeFailures = 0; stats.readFailures = 0; stats.oversize = 0; stats.joins = 0; stats.staleSkipped = 0;
}
