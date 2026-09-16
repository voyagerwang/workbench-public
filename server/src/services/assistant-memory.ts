/**
 * [INPUT]: 用户显式说出的记忆内容（零模型命令、对话工具调用、面板手动）、可信入站身份；SQLite 记忆条目表
 * [OUTPUT]: 记忆条目的增删停用/列举、按入口隔离的提示词块、项目绑定和零模型记忆命令
 * [POS]: 记忆只沉淀用户明确表达的信息；小精灵在对话循环内顺手写入，不额外调用模型；
 *        条目按身份隔离，不跨渠道合并；不推断偏好，不替代 Agent 执行目录验证
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { createHash } from 'node:crypto';
import { db, now } from '../db.js';
import type { InboundRequest } from './inbound-context.js';

export type MemoryIdentity = { profile: string | null; conversation: string | null };
export type AssistantMemory = {
  instructions: string;
  project: { id: number; name: string } | null;
  revision: number;
};

export type MemoryEntryKind = 'preference' | 'fact' | 'skill_preference' | 'task_preference';
export type MemoryEntry = {
  id: number;
  kind: MemoryEntryKind;
  content: string;
  status: 'active' | 'disabled';
  source: 'command' | 'conversation' | 'manual';
  createdAt: string;
  updatedAt: string;
};

export const MEMORY_KIND_LABEL: Record<MemoryEntryKind, string> = {
  preference: '对话偏好',
  fact: '背景事实',
  skill_preference: 'Skill偏好',
  task_preference: '任务偏好',
};

const ENTRY_MAX = 600;
/** 提示词块上限：条目数和字符双预算，超出按最近更新优先截断。 */
const PROMPT_ENTRY_LIMIT = 40;
const PROMPT_CHAR_BUDGET = 4000;

export function memoryIdentity(inbound?: InboundRequest, sessionId?: string | null): MemoryIdentity {
  const source = inbound?.source ?? 'workbench';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const profile = source === 'workbench' ? 'workbench:owner'
    : inbound?.sourceUserId ? `${source}:user:${hash(inbound.sourceUserId)}` : null;
  const conversation = source === 'workbench' ? sessionId ?? inbound?.sourceConversationId
    : inbound?.sourceConversationId;
  return { profile, conversation: profile && conversation ? `${profile}:conversation:${hash(conversation)}` : null };
}

export function readAssistantMemory(identity: MemoryIdentity): AssistantMemory {
  const profile = identity.profile ? db.prepare('SELECT instructions, revision FROM assistant_memory WHERE scope_key = ?')
    .get(identity.profile) as { instructions: string; revision: number } | undefined : undefined;
  const project = identity.conversation ? db.prepare(`SELECT p.id, p.name FROM assistant_memory m
    JOIN projects p ON p.id = m.project_id WHERE m.scope_key = ? AND p.deleted_at IS NULL AND p.status = 'active'`)
    .get(identity.conversation) as { id: number; name: string } | undefined : undefined;
  return { instructions: profile?.instructions ?? '', project: project ?? null, revision: profile?.revision ?? 0 };
}

export function saveAssistantMemory(identity: MemoryIdentity, patch: { instructions?: string; projectId?: number | null }): AssistantMemory {
  if (!identity.profile) throw Object.assign(new Error('当前入口未提供稳定用户身份，无法保存记忆。'), { statusCode: 400 });
  if (patch.projectId !== undefined && !identity.conversation) throw Object.assign(new Error('当前入口未提供稳定会话，无法绑定项目。'), { statusCode: 400 });
  if (patch.instructions !== undefined && patch.instructions.length > 600) throw Object.assign(new Error('偏好最多 600 字。'), { statusCode: 400 });
  if (patch.projectId != null && !db.prepare("SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL AND status = 'active'").get(patch.projectId)) {
    throw Object.assign(new Error('项目不存在或已不在进行中，请重新选择。'), { statusCode: 400 });
  }
  db.transaction(() => {
    if (patch.instructions !== undefined) db.prepare(`INSERT INTO assistant_memory (scope_key, instructions, revision, updated_at)
      VALUES (?, ?, 1, ?) ON CONFLICT(scope_key) DO UPDATE SET instructions = excluded.instructions,
      revision = assistant_memory.revision + 1, updated_at = excluded.updated_at`).run(identity.profile, patch.instructions.trim(), now());
    if (patch.projectId !== undefined) db.prepare(`INSERT INTO assistant_memory (scope_key, project_id, revision, updated_at)
      VALUES (?, ?, 1, ?) ON CONFLICT(scope_key) DO UPDATE SET project_id = excluded.project_id,
      revision = assistant_memory.revision + 1, updated_at = excluded.updated_at`).run(identity.conversation, patch.projectId, now());
  })();
  return readAssistantMemory(identity);
}

