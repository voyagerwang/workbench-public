// 回收站：软删除内容的统一回显 / 恢复 / 彻底删除
// 各业务模块的 DELETE 只打 deleted_at 标记（Skill 是文件目录，删除时移入 data/skill-trash 并登记）；
// 这里按「工作台 / 知识库 / AI 资源库」三类回显，超过保留期惰性物理清除。
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { db } from '../db.js';

const RETAIN_DAYS = 30;
const PREVIEW_CHARS = 240;
const DETAIL_CHARS = 200_000;

export const TRASH_KINDS = ['tasks', 'projects', 'fragments', 'reminders', 'notes', 'knowledge', 'prompts', 'skills'] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];
/** 兼容旧命名：前端撤销提示等仍写作 TrashType */
export type TrashType = TrashKind;

export type TrashGroup = 'workspace' | 'knowledge' | 'ai';

/** 分类归属：与左侧导航的模块划分保持一致，回收站按此分组展示 */
export const TRASH_GROUPS: Array<{ key: TrashGroup; label: string; kinds: TrashKind[] }> = [
  { key: 'workspace', label: '工作台', kinds: ['tasks', 'projects', 'fragments', 'reminders'] },
  { key: 'knowledge', label: '知识库', kinds: ['notes', 'knowledge'] },
  { key: 'ai', label: 'AI 资源库', kinds: ['prompts', 'skills'] },
];

export interface TrashChip {
  label: string;
  tone: 'muted' | 'accent' | 'warn';
}

export interface TrashEntry {
  kind: TrashKind;
  id: number;
  title: string;
  /** 正文摘要，回收站卡片直接回显 */
  preview: string;
  /** 正文字数，0 表示没有正文可看 */
  chars: number;
  chips: TrashChip[];
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string;
  /** 是否可以展开看全文 */
  expandable: boolean;
}

type Row = Record<string, unknown>;
type DraftEntry = Omit<TrashEntry, 'kind'>;

const text = (v: unknown): string => (v == null ? '' : String(v));
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n = PREVIEW_CHARS) => (s.length > n ? `${s.slice(0, n)}…` : s);
const charsChip = (n: number): TrashChip[] => (n > 0 ? [{ label: `${n} 字`, tone: 'muted' }] : []);

const TASK_STATUS: Record<string, string> = { todo: '待办', doing: '进行中', done: '已完成' };
const PROJECT_STATUS: Record<string, string> = { active: '进行中', paused: '已暂停', archived: '已归档', done: '已完成' };
const REMINDER_STATUS: Record<string, string> = { pending: '未触发', fired: '已触发', done: '已完成' };
const SOURCE_LABEL: Record<string, string> = {
  manual: '手动', feishu: '飞书', dingtalk: '钉钉', url: '网页', folder: '文件夹', conversation: '对话',
};
const TRIAGED_LABEL: Record<string, string> = { task: '清单', note: '笔记', reminder: '提醒' };

function parseTags(raw: unknown): string[] {
  try {
    const value = JSON.parse(text(raw) || '[]');
    return Array.isArray(value) ? value.map(String).slice(0, 3) : [];
  } catch {
    return [];
  }
}

/** 无标题内容取正文首行当标题，避免回收站里出现「（无标题）」这种看不出所以然的行 */
function fallbackTitle(content: string): string {
  const first = oneLine(content).slice(0, 48);
  return first || '（无标题）';
}

interface KindConfig {
  label: string;
  /** 软删除所在表；Skill 走文件系统，无表 */
  table?: string;
  listSql: string;
  toEntry(row: Row): DraftEntry;
  /** 全文回显：按 id 取出被删条目的完整正文 */
  detail?(id: number): { title: string; body: string } | null;
}

function softDeleteDetail(table: string, columns: string, titleOf: (row: Row) => string, bodyOf: (row: Row) => string) {
  return (id: number) => {
    const row = db.prepare(`SELECT ${columns} FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`).get(id) as Row | undefined;
    if (!row) return null;
    return { title: titleOf(row), body: bodyOf(row).slice(0, DETAIL_CHARS) };
  };
}

