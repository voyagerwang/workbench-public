// 任务 ↔ 提醒的联动：一条提醒要么独立存在，要么挂在某个清单项上（reminders.linked_task_id）。
// 分诊与改分类都靠这个「同一行提醒换归属」的机制来避免重复创建，并从任务完成时自动失效。
import { db, now } from '../db.js';
import { type ReminderChannel } from './notify.js';

export const taskReminderMessage = (title: string) => `任务 · ${title}`;

export type { ReminderChannel };

import { reminderChannelSchema } from './reminder-channels.js';

/**
 * 新建提醒：显式选择规范化保存，未指定保存 auto，在触发时跟随默认设置。
 * 四个创建入口（提醒页 / 助手 MCP / 分诊 / 任务联动）都必须走这里，否则设置项只在页面生效。
 */
export function resolveReminderChannel(explicit?: string | null): ReminderChannel {
  if (explicit == null) return 'auto';
  return reminderChannelSchema.parse(explicit);
}

/** 设 remindAt 则 upsert 联动提醒；设 null/undefined 则清除未触发的联动提醒 */
export function syncTaskReminder(taskId: number, title: string, remindAt: string | null | undefined, channel?: string | null): void {
  if (remindAt === null || remindAt === undefined) {
    db.prepare("DELETE FROM reminders WHERE linked_task_id = ? AND status != 'done'").run(taskId);
    return;
  }
  const existing = db.prepare(
    'SELECT id FROM reminders WHERE linked_task_id = ? ORDER BY id DESC LIMIT 1',
  ).get(taskId) as { id: number } | undefined;
  const message = taskReminderMessage(title);
  if (existing) {
    db.prepare("UPDATE reminders SET message = ?, trigger_at = ?, status = 'pending', fired_at = NULL, deleted_at = NULL WHERE id = ?")
      .run(message, remindAt, existing.id);
  } else {
    db.prepare('INSERT INTO reminders (id, message, trigger_at, repeat_rule, channel, status, linked_task_id) VALUES (sync_id(), ?, ?, ?, ?, ?, ?)')
      .run(message, remindAt, 'none', resolveReminderChannel(channel), 'pending', taskId);
  }
}

/** 清单项进回收站：连带它挂着的、还没确认完成的提醒一起进（keepId 用于改分类时保住的提醒） */
export function softDeleteTaskTree(taskId: number, keepReminderId?: number): void {
  const ts = now();
  db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, taskId);
  db.prepare(
    `UPDATE reminders SET deleted_at = ? WHERE linked_task_id = ? AND deleted_at IS NULL AND status != 'done'
     AND (? = -1 OR id != ?)`,
  ).run(ts, taskId, keepReminderId ?? -1, keepReminderId ?? -1);
}

/** 把挂在任务上的提醒解绑成独立提醒（清单项 → 提醒 时复用同一行，不新建） */
export function detachReminder(reminderId: number): void {
  db.prepare('UPDATE reminders SET linked_task_id = NULL WHERE id = ?').run(reminderId);
}

/** 把一条独立提醒挂到清单项上（提醒 → 清单 时复用同一行） */
export function attachReminder(reminderId: number, taskId: number, title: string): void {
  db.prepare('UPDATE reminders SET linked_task_id = ?, message = ?, status = ?, fired_at = NULL, deleted_at = NULL WHERE id = ?')
    .run(taskId, taskReminderMessage(title), 'pending', reminderId);
}

/** 任务当前挂着的未处理提醒（pending/fired，未删） */
export function taskOpenReminder(taskId: number): { id: number; trigger_at: string } | undefined {
  return db.prepare(
    "SELECT id, trigger_at FROM reminders WHERE linked_task_id = ? AND deleted_at IS NULL AND status != 'done' ORDER BY id DESC LIMIT 1",
  ).get(taskId) as { id: number; trigger_at: string } | undefined;
}
