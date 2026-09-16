/**
 * [INPUT]: 任务/项目请求与 SQLite 业务数据
 * [OUTPUT]: 任务/项目读写，按 ID 读取仅返回未删除文档
 * [POS]: 任务路由边界，保留周期、提醒和回收站的原有规则
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
// 任务与项目路由
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now, today } from '../db.js';
import { extractRecurringSchedule, repeatRuleSchema, stripRecurringPrefix } from '../services/recurrence.js';
import { syncTaskReminder } from '../services/reminders.js';
import { createNextRecurringTask } from '../services/recurring-tasks.js';

const taskRow = `
  SELECT t.*, p.name AS project_name, p.domain AS project_domain, p.status AS project_status
  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
`;

function getTask(id: number) {
  return db.prepare(`${taskRow} WHERE t.id = ?`).get(id);
}

export default async function taskRoutes(app: FastifyInstance) {
  // ---------- 项目 ----------
  app.get('/api/projects', () => {
    return db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status != 'done') AS open_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'done') AS done_tasks,
        (SELECT MAX(t.completed_at) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'done') AS last_done_at
      FROM projects p
      WHERE p.deleted_at IS NULL
      ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, p.updated_at DESC
    `).all();
  });

  const projectBody = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    domain: z.enum(['work', 'life']).default('work'),
    status: z.enum(['active', 'paused', 'archived', 'done']).optional(),
    color: z.string().nullable().optional(),
  });

  app.post('/api/projects', (req) => {
    const b = projectBody.parse(req.body);
    const info = db.prepare(
      'INSERT INTO projects (id, name, description, domain, color) VALUES (sync_id(), ?, ?, ?, ?)',
    ).run(b.name, b.description ?? '', b.domain, b.color ?? null);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
  });

  app.patch('/api/projects/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const b = projectBody.partial().parse(req.body);
    const cur = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!cur) throw app.httpErrors.notFound();
    const next = { ...cur, ...b, updated_at: now() };
    db.prepare(`UPDATE projects SET name=@name, description=@description, domain=@domain,
      status=@status, color=@color, updated_at=@updated_at WHERE id=@id`).run(next);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  });

  // 软删除进回收站：任务保留 project_id，恢复后关联关系原样回来
  app.delete('/api/projects/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
    return { ok: true };
  });

  // ---------- 任务 ----------
  // 排序：手动 sort_order 优先，从未排过（NULL）的按时间倒序兜底
  app.get('/api/tasks', () =>
    db.prepare(`${taskRow} WHERE t.deleted_at IS NULL ORDER BY t.sort_order IS NULL ASC, t.sort_order ASC, t.created_at DESC, t.id DESC`).all());

  app.get('/api/tasks/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const task = db.prepare(`${taskRow} WHERE t.id = ? AND t.deleted_at IS NULL`).get(id);
    if (!task) throw app.httpErrors.notFound('文档不存在或已删除');
    return task;
  });

  // 拖拽重排：前端把可见列表的新顺序整组发来，按下标落库
  app.post('/api/tasks/reorder', (req) => {
    const b = z.object({ ids: z.array(z.number()).min(1) }).parse(req.body);
    const upd = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');
    db.transaction(() => { b.ids.forEach((id, i) => upd.run(i, id)); })();
    return { ok: true };
  });

  const taskBody = z.object({
    title: z.string().min(1).optional(),
    notes: z.string().optional(),
    projectId: z.number().nullable().optional(),
    status: z.enum(['todo', 'doing', 'done']).optional(),
    priority: z.number().int().min(0).max(2).optional(),
    dueAt: z.string().nullable().optional(),
    plannedDate: z.string().nullable().optional(), // YYYY-MM-DD 或 null 移出今日
    remindAt: z.string().nullable().optional(),   // 任务提醒，null = 清除
    repeatRule: repeatRuleSchema.optional(), // 完成后生成下一次任务（支持 monthly / ndays:N）
    detail: z.string().max(512 * 1024).optional(), // 详情文档（Markdown）
  });

  app.post('/api/tasks', (req) => {
    const b = taskBody.parse(req.body);
    if (!b.title) throw new Error('title required');
    // 标题里直接说周期时也走结构化周期任务，避免把“每周五”只当普通文本保存
    const recurring = extractRecurringSchedule(b.title);
    const title = recurring ? stripRecurringPrefix(b.title) : b.title;
    const plannedDate = recurring?.plannedDate ?? b.plannedDate ?? null;
    const repeatRule = recurring?.repeatRule ?? b.repeatRule ?? 'none';
    const nextSort = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS v FROM tasks').get() as { v: number }).v + 1;
    const info = db.prepare(`
      INSERT INTO tasks (id, title, notes, project_id, priority, due_at, planned_date, remind_at, repeat_rule, sort_order)
      VALUES (sync_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, b.notes ?? '', b.projectId ?? null, b.priority ?? 0, b.dueAt ?? null, plannedDate, b.remindAt ?? null, repeatRule, nextSort);
    const id = Number(info.lastInsertRowid);
    if (b.remindAt) syncTaskReminder(id, title, b.remindAt);
    return getTask(id);
  });

  app.patch('/api/tasks/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const b = taskBody.parse(req.body);
    const cur = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!cur) throw app.httpErrors.notFound();

    const patch: Record<string, unknown> = {
      title: b.title ?? cur.title,
      notes: b.notes ?? cur.notes,
      project_id: b.projectId !== undefined ? b.projectId : cur.project_id,
      status: b.status ?? cur.status,
      priority: b.priority !== undefined ? b.priority : cur.priority,
      due_at: b.dueAt !== undefined ? b.dueAt : cur.due_at,
      planned_date: b.plannedDate !== undefined ? b.plannedDate : cur.planned_date,
      remind_at: b.remindAt !== undefined ? b.remindAt : cur.remind_at,
      repeat_rule: b.repeatRule !== undefined ? b.repeatRule : cur.repeat_rule,
      detail: b.detail !== undefined ? b.detail : cur.detail,
      completed_at: cur.completed_at,
      updated_at: now(),
    };
    if (b.status === 'done' && cur.status !== 'done') patch.completed_at = now();
    if (b.status && b.status !== 'done') patch.completed_at = null;

    db.prepare(`UPDATE tasks SET title=@title, notes=@notes, project_id=@project_id, status=@status,
      priority=@priority, due_at=@due_at, planned_date=@planned_date, remind_at=@remind_at,
      repeat_rule=@repeat_rule, detail=@detail, completed_at=@completed_at, updated_at=@updated_at WHERE id=@id`).run({ ...patch, id });

    // 联动提醒生命周期
    if (b.status === 'done' && cur.status !== 'done') {
      // fired 也要一起失效：任务都做完了，界面上还挂着一条「到点了」是自相矛盾
      db.prepare("UPDATE reminders SET status = 'done' WHERE linked_task_id = ? AND status IN ('pending', 'fired')").run(id);
      createNextRecurringTask(id);
    } else if (b.status && b.status !== 'done' && cur.status === 'done') {
      // 从完成态拉回：若设有提醒时间则重新武装
      if (patch.remind_at) syncTaskReminder(id, patch.title as string, patch.remind_at as string);
    } else if (b.remindAt !== undefined) {
      // 显式设置/清除提醒时间
      syncTaskReminder(id, patch.title as string, b.remindAt as string | null);
    } else if (b.title !== undefined) {
      // 仅改标题：保留提醒，同步文案
      db.prepare('UPDATE reminders SET message = ? WHERE linked_task_id = ? AND status = ?')
        .run(`任务 · ${patch.title}`, id, 'pending');
    }
    return getTask(id);
  });

  // 软删除进回收站；任务附带的联动提醒一并隐藏，恢复时还原
  app.delete('/api/tasks/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    db.transaction(() => {
      db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
      db.prepare('UPDATE reminders SET deleted_at = ? WHERE linked_task_id = ? AND deleted_at IS NULL').run(now(), id);
    })();
    return { ok: true };
  });

  // 今日速览（供首页聚合：今日计划任务 + 已完成数）
  app.get('/api/tasks/today-summary', () => {
    const d = today();
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count
      FROM tasks WHERE planned_date = ? AND deleted_at IS NULL
    `).get(d) as { open_count: number; done_count: number };
    return { date: d, openCount: row.open_count ?? 0, doneCount: row.done_count ?? 0 };
  });
}