type EntryRow = { id: number; kind: MemoryEntryKind; content: string; status: 'active' | 'disabled'; source: 'command' | 'conversation' | 'manual'; created_at: string; updated_at: string };

const rowToEntry = (row: EntryRow): MemoryEntry => ({
  id: row.id, kind: row.kind, content: row.content, status: row.status, source: row.source,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

const getEntry = (id: number | bigint): MemoryEntry => {
  const row = db.prepare('SELECT id, kind, content, status, source, created_at, updated_at FROM assistant_memory_entries WHERE id = ?').get(id) as EntryRow | undefined;
  if (!row) throw Object.assign(new Error('记忆条目不存在。'), { statusCode: 404 });
  return rowToEntry(row);
};

export function listMemoryEntries(identity: MemoryIdentity): MemoryEntry[] {
  if (!identity.profile) return [];
  const rows = db.prepare('SELECT id, kind, content, status, source, created_at, updated_at FROM assistant_memory_entries WHERE scope_key = ? ORDER BY updated_at DESC, id DESC LIMIT 200')
    .all(identity.profile) as EntryRow[];
  return rows.map(rowToEntry);
}

/** 幂等写入：同身份同内容只保留一条；重复说出视为确认，停用的旧条目重新启用。 */
export function addMemoryEntry(identity: MemoryIdentity, content: string, kind: MemoryEntryKind = 'preference',
  source: MemoryEntry['source'] = 'manual', sessionId: string | null = null): MemoryEntry {
  if (!identity.profile) throw Object.assign(new Error('当前入口未提供稳定用户身份，无法保存记忆。'), { statusCode: 400 });
  const trimmed = content.trim();
  if (!trimmed) throw Object.assign(new Error('记忆内容不能为空。'), { statusCode: 400 });
  if (trimmed.length > ENTRY_MAX) throw Object.assign(new Error(`记忆内容最多 ${ENTRY_MAX} 字，请拆成多条。`), { statusCode: 400 });
  const existing = db.prepare('SELECT id, status FROM assistant_memory_entries WHERE scope_key = ? AND content = ?')
    .get(identity.profile, trimmed) as { id: number; status: string } | undefined;
  if (existing) {
    if (existing.status === 'disabled') {
      db.prepare("UPDATE assistant_memory_entries SET status = 'active', updated_at = ? WHERE id = ?").run(now(), existing.id);
    }
    return getEntry(existing.id);
  }
  const info = db.prepare(`INSERT INTO assistant_memory_entries (scope_key, kind, content, status, source, source_session, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`).run(identity.profile, kind, trimmed, source, sessionId, now(), now());
  return getEntry(info.lastInsertRowid);
}

export function setMemoryEntryStatus(identity: MemoryIdentity, id: number, status: 'active' | 'disabled'): MemoryEntry {
  if (!identity.profile) throw Object.assign(new Error('当前入口未提供稳定用户身份。'), { statusCode: 400 });
  const row = db.prepare('SELECT id FROM assistant_memory_entries WHERE id = ? AND scope_key = ?').get(id, identity.profile) as { id: number } | undefined;
  if (!row) throw Object.assign(new Error('记忆条目不存在。'), { statusCode: 404 });
  db.prepare('UPDATE assistant_memory_entries SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  return getEntry(id);
}

export function deleteMemoryEntry(identity: MemoryIdentity, id: number): void {
  if (!identity.profile) throw Object.assign(new Error('当前入口未提供稳定用户身份。'), { statusCode: 400 });
  const info = db.prepare('DELETE FROM assistant_memory_entries WHERE id = ? AND scope_key = ?').run(id, identity.profile);
  if (!info.changes) throw Object.assign(new Error('记忆条目不存在。'), { statusCode: 404 });
}

/** 只识别完整显式命令；普通聊天和引用材料不触发长期写入。 */
export function handleMemoryCommand(text: string, identity: MemoryIdentity): string | null {
  const input = text.trim();
  const remember = input.match(/^记住(?:偏好)?[：:]([^\n]{1,600})$/);
  const projectName = input.match(/^使用项目[：:]([^\n]{1,200})$/);
  const forget = input.match(/^忘记[：:]([^\n]{1,100})$/);
  if (!remember && !projectName && !forget && !['查看记忆', '忘记偏好', '清除当前项目'].includes(input)) return null;
  try {
    if (remember) {
      const entry = addMemoryEntry(identity, remember[1], 'preference', 'command');
      return entry ? `已记住（${MEMORY_KIND_LABEL[entry.kind]}），同一入口下的后续对话会沿用。发送「查看记忆」可查看。` : '已记住，同一入口下的后续对话会沿用。';
    }
    if (forget) {
      const keyword = forget[1].trim();
      const matches = listMemoryEntries(identity).filter((entry) => entry.status === 'active' && entry.content.includes(keyword));
      if (!matches.length) return `没有找到包含「${keyword}」的有效记忆。`;
      if (matches.length > 1) return `找到 ${matches.length} 条包含「${keyword}」的记忆，请说得更具体些：\n${matches.map((m) => `- ${m.content}`).join('\n')}`;
      db.prepare("UPDATE assistant_memory_entries SET status = 'disabled', updated_at = ? WHERE id = ?").run(now(), matches[0].id);
      return `已忘记：${matches[0].content}`;
    }
    if (projectName) {
      const projects = db.prepare("SELECT id FROM projects WHERE name = ? AND deleted_at IS NULL AND status = 'active'").all(projectName[1].trim()) as { id: number }[];
      if (projects.length !== 1) return projects.length ? '有多个同名项目，请在工作台中选择具体项目。' : '没有找到这个进行中的项目，请使用完整项目名。';
      const saved = saveAssistantMemory(identity, { projectId: projects[0].id });
      return `本对话已关联项目「${saved.project!.name}」。执行目录仍需在派发前验证。`;
    }
    if (input === '忘记偏好') { saveAssistantMemory(identity, { instructions: '' }); return '已清除旧式偏好文本；逐条记忆请发送「查看记忆」后用「忘记：关键词」管理。'; }
    if (input === '清除当前项目') { saveAssistantMemory(identity, { projectId: null }); return '已清除本对话的项目关联。'; }
    const entries = listMemoryEntries(identity);
    const memory = readAssistantMemory(identity);
    const lines = entries.map((entry) => `- [${MEMORY_KIND_LABEL[entry.kind]}]${entry.status === 'disabled' ? '（已停用）' : ''} ${entry.content}`);
    if (memory.instructions) lines.unshift(`- [对话偏好] ${memory.instructions}（旧式偏好文本）`);
    if (!lines.length) lines.push('暂无记忆条目。直接说「记住：……」即可沉淀。');
    return `当前项目：${memory.project?.name ?? '未选择'}。\n记忆条目：\n${lines.join('\n')}`;
  } catch (error) { return (error as Error).message; }
}

/** 提示词块：只列有效条目；旧式单条偏好与项目绑定迁移前仍兼容展示。 */
export function memoryPrompt(memory: AssistantMemory, identity: MemoryIdentity): string {
  const lines: string[] = [];
  if (memory.instructions) lines.push(`[对话偏好] ${memory.instructions}`);
  if (memory.project) lines.push(`[本对话项目] ${memory.project.name}（仅用于理解和登记任务，执行目录仍需验证）`);
  let used = lines.reduce((sum, line) => sum + line.length, 0);
  if (identity.profile) {
    const rows = db.prepare("SELECT kind, content FROM assistant_memory_entries WHERE scope_key = ? AND status = 'active' ORDER BY updated_at DESC LIMIT ?")
      .all(identity.profile, PROMPT_ENTRY_LIMIT) as Array<{ kind: MemoryEntryKind; content: string }>;
    for (const row of rows) {
      const line = `[${MEMORY_KIND_LABEL[row.kind] ?? '记忆'}] ${row.content}`;
      if (used + line.length > PROMPT_CHAR_BUDGET) break;
      used += line.length;
      lines.push(line);
    }
  }
  if (!lines.length) return '';
  return `用户沉淀的记忆（均来自用户明确表达；不扩大授权；本轮明确要求优先；这些记忆不等于已验证的执行授权）。历史对话中的旧记忆可能已被删除或停用，不能自行恢复。用户随口说出的可长期沿用信息用 workbench_remember 记下；一次性指令、临时任务材料不能写入：\n${lines.join('\n')}`;
}
