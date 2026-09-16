/**
 * [INPUT]: 依赖工作台各本地数据表与 searchKnowledgeLayers 公共知识检索
 * [OUTPUT]: 提供全局搜索 HTTP 路由，知识结果保留版本引用且不旁路旧快照
 * [POS]: 全局快捷搜索聚合层；知识检索口径由 knowledge-search.ts 单点维护
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { searchKnowledgeLayers } from '../services/knowledge-search.js';

interface SearchItem {
  id: number | string;
  title: string;
  hint: string;
  route: string;
}

interface SearchGroup {
  type: 'task' | 'note' | 'knowledge' | 'source_document' | 'archive' | 'prompt' | 'reminder';
  label: string;
  items: SearchItem[];
}

const LIMIT = 6;

/** LIKE 通配符转义，避免用户输入 % _ 引发全表匹配 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** 从长文本里截取命中位置附近的摘录作为提示 */
function excerpt(content: string, q: string): string {
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return content.slice(0, 60).replace(/\s+/g, ' ');
  const start = Math.max(0, idx - 20);
  return (start > 0 ? '…' : '') + content.slice(start, idx + q.length + 40).replace(/\s+/g, ' ') + '…';
}

export default async function searchRoutes(app: FastifyInstance) {
  app.get('/api/search', (req) => {
    const q = String((req.query as Record<string, unknown>)?.q ?? '').trim();
    if (!q) return { groups: [] as SearchGroup[] };
    const p = likePattern(q);
    const groups: SearchGroup[] = [];

    const tasks = db.prepare(
      `SELECT id, title, notes, planned_date, project_id, status FROM tasks
       WHERE title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT ${LIMIT}`,
    ).all(p, p, p, p) as Array<{ id: number; title: string; notes: string; planned_date: string | null; project_id: number | null; status: string }>;
    if (tasks.length) {
      groups.push({
        type: 'task',
        label: '清单',
        items: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          hint: t.planned_date ? `计划 ${t.planned_date}${t.status === 'done' ? ' · 已完成' : ''}` : '未排期',
          route: t.planned_date ? `/?day=${t.planned_date}` : t.project_id ? `/projects/${t.project_id}` : '/',
        })),
      });
    }

    const notes = db.prepare(
      `SELECT id, title, content FROM notes
       WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT ${LIMIT}`,
    ).all(p, p, p, p) as Array<{ id: number; title: string; content: string }>;
    if (notes.length) {
      groups.push({
        type: 'note',
        label: '笔记',
        items: notes.map((n) => ({
          id: n.id,
          title: n.title || '未命名笔记',
          hint: excerpt(n.content, q),
          route: `/knowledge/notes?note=${n.id}`,
        })),
      });
    }

    const layered = searchKnowledgeLayers(q, LIMIT);
    const knowledgeHits = layered.filter((h) => h.kind === 'knowledge');
    if (knowledgeHits.length) {
      groups.push({
        type: 'knowledge',
        label: '知识',
        items: knowledgeHits.map((h) => ({
          id: h.id,
          title: h.title,
          hint: h.source_title ? `来自《${h.source_title}》` : h.snippet,
          route: h.evidence_url ?? (h.topic_id ? `/knowledge/topics/${h.topic_id}` : '/knowledge/topics'),
        })),
      });
    }

    const documentHits = layered.filter((h) => h.kind === 'source_document');
    if (documentHits.length) {
      groups.push({
        type: 'source_document',
        label: '主题资料',
        items: documentHits.map((h) => ({
          id: h.id,
          title: h.title,
          hint: h.body_status === 'suspect' ? '正文可能不完整' : h.body_status === 'failed' ? '抓取失败' : h.snippet,
          route: h.evidence_url ?? '/knowledge/topics',
        })),
      });
    }

    const prompts = db.prepare(
      `SELECT id, title, description, content FROM prompts
       WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
       ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT ${LIMIT}`,
    ).all(p, p, p, p, p) as Array<{ id: number; title: string; description: string; content: string }>;
    if (prompts.length) {
      groups.push({
        type: 'prompt',
        label: '提示词',
        items: prompts.map((pr) => ({
          id: pr.id,
          title: pr.title || '未命名提示词',
          hint: pr.description || excerpt(pr.content, q),
          route: `/knowledge/prompts?prompt=${pr.id}`,
        })),
      });
    }

    const reminders = db.prepare(
      `SELECT id, message, trigger_at, status FROM reminders
       WHERE deleted_at IS NULL AND message LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, trigger_at ASC
       LIMIT ${LIMIT}`,
    ).all(p) as Array<{ id: number; message: string; trigger_at: string; status: string }>;
    if (reminders.length) {
      groups.push({
        type: 'reminder',
        label: '提醒',
        items: reminders.map((r) => ({
          id: r.id,
          title: r.message,
          hint: `${r.status === 'pending' ? '待触发' : r.status === 'fired' ? '已到点' : '已确认'} · ${r.trigger_at}`,
          route: '/reminders',
        })),
      });
    }

    return { groups };
  });
}
