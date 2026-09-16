/**
 * 4.1 原子派发计划：模型只提交一次完整意图，服务端冻结后决定直发或等待确认。
 *
 * 为什么需要它：旧链路里模型可以一轮并行调 N 次 feishu_chat_send，每次只知道一个群，
 * 服务端无法在单个工具 case 内识别「同轮跨群」，批量派发完全没有确认边界。
 * 新链路把「收集 → 归并 → 冻结 → 竞争 → 发送」全部收到服务端：
 *
 *   模型 ──feishu_dispatch(items[])──> 请求级收集器 ──循环结束封板──> DispatchPlan
 *                                                                    │
 *                                需要确认 ──确认卡──> confirm CAS ──┤
 *                                不需要确认 ───────────────────────┤
 *                                                                    ▼
 *                                                          Item 认领 CAS → 发送
 *
 * 四条硬约束（改这个文件前先读一遍）：
 * 1. 收集器绑定「单次请求」，用 AsyncLocalStorage 而不是进程级 Map——
 *    并发请求不能串数据，请求异常退出也不能留残留缓冲。
 * 2. CAS 与网络请求严格分离：先用单条条件 UPDATE 抢状态，只有 changes=1 的请求获得执行权，
 *    拿到执行权之后才发网络请求。绝不在 SQLite 事务里等飞书。
 * 3. 确认接口只接收 Plan ID，正文/群/目标/身份一律读冻结数据，客户端传什么都不认。
 * 4. 发送结果未知（超时、连接重置）时不得盲目重发，重试点必须先按幂等窗口核验。
 */

import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db, now } from '../db.js';
import {
  deleteChatMessage, getChatById, listChatMembers, resolveChatByName, sanitizeLarkMarkup, sendChatMessage,
  type LarkIdentity, type SendMessageResult,
} from './lark-cli.js';
import {
  IDEMPOTENCY_WINDOW_MS, POLL_BACKOFF_MS, WATCH_WINDOW_MS, computeIdempotencyKey,
  getAction, isoAfter, recordDispatch, type AssistantAction,
} from './assistant-actions.js';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 待确认计划的有效期。过期后确认一律拒绝，零发送。 */
export const CONFIRM_WINDOW_MS = 15 * 60_000;

/**
 * last_error 前缀：标记「这次失败时不知道消息到底发出去没有」。
 * 重试路径看到它必须先核验再决定，不能直接重发——否则超时重试会造成群里出现两条一样的消息。
 */
const UNKNOWN_RESULT_PREFIX = '[unknown-result] ';

const MAX_ITEMS_PER_PLAN = 20;
const MAX_TARGETS_PER_ITEM = 20;

// ── 对外类型 ────────────────────────────────────────────────────────────────

export type DispatchPlanStatus =
  | 'pending_confirmation' | 'dispatching' | 'dispatched'
  | 'partial_failed' | 'failed' | 'cancelled' | 'expired';

export type DispatchItemStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'recalling' | 'recalled';

export type DispatchConfirmationReason = 'multiple_items' | 'multiple_targets' | 'multiple_chats';

export type DispatchTargetView = {
  id: string;
  actorId: string;
  actorName: string;
  expectsReply: boolean;
  /** 期待回复的目标在发送成功后挂一个 child action；没发或没期待回复时为 null。 */
  action: AssistantAction | null;
};

export type DispatchItemView = {
  id: string;
  itemOrder: number;
  status: DispatchItemStatus;
  chatId: string;
  chatName: string | null;
  body: string;
  format: 'text' | 'markdown';
  senderIdentity: 'user' | 'bot';
  outboundMessageId: string | null;
  sentAt: string | null;
  recalledAt: string | null;
  attempts: number;
  lastError: string | null;
  targets: DispatchTargetView[];
};

export type DispatchPlanView = {
  id: string;
  status: DispatchPlanStatus;
  confirmationRequired: boolean;
  confirmationReasons: string[];
  itemCount: number;
  targetCount: number;
  chatCount: number;
  expiresAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  items: DispatchItemView[];
};

// ── 模型输入与解析后的内部形态 ──────────────────────────────────────────────

export type DispatchTargetInput = {
  name: string;
  expectsReply?: boolean;
};

export type DispatchItemInput = {
  chatId?: string;
  chatName?: string;
  text: string;
  format?: 'text' | 'markdown';
  as?: 'user' | 'bot';
  targets?: DispatchTargetInput[];
};

type ResolvedTarget = {
  /** 稳定身份键。名字会变、会重名，绝不能拿名字做关联键。 */
  targetKey: string;
  actorId: string;
  actorName: string;
  expectsReply: boolean;
};

type ResolvedItem = {
  chatId: string;
  chatName: string;
  /** 用户正文原文（保留换行，Markdown 依赖它）。发送时由 sendChatMessage 拼 @ 前缀。 */
  body: string;
  format: 'text' | 'markdown';
  senderIdentity: 'user' | 'bot';
  targets: ResolvedTarget[];
};

// ── 测试替身 ────────────────────────────────────────────────────────────────
// 验收矩阵要求「禁止真实发飞书」，所以群解析、成员解析、发送三处都必须可替换。
// 生产环境三项全为 null，走真实 lark-cli。

