/**
 * [INPUT]: tags/source_document_tags 表、notes.tags JSON 列与 services/tags.ts 的规范化规则
 * [OUTPUT]: 统一标签池读写：池列表计数、资料标签增删（人工优先、rejected 记忆）、全局重命名与删除、关联内容查询
 * [POS]: 标签池唯一业务口径；手记 JSON 仍是手记侧存储，全局改名/删除在这里统一波及两个载体
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { db, now, sync_id } from '../db.js';
import { normalizeTag, normalizeTags, tagKey } from './tags.js';

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** notes.tags 是 JSON 文本；历史数据可能存着非数组，一律兜成字符串数组（与 routes/inbox.ts 同规则） */
function parseNoteTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => String(item ?? ''));
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item ?? '')) : [];
  } catch {
    return [];
  }
}

type TagRow = { id: number; name: string; origin: 'user' | 'ai'; deleted_at: string | null };

/**
 * 找到（或建出）名字登记行。部分唯一索引只约束未删除行：同名软删行可以并存，
 * 手动重新使用被全局删除的名字时复活最近的一行（删除记忆就此清除）。
 * 自动打标路径不允许复活软删行——调用方必须先自行检查 dismissed。
 */
export function ensureTag(rawName: string, origin: 'user' | 'ai'): TagRow {
  const name = normalizeTag(rawName);
  if (!name) throw httpError(400, '标签名不能为空');
  const active = db.prepare('SELECT id, name, origin, deleted_at FROM tags WHERE name = ? AND deleted_at IS NULL').get(name) as TagRow | undefined;
  if (active) return active;
  const dismissed = db.prepare('SELECT id, name, origin, deleted_at FROM tags WHERE name = ? AND deleted_at IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 1').get(name) as TagRow | undefined;
  const ts = now();
  if (dismissed) {
    db.prepare('UPDATE tags SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(ts, dismissed.id);
    return { ...dismissed, deleted_at: null };
  }
  const id = sync_id();
  db.prepare('INSERT INTO tags (id, name, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, origin, ts, ts);
  return { id, name, origin, deleted_at: null };
}

export type TagPoolEntry = { name: string; origin: 'user' | 'ai'; document_count: number; note_count: number };

/** 池列表 = 登记表 ∪ 手记 JSON 里的名字（手记侧不经过登记表，按 tagKey 合并、登记表写法优先展示） */
export function listTagPool(): TagPoolEntry[] {
  const registry = db.prepare(`
    SELECT t.id, t.name, t.origin,
      (SELECT COUNT(*) FROM source_document_tags st JOIN source_documents d ON d.source_key = st.document_key
        WHERE st.tag_id = t.id AND st.state = 'active' AND d.deleted_at IS NULL) AS document_count
    FROM tags t WHERE t.deleted_at IS NULL
  `).all() as Array<{ id: number; name: string; origin: 'user' | 'ai'; document_count: number }>;

  const noteRows = db.prepare('SELECT tags FROM notes WHERE deleted_at IS NULL').all() as Array<{ tags: string }>;
  const noteCounts = new Map<string, { name: string; count: number }>();
  for (const row of noteRows) {
    for (const tag of normalizeTags(parseNoteTags(row.tags))) {
      const key = tagKey(tag);
      const entry = noteCounts.get(key);
      if (entry) entry.count += 1;
      else noteCounts.set(key, { name: tag, count: 1 });
    }
  }

  const merged = new Map<string, TagPoolEntry>();
  for (const row of registry) merged.set(tagKey(row.name), { name: row.name, origin: row.origin, document_count: row.document_count, note_count: 0 });
  for (const [key, note] of noteCounts) {
    const existing = merged.get(key);
    if (existing) existing.note_count = note.count;
    else merged.set(key, { name: note.name, origin: 'user', document_count: 0, note_count: note.count });
  }
  return [...merged.values()].sort((a, b) =>
    (b.document_count + b.note_count) - (a.document_count + a.note_count) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export type DocumentTag = { name: string; origin: 'user' | 'ai'; created_at: string };

/** 一篇资料的当前标签（state='active'；登记行被软删的不算——全局删除后立即从资料上消失） */
export function documentTags(sourceKey: string): DocumentTag[] {
  return db.prepare(`
    SELECT t.name, st.origin, st.created_at FROM source_document_tags st
    JOIN tags t ON t.id = st.tag_id
    WHERE st.document_key = ? AND st.state = 'active' AND t.deleted_at IS NULL
    ORDER BY st.created_at, st.id
  `).all(sourceKey) as DocumentTag[];
}

function requireDocument(sourceKey: string): void {
  const doc = db.prepare('SELECT deleted_at FROM source_documents WHERE source_key = ?').get(sourceKey) as { deleted_at: string | null } | undefined;
  if (!doc || doc.deleted_at) throw httpError(404, '资料不存在或已删除');
}

/** 手动加标签：人工行永远 state='active'，顺带清掉这篇资料上的 rejected 记忆（用户改主意了） */
export function addDocumentTag(sourceKey: string, rawName: string): DocumentTag {
  const name = normalizeTag(rawName);
  if (!name) throw httpError(400, '标签名不能为空');
  if (name.length > 50) throw httpError(400, '标签太长（最多 50 字）');
  requireDocument(sourceKey);
  const ts = now();
  let created_at = ts;
  db.transaction(() => {
    const tag = ensureTag(name, 'user');
    db.prepare(`
      INSERT INTO source_document_tags (id, tag_id, document_key, origin, state, created_at, updated_at)
      VALUES (?, ?, ?, 'user', 'active', ?, ?)
      ON CONFLICT(tag_id, document_key) DO UPDATE SET origin = 'user', state = 'active', updated_at = excluded.updated_at
    `).run(sync_id(), tag.id, sourceKey, ts, ts);
    const row = db.prepare('SELECT created_at FROM source_document_tags WHERE tag_id = ? AND document_key = ?').get(tag.id, sourceKey) as { created_at: string };
    created_at = row.created_at;
  })();
  return { name, origin: 'user', created_at };
}

/** 从一篇资料上移除：行保留、state 置 rejected —— 这是「自动打标别再给我加这个」的记忆 */
export function removeDocumentTag(sourceKey: string, rawName: string): { ok: true } {
  const name = normalizeTag(rawName);
  requireDocument(sourceKey);
  db.prepare(`
    UPDATE source_document_tags SET state = 'rejected', updated_at = ?
    WHERE document_key = ? AND tag_id = (SELECT id FROM tags WHERE name = ?) AND state = 'active'
  `).run(now(), sourceKey, name);
  return { ok: true };
}

function rewriteNoteTags(mapTag: (tag: string) => string | null): number {
  const rows = db.prepare('SELECT id, tags FROM notes WHERE deleted_at IS NULL').all() as Array<{ id: number; tags: string }>;
  const update = db.prepare('UPDATE notes SET tags = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    const tags = normalizeTags(parseNoteTags(row.tags));
    const next = tags.map(mapTag).filter((tag): tag is string => Boolean(tag));
    // 顺序与去重都由 normalizeTags 收口；没有变化就不写行
    if (next.length === tags.length && next.every((tag, index) => tag === tags[index])) continue;
    update.run(JSON.stringify(next), row.id);
    changed += 1;
  }
  return changed;
}

function activeDocumentCount(tagId: number): number {
  return (db.prepare(`
    SELECT COUNT(*) AS n FROM source_document_tags st JOIN source_documents d ON d.source_key = st.document_key
    WHERE st.tag_id = ? AND st.state = 'active' AND d.deleted_at IS NULL
  `).get(tagId) as { n: number }).n;
}

function notesTagUsage(key: string): number {
  const rows = db.prepare('SELECT tags FROM notes WHERE deleted_at IS NULL').all() as Array<{ tags: string }>;
  return rows.filter((row) => normalizeTags(parseNoteTags(row.tags)).some((tag) => tagKey(tag) === key)).length;
}

/** 全局重命名：登记表改名（关联行的 tag_id 不动），手记 JSON 同步改写。撞上已有名字（登记表或手记侧）→ 409，合并留给 V2。 */
export function renameTag(rawFrom: string, rawTo: string): { documents: number; notes: number } {
  const from = normalizeTag(rawFrom);
  const to = normalizeTag(rawTo);
  if (!from || !to) throw httpError(400, '标签名不能为空');
  if (tagKey(from) === tagKey(to)) throw httpError(400, '新旧标签名一样，没有需要改的');
  const conflict = db.prepare('SELECT id FROM tags WHERE name = ? AND deleted_at IS NULL').get(to);
  // 只存在于手记 JSON 的名字同样算撞名：合并语义（两侧一起并）属于 V2，不许静默变成改名
  const noteConflict = notesTagUsage(tagKey(to));
  if (conflict || noteConflict) {
    throw httpError(409, `已有同名标签「${to}」${noteConflict && !conflict ? '（正在手记中使用）' : ''}。把两个并成一个的合并功能在后续版本提供`);
  }
  // 先确认真的有人在用，再走 ensureTag——它会给不存在的名字建行，不能拿来当查询用
  const row = db.prepare('SELECT id FROM tags WHERE name = ? AND deleted_at IS NULL').get(from) as { id: number } | undefined;
  if (!row && !notesTagUsage(tagKey(from))) throw httpError(404, '没有内容用到这个标签');

  const source = ensureTag(from, 'user');
  const notes = rewriteNoteTags((tag) => (tagKey(tag) === tagKey(from) ? to : tag));
  db.prepare('UPDATE tags SET name = ?, updated_at = ? WHERE id = ?').run(to, now(), source.id);
  // 清掉新名字上没有关联的软删残留行，避免它的「全局删除」记忆误伤改名后的正常使用
  db.prepare(`DELETE FROM tags WHERE name = ? AND deleted_at IS NOT NULL AND id != ?
    AND NOT EXISTS (SELECT 1 FROM source_document_tags st WHERE st.tag_id = tags.id)`).run(to, source.id);
  return { documents: activeDocumentCount(source.id), notes };
}

/** 全局删除：资料关联全部置 rejected（逐篇记忆，自动不再加回）、手记 JSON 摘除、登记行软删留档。 */
export function deleteTagEverywhere(rawName: string): { documents: number; notes: number } {
  const name = normalizeTag(rawName);
  if (!name) throw httpError(400, '标签名不能为空');
  const tagKeyOf = tagKey(name);
  const row = db.prepare('SELECT id FROM tags WHERE name = ? AND deleted_at IS NULL').get(name) as { id: number } | undefined;
  const notes = rewriteNoteTags((tag) => (tagKey(tag) === tagKeyOf ? null : tag));
  if (!row && !notes) throw httpError(404, '没有内容用到这个标签');
  const ts = now();
  let documents = 0;
  if (row) {
    // 影响面要先统计再动手：置 rejected 之后 active 计数恒为 0
    documents = activeDocumentCount(row.id);
    db.prepare("UPDATE source_document_tags SET state = 'rejected', updated_at = ? WHERE tag_id = ? AND state = 'active'").run(ts, row.id);
    db.prepare('UPDATE tags SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, row.id);
  } else {
    // 只在手记里出现过的名字也登记成软删行：自动打标从此不再建议这个名字
    const id = sync_id();
    db.prepare("INSERT INTO tags (id, name, origin, created_at, updated_at, deleted_at) VALUES (?, ?, 'user', ?, ?, ?)").run(id, name, ts, ts, ts);
  }
  return { documents, notes };
}

export type TagItems = {
  documents: Array<{ source_key: string; title: string; updated_at: string }>;
  notes: Array<{ id: number; title: string }>;
};

/** 「这个标签关联了什么」：资料与手记一起列出来——统一池的关联视图 */
export function tagItems(rawName: string): TagItems {
  const name = normalizeTag(rawName);
  if (!name) throw httpError(400, '标签名不能为空');
  const documents = db.prepare(`
    SELECT d.source_key, d.title, d.updated_at FROM source_document_tags st
    JOIN tags t ON t.id = st.tag_id
    JOIN source_documents d ON d.source_key = st.document_key
    WHERE t.name = ? AND st.state = 'active' AND d.deleted_at IS NULL
    ORDER BY d.updated_at DESC LIMIT 200
  `).all(name) as TagItems['documents'];
  const key = tagKey(name);
  const noteRows = db.prepare('SELECT id, title, tags FROM notes WHERE deleted_at IS NULL').all() as Array<{ id: number; title: string; tags: string }>;
  const notes = noteRows
    .filter((row) => normalizeTags(parseNoteTags(row.tags)).some((tag) => tagKey(tag) === key))
    .map((row) => ({ id: row.id, title: row.title }))
    .slice(0, 200);
  return { documents, notes };
}