const KIND_CONFIG: Record<TrashKind, KindConfig> = {
  tasks: {
    label: '清单',
    table: 'tasks',
    listSql: `SELECT t.id, t.title, t.notes, t.detail, t.status, t.priority, t.planned_date, t.due_at,
                     t.created_at, t.updated_at, t.deleted_at, p.name AS project_name, p.domain AS project_domain
              FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
              WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC LIMIT 500`,
    toEntry(row) {
      const body = [text(row.detail), text(row.notes)].map((s) => s.trim()).filter(Boolean).join('\n\n');
      const chips: TrashChip[] = [];
      const status = TASK_STATUS[text(row.status)];
      if (status) chips.push({ label: status, tone: text(row.status) === 'done' ? 'muted' : 'accent' });
      const priority = Number(row.priority ?? 0);
      if (priority === 2) chips.push({ label: '紧急重要', tone: 'warn' });
      else if (priority === 1) chips.push({ label: '重要', tone: 'warn' });
      if (text(row.project_name)) chips.push({ label: text(row.project_name), tone: 'muted' });
      if (text(row.planned_date)) chips.push({ label: `计划 ${text(row.planned_date).slice(5)}`, tone: 'muted' });
      else if (text(row.due_at)) chips.push({ label: `截止 ${text(row.due_at).slice(0, 10)}`, tone: 'muted' });
      const title = oneLine(text(row.title)) || fallbackTitle(body);
      return { id: Number(row.id), title, preview: body ? clip(oneLine(body)) : '', chars: body.length, chips, created_at: text(row.created_at) || null, updated_at: text(row.updated_at) || null, deleted_at: text(row.deleted_at), expandable: Boolean(body) };
    },
    detail: softDeleteDetail(
      'tasks',
      'title, notes, detail, created_at, deleted_at',
      (row) => oneLine(text(row.title)) || '清单',
      (row) => {
        const meta = `删除于 ${text(row.deleted_at).replace('T', ' ')}${text(row.created_at) ? ` · 创建于 ${text(row.created_at).slice(0, 10)}` : ''}`;
        return [`# ${oneLine(text(row.title)) || '清单'}`, meta, text(row.detail).trim(), text(row.notes).trim()].filter(Boolean).join('\n\n');
      },
    ),
  },
  projects: {
    label: '项目',
    table: 'projects',
    listSql: `SELECT p.id, p.name, p.description, p.domain, p.status, p.created_at, p.updated_at, p.deleted_at,
                     (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL) AS open_tasks
              FROM projects p WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC LIMIT 500`,
    toEntry(row) {
      const description = text(row.description).trim();
      const chips: TrashChip[] = [{ label: text(row.domain) === 'life' ? '生活' : '工作', tone: 'muted' }];
      const status = PROJECT_STATUS[text(row.status)];
      if (status) chips.push({ label: status, tone: 'muted' });
      chips.push({ label: `关联 ${Number(row.open_tasks ?? 0)} 条清单`, tone: 'muted' });
      const title = oneLine(text(row.name)) || '未命名项目';
      return { id: Number(row.id), title, preview: clip(oneLine(description)), chars: description.length, chips, created_at: text(row.created_at) || null, updated_at: text(row.updated_at) || null, deleted_at: text(row.deleted_at), expandable: Boolean(description) };
    },
    detail: softDeleteDetail(
      'projects',
      'name, description, domain, status, deleted_at',
      (row) => oneLine(text(row.name)) || '未命名项目',
      (row) => [`# ${oneLine(text(row.name)) || '未命名项目'}`, `删除于 ${text(row.deleted_at).replace('T', ' ')}`, text(row.description).trim()].filter(Boolean).join('\n\n'),
    ),
  },
  fragments: {
    label: '随手记',
    table: 'fragments',
    listSql: `SELECT id, content, rich_content, triaged_type, triaged_id, created_at, triaged_at, deleted_at
              FROM fragments WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500`,
    toEntry(row) {
      const content = text(row.content).trim();
      const chips: TrashChip[] = [];
      const triaged = TRIAGED_LABEL[text(row.triaged_type)];
      chips.push({ label: triaged ? `已分成${triaged}` : '未分诊', tone: triaged ? 'accent' : 'muted' });
      return { id: Number(row.id), title: fallbackTitle(content), preview: clip(oneLine(content)), chars: content.length, chips, created_at: text(row.created_at) || null, updated_at: null, deleted_at: text(row.deleted_at), expandable: content.length > 0 };
    },
    detail: softDeleteDetail(
      'fragments',
      'content, rich_content, created_at, deleted_at',
      (row) => fallbackTitle(text(row.content)),
      (row) => {
        const rich = text(row.rich_content).trim();
        const body = rich && rich !== text(row.content).trim() ? `${text(row.content).trim()}\n\n---\n\n${rich}` : text(row.content).trim();
        return [`# 随手记`, `删除于 ${text(row.deleted_at).replace('T', ' ')}${text(row.created_at) ? ` · 记于 ${text(row.created_at).slice(0, 16).replace('T', ' ')}` : ''}`, body].filter(Boolean).join('\n\n');
      },
    ),
  },
  reminders: {
    label: '提醒',
    table: 'reminders',
    listSql: `SELECT r.id, r.message, r.trigger_at, r.status, r.repeat_rule, r.linked_task_id, r.created_at, r.deleted_at,
                     t.title AS task_title
              FROM reminders r LEFT JOIN tasks t ON t.id = r.linked_task_id
              WHERE r.deleted_at IS NOT NULL ORDER BY r.deleted_at DESC LIMIT 500`,
    toEntry(row) {
      const message = text(row.message).trim();
      const chips: TrashChip[] = [];
      const status = REMINDER_STATUS[text(row.status)];
      if (status) chips.push({ label: status, tone: text(row.status) === 'pending' ? 'warn' : 'muted' });
      if (text(row.trigger_at)) chips.push({ label: `原定 ${text(row.trigger_at).slice(5, 16).replace('T', ' ')}`, tone: 'muted' });
      if (text(row.repeat_rule) !== 'none') chips.push({ label: '重复提醒', tone: 'muted' });
      if (text(row.task_title)) chips.push({ label: `来自「${oneLine(text(row.task_title)).slice(0, 16)}」`, tone: 'muted' });
      return { id: Number(row.id), title: oneLine(message) || '提醒', preview: '', chars: message.length, chips, created_at: text(row.created_at) || null, updated_at: null, deleted_at: text(row.deleted_at), expandable: false };
    },
  },
  notes: {
    label: '笔记',
    table: 'notes',
    listSql: `SELECT id, title, content, tags, source_fragment_id, created_at, updated_at, deleted_at
              FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500`,
    toEntry(row) {
      const content = text(row.content).trim();
      const chips: TrashChip[] = parseTags(row.tags).map((tag) => ({ label: tag, tone: 'muted' as const }));
      const title = oneLine(text(row.title)) || fallbackTitle(content);
      return { id: Number(row.id), title, preview: content === title ? '' : clip(oneLine(content)), chars: content.length, chips, created_at: text(row.created_at) || null, updated_at: text(row.updated_at) || null, deleted_at: text(row.deleted_at), expandable: Boolean(content) };
    },
    detail: softDeleteDetail(
      'notes',
      'title, content, created_at, updated_at, deleted_at',
      (row) => oneLine(text(row.title)) || '笔记',
      (row) => [`# ${oneLine(text(row.title)) || '笔记'}`, `删除于 ${text(row.deleted_at).replace('T', ' ')} · 最后更新 ${text(row.updated_at).slice(0, 16).replace('T', ' ')}`, text(row.content).trim()].filter(Boolean).join('\n\n'),
    ),
  },
  knowledge: {
    label: '知识存档',
    table: 'knowledge_archives',
    listSql: `SELECT id, title, content, source_kind, source_url, file_name, status, error, created_at, updated_at, deleted_at
              FROM knowledge_archives WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500`,
    toEntry(row) {
      const content = text(row.content).trim();
      const chips: TrashChip[] = [{ label: SOURCE_LABEL[text(row.source_kind)] ?? '手动', tone: 'muted' }];
      if (text(row.status) !== 'indexed') chips.push({ label: text(row.status) === 'needs_auth' ? '需要授权' : text(row.status) === 'remote' ? '云端索引' : '导入失败', tone: 'warn' });
      if (text(row.file_name)) chips.push({ label: basename(text(row.file_name)), tone: 'muted' });
      const title = oneLine(text(row.title)) || text(row.file_name) || fallbackTitle(content);
      const preview = content ? clip(oneLine(content)) : oneLine(text(row.error));
      return { id: Number(row.id), title, preview, chars: content.length, chips, created_at: text(row.created_at) || null, updated_at: text(row.updated_at) || null, deleted_at: text(row.deleted_at), expandable: Boolean(content) };
    },
    detail: softDeleteDetail(
      'knowledge_archives',
      'title, content, source_url, file_name, deleted_at',
      (row) => oneLine(text(row.title)) || '知识存档',
      (row) => {
        const source = text(row.source_url) || text(row.file_name);
        return [`# ${oneLine(text(row.title)) || '知识存档'}`, `删除于 ${text(row.deleted_at).replace('T', ' ')}${source ? ` · 来源 ${source}` : ''}`, text(row.content).trim()].filter(Boolean).join('\n\n');
      },
    ),
  },
  prompts: {
    label: '提示词',
    table: 'prompts',
    listSql: `SELECT id, title, content, description, tags, created_at, updated_at, deleted_at
              FROM prompts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500`,
    toEntry(row) {
      const content = text(row.content).trim();
      const description = text(row.description).trim();
      const chips: TrashChip[] = parseTags(row.tags).map((tag) => ({ label: tag, tone: 'accent' as const }));
      if (!chips.length) chips.push({ label: '通用', tone: 'muted' });
      const title = oneLine(text(row.title)) || '未命名提示词';
      return { id: Number(row.id), title, preview: clip(oneLine(description || content)), chars: content.length, chips, created_at: text(row.created_at) || null, updated_at: text(row.updated_at) || null, deleted_at: text(row.deleted_at), expandable: Boolean(content) };
    },
    detail: softDeleteDetail(
      'prompts',
      'title, content, description, created_at, updated_at, deleted_at',
      (row) => oneLine(text(row.title)) || '未命名提示词',
      (row) => [`# ${oneLine(text(row.title)) || '未命名提示词'}`, text(row.description).trim(), `删除于 ${text(row.deleted_at).replace('T', ' ')} · 最后更新 ${text(row.updated_at).slice(0, 16).replace('T', ' ')}`, '---', text(row.content).trim()].filter(Boolean).join('\n\n'),
    ),
  },
  skills: {
    label: 'Skill',
    listSql: `SELECT id, name, description, origin_dir, trash_dir, created_at, deleted_at
              FROM skill_trash ORDER BY deleted_at DESC LIMIT 500`,
    toEntry(row) {
      const trashDir = text(row.trash_dir);
      const description = text(row.description).trim();
      const chips: TrashChip[] = [{ label: basename(text(row.origin_dir)) || 'Skill', tone: 'muted' }];
      return {
        id: Number(row.id),
        title: oneLine(text(row.name)) || basename(text(row.origin_dir)) || 'Skill',
        preview: clip(oneLine(description)),
        chars: description.length,
        chips,
        created_at: text(row.created_at) || null,
        updated_at: null,
        deleted_at: text(row.deleted_at),
        expandable: existsSync(join(trashDir, 'SKILL.md')),
      };
    },
    detail(id) {
      const row = db.prepare('SELECT name, description, origin_dir, trash_dir, deleted_at FROM skill_trash WHERE id = ?').get(id) as Row | undefined;
      if (!row) return null;
      const file = join(text(row.trash_dir), 'SKILL.md');
      if (!existsSync(file)) return null;
      let content = '';
      try { content = readFileSync(file, 'utf8'); } catch { return null; }
      return {
        title: text(row.name) || basename(text(row.origin_dir)),
        body: [
          `# ${text(row.name) || 'SKILL.md'}`,
          `删除于 ${text(row.deleted_at).replace('T', ' ')} · 原位置 ${text(row.origin_dir)}`,
          content.trim().slice(0, DETAIL_CHARS),
        ].join('\n\n'),
      };
    },
  },
};

