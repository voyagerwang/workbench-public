/**
 * [INPUT]: 碎片捕获、笔记正文/标签请求与 SQLite
 * [OUTPUT]: 分诊和笔记读写；已删除笔记不可被详情读取或保存
 * [POS]: 笔记 API 业务边界，服务共用详情的薄适配
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
// 收件箱（随手记）与笔记路由
// 随手记捕获即分诊并落到对应模块（清单 / 笔记 / 提醒）；拖拽改分类走同步迁移
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../db.js';
import { deleteFragment, reclassifyCapture, repairOrphanFragmentTasks, triageCapture, withTargets, type FragmentRow } from '../services/triage.js';
import { normalizeTag, normalizeTags, tagKey } from '../services/tags.js';

/** notes.tags 是 JSON 文本；历史数据里可能存着非数组，一律兜成字符串数组 */
function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t ?? ''));
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((t) => String(t ?? '')) : [];
  } catch {
    return [];
  }
}

function parseNote(row: Record<string, unknown> | undefined) {
  if (!row) return row;
  row.tags = parseTags(row.tags);
  row.pinned = row.pinned ? 1 : 0;
  return row;
}

export default async function inboxRoutes(app: FastifyInstance) {
  // ---------- 随手记 ----------
  app.get('/api/fragments', (req) => {
    const q = z.object({ untriaged: z.enum(['0', '1']).default('0') }).parse(req.query);
    const where = q.untriaged === '1' ? 'WHERE triaged_type IS NULL AND deleted_at IS NULL' : 'WHERE deleted_at IS NULL';
    const rows = db.prepare(`SELECT * FROM fragments ${where} ORDER BY created_at DESC LIMIT 200`).all() as FragmentRow[];
    return withTargets(rows);
  });

  // 捕获即分诊：优先模型，模型不可用时退回透明规则；结果真的建到清单/笔记/提醒里
  app.post('/api/fragments', async (req) => {
    const b = z.object({
      content: z.string().max(4000).default(''),
      richContent: z.string().max(100_000).optional(),
    }).refine((v) => Boolean(v.content.trim() || v.richContent?.trim()), { message: '随手记不能为空' }).parse(req.body);
    return await triageCapture(b.content, b.richContent);
  });

  // 改分类：把内容迁移到目标模块（旧条目软删进回收站，提醒尽量复用同一行）
  app.post('/api/fragments/:id/reclassify', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const b = z.object({
      type: z.enum(['task', 'note', 'reminder']),
      reminderAt: z.string().nullable().optional(), // 指定提醒时间；缺省或 null = 按内容/旧条目推算
    }).parse(req.body);
    return reclassifyCapture(id, b.type, { remindAt: b.reminderAt });
  });

  // 删随手记：默认连它分出来的那条一起进回收站；目标被用户改过时先留着，由前端问一句
  app.delete('/api/fragments/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const q = z.object({ mode: z.enum(['auto', 'both']).default('auto') }).parse(req.query);
    return deleteFragment(id, q.mode);
  });

  // 一键把历史遗留的「没排期的随手记清单项」排进分诊当天
  app.post('/api/fragments/repair', () => ({ fixed: repairOrphanFragmentTasks() }));

  // ---------- 笔记 ----------
  // 排序：置顶优先，其次最近编辑。置顶是「钉住」而不是「收藏」，所以它只影响顺序。
  const NOTES_ORDER = 'ORDER BY pinned DESC, updated_at DESC LIMIT 500';

  app.get('/api/notes', (req) => {
    const q = z.object({ q: z.string().default(''), tag: z.string().default('') }).parse(req.query);
    let rows: Array<Record<string, unknown>>;
    if (q.q) {
      rows = db.prepare(
        `SELECT * FROM notes WHERE deleted_at IS NULL AND (title LIKE ? OR content LIKE ?) ${NOTES_ORDER}`,
      ).all(`%${q.q}%`, `%${q.q}%`) as never;
    } else if (q.tag) {
      rows = db.prepare(
        `SELECT * FROM notes WHERE deleted_at IS NULL AND tags LIKE ? ${NOTES_ORDER}`,
      ).all(`%"${q.tag}"%`) as never;
    } else {
      rows = db.prepare(`SELECT * FROM notes WHERE deleted_at IS NULL ${NOTES_ORDER}`).all() as never;
    }
    return rows.map(parseNote);
  });

  /**
   * 标签批量操作（重命名 / 合并 / 删除 / 补回）。
   *
   * 四个 op 走同一个事务，因为「撤销」本质就是反向再来一次：
   *   重命名 A→B 的撤销 = 重命名 B→A
   *   合并 A→B 的撤销    = add A 到受影响的那批笔记
   *   删除 A 的撤销      = add A 到受影响的那批笔记
   * 返回受影响的笔记 id 列表，前端拿它构造撤销参数。
   *
   * 刻意不更新 updated_at：整理标签不是编辑笔记内容，改一个标签就让几十条笔记
   * 集体跳到列表顶部、把真正在写的那条挤下去，是纯粹的噪声。
   */
  const tagBatchSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('rename'), from: z.string(), to: z.string() }),
    z.object({ op: z.literal('merge'), from: z.string(), to: z.string() }),
    z.object({ op: z.literal('remove'), tag: z.string() }),
    z.object({ op: z.literal('add'), tag: z.string(), ids: z.array(z.number().int()).max(1000) }),
  ]);

  app.post('/api/notes/tags/batch', (req) => {
    const b = tagBatchSchema.parse(req.body ?? {});

    const subject = b.op === 'remove' || b.op === 'add' ? normalizeTag(b.tag) : normalizeTag(b.from);
    const target = b.op === 'rename' || b.op === 'merge' ? normalizeTag(b.to) : '';
    if (!subject) throw app.httpErrors.badRequest('标签名不能为空');
    if ((b.op === 'rename' || b.op === 'merge') && !target) throw app.httpErrors.badRequest('新标签名不能为空');
    if ((b.op === 'rename' || b.op === 'merge') && tagKey(subject) === tagKey(target)) {
      throw app.httpErrors.badRequest('新旧标签名一样，没有需要改的');
    }

    const rows = db.prepare('SELECT id, tags FROM notes WHERE deleted_at IS NULL').all() as Array<{ id: number; tags: string }>;
    const parsed = rows.map((row) => ({ id: row.id, tags: normalizeTags(parseTags(row.tags)) }));

    // 现有标签全集：tagKey → 首次出现的写法，用来做「重命名撞名」和「合并到不存在的标签」校验
    const existing = new Map<string, string>();
    for (const row of parsed) {
      for (const tag of row.tags) if (!existing.has(tagKey(tag))) existing.set(tagKey(tag), tag);
    }
    if (b.op === 'rename' && existing.has(tagKey(target))) {
      throw app.httpErrors.conflict(`已经有「${existing.get(tagKey(target))}」这个标签了，要合并请用合并`);
    }
    if (b.op === 'merge' && !existing.has(tagKey(target))) {
      throw app.httpErrors.badRequest('要合并到的标签还不存在');
    }

    const idSet = b.op === 'add' ? new Set(b.ids) : null;
    const updates: Array<{ id: number; tags: string[] }> = [];
    for (const row of parsed) {
      const hit = row.tags.some((tag) => tagKey(tag) === tagKey(subject));
      let next: string[] | null = null;
      if (b.op === 'rename' || b.op === 'merge') {
        // 原地替换而不是「删掉再追加」：标签顺序是用户排的，改名不该把它挪到末尾。
        // 同时带着两个标签的笔记，normalizeTags 的去重会把它们收成一个目标标签。
        if (hit) next = normalizeTags(row.tags.map((tag) => (tagKey(tag) === tagKey(subject) ? target : tag)));
      } else if (b.op === 'remove') {
        if (hit) next = row.tags.filter((tag) => tagKey(tag) !== tagKey(subject));
      } else if (!hit && idSet?.has(row.id)) {
        next = normalizeTags([...row.tags, subject]);
      }
      if (next && next.join('\u0000') !== row.tags.join('\u0000')) updates.push({ id: row.id, tags: next });
    }

    if (updates.length) {
      const stmt = db.prepare('UPDATE notes SET tags = ? WHERE id = ?');
      db.transaction(() => { for (const u of updates) stmt.run(JSON.stringify(u.tags), u.id); })();
    }
    return { affected: updates.map((u) => u.id) };
  });

  app.get('/api/notes/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const note = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!note) throw app.httpErrors.notFound('文档不存在或已删除');
    return parseNote(note);
  });

  app.post('/api/notes', (req) => {
    const b = z.object({
      title: z.string().default(''), content: z.string().default(''),
      tags: z.array(z.string()).default([]),
      pinned: z.boolean().default(false),
    }).parse(req.body ?? {});
    const info = db.prepare('INSERT INTO notes (id, title, content, tags, pinned) VALUES (sync_id(), ?, ?, ?, ?)')
      .run(b.title, b.content, JSON.stringify(normalizeTags(b.tags)), b.pinned ? 1 : 0);
    return parseNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>);
  });

  app.patch('/api/notes/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const b = z.object({
      title: z.string().optional(), content: z.string().optional(),
      tags: z.array(z.string()).optional(),
      pinned: z.boolean().optional(),
      touchUpdatedAt: z.boolean().default(true),
    }).parse(req.body);
    const cur = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!cur) throw app.httpErrors.notFound();
    parseNote(cur);
    db.prepare(`UPDATE notes SET title=?, content=?, tags=?, pinned=?, updated_at=? WHERE id=?`).run(
      b.title ?? cur.title, b.content ?? cur.content,
      JSON.stringify(normalizeTags(b.tags ?? (cur.tags as string[]))),
      b.pinned === undefined ? cur.pinned : (b.pinned ? 1 : 0),
      b.touchUpdatedAt ? now() : cur.updated_at, id,
    );
    return parseNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Record<string, unknown>);
  });

  // 软删除进回收站
  app.delete('/api/notes/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    db.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
    return { ok: true };
  });
}
