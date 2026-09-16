import { homedir } from 'node:os';
// 对接 ~/Documents/feishu-kb 本地知识库快照（全量抓取管道的产物：821 篇全文 MD + 概念卡 + 检索服务）。
// 检索走 kb_search_server（:8792，未启动时静默降级）；读全文直接读本地 MD（kb_manifest.jsonl 提供 url/token → file 映射），
// 比走云端 CLI/MCP 快得多，也没有权限与限流问题。
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const KB_ROOT = process.env.FEISHU_KB_ROOT ?? `${homedir()}/Documents/feishu-kb`;
const SEARCH_BASE = 'http://127.0.0.1:8792';

export type KbHit = {
  kind: 'doc' | 'concept';
  title: string;
  space: string | null;
  url: string | null; // doc = 飞书 wiki 链接；concept = 本地概念卡路径
  snippet: string;
  score: number;
};

export type KbManifest = {
  tokens: Set<string>; // url 与 obj_token 都收进来，用于「这篇是否在快照里」判断
  files: Map<string, string>; // url / obj_token → 本地 md 路径
};

let cached: KbManifest | null = null;

function loadManifest(): KbManifest {
  if (cached) return cached;
  const result: KbManifest = { tokens: new Set(), files: new Map() };
  try {
    // 同步读一次并缓存；文件不大（800+ 行 JSONL），冷启动一次性成本可接受
    const raw = readFileSync(path.join(KB_ROOT, 'index', 'kb_manifest.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { url?: string; obj_token?: string; file?: string };
        if (!row.file) continue;
        if (row.url) { result.tokens.add(row.url); result.files.set(row.url, row.file); }
        if (row.obj_token) { result.tokens.add(row.obj_token); result.files.set(row.obj_token, row.file); }
      } catch { /* 跳过坏行 */ }
    }
  } catch { /* 快照目录不存在时保持空映射 */ }
  cached = result;
  return result;
}

/** 本地快照里是否有这篇文档（reference 可传 wiki 链接或 obj_token） */
export function kbSnapshotHas(reference: string): boolean {
  return loadManifest().tokens.has(reference.trim());
}

/**
 * 快照里实际有正文的文档数（清单去重后的本地 MD 文件数）。
 *
 * 必须按 file 去重：清单同时用 url 和 obj_token 两个键指向同一份文件，
 * 直接取 `files.size` 会翻倍。快照目录不存在时返回 0。
 */
export function feishuSnapshotDocs(): number {
  return new Set(loadManifest().files.values()).size;
}

/**
 * 快照里已存正文的文档链接（去重）。
 *
 * 只返回 http(s) 开头的键：清单同时用 obj_token 当键，token 跟目录里的 wiki 链接对不上。
 * 调用方拿它和「目录里列出的链接」求交集，统计该目录内到底有几篇存了正文 ——
 * 不能用整个快照的文档数代替：同步范围可以是单个空间甚至单篇文档，
 * provider 级的总数会和目录篇数对不上（出现「目录 20 篇 / 可检索 821 篇」这种鬼话）。
 */
