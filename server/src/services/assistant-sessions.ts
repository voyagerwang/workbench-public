/**
 * [INPUT]: 会话消息、服务端写入凭证与任务/动作/派发计划 ID
 * [OUTPUT]: 持久化会话、笔记草稿绑定与可恢复的消息引用
 * [POS]: 会话日志唯一来源；只存任务 ID，状态读取任务台账
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { db, now } from '../db.js';
import { generateConversationTitle } from './conversation-title.js';
import type { CaptureOutcome } from './triage.js';
import { memoryIdentity } from './assistant-memory.js';

/**
 * 助手会话的服务端持久化。
 *
 * 三条规定了这份代码长什么样：
 * 1. **服务端是唯一权威**。前端 localStorage 降级为离线缓存，进入会话时以这里的数据为准覆盖，
 *    否则刷新一次就会留下「凭证明明发生过却没有上下文」的孤儿状态。
 * 2. **只追加，不改写**。消息是日志，不是可编辑文档；改内容只能通过对话让小精灵改工作台里的条目。
 * 3. **凭证与动作 id 跟消息一起存**。凭证是服务端写库的真实结果，动作 id 指向后台仍在推进的状态，
 *    两者都不是模型的话术，也不该随会话重建而丢失。
 */

export type SessionKind = 'global' | 'task' | 'document';

/**
 * 标题归属状态机。
 * auto →（首句话兜底）→ fallback →（模型起名，成功或失败都只试一次）→ named
 * 任意状态被用户改名后直接落到 user，此后系统永不覆盖。
 */
export type TitleState = 'auto' | 'fallback' | 'named' | 'user';

