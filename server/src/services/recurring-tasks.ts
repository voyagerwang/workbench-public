import { db, newId } from '../db.js';
import { syncTaskReminder } from './reminders.js';
import { nextRecurringDate, type RepeatRule } from './recurrence.js';

type RecurringTask = {
  id: number;
  title: string;
  notes: string;
  project_id: number | null;
  priority: number;
  due_at: string | null;
  planned_date: string | null;
  remind_at: string | null;
  repeat_rule: RepeatRule;
  detail: string;
};

function shiftIsoDate(iso: string | null, fromDate: string, toDate: string): string | null {
  if (!iso) return null;
  const time = iso.slice(10);
  return `${toDate}${time}`;
}

/** 完成周期任务后，生成下一期未完成任务；当前任务仍保留为完成记录。 */
export function createNextRecurringTask(id: number): number | null {
  const task = db.prepare(`
    SELECT id, title, notes, project_id, priority, due_at, planned_date, remind_at, repeat_rule, detail
    FROM tasks WHERE id = ? AND deleted_at IS NULL
  `).get(id) as RecurringTask | undefined;
  if (!task || task.repeat_rule === 'none' || !task.planned_date) return null;

  const plannedDate = nextRecurringDate(task.planned_date, task.repeat_rule);
  if (!plannedDate) return null;
  const dueAt = shiftIsoDate(task.due_at, task.planned_date, plannedDate);
  const remindAt = shiftIsoDate(task.remind_at, task.planned_date, plannedDate);
  const nextSort = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS v FROM tasks').get() as { v: number }).v + 1;
  const nextId = Number(db.prepare(`
    INSERT INTO tasks (id, title, notes, project_id, status, priority, due_at, planned_date, remind_at, repeat_rule, detail, sort_order)
    VALUES (sync_id(), ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.title,
    task.notes,
    task.project_id,
    task.priority,
    dueAt,
    plannedDate,
    remindAt,
    task.repeat_rule,
    task.detail,
    nextSort,
  ).lastInsertRowid);
  if (remindAt) {
    syncTaskReminder(nextId, task.title, remindAt);
    // 周期任务的提醒也归入同一系列：把上一期的 series_id 传下去（老数据没有就现场补）
    const prev = db.prepare(
      'SELECT series_id FROM reminders WHERE linked_task_id = ? AND series_id IS NOT NULL ORDER BY id DESC LIMIT 1',
    ).get(id) as { series_id: string | null } | undefined;
    const seriesId = prev?.series_id ?? String(newId());
    db.prepare('UPDATE reminders SET series_id = ? WHERE linked_task_id = ? AND series_id IS NULL').run(seriesId, nextId);
    if (!prev) db.prepare('UPDATE reminders SET series_id = ? WHERE linked_task_id = ? AND series_id IS NULL').run(seriesId, id);
  }
  return nextId;
}
