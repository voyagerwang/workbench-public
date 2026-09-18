import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const dir = mkdtempSync(`${tmpdir()}/workbench-assistant-p0p1-`);
process.env.DATA_DIR = dir;
const { executeAssistantTool } = await import('./src/services/assistant-tools.ts');
const { db } = await import('./src/db.ts');

try {
  const project = await executeAssistantTool('workbench_create_project', { name: 'P0P1 验证项目', domain: 'work' }) as { id: number };
  assert.ok(project.id);
  const task = await executeAssistantTool('workbench_create_task', {
    title: '验证结构化清单', projectId: project.id, detail: '1. 项目\n2. 详情', plannedDate: '2026-09-18',
  }) as { id: number; project_id: number; detail: string };
  assert.equal(task.project_id, project.id);
  assert.equal(task.detail, '1. 项目\n2. 详情');
  const updated = await executeAssistantTool('workbench_update_task', { id: task.id, status: 'done', detail: '已验收' }) as { status: string; detail: string };
  assert.equal(updated.status, 'done');
  assert.equal(updated.detail, '已验收');

  const noteInfo = db.prepare('INSERT INTO notes (id, title, content, tags) VALUES (sync_id(), ?, ?, ?)').run('验证笔记', '正文', '[]');
  const noteId = Number(noteInfo.lastInsertRowid);
  const note = await executeAssistantTool('workbench_update_note', { id: noteId, content: '新正文', tags: ['测试'], pinned: true }) as { content: string; pinned: number; tags: string[] };
  assert.equal(note.content, '新正文');
  assert.equal(note.pinned, 1);
  assert.deepEqual(note.tags, ['测试']);

  const reminderInfo = db.prepare("INSERT INTO reminders (id, message, trigger_at, channel) VALUES (sync_id(), '原提醒', '2026-09-18T10:00', 'auto')").run();
  const reminderId = Number(reminderInfo.lastInsertRowid);
  const reminder = await executeAssistantTool('workbench_update_reminder', { id: reminderId, message: '新提醒', status: 'done' }) as { message: string; status: string };
  assert.equal(reminder.message, '新提醒');
  assert.equal(reminder.status, 'done');

  await executeAssistantTool('workbench_delete_task', { id: task.id });
  const trash = await executeAssistantTool('workbench_list_trash', {}) as { items: Array<{ kind: string; id: number }> };
  assert.ok(trash.items.some((item) => item.kind === 'tasks' && item.id === task.id));
  await executeAssistantTool('workbench_restore_trash', { kind: 'tasks', id: task.id });
  assert.equal((db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(task.id) as { deleted_at: string | null }).deleted_at, null);
  console.log('PASS assistant P0/P1 tools');
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