export type AssistantSessionRecord = {
  id: string;
  kind: SessionKind;
  refId: string | null;
  title: string;
  /** 标题归属：auto=默认态可覆盖 / fallback=已用首句话兜底 / named=模型起过名 / user=用户改过，永不覆盖 */
  titleState: TitleState;
  summary: string | null;
  model: string | null;
  messageCount: number;
  actionCount: number;
  pinned: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredMessage = {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  /** 本轮随消息发送的图片（/api/files/xxx 本地地址）；模型调用时转成 data URI 内联。 */
  images?: string[];
  /** 服务端真实落库结果；null = 这一轮没有产生待记内容 */
  receipt: CaptureOutcome | null;
  /** 落库失败的说明。非空 = 确实没记上，前端必须如实提示 */
  receiptError: string | null;
  /** 本轮派出去的外部动作 id；状态不快照，按 id 现拉 */
  actionIds: string[];
  /** 本轮创建的派发计划 id；确认/取消/过期/发送结果都在变，同样只存 id */
  planIds: string[];
  agentTaskIds: string[];
  createdAt: string;
};

/** 标题还是系统自动给的默认态时，才允许被首句话或 AI 覆盖（任务名/文档名一律不动）。 */
const AUTO_TITLES = new Set(['新对话', '未命名对话', '今天']);

const MAX_CONTENT = 20_000;

type SessionRow = {
  id: string; kind: string; ref_id: string | null; title: string; title_state: string;
  summary: string | null;
  model: string | null; message_count: number; action_count: number; pinned: number;
  archived_at: string | null; created_at: string; updated_at: string;
};

const TITLE_STATES: readonly TitleState[] = ['auto', 'fallback', 'named', 'user'];

function titleState(value: string): TitleState {
  return (TITLE_STATES as readonly string[]).includes(value) ? value as TitleState : 'auto';
}

type MessageRow = {
  id: number; session_id: string; role: string; content: string;
  images_json: string | null;
  receipt_json: string | null; receipt_error: string | null;
  action_ids_json: string | null; plan_ids_json: string | null; agent_task_ids_json: string | null;
  created_at: string;
};

function toSession(row: SessionRow): AssistantSessionRecord {
  return {
    id: row.id,
    kind: (row.kind === 'task' || row.kind === 'document' ? row.kind : 'global') as SessionKind,
    refId: row.ref_id,
    title: row.title,
    titleState: titleState(row.title_state),
    summary: row.summary,
    model: row.model,
    messageCount: row.message_count,
    actionCount: row.action_count,
    pinned: row.pinned === 1,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    images: parseJson<string[]>(row.images_json) ?? undefined,
    receipt: parseJson<CaptureOutcome>(row.receipt_json),
    receiptError: row.receipt_error,
    actionIds: parseJson<string[]>(row.action_ids_json) ?? [],
    // 只存计划 id：计划状态一直在变（确认/取消/过期/发送结果），存快照就是存过期数据。
    planIds: parseJson<string[]>(row.plan_ids_json) ?? [],
    agentTaskIds: parseJson<string[]>(row.agent_task_ids_json) ?? [],
    createdAt: row.created_at,
  };
}

/**
 * 会话的计数与更新时间。
 * message_count 每次从明细重算，避免并发追加或异常中断后计数漂移；
 * action_count 只增不减（动作是既成事实，不会因后续编辑而消失），按本轮新增条数累加。
 */
function touchSession(sessionId: string, extraActions = 0): void {
  db.prepare(`
    UPDATE assistant_sessions SET
      message_count = (SELECT COUNT(*) FROM assistant_messages WHERE session_id = @id),
      action_count  = action_count + @extra,
      updated_at    = @ts
    WHERE id = @id
  `).run({ id: sessionId, extra: extraActions, ts: now() });
}

export function getSession(id: string): AssistantSessionRecord | null {
  const row = db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ? toSession(row) : null;
}

export type SessionMeta = {
  kind?: SessionKind;
  refId?: string | null;
  /** 只在新建时生效：已存在的会话标题不动（用户可能改过，AI 也可能起过名） */
  title?: string;
  model?: string | null;
};

export function ensureSession(id: string, meta: SessionMeta = {}): AssistantSessionRecord {
  const existing = getSession(id);
  if (existing) return existing;
  const ts = now();
  const title = meta.title?.trim() || '新对话';
  db.prepare(`
    INSERT INTO assistant_sessions (id, kind, ref_id, title, title_state, summary, model,
      message_count, action_count, pinned, archived_at, created_at, updated_at)
    VALUES (@id, @kind, @refId, @title, @titleState, NULL, @model, 0, 0, 0, NULL, @ts, @ts)
    ON CONFLICT(id) DO NOTHING
  `).run({
    id,
    kind: meta.kind ?? 'global',
    refId: meta.refId ?? null,
    title,
    // 任务名/文档名是用户自己的命名，一进来就是 user，系统从头到尾不动它
    titleState: AUTO_TITLES.has(title) ? 'auto' : 'user',
    model: meta.model ?? null,
    ts,
  });
  return getSession(id)!;
}

/**
 * 追加一条消息。
 * 用户的输入先落库再调模型：模型卡住或进程崩溃时，用户说过的话不该跟着丢。
 */
export function appendMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  extras: {
    receipt?: CaptureOutcome | null;
    receiptError?: string | null;
    actionIds?: string[];
    /** 本轮创建的派发计划 id；刷新后前端按 id 重新拉取实时状态。 */
    planIds?: string[];
    agentTaskIds?: string[];
    /** 本轮随消息发送的图片（/api/files/xxx 本地地址）。 */
    images?: string[];
    meta?: SessionMeta;
  } = {},
): StoredMessage {
  ensureSession(id, extras.meta ?? {});
  const ts = now();
  const actionIds = extras.actionIds ?? [];
  const planIds = extras.planIds ?? [];
  const agentTaskIds = [...new Set(extras.agentTaskIds ?? [])];
  const images = (extras.images ?? []).filter((url) => typeof url === 'string' && url.trim()).slice(0, 9);
  const info = db.prepare(`
    INSERT INTO assistant_messages (session_id, role, content, receipt_json, receipt_error, action_ids_json, plan_ids_json, agent_task_ids_json, images_json, created_at)
    VALUES (@sessionId, @role, @content, @receipt, @receiptError, @actionIds, @planIds, @agentTaskIds, @images, @ts)
  `).run({
    sessionId: id,
    role,
    content: content.slice(0, MAX_CONTENT),
    receipt: extras.receipt ? JSON.stringify(extras.receipt) : null,
    receiptError: extras.receiptError?.trim() || null,
    actionIds: actionIds.length ? JSON.stringify(actionIds) : null,
    planIds: planIds.length ? JSON.stringify(planIds) : null,
    agentTaskIds: agentTaskIds.length ? JSON.stringify(agentTaskIds) : null,
    images: images.length ? JSON.stringify(images) : null,
    ts,
  });
  // 计划还没执行完，动作条数也还不定，所以计数只按已落地的动作累加。
  touchSession(id, actionIds.length);
  return {
    id: Number(info.lastInsertRowid),
    sessionId: id,
    role,
    content: content.slice(0, MAX_CONTENT),
    images: images.length ? images : undefined,
    receipt: extras.receipt ?? null,
    receiptError: extras.receiptError?.trim() || null,
    actionIds,
    planIds,
    agentTaskIds,
    createdAt: ts,
  };
}