function cutoff(): string {
  const d = new Date(Date.now() - RETAIN_DAYS * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Skill 删除登记：ai-resources 把目录移进 data/skill-trash 后调用，回收站据此提供恢复入口 */
export function registerSkillTrash(input: { name: string; description: string; originDir: string; trashDir: string }): number {
  const result = db.prepare(
    'INSERT INTO skill_trash (name, description, origin_dir, trash_dir) VALUES (?, ?, ?, ?)',
  ).run(input.name, input.description, input.originDir, input.trashDir);
  return Number(result.lastInsertRowid);
}

function skillRow(id: number): Row | undefined {
  return db.prepare('SELECT * FROM skill_trash WHERE id = ?').get(id) as Row | undefined;
}

function restoreSkill(id: number): void {
  const row = skillRow(id);
  if (!row) throw Object.assign(new Error('Skill 备份记录不存在'), { statusCode: 404 });
  const trashDir = text(row.trash_dir);
  const originDir = text(row.origin_dir);
  db.prepare('DELETE FROM skill_trash WHERE id = ?').run(id);
  if (!existsSync(trashDir)) throw Object.assign(new Error('备份目录已不存在，无法恢复'), { statusCode: 409 });
  if (existsSync(originDir)) {
    throw Object.assign(new Error(`原位置已有同名目录，先清掉才能恢复：${originDir}`), { statusCode: 409 });
  }
  mkdirSync(dirname(originDir), { recursive: true });
  renameSync(trashDir, originDir);
}

function purgeSkill(id: number): void {
  const row = skillRow(id);
  if (!row) throw Object.assign(new Error('Skill 备份记录不存在'), { statusCode: 404 });
  db.prepare('DELETE FROM skill_trash WHERE id = ?').run(id);
  const dir = text(row.trash_dir);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** 物理清除超期内容（tasks 的联动提醒靠外键 CASCADE 一并清掉） */
export function purgeExpiredTrash(): void {
  const c = cutoff();
  for (const kind of TRASH_KINDS) {
    const table = KIND_CONFIG[kind].table;
    if (table) db.prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`).run(c);
  }
  for (const row of db.prepare('SELECT id, trash_dir FROM skill_trash WHERE deleted_at < ?').all(c) as Array<{ id: number; trash_dir: string }>) {
    db.prepare('DELETE FROM skill_trash WHERE id = ?').run(row.id);
    if (row.trash_dir && existsSync(row.trash_dir)) {
      try { rmSync(row.trash_dir, { recursive: true, force: true }); } catch { /* 目录被手动清过就只丢登记 */ }
    }
  }
}

function listEntries(): TrashEntry[] {
  const items: TrashEntry[] = [];
  for (const kind of TRASH_KINDS) {
    const config = KIND_CONFIG[kind];
    for (const row of db.prepare(config.listSql).all() as Row[]) {
      items.push({ kind, ...config.toEntry(row) });
    }
  }
  return items.sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
}

function restoreOne(kind: TrashKind, id: number): void {
  if (kind === 'skills') {
    restoreSkill(id);
    return;
  }
  const table = KIND_CONFIG[kind].table!;
  const info = db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`).run(id);
  if (info.changes === 0) throw Object.assign(new Error('这条内容不在回收站里'), { statusCode: 404 });
  // 恢复任务时，连带还原随任务入站的提醒
  if (kind === 'tasks') {
    db.prepare('UPDATE reminders SET deleted_at = NULL WHERE linked_task_id = ? AND deleted_at IS NOT NULL').run(id);
  }
}

function purgeOne(kind: TrashKind, id: number): void {
  if (kind === 'skills') {
    purgeSkill(id);
    return;
  }
  const table = KIND_CONFIG[kind].table!;
  const cur = db.prepare(`SELECT deleted_at FROM ${table} WHERE id = ?`).get(id) as { deleted_at: string | null } | undefined;
  if (!cur?.deleted_at) throw Object.assign(new Error('这条内容不在回收站里'), { statusCode: 404 });
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}

const kindSchema = z.enum(TRASH_KINDS);

export default async function trashRoutes(app: FastifyInstance) {
  // 全量回收站（顺带清一次过期项）：一次返回所有分类，前端按模块分组展示
  app.get('/api/trash', () => {
    purgeExpiredTrash();
    const items = listEntries();
    const counts: Partial<Record<TrashKind, number>> = {};
    for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return {
      retainDays: RETAIN_DAYS,
      total: items.length,
      counts,
      categories: TRASH_GROUPS.map((group) => ({
        key: group.key,
        label: group.label,
        kinds: group.kinds.map((kind) => ({ kind, label: KIND_CONFIG[kind].label, count: counts[kind] ?? 0 })),
      })),
      items,
    };
  });

  // 全文回显：展开卡片时按需取正文，列表接口只带摘要
  app.get('/api/trash/:kind/:id', (req) => {
    const { kind, id } = z.object({ kind: kindSchema, id: z.coerce.number().int() }).parse(req.params);
    const detail = KIND_CONFIG[kind].detail?.(id);
    if (!detail) throw app.httpErrors.notFound('这条内容没有可回显的正文，或已被清除');
    return detail;
  });

  const params = z.object({ kind: kindSchema, id: z.coerce.number().int() });

  app.post('/api/trash/:kind/:id/restore', (req) => {
    const { kind, id } = params.parse(req.params);
    restoreOne(kind, id);
    return { ok: true };
  });

  app.delete('/api/trash/:kind/:id', (req) => {
    const { kind, id } = params.parse(req.params);
    purgeOne(kind, id);
    return { ok: true };
  });

  // 批量清空：仅限回收站内，不可逆，前端需输口令二次确认后才能调到这里
  const purgeBody = z.object({ kinds: z.array(kindSchema).min(1).optional() }).default({});

  app.post('/api/trash/purge-all', (req) => {
    const { kinds } = purgeBody.parse(req.body ?? {});
    const targets = kinds ?? [...TRASH_KINDS];
    let purged = 0;
    for (const kind of targets) {
      const ids = (kind === 'skills'
        ? db.prepare('SELECT id FROM skill_trash').all()
        : db.prepare(`SELECT id FROM ${KIND_CONFIG[kind].table!} WHERE deleted_at IS NOT NULL`).all()) as Array<{ id: number }>;
      for (const { id } of ids) {
        purgeOne(kind, id);
        purged += 1;
      }
    }
    return { ok: true, purged };
  });

  // 兜底：启动时也清一次
  purgeExpiredTrash();
}