export type ChatResolver = (input: { chatId?: string; chatName?: string }) => Promise<{ chatId: string; name: string }>;
export type MemberResolver = (chatId: string) => Promise<Array<{ memberId: string; name: string; kind: 'user' | 'bot' }>>;
export type SendDouble = (input: {
  chatId: string;
  text: string;
  mentionNames: string[];
  as: LarkIdentity;
  format: 'text' | 'markdown';
}) => Promise<{ messageId: string | null; mentioned: Array<{ name: string; memberId: string }> }>;
export type RecallDouble = (input: { messageId: string; as: LarkIdentity }) => Promise<void>;

export type DispatchDoubles = {
  resolveChat?: ChatResolver;
  listMembers?: MemberResolver;
  send?: SendDouble;
  /** 撤回替身。失败时抛异常即可，调用方按「未知结果」规则判定是否回退。 */
  recall?: RecallDouble;
};

let doubles: DispatchDoubles | null = null;

/** 装上替身（测试用）。传 null 立即恢复生产行为。 */
export function setDispatchDoubles(next: DispatchDoubles | null): void {
  doubles = next;
}

// ── 请求级收集器 ────────────────────────────────────────────────────────────

type CollectorState = {
  sessionId: string | null;
  sourceMessageId: number | null;
  items: ResolvedItem[];
  /** 收集阶段的单条失败不影响整轮：记下来回给模型，让它自己决定补发还是放弃。 */
  errors: string[];
};

const collectorStorage = new AsyncLocalStorage<CollectorState>();

export type DispatchRequestContext = {
  /** 有 sessionKey 时写入，刷新后确认卡能随会话历史恢复；一次性调用为 null。 */
  sessionId: string | null;
  /** 触发本次派发的用户消息 id；无会话时为 null。 */
  sourceMessageId: number | null;
};

/**
 * 在单次请求的异步上下文里跑模型循环。
 * 用 AsyncLocalStorage 而不是「按 session key 存 Map」：后者在并发请求下会串数据，
 * 且请求中途抛错时缓冲没有清空的时机，会一直留到下次同 session 调用。
 */
export async function runWithDispatchCollector<T>(ctx: DispatchRequestContext, fn: () => Promise<T>): Promise<T> {
  return collectorStorage.run({ sessionId: ctx.sessionId, sourceMessageId: ctx.sourceMessageId, items: [], errors: [] }, fn);
}

function requireCollector(): CollectorState {
  const state = collectorStorage.getStore();
  if (!state) throw new Error('派发收集器不在请求上下文中：feishu_dispatch 只能在助手请求内调用');
  return state;
}

/** 工具层用它判断当前是否处于可派发的请求上下文，避免在非助手链路里静默丢消息。 */
export function hasDispatchCollector(): boolean {
  return !!collectorStorage.getStore();
}

/** 工具层读取当前请求的会话 key（Skill 确认凭证的会话绑定用它）；不在请求内返回 null。 */
export function currentDispatchSessionId(): string | null {
  return collectorStorage.getStore()?.sessionId ?? null;
}

// ── 解析：群 / 成员 ─────────────────────────────────────────────────────────

async function resolveChat(input: { chatId?: string; chatName?: string }): Promise<{ chatId: string; name: string }> {
  if (doubles?.resolveChat) return doubles.resolveChat(input);
  const chatId = input.chatId?.trim() ?? '';
  if (chatId) {
    // 只给了 chat_id 时反查群名，别把 oc_ 开头的 id 当群名到处展示
    const name = input.chatName?.trim() || (await getChatById(chatId))?.name || chatId;
    return { chatId, name };
  }
  const chatName = input.chatName?.trim() ?? '';
  if (!chatName) throw new Error('必须提供 chatName 或 chatId');
  const chat = await resolveChatByName(chatName);
  if (!chat.chat_id) throw new Error(`群“${chatName}”没有返回有效的 chat_id`);
  return { chatId: chat.chat_id, name: chat.name };
}

async function resolveTargets(chatId: string, input: DispatchTargetInput[]): Promise<ResolvedTarget[]> {
  const wanted = input
    .map((target) => ({ name: typeof target?.name === 'string' ? target.name.trim() : '', expectsReply: target?.expectsReply !== false }))
    .filter((target) => target.name)
    .slice(0, MAX_TARGETS_PER_ITEM);
  if (!wanted.length) return [];

  const members = doubles?.listMembers
    ? await doubles.listMembers(chatId)
    : (await listChatMembers(chatId, 'user')).map((member) => ({ memberId: member.member_id, name: member.name, kind: member.kind }));

  const resolved: ResolvedTarget[] = [];
  for (const target of wanted) {
    const matches = members.filter((member) => member.name.trim().toLocaleLowerCase() === target.name.toLocaleLowerCase());
    if (!matches.length) {
      const pool = members.slice(0, 30).map((member) => member.name).filter(Boolean).join('、');
      throw new Error(`群里没有名为“${target.name}”的成员。可用成员：${pool || '（读取为空）'}`);
    }
    // 同名优先取机器人：艾特机器人派活是主场景。
    const hit = matches.find((member) => member.kind === 'bot') ?? matches[0]!;
    const existing = resolved.find((item) => item.targetKey === hit.memberId);
    if (existing) {
      // 同一条消息里重复艾特同一个人：只要有一次说要回复，就按要回复算，宁可多盯一个。
      existing.expectsReply = existing.expectsReply || target.expectsReply;
      continue;
    }
    resolved.push({ targetKey: hit.memberId, actorId: hit.memberId, actorName: hit.name, expectsReply: target.expectsReply });
  }
  return resolved;
}