export function feishuSnapshotUrls(): string[] {
  const urls = new Set<string>();
  for (const key of loadManifest().files.keys()) {
    if (/^https?:\/\//i.test(key)) urls.add(key);
  }
  return [...urls];
}

/** feishu-kb 全文检索；服务没起或出错时返回空数组（调用方静默降级到本地库检索） */
export async function searchFeishuKb(query: string, limit = 6): Promise<KbHit[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const res = await fetch(`${SEARCH_BASE}/search?q=${encodeURIComponent(q)}&limit=${limit}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { results?: Array<Record<string, unknown>> };
    return (data.results ?? []).slice(0, limit).map((row) => ({
      kind: row.kind === 'concept' ? 'concept' as const : 'doc' as const,
      title: String(row.title ?? ''),
      space: row.space == null ? null : String(row.space),
      url: row.url == null ? null : String(row.url),
      snippet: String(row.snippet ?? '').slice(0, 600),
      score: Number(row.score ?? 0),
    }));
  } catch {
    return [];
  }
}

/** 按链接或 obj_token 读本地快照正文；快照里没有这篇时返回 null（调用方回落云端读取） */
export async function readFeishuKbDocument(reference: string): Promise<{ title: string; content: string; file: string } | null> {
  const key = reference.trim();
  if (!key) return null;
  const file = loadManifest().files.get(key);
  if (!file) return null;
  try {
    const raw = await readFile(file, 'utf8');
    const title = raw.split('\n', 1)[0]?.replace(/^#+\s*/, '').trim() || path.basename(file, '.md');
    return { title, content: raw, file };
  } catch {
    return null;
  }
}

export type KbStatus = {
  available: boolean; // 检索服务（:8792）是否在线
  docs?: number; // 快照全文文档数
  concepts?: number; // 概念卡数量
  indexLoadedAt?: string | null;
};

/**
 * 探测一次检索服务（:8792）的健康状态；没起、超时或报错都返回 available=false，不抛错。
 *
 * 这是唯一真正发请求的地方，其余入口都走缓存。
 */
async function probeKbStatus(): Promise<KbStatus> {
  try {
    const res = await fetch(`${SEARCH_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { available: false };
    const data = await res.json() as { status?: string; docs?: number; concepts?: number; index_loaded_at?: string };
    return {
      available: data.status === 'ok',
      docs: data.docs,
      concepts: data.concepts,
      indexLoadedAt: data.index_loaded_at ?? null,
    };
  } catch {
    return { available: false };
  }
}

const PROBE_TTL_MS = 60_000;
let probeCache: { at: number; status: KbStatus } | null = null;
let probeInflight: Promise<KbStatus> | null = null;

/** 真正刷新一次状态；并发调用共享同一个请求，不会打出一串探测 */
function refreshKbStatus(): Promise<KbStatus> {
  if (probeInflight) return probeInflight;
  probeInflight = probeKbStatus()
    .then((status) => { probeCache = { at: Date.now(), status }; return status; })
    .finally(() => { probeInflight = null; });
  return probeInflight;
}

/**
 * 非阻塞读取状态：返回上次探测结果，过期或没探测过就在后台刷新，绝不 await。
 *
 * 知识存档列表每一行都要显示「能不能搜到正文」，以前直接 await 探测 ——
 * 端口直接拒绝时确实只要 1ms，但服务卡住时整个列表要等满 3 秒超时。
 * 主列表不该被一个旁路服务的健康度拖住，所以这里只给缓存值（首次调用会给 null）。
 */
export function feishuKbStatusCached(maxAgeMs = PROBE_TTL_MS): KbStatus | null {
  if (!probeCache || Date.now() - probeCache.at > maxAgeMs) void refreshKbStatus();
  return probeCache?.status ?? null;
}

/**
 * 需要确定答案的调用方走这里（设置页、基线面板、助手工具）。
 * 默认复用 60 秒内的缓存；用户主动点「检查状态」时传 `{ force: true }` 强制重探。
 */
export async function feishuKbStatus(opts: { force?: boolean } = {}): Promise<KbStatus> {
  if (!opts.force && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.status;
  return refreshKbStatus();
}

/** 启动时预热一次探测，避免第一个打开知识库的人拿到「未知」 */
export function warmFeishuKbStatus(): void {
  void refreshKbStatus();
}

/**
 * 触发快照管道的增量同步（等价于 `curl -X POST :8792/sync`）。
 * 增量只抓有变动的文档，通常很快；成功后作废 manifest 缓存让新文档立即可读。
 */
export async function refreshFeishuKb(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${SEARCH_BASE}/sync`, { method: 'POST', signal: AbortSignal.timeout(10 * 60_000) });
    const raw = await res.text().catch(() => '');
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(raw) as Record<string, unknown>; } catch { /* 保留原始文本 */ }
    if (!res.ok || (data.ok === false)) {
      return { ok: false, error: String(data.error ?? raw.slice(0, 200) ?? `HTTP ${res.status}`) };
    }
    cached = null; // 快照可能新增/更新了文件，强制下次重读 manifest
    return { ok: true };
  } catch (error) {
    const e = error as Error;
    return { ok: false, error: e.name === 'TimeoutError' ? '同步超时（10 分钟）' : e.message };
  }
}
