/**
 * [INPUT]: source_documents 正文、统一标签池词汇（services/tag-pool.ts）与知识库专属 WorkBuddy 文本生成器
 * [OUTPUT]: 资料自动打标：导入完成后排队执行、存量资料批量补跑（可 force 重跑）
 * [POS]: 自动标签唯一执行者边界；固定 WorkBuddy 文本生成，模型失败静默留白，绝不阻塞导入或覆盖人工标签
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { z } from 'zod';
import { db, now, sync_id } from '../db.js';
import { generateKnowledgeText } from './knowledge-text.js';
import { normalizeTags } from './tags.js';
import { ensureTag } from './tag-pool.js';

// 测试注入：与 knowledge-lifecycle 的候选/简报生成器同一套套路
type Generator = (prompt: string) => Promise<string>;
let generator: Generator = generateKnowledgeText;
export function setTagGeneratorForTest(value: Generator | null): void {
  generator = value ?? generateKnowledgeText;
}

/** 与导入通道共存的模型并发上限；WorkBuddy CLI 单次最久 60s（knowledge-text 内部超时） */
const CONCURRENCY = 2;
/** 单篇送给模型的正文上限，打标不需要全文 */
const CONTENT_BUDGET = 4000;
/** 词汇表上限：只给模型最常见的 200 个已有标签，控制提示词体积 */
const VOCABULARY_LIMIT = 200;

const queue: string[] = [];
const queued = new Set<string>();
const pendingOptions = new Map<string, { force: boolean }>();
let running = 0;

/** 队列去重：同一篇资料只排一次；force 以「任一次要求过 force」为准 */
export function scheduleDocumentAutoTag(sourceKey: string, options: { force?: boolean } = {}): void {
  if (queued.has(sourceKey)) {
    if (options.force) pendingOptions.set(sourceKey, { force: true });
    return;
  }
  queued.add(sourceKey);
  pendingOptions.set(sourceKey, { force: Boolean(options.force) });
  queue.push(sourceKey);
  void pump();
}

async function pump(): Promise<void> {
  while (running < CONCURRENCY && queue.length) {
    const sourceKey = queue.shift()!;
    queued.delete(sourceKey);
    const options = pendingOptions.get(sourceKey) ?? { force: false };
    pendingOptions.delete(sourceKey);
    running += 1;
    void autoTagDocument(sourceKey, options)
      .then((outcome) => {
        // 打标是旁路任务：没有这次日志，失败/跳过就无声无息，页面只会看到「没有标签」
        if (outcome.status !== 'tagged') console.log('[tag-auto]', sourceKey, outcome.status, outcome.reason ?? '');
      })
      .catch((error) => console.warn('[tag-auto]', sourceKey, (error as Error).message))
      .finally(() => {
        running -= 1;
        void pump();
      });
  }
}

const payloadSchema = z.object({ tags: z.array(z.string()).max(12).default([]) });

function parseTagsPayload(raw: string): string[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const parsed = payloadSchema.parse(JSON.parse(start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed));
  return normalizeTags(parsed.tags).slice(0, 8).filter((name) => name.length <= 50);
}

export type AutoTagOutcome = { status: 'tagged' | 'skipped' | 'failed'; tags?: string[]; reason?: string };

/**
 * 给一篇资料自动打标。只给「没有当前标签」的资料调模型（force 除外）；
 * rejected（用户移除过）与 dismissed（全局删除过）的名字绝不写回。
 */
export async function autoTagDocument(sourceKey: string, options: { force?: boolean } = {}): Promise<AutoTagOutcome> {
  const doc = db.prepare('SELECT title, content, body_status, deleted_at FROM source_documents WHERE source_key = ?').get(sourceKey) as
    | { title: string; content: string; body_status: string; deleted_at: string | null }
    | undefined;
  if (!doc || doc.deleted_at || doc.body_status !== 'fetched' || !doc.content.trim()) {
    return { status: 'skipped', reason: '正文不可用' };
  }
  if (!options.force) {
    const existing = db.prepare("SELECT COUNT(*) AS n FROM source_document_tags WHERE document_key = ? AND state = 'active'").get(sourceKey) as { n: number };
    if (existing.n) return { status: 'skipped', reason: '已有标签' };
  }
  const vocabulary = (db.prepare('SELECT name FROM tags WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?')
    .all(VOCABULARY_LIMIT) as Array<{ name: string }>).map((row) => row.name);

  const prompt = '请仅返回 JSON：{"tags":["标签"]}。为下面的资料挑 0 到 8 个标签：用简短名词（不超过 16 个字）概括它的主题、领域或用途；「已有标签」里有贴切的优先复用，不要照抄标题，没有把握或资料太短就返回空数组。\n' +
    `已有标签：${vocabulary.length ? vocabulary.join('、') : '（暂无）'}\n` +
    `资料标题：${doc.title || '（未命名）'}\n` +
    `正文：${doc.content.slice(0, CONTENT_BUDGET)}`;

  let raw: string;
  try {
    raw = await generator(prompt);
  } catch (error) {
    return { status: 'failed', reason: (error as Error).message.slice(0, 200) };
  }
  let names: string[];
  try {
    names = parseTagsPayload(raw);
  } catch {
    return { status: 'failed', reason: '模型没有返回符合结构的标签 JSON' };
  }

  const ts = now();
  const added: string[] = [];
  db.transaction(() => {
    for (const name of names) {
      if (db.prepare('SELECT 1 FROM tags WHERE name = ? AND deleted_at IS NOT NULL').get(name)) continue;
      const rejected = db.prepare(`
        SELECT 1 FROM source_document_tags st JOIN tags t ON t.id = st.tag_id
        WHERE st.document_key = ? AND t.name = ? AND st.state = 'rejected'
      `).get(sourceKey, name);
      if (rejected) continue;
      const tag = ensureTag(name, 'ai');
      const info = db.prepare(`
        INSERT INTO source_document_tags (id, tag_id, document_key, origin, state, created_at, updated_at)
        VALUES (?, ?, ?, 'ai', 'active', ?, ?)
        ON CONFLICT(tag_id, document_key) DO NOTHING
      `).run(sync_id(), tag.id, sourceKey, ts, ts);
      if (info.changes) added.push(name);
    }
  })();
  return added.length ? { status: 'tagged', tags: added } : { status: 'skipped', reason: '没有产生新标签' };
}

/** 手动补跑入口：不传 keys = 全部「正文可用且没有任何当前标签」的资料 */
export function autoTagDocuments(sourceKeys: string[] | undefined, force = false): { scheduled: number } {
  let keys: string[];
  if (sourceKeys?.length) {
    keys = [...new Set(sourceKeys)];
  } else {
    keys = (db.prepare(`
      SELECT d.source_key FROM source_documents d
      WHERE d.deleted_at IS NULL AND d.body_status = 'fetched' AND TRIM(d.content) != ''
        AND NOT EXISTS (SELECT 1 FROM source_document_tags st WHERE st.document_key = d.source_key AND st.state = 'active')
      ORDER BY d.updated_at DESC LIMIT 2000
    `).all() as Array<{ source_key: string }>).map((row) => row.source_key);
  }
  for (const key of keys) scheduleDocumentAutoTag(key, { force });
  return { scheduled: keys.length };
}