// ── 规范化 / 归并 / 冻结 ────────────────────────────────────────────────────

/** 归并键用的正文归一化：连续空白压成单空格，避免「多一个空格」就绕过去重。 */
function normalizeForMerge(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** 归并键：同群 + 同正文 + 同格式 + 同发送身份。四项全一致目标才能合到一条消息里。 */
function mergeKey(item: Omit<ResolvedItem, 'targets'>): string {
  return `${item.chatId}\u0000${item.senderIdentity}\u0000${item.format}\u0000${normalizeForMerge(item.body)}`;
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

type FrozenItem = {
  chatId: string;
  chatName: string;
  body: string;
  format: 'text' | 'markdown';
  senderIdentity: 'user' | 'bot';
  targets: Array<{ actorId: string; actorName: string; expectsReply: boolean }>;
};

function toFrozen(item: ResolvedItem): FrozenItem {
  return {
    chatId: item.chatId,
    chatName: item.chatName,
    body: item.body,
    format: item.format,
    senderIdentity: item.senderIdentity,
    targets: item.targets.map((target) => ({ actorId: target.actorId, actorName: target.actorName, expectsReply: target.expectsReply })),
  };
}

function itemPayloadHash(frozen: FrozenItem): string {
  return sha1(JSON.stringify(frozen));
}

/**
 * 幂等键：跨 Plan 稳定，绝不能包含 Plan ID——否则「用户取消后重新派同一句」会被误判成新请求，
 * 而「重试生成了新 Plan」反而会被去重挡掉。
 */
function itemIdempotencyKey(item: ResolvedItem): string {
  const keys = item.targets.map((target) => target.targetKey);
  return sha1(`${item.chatId}\u0000${item.senderIdentity}\u0000${item.format}\u0000${keys.join(',')}\u0000${normalizeForMerge(item.body)}`);
}

/**
 * 与旧链路（assistant_actions）同源的签名。
 * 4.1 双轨期间旧表里还躺着已发消息，不查它就会在切换窗口内重复发一次。
 */
function legacyIdempotencyKey(item: ResolvedItem): string {
  return computeIdempotencyKey(item.chatId, item.senderIdentity, item.targets.map((target) => target.actorName), normalizeForMerge(item.body));
}

/** 收集阶段入口：模型每调一次 feishu_dispatch 走一次，同轮可调用 1..N 次。 */
export async function collectDispatch(items: DispatchItemInput[]): Promise<{ queued: number; errors: string[] }> {
  const state = requireCollector();
  if (!Array.isArray(items) || !items.length) throw new Error('items 不能为空');
  const list = items.slice(0, MAX_ITEMS_PER_PLAN);
  let queued = 0;

  for (const raw of list) {
    const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
    if (!text) {
      state.errors.push('有一条派发缺少正文，已跳过');
      continue;
    }
    if (text.length > 20_000) {
      state.errors.push('有一条派发正文超过 20000 字，已跳过');
      continue;
    }
    try {
      const chat = await resolveChat({ chatId: typeof raw.chatId === 'string' ? raw.chatId : undefined, chatName: typeof raw.chatName === 'string' ? raw.chatName : undefined });
      const targets = await resolveTargets(chat.chatId, Array.isArray(raw.targets) ? raw.targets : []);
      state.items.push({
        chatId: chat.chatId,
        chatName: chat.name,
        body: text,
        format: raw.format === 'markdown' ? 'markdown' : 'text',
        senderIdentity: raw.as === 'bot' ? 'bot' : 'user',
        targets,
      });
      queued += 1;
    } catch (error) {
      // 单条解析失败不掀桌：模型还能看到错误并决定是改名重派还是放弃。
      state.errors.push((error as Error).message);
    }
  }
  return { queued, errors: [...state.errors] };
}

/** 同轮多次调用后统一归并：跨群、正文不同、格式不同、身份不同都各占一条 Item。 */
function mergeItems(items: ResolvedItem[]): ResolvedItem[] {
  const merged: ResolvedItem[] = [];
  const index = new Map<string, number>();
  for (const item of items) {
    const key = mergeKey(item);
    const slot = index.get(key);
    if (slot === undefined) {
      index.set(key, merged.length);
      merged.push({ ...item, targets: [...item.targets] });
      continue;
    }
    const target = merged[slot]!;
    for (const incoming of item.targets) {
      const existing = target.targets.find((t) => t.targetKey === incoming.targetKey);
      if (existing) existing.expectsReply = existing.expectsReply || incoming.expectsReply;
      else target.targets.push({ ...incoming }); // 目标顺序按首次出现冻结
    }
  }
  return merged;
}

// ── 建计划（事务内冻结） ────────────────────────────────────────────────────

type PlanRow = {
  id: string;
  session_id: string | null;
  source_message_id: number | null;
  status: string;
  confirmation_required: number;
  confirmation_reasons_json: string;
  item_count: number;
  target_count: number;
  chat_count: number;
  frozen_payload_json: string;
  payload_hash: string;
  expires_at: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type ItemRow = {
  id: string;
  plan_id: string;
  item_order: number;
  status: string;
  chat_id: string;
  chat_name: string | null;
  body: string;
  format: string;
  sender_identity: string;
  frozen_payload_json: string;
  payload_hash: string;
  idempotency_key: string;
  outbound_message_id: string | null;
  sent_at: string | null;
  recalled_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type TargetRow = {
  id: string;
  dispatch_item_id: string;
  target_key: string;
  actor_id: string;
  actor_name: string;
  expects_reply: number;
  mention_order: number;
};

function createPlan(items: ResolvedItem[], ctx: DispatchRequestContext): string {
  const id = randomUUID();
  const ts = now();

  const itemCount = items.length;
  const targetCount = new Set(items.flatMap((item) => item.targets.map((target) => target.targetKey))).size;
  const chatCount = new Set(items.map((item) => item.chatId)).size;

  const reasons: DispatchConfirmationReason[] = [];
  if (itemCount > 1) reasons.push('multiple_items');
  if (targetCount > 1) reasons.push('multiple_targets');
  if (chatCount > 1) reasons.push('multiple_chats');
  const confirmationRequired = reasons.length > 0;

  const frozen = { items: items.map(toFrozen) };
  const payloadHash = sha1(JSON.stringify(frozen));
  const expiresAt = confirmationRequired ? isoAfter(CONFIRM_WINDOW_MS) : null;
  // 无需确认的 Plan 直接落到 dispatching，执行阶段认领 Item 时再逐条 CAS。
  const status: DispatchPlanStatus = confirmationRequired ? 'pending_confirmation' : 'dispatching';

  db.transaction(() => {
    db.prepare(`
      INSERT INTO assistant_dispatch_plans (
        id, session_id, source_message_id, status, confirmation_required, confirmation_reasons_json,
        item_count, target_count, chat_count, frozen_payload_json, payload_hash,
        expires_at, confirmed_at, cancelled_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      ctx.sessionId,
      ctx.sourceMessageId,
      status,
      confirmationRequired ? 1 : 0,
      JSON.stringify(reasons),
      itemCount,
      targetCount,
      chatCount,
      JSON.stringify(frozen),
      payloadHash,
      expiresAt,
      confirmationRequired ? null : ts,
      null,
      ts,
      ts,
    );

    const insertItem = db.prepare(`
      INSERT INTO assistant_dispatch_items (
        id, plan_id, item_order, status, chat_id, chat_name, body, format, sender_identity,
        frozen_payload_json, payload_hash, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTarget = db.prepare(`
      INSERT INTO assistant_dispatch_targets (
        id, dispatch_item_id, target_key, actor_id, actor_name, expects_reply, mention_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    items.forEach((item, order) => {
      const frozenItem = toFrozen(item);
      const itemId = randomUUID();
      insertItem.run(
        itemId, id, order,
        item.chatId, item.chatName, item.body, item.format, item.senderIdentity,
        JSON.stringify(frozenItem), itemPayloadHash(frozenItem), itemIdempotencyKey(item),
        ts, ts,
      );
      item.targets.forEach((target, mentionOrder) => {
        insertTarget.run(randomUUID(), itemId, target.targetKey, target.actorId, target.actorName, target.expectsReply ? 1 : 0, mentionOrder, ts, ts);
      });
    });
  })();

  return id;
}

/**
 * 模型循环结束后封板：归并 → 风险判定 → 事务冻结 → 无需确认则立即执行。
 * 返回本轮生成的计划（没有派发时为空数组）。
 */
export async function sealDispatchCollector(): Promise<DispatchPlanView[]> {
  const state = collectorStorage.getStore();
  if (!state || !state.items.length) return [];
  // 立刻清空：封板只允许发生一次，后续的兜底重试路径不能再建第二个 Plan。
  const items = mergeItems(state.items);
  state.items = [];

  const planId = createPlan(items, { sessionId: state.sessionId, sourceMessageId: state.sourceMessageId });
  const plan = getPlan(planId);
  if (plan && plan.status === 'dispatching') await executePlan(planId);
  return [getPlan(planId)].filter((item): item is DispatchPlanView => !!item);
}

// ── 读取 ────────────────────────────────────────────────────────────────────

function toStatus(value: string): DispatchPlanStatus {
  return value === 'pending_confirmation' || value === 'dispatching' || value === 'dispatched'
    || value === 'partial_failed' || value === 'failed' || value === 'cancelled' || value === 'expired'
    ? value : 'failed';
}

function toItemStatus(value: string): DispatchItemStatus {
  return value === 'pending' || value === 'sending' || value === 'sent'
    || value === 'failed' || value === 'recalling' || value === 'recalled'
    ? value : 'pending';
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export function getPlan(id: string): DispatchPlanView | null {
  const row = db.prepare('SELECT * FROM assistant_dispatch_plans WHERE id = ?').get(id) as PlanRow | undefined;
  if (!row) return null;
  const items = db.prepare('SELECT * FROM assistant_dispatch_items WHERE plan_id = ? ORDER BY item_order ASC').all(id) as ItemRow[];
  const targetRows = items.length
    ? db.prepare(
      `SELECT * FROM assistant_dispatch_targets WHERE dispatch_item_id IN (${items.map(() => '?').join(',')}) ORDER BY mention_order ASC`,
    ).all(...items.map((item) => item.id)) as TargetRow[]
    : [];
  const actionsByItem = loadChildActions(items.map((item) => item.id));

  return {
    id: row.id,
    status: toStatus(row.status),
    confirmationRequired: row.confirmation_required === 1,
    confirmationReasons: parseJson<string[]>(row.confirmation_reasons_json, []),
    itemCount: row.item_count,
    targetCount: row.target_count,
    chatCount: row.chat_count,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map((item) => ({
      id: item.id,
      itemOrder: item.item_order,
      status: toItemStatus(item.status),
      chatId: item.chat_id,
      chatName: item.chat_name,
      body: item.body,
      format: item.format === 'markdown' ? 'markdown' : 'text',
      senderIdentity: item.sender_identity === 'bot' ? 'bot' : 'user',
      outboundMessageId: item.outbound_message_id,
      sentAt: item.sent_at,
      recalledAt: item.recalled_at,
      attempts: item.attempts,
      lastError: item.last_error,
      targets: targetRows
        .filter((target) => target.dispatch_item_id === item.id)
        .map((target) => ({
          id: target.id,
          actorId: target.actor_id,
          actorName: target.actor_name,
          expectsReply: target.expects_reply === 1,
          action: actionsByItem.get(`${item.id}\u0000${target.actor_id}`) ?? null,
        })),
    })),
  };
}

/** child action 按 (item, actor) 索引：一个 Item 多目标时各自独立推进，不共用状态。 */
function loadChildActions(itemIds: string[]): Map<string, AssistantAction> {
  const out = new Map<string, AssistantAction>();
  if (!itemIds.length) return out;
  const rows = db.prepare(
    `SELECT id, dispatch_item_id, target_actor_id FROM assistant_actions
       WHERE dispatch_item_id IN (${itemIds.map(() => '?').join(',')})`,
  ).all(...itemIds) as Array<{ id: string; dispatch_item_id: string; target_actor_id: string | null }>;
  for (const row of rows) {
    const action = getAction(row.id);
    if (action) out.set(`${row.dispatch_item_id}\u0000${row.target_actor_id ?? ''}`, action);
  }
  return out;
}

// ── CAS：确认 / 取消 / 过期 ─────────────────────────────────────────────────

/** 把已过期但还挂在 pending_confirmation 的计划收口。确认/取消前先跑一次，保证状态新鲜。 */
export function expirePlans(planId?: string): number {
  const ts = now();
  if (planId) {
    return db.prepare(
      `UPDATE assistant_dispatch_plans SET status = 'expired', updated_at = ?
         WHERE id = ? AND status = 'pending_confirmation' AND expires_at IS NOT NULL AND expires_at <= ?`,
    ).run(ts, planId, ts).changes;
  }
  return db.prepare(
    `UPDATE assistant_dispatch_plans SET status = 'expired', updated_at = ?
       WHERE status = 'pending_confirmation' AND expires_at IS NOT NULL AND expires_at <= ?`,
  ).run(ts, ts).changes;
}

/**
 * 确认发送。CAS 成功者独占执行权，重复确认只返回当前计划，绝不二发。
 * 只接受 plan id——客户端传来的正文/群/目标/身份一概不读。
 */
export async function confirmPlan(id: string): Promise<DispatchPlanView> {
  expirePlans(id);
  const ts = now();
  const claimed = db.prepare(
    `UPDATE assistant_dispatch_plans SET status = 'dispatching', confirmed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending_confirmation' AND expires_at > ?`,
  ).run(ts, ts, id, ts);

  const plan = getPlan(id);
  if (!plan) throw new Error('派发计划不存在');

  if (claimed.changes !== 1) {
    // 抢不到就说明别人已经处理了（或已过期/已取消），直接把现状还给前端，不重复发送。
    if (plan.status === 'expired') throw new Error('确认已过期，这份计划没有发送。请重新发起派发。');
    if (plan.status === 'cancelled') throw new Error('这份计划已取消，没有发送。');
    return plan;
  }
  await executePlan(id);
  return getPlan(id) ?? plan;
}

export function cancelPlan(id: string): DispatchPlanView {
  expirePlans(id);
  const ts = now();
  const claimed = db.prepare(
    `UPDATE assistant_dispatch_plans SET status = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending_confirmation'`,
  ).run(ts, ts, id);

  const plan = getPlan(id);
  if (!plan) throw new Error('派发计划不存在');
  if (claimed.changes !== 1) {
    // 已取消/已过期视为幂等成功：用户点了两次取消不该报错。
    if (plan.status === 'cancelled' || plan.status === 'expired') return plan;
    throw new Error('这份计划已经开始发送，无法取消。');
  }
  return plan;
}

// ── 执行 ────────────────────────────────────────────────────────────────────

/** 幂等核验：窗口内是否已有「确实发出过」的同签名消息。Item 表和旧 action 表都要查。 */
function findAlreadySent(item: ResolvedItem): { messageId: string; sentAt: string | null } | null {
  const key = itemIdempotencyKey(item);
  const row = db.prepare(`
    SELECT outbound_message_id, sent_at FROM assistant_dispatch_items
      WHERE idempotency_key = ? AND created_at > ? AND outbound_message_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
  `).get(key, isoAfter(-IDEMPOTENCY_WINDOW_MS)) as { outbound_message_id: string; sent_at: string | null } | undefined;
  if (row?.outbound_message_id) return { messageId: row.outbound_message_id, sentAt: row.sent_at };

  // 旧链路（4.1 之前直接 feishu_chat_send 落下的动作）用的是名字签名，窗口内同样算重复。
  const legacy = db.prepare(`
    SELECT outbound_message_id, created_at FROM assistant_actions
      WHERE idempotency_key = ? AND created_at > ? AND outbound_message_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
  `).get(legacyIdempotencyKey(item), isoAfter(-IDEMPOTENCY_WINDOW_MS)) as { outbound_message_id: string; created_at: string } | undefined;
  return legacy?.outbound_message_id ? { messageId: legacy.outbound_message_id, sentAt: legacy.created_at } : null;
}

/** 发送失败时判断「到底发出去没有」。判不了的一律按未知处理，重试前必须核验。 */
function isUnknownResult(error: unknown): boolean {
  const message = (error as Error)?.message ?? String(error);
  return /timed?\s*out|timeout|ETIMEDOUT|ECONNRESET|ECONNABORTED|socket hang up|network|ENOTFOUND|EAI_AGAIN/i.test(message);
}

async function callSend(item: ResolvedItem): Promise<SendMessageResult> {
  const mentionNames = item.targets.map((target) => target.actorName);
  if (doubles?.send) {
    const result = await doubles.send({ chatId: item.chatId, text: item.body, mentionNames, as: item.senderIdentity, format: item.format });
    return {
      ok: true,
      message_id: result.messageId,
      identity: item.senderIdentity,
      mentioned: result.mentioned.map((member) => ({ name: member.name, member_id: member.memberId })),
      body: mentionNames.length ? `${mentionNames.map((name) => `@${name}`).join(' ')} ${item.body}` : item.body,
      dry_run: false,
    };
  }
  return sendChatMessage({ chatId: item.chatId, text: item.body, mentionNames, as: item.senderIdentity, format: item.format });
}

/** 从冻结的 Item 行重建发送所需形态——执行阶段绝不重新解析模型给的参数。 */
function itemFromRow(row: ItemRow): ResolvedItem {
  const frozen = parseJson<FrozenItem>(row.frozen_payload_json, {
    chatId: row.chat_id, chatName: row.chat_name ?? row.chat_id, body: row.body,
    format: row.format === 'markdown' ? 'markdown' : 'text',
    senderIdentity: row.sender_identity === 'bot' ? 'bot' : 'user',
    targets: [],
  });
  return {
    chatId: frozen.chatId,
    chatName: frozen.chatName,
    body: frozen.body,
    format: frozen.format,
    senderIdentity: frozen.senderIdentity,
    targets: frozen.targets.map((target) => ({
      targetKey: target.actorId, actorId: target.actorId, actorName: target.actorName, expectsReply: target.expectsReply,
    })),
  };
}

function loadItem(id: string): ItemRow | null {
  return (db.prepare('SELECT * FROM assistant_dispatch_items WHERE id = ?').get(id) as ItemRow | undefined) ?? null;
}

/** 认领 CAS：只有 pending/failed 能抢到 sending，抢不到说明别人正在发或已经发出。 */
function claimItem(id: string): boolean {
  const ts = now();
  return db.prepare(
    `UPDATE assistant_dispatch_items SET status = 'sending', attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'failed')`,
  ).run(ts, id).changes === 1;
}

function markItemSent(id: string, messageId: string, sentAt: string): void {
  db.prepare(
    `UPDATE assistant_dispatch_items SET status = 'sent', outbound_message_id = ?, sent_at = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`,
  ).run(messageId, sentAt, now(), id);
}

function markItemFailed(id: string, error: string, unknown: boolean): void {
  db.prepare(
    `UPDATE assistant_dispatch_items SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(unknown ? `${UNKNOWN_RESULT_PREFIX}${error}` : error, now(), id);
}

/** 同一进程内把同签名的查重与发送串行化，避免不同 Plan 并发穿过查重窗口。 */
const idempotencyLocks = new Map<string, Promise<void>>();

async function withIdempotencyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = idempotencyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  idempotencyLocks.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (idempotencyLocks.get(key) === current) idempotencyLocks.delete(key);
  }
}

/** 发送成功后为 expects_reply=1 的目标各建一个 child action；每个 (item, actor) 最多一个。 */
function createChildActions(row: ItemRow, item: ResolvedItem, messageId: string, summary: string): void {
  const ts = now();
  const exists = db.prepare('SELECT 1 FROM assistant_actions WHERE dispatch_item_id = ? AND target_actor_id = ?');
  const insert = db.prepare(`
    INSERT INTO assistant_actions (
      id, kind, status, summary, chat_id, chat_name, outbound_message_id, idempotency_key,
      target_actor_id, target_actor_name, dispatch_item_id, next_poll_at, watch_deadline_at,
      seen_json, attempts, created_at, updated_at
    ) VALUES (?, 'feishu_dispatch', 'dispatched', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, '[]', 0, ?, ?)
  `);
  for (const target of item.targets) {
    if (!target.expectsReply) continue;
    if (exists.get(row.id, target.actorId)) continue;
    insert.run(
      randomUUID(),
      sanitizeLarkMarkup(summary).slice(0, 2000),
      item.chatId,
      item.chatName,
      messageId,
      target.actorId,
      target.actorName,
      row.id,
      isoAfter(POLL_BACKOFF_MS[0]),
      isoAfter(WATCH_WINDOW_MS),
      ts,
      ts,
    );
  }
}

/** 单条 Item 的完整发送流程：认领 → 幂等核验 → 发送 → 记账。全程不发事务包网络请求。 */
async function sendItem(itemId: string): Promise<void> {
  if (!claimItem(itemId)) return; // 已被并发请求接管，或已经发出去了
  const row = loadItem(itemId);
  if (!row) return;
  const item = itemFromRow(row);

  await withIdempotencyLock(itemIdempotencyKey(item), async () => {
    // 幂等核验放在认领之后、发送之前：命中就沿用已发的消息 id，绝不再发第二条。
    const already = findAlreadySent(item);
    if (already) {
      markItemSent(itemId, already.messageId, already.sentAt ?? now());
      createChildActions(row, item, already.messageId, item.body);
      return;
    }

    try {
      const result = await callSend(item);
      if (!result.message_id) throw new Error('飞书未返回消息 id，发送结果未知');
      const sentAt = now();
      markItemSent(itemId, result.message_id, sentAt);
      createChildActions(row, item, result.message_id, result.body || item.body);
    } catch (error) {
      const message = (error as Error).message || '发送失败';
      markItemFailed(itemId, message, isUnknownResult(error));
    }
  });
}

/** 顺序发送：一条一条来，失败不影响后续，也不回滚已经发出去的。 */
export async function executePlan(planId: string): Promise<void> {
  const rows = db.prepare('SELECT id FROM assistant_dispatch_items WHERE plan_id = ? ORDER BY item_order ASC').all(planId) as Array<{ id: string }>;
  for (const row of rows) await sendItem(row.id);
  aggregatePlan(planId);
}

/**
 * 按 Item 现状聚合 Plan 终态。
 * 部分失败不回滚：有成功也有失败就是 partial_failed，全失败才是 failed。
 */
function aggregatePlan(planId: string): void {
  const rows = db.prepare('SELECT status FROM assistant_dispatch_items WHERE plan_id = ?').all(planId) as Array<{ status: string }>;
  if (!rows.length) return;
  const total = rows.length;
  const settled = rows.filter((row) => row.status === 'sent' || row.status === 'recalled' || row.status === 'failed').length;
  // 还有 sending/pending 的说明执行没跑完，别急着定终态。
  if (settled !== total) return;
  const sent = rows.filter((row) => row.status === 'sent' || row.status === 'recalled').length;
  const status: DispatchPlanStatus = sent === total ? 'dispatched' : sent === 0 ? 'failed' : 'partial_failed';
  // 守卫只放行「还在推进中」的状态：
  // 失败项重试成功时，计划要从 partial_failed/failed 重新聚合回 dispatched；
  // 而 cancelled/expired 是终态，任何重新聚合都不许把它们改写回已发送。
  db.prepare(
    `UPDATE assistant_dispatch_plans SET status = ?, updated_at = ?
       WHERE id = ? AND status IN ('dispatching', 'partial_failed', 'failed')`,
  ).run(status, now(), planId);
}

/**
 * 用户明确重试单个失败项。只认当前仍为 failed 的 Item，绝不整批重放——
 * 整批重放会把已经发成功的那些再发一遍。
 */
export async function retryItem(itemId: string): Promise<DispatchPlanView> {
  const row = loadItem(itemId);
  if (!row) throw new Error('派发条目不存在');
  if (row.status !== 'failed') throw new Error('只有发送失败的条目可以重试');

  // 上次是「结果未知」的失败：先在幂等窗口里找证据，找到就认领成已发，绝不重发。
  if ((row.last_error ?? '').startsWith(UNKNOWN_RESULT_PREFIX)) {
    const already = findAlreadySent(itemFromRow(row));
    if (already) {
      markItemSent(itemId, already.messageId, already.sentAt ?? now());
      createChildActions(row, itemFromRow(row), already.messageId, row.body);
      aggregatePlan(row.plan_id);
      return getPlan(row.plan_id)!;
    }
    // 找不到证据才允许真重发，把未知标记清掉，避免下一次重试又走一遍核验。
    db.prepare('UPDATE assistant_dispatch_items SET last_error = ?, updated_at = ? WHERE id = ?')
      .run(row.last_error!.slice(UNKNOWN_RESULT_PREFIX.length), now(), itemId);
  }

  await sendItem(itemId);
  aggregatePlan(row.plan_id);
  return getPlan(row.plan_id)!;
}

export function planIdForItem(itemId: string): string | null {
  return loadItem(itemId)?.plan_id ?? null;
}

// ── 撤回 ────────────────────────────────────────────────────────────────────
// 撤回只推进「投递状态」，绝不碰「任务执行状态」：
// assistant_actions 一行都不改。消息撤了不等于活儿没干，界面必须同时展示两者，
// 不能把「消息已撤回」渲染成「任务已取消」或「任务已完成」。

/** 飞书只允许撤回 5 分钟内的消息。服务端也拦一道，别让用户点了个必然失败的操作。 */
export const RECALL_WINDOW_MS = 5 * 60_000;

/**
 * 允许的系统时钟抖动容差。客户端/服务端时钟可能略有偏差，边界处给 60s 缓冲，
 * 避免本应可撤的消息被误杀；超过容差的「未来时间」则视为异常、拒绝撤回。
 */
export const RECALL_CLOCK_DRIFT_TOLERANCE_MS = 60_000;

/** 撤回认领 CAS：只有 sent 能进 recalling。已 recalled 或正在 recalling 的都抢不到，天然幂等。 */
function claimRecall(id: string): boolean {
  return db.prepare(
    `UPDATE assistant_dispatch_items SET status = 'recalling', last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'sent'`,
  ).run(now(), id).changes === 1;
}

/** 撤回成功。outbound_message_id 与 sent_at 永久保留——它们是投递事实，不是状态标记。 */
function markItemRecalled(id: string): void {
  const ts = now();
  db.prepare(
    `UPDATE assistant_dispatch_items SET status = 'recalled', recalled_at = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`,
  ).run(ts, ts, id);
}

/**
 * 撤回失败：回退到 sent，保留 outbound_message_id 与 sent_at，只记 last_error。
 * 消息多半还在群里，把它标成 recalled 就是撒谎——用户会以为对方看不见了。
 */
function revertRecall(id: string, error: string, unknown: boolean): void {
  db.prepare(
    `UPDATE assistant_dispatch_items SET status = 'sent', last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(unknown ? `${UNKNOWN_RESULT_PREFIX}${error}` : error, now(), id);
}

/**
 * 按 Item 冻结的发送身份调删除。身份错了撤不掉——
 * 用 bot 去撤 user 发的消息，在 bot 不是管理员的群里必然失败。
 */
async function callRecall(row: ItemRow): Promise<void> {
  const messageId = row.outbound_message_id;
  if (!messageId) throw new Error('缺少消息 ID，无法撤回');
  const as: LarkIdentity = row.sender_identity === 'bot' ? 'bot' : 'user';
  if (doubles?.recall) {
    await doubles.recall({ messageId, as });
    return;
  }
  await deleteChatMessage({ messageId, as });
}

/**
 * 撤回一条已发送的 Item。
 *
 * 三条边界：
 * - 已撤回 / 正在撤回：直接返回当前计划，不重复调飞书（重复点击不能撤两次）。
 * - 未发送 / 发送中 / 发送失败：明确拒绝，没有消息可撤。
 * - 超过 5 分钟窗口：服务端拒绝。飞书那边也撤不掉，与其让按钮假装能点，不如早说。
 */
export async function recallItem(itemId: string): Promise<DispatchPlanView> {
  const row = loadItem(itemId);
  if (!row) throw new Error('派发条目不存在');

  if (row.status === 'recalled' || row.status === 'recalling') {
    return getPlan(row.plan_id)!; // 幂等：重复点击返回现状，不再动飞书
  }
  if (row.status !== 'sent') {
    throw new Error('只有已发送的条目可以撤回');
  }

  // 时间门禁必须 fail-closed：飞书侧可撤与否未知时，高危险写宁可拒绝。
  // 缺失 / 不可解析 / 明显晚于当前时间（超时钟容差）都直接拒绝；
  // 只有「合法、是过去的、且落在 5 分钟窗口内」的时间才放行。
  const sentMs = row.sent_at ? Date.parse(row.sent_at) : NaN;
  if (!Number.isFinite(sentMs)) {
    throw new Error('派发时间缺失或无法识别，无法确认是否仍在撤回窗口内');
  }
  if (sentMs > Date.now() + RECALL_CLOCK_DRIFT_TOLERANCE_MS) {
    throw new Error('派发时间异常（晚于当前时间），拒绝撤回以免误撤');
  }
  if (Date.now() - sentMs > RECALL_WINDOW_MS) {
    throw new Error('已超过 5 分钟，飞书不允许撤回这条消息');
  }

  // 抢不到说明并发请求已经接管了这次撤回，返回现状即可。
  if (!claimRecall(itemId)) return getPlan(row.plan_id)!;

  try {
    await callRecall(row);
    markItemRecalled(itemId);
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    // 超时/网络错误时撤回结果未知：消息可能已经撤了，也可能没有。
    // 记成 unknown 让上层可以核验后重试，但不自动重试——那是用户该决定的事。
    revertRecall(itemId, message, isUnknownResult(error));
    throw error;
  }

  aggregatePlan(row.plan_id);
  return getPlan(row.plan_id)!;
}