/**
 * 首次落库迁移：老会话只存在浏览器 localStorage 里，服务端是空的。
 * 客户端在第一次发送时把缓存的历史带上来补种，避免「升级后第一轮对话失忆」。
 * 只在会话确实为空时生效，已有机记录的一概不动。
 */
export function seedMessages(
  id: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  meta: SessionMeta = {},
): number {
  if (!history.length) return 0;
  const existing = db.prepare('SELECT COUNT(*) AS n FROM assistant_messages WHERE session_id = ?').get(id) as { n: number };
  if (existing.n > 0) return 0;
  const list = history.filter((item) => item?.content?.trim() && (item.role === 'user' || item.role === 'assistant')).slice(-40);
  if (!list.length) return 0;
  ensureSession(id, meta);
  const insert = db.prepare(`
    INSERT INTO assistant_messages (session_id, role, content, receipt_json, receipt_error, action_ids_json, created_at)
    VALUES (?, ?, ?, NULL, NULL, NULL, ?)
  `);
  db.transaction(() => {
    for (const item of list) insert.run(id, item.role, item.content.trim().slice(0, MAX_CONTENT), now());
  })();
  touchSession(id);
  return list.length;
}

export function sessionMessages(id: string, limit = 200): StoredMessage[] {
  const rows = db.prepare(
    'SELECT * FROM (SELECT * FROM assistant_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
  ).all(id, limit) as MessageRow[];
  return rows.map(toMessage);
}

export function readSession(id: string): { session: AssistantSessionRecord; messages: StoredMessage[] } | null {
  const session = getSession(id);
  if (!session) return null;
  return { session, messages: sessionMessages(id) };
}

/** 列表页用：默认不返回已归档的。 */
export function listSessions(limit = 50, includeArchived = false): AssistantSessionRecord[] {
  const rows = db.prepare(
    `SELECT * FROM assistant_sessions ${includeArchived ? '' : 'WHERE archived_at IS NULL '}ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
  ).all(limit) as SessionRow[];
  return rows.map(toSession);
}

export function renameSession(id: string, title: string): AssistantSessionRecord | null {
  const clean = title.trim().slice(0, 60);
  if (!clean) return getSession(id);
  db.prepare("UPDATE assistant_sessions SET title = ?, title_state = 'user', updated_at = ? WHERE id = ?")
    .run(clean, now(), id);
  return getSession(id);
}

/**
 * 重新发送 / 重新生成：把会话退回到「最后一条用户消息之前」，并交出那条文本。
 *
 * 只动日志的尾部，不新开会话——这是聊天产品的通行做法：最后一条重发等于原地重跑，
 * 上下文、标题、凭证都留在同一份会话里。（中间某条重发会把其后的对话一起丢掉，
 * 那是分叉新会话的语义，这里刻意不做。）
 *
 * 返回 null = 这个会话里还没有用户说过话，没有可重跑的轮次。
 */
export function rewindForResend(id: string): { text: string; images?: string[]; removed: number } | null {
  return db.transaction(() => {
    const last = db.prepare(
      "SELECT id, content, images_json FROM assistant_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1",
    ).get(id) as { id: number; content: string; images_json: string | null } | undefined;
    if (!last) return null;
    const info = db.prepare('DELETE FROM assistant_messages WHERE session_id = ? AND id >= ?').run(id, last.id);
    // 主题分界点如果正好落在被删掉的那段里就一并清掉：留着会指向一条不存在的消息，
    // modelSessionMessages 会据此把剩余历史整个过滤掉，等于「重发一次上下文全没了」。
    db.prepare('DELETE FROM assistant_context_segments WHERE session_id = ? AND start_message_id >= ?').run(id, last.id);
    touchSession(id);
    return {
      text: last.content,
      images: parseJson<string[]>(last.images_json) ?? undefined,
      removed: Number(info.changes),
    };
  })();
}

export function deleteSession(id: string): boolean {
  return db.transaction(() => {
    const info = db.prepare('DELETE FROM assistant_sessions WHERE id = ?').run(id);
    const scope = id.startsWith('im:') ? id.slice(3) : memoryIdentity(undefined, id).conversation;
    if (info.changes && scope) db.prepare('DELETE FROM assistant_memory WHERE scope_key = ?').run(scope);
    return info.changes > 0;
  })();
}

export function setArchived(id: string, archived: boolean): AssistantSessionRecord | null {
  db.prepare('UPDATE assistant_sessions SET archived_at = ?, updated_at = ? WHERE id = ?')
    .run(archived ? now() : null, now(), id);
  return getSession(id);
}

/**
 * 标题兜底：拿会话里第一条用户消息当标题。
 * 从库里查而不是用刚追加的那条——老会话补种进来时，开头的话才是这段对话真正的起点。
 */
export function autoTitleFromFirstMessage(id: string): void {
  const session = getSession(id);
  if (session?.titleState !== 'auto') return;
  const first = db.prepare(
    "SELECT content FROM assistant_messages WHERE session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1",
  ).get(id) as { content: string } | undefined;
  const fallback = first?.content.trim().replace(/\s+/g, ' ').slice(0, 24);
  if (!fallback) return;
  db.prepare("UPDATE assistant_sessions SET title = ?, title_state = 'fallback', updated_at = ? WHERE id = ?")
    .run(fallback, now(), id);
}

/**
 * 第一轮对话跑完后让模型重写标题，只试一次。
 *
 * 同步执行：此刻用户刚等完整个模型循环，多一个小请求通常无感；若嫌慢改成 void 调用即可，
 * 客户端下次进入会话会自然拉到新标题。**失败也落到 named**——不能让一次失败变成之后每轮都白等。
 */
export async function refineSessionTitle(id: string): Promise<string | null> {
  const session = getSession(id);
  if (session?.titleState !== 'fallback' || session.messageCount < 2) return null;
  const rows = db.prepare(
    'SELECT role, content FROM assistant_messages WHERE session_id = ? ORDER BY id ASC LIMIT 2',
  ).all(id) as Array<{ role: string; content: string }>;
  const transcript = rows.map((row) => `${row.role === 'user' ? '用户' : '助理'}：${row.content}`).join('\n\n');
  const title = transcript.trim() ? await generateConversationTitle(transcript) : null;
  if (title) {
    db.prepare("UPDATE assistant_sessions SET title = ?, title_state = 'named', updated_at = ? WHERE id = ?")
      .run(title.slice(0, 60), now(), id);
  } else {
    // 兜底标题已经够用，只是不再尝试
    db.prepare("UPDATE assistant_sessions SET title_state = 'named', updated_at = ? WHERE id = ?").run(now(), id);
  }
  return title;
}

/** 笔记落库只绑定引用，保留原会话主键，避免迁移消息/派发/记忆的关联图。 */
export function resolveNoteSession(input: { noteId?: number; draftKey?: string; title?: string }) {
  return db.transaction(() => {
    const refId = input.noteId ? `note:${input.noteId}` : null;
    if (input.noteId && !db.prepare('SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL').get(input.noteId)) {
      throw Object.assign(new Error('笔记不存在或已删除'), { statusCode: 404 });
    }
    const draft = input.draftKey ? getSession(input.draftKey) : null;
    if (draft && (draft.kind !== 'document' || (draft.refId && draft.refId !== refId))) {
      throw Object.assign(new Error('草稿会话已绑定其他文档'), { statusCode: 409 });
    }
    const linked = refId ? db.prepare("SELECT id FROM assistant_sessions WHERE kind = 'document' AND ref_id = ? ORDER BY created_at, id LIMIT 1").get(refId) as { id: string } | undefined : undefined;
    if (linked && draft && linked.id !== draft.id) {
      throw Object.assign(new Error('笔记已有其他会话，请重新打开后继续'), { statusCode: 409 });
    }
    const key = linked?.id ?? draft?.id ?? (input.noteId ? `document:note:${input.noteId}` : input.draftKey);
    if (!key) throw Object.assign(new Error('缺少笔记或草稿身份'), { statusCode: 400 });
    ensureSession(key, { kind: 'document', refId, title: input.title });
    if (refId) db.prepare('UPDATE assistant_sessions SET ref_id = ?, updated_at = ? WHERE id = ?').run(refId, now(), key);
    return getSession(key)!;
  })();
}

/** 模型上下文只读当前主题；换主题不删除原消息、文件或正在执行的任务。 */
export function modelSessionMessages(id: string, limit = 24): StoredMessage[] {
  const segment = db.prepare('SELECT start_message_id FROM assistant_context_segments WHERE session_id = ?').get(id) as { start_message_id: number } | undefined;
  return sessionMessages(id, limit).filter(m => !segment || m.id >= segment.start_message_id);
}
export function startContextSegment(sessionId: string, messageId: number): void {
  if (!db.prepare('SELECT id FROM assistant_messages WHERE session_id = ? AND id = ? AND role = ?').get(sessionId,messageId,'user')) throw new Error('主题起点必须是本会话的用户消息');
  db.prepare('INSERT INTO assistant_context_segments VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET start_message_id=excluded.start_message_id').run(sessionId,messageId);
}
