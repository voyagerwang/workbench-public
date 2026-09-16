/**
 * 助手动作台账 + 飞书派单的「回音」追踪。
 *
 * 要解决的问题：派发成功 ≠ 任务完成。助手把活派进飞书群之后，
 * 旧链路里这条动作就消失了——用户不知道机器人有没有接、有没有做完、做完说了什么。
 *
 * 设计原则（三条，顺序不能颠倒）：
 * 1. **宁可说"没等到"，不可说"已完成"**。状态只由真实抓到的回复推进；
 *    抓不到就是抓不到，超时一律 expired，绝不用"估计做完了"补齐。
 * 2. **原始回复永远随状态一起展示**。就算分类器没认出终态，用户也能自己看到机器人说了什么，
 *    分类错误只是标签不准，不会变成信息黑洞。
 * 3. **关联要能自证**。每条动作记下 correlation（怎么认出这条回复的），
 *    串单时能一眼看出是靠 thread 认的（可靠）还是靠"群里只有这一个待办"猜的（弱）。
 *
 * 关联路径（L1 主、L2 次、L3 备，实测依据见 docs/feishu-correlation-findings.md）：
 * - L1 thread_reply：飞书没有 parent_id，回复挂在「话题」上。拿自己发出的 om_ 消息 ID 直查话题，
 *   逐条比对 sender。一次调用只针对自己那条消息，天然零串单。
 * - L2 mention_match：目标若「不走话题、在群里新发一条并 @ 派发者」，L1 会一直空。
 *   此时靠艾特关系认领：sender 是本动作的目标，且艾特列表里有派发者本人。
 *   艾特点名是明确指向，比 L3 的「猜」可靠得多，所以优先级排在 L3 之前。
 * - L3 unique_pending_actor：目标连 @ 都不带时才用。此时若整个群只有这一个 open 待办，
 *   则派发之后出现的机器人消息可归属给它。
 *   守卫很硬：只认 sender_type 非 user 的消息，且必须晚于派发位置——真人闲聊不会误判成回音。
 *
 * 三条路径共用两条铁律：
 * - **一条回复最多归属一个动作**。同群多个待办竞争同一条消息时，按 L1 > L2 > L3 的可靠度
 *   和创建先后仲裁，绝不进两次 result_text。
 * - **判不准就不认**。「宁可说没等到，不可说已完成」，这条比召回率重要。
 */

import { createHash, randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
import { sendSystemNotification, systemNotifySupported, type SendResult } from './notify.js';
import {
  MESSAGE_TEXT_LIMIT, readChatMessages, readThreadReplies, sanitizeLarkMarkup, sendChatMessage,
  type LarkAttachment, type LarkIdentity, type LarkMessage, type ReadMessagesOptions, type ThreadReplies,
} from './lark-cli.js';

/**
 * 读取出口的测试替身注入点。生产环境恒为 null，一律走真实 lark-cli。
 *
 * 为什么要留这个口子：L1/L2/L3 三条关联路径的差异全在「消息从哪来、带了什么艾特」，
 * 而这些只有真实群才造得出来。没有注入点就只能靠线上碰运气复现串单，
 * 那等于把「一条回复归属两个动作」这种事故留给用户在生产环境发现。
 */
type LarkReadDoubles = {
  readChatMessages?: (chatId: string, options: ReadMessagesOptions) => Promise<LarkMessage[]>;
  readThreadReplies?: (messageId: string, as: LarkIdentity) => Promise<ThreadReplies>;
};

let larkReads: LarkReadDoubles | null = null;

export function setLarkReadDoubles(next: LarkReadDoubles | null): void {
  larkReads = next;
}

/**
 * 系统通知的测试替身注入点。生产环境恒为 null，走真实的 macOS 通知中心。
 *
 * 为什么要留：验收脚本跑在 macOS 上时，`notifyIfNeeded()` 会真的 `execFile('osascript')`——
 * 弹真实系统通知，失败时还在 stderr 刷日志。自动化测试产生外部副作用本身就是缺陷，
 * 更糟的是它会被「断言全过」掩盖：通知报错不影响 result_text，于是报告照样写着「全程无外部副作用」。
 * 装上替身后，测试可以断言通知走了替身、真实 osascript 一次都没跑。
 */
let notifyDouble: ((title: string, text: string) => Promise<SendResult>) | null = null;

export function setNotifyDouble(next: ((title: string, text: string) => Promise<SendResult>) | null): void {
  notifyDouble = next;
}

async function readChat(chatId: string, options: ReadMessagesOptions): Promise<LarkMessage[]> {
  return larkReads?.readChatMessages ? larkReads.readChatMessages(chatId, options) : readChatMessages(chatId, options);
}

async function readThread(messageId: string, as: LarkIdentity): Promise<ThreadReplies> {
  return larkReads?.readThreadReplies ? larkReads.readThreadReplies(messageId, as) : readThreadReplies(messageId, as);
}

/**
 * 多条回复聚合时的正文总预算与硬上限。
 * 单条已经能带到 MESSAGE_TEXT_LIMIT(3000) 字，聚合若还卡在 4000，
 * 两条长回复就会互相挤掉尾巴，所以整体一起放宽。
 */
const REPLIES_BODY_BUDGET = 7000;
const REPLIES_TOTAL_LIMIT = 9000;

export type ActionStatus = 'dispatched' | 'acked' | 'progress' | 'succeeded' | 'failed' | 'expired';

export type CorrelationMethod =
  | 'thread_reply'
  | 'mention_match'
  | 'unique_pending_actor'
  | 'quiescence'
  | 'manual';

export type AssistantAction = {
  id: string;
  kind: string;
  status: ActionStatus;
  summary: string;
  chatId: string | null;
  chatName: string | null;
  outboundMessageId: string | null;
  /** 幂等键：同签名在窗口内只许真正发出一次。 */
  idempotencyKey: string | null;
  targetActorId: string | null;
  targetActorName: string | null;
  correlation: CorrelationMethod | null;
  resultText: string | null;
  lastReplyAt: string | null;
  /** 用户是否已读结果。null = 还没看过（前端该给个未读提示）。 */
  readAt: string | null;
  attempts: number;
  nextPollAt: string | null;
  watchDeadlineAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type ActionRow = {
  id: string;
  kind: string;
  status: string;
  summary: string;
  chat_id: string | null;
  chat_name: string | null;
  outbound_message_id: string | null;
  idempotency_key: string | null;
  outbound_position: number | null;
  self_sender_id: string | null;
  target_actor_id: string | null;
  target_actor_name: string | null;
  correlation: string | null;
  result_text: string | null;
  last_reply_at: string | null;
  notified_at: string | null;
  read_at: string | null;
  attempts: number;
  next_poll_at: string | null;
  watch_deadline_at: string | null;
  seen_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

const OPEN_STATUSES: ActionStatus[] = ['dispatched', 'acked', 'progress'];

/** 派单后最多盯 30 分钟。超期一律 expired，不做"估计完成了"的推断。 */
export const WATCH_WINDOW_MS = 30 * 60_000;
/** 轮询退避阶梯：刚派下时 20s 一次，一直没回音就逐步放宽到 2min，避免空转打频控。 */
export const POLL_BACKOFF_MS = [20_000, 30_000, 45_000, 60_000, 90_000, 120_000] as const;
/** 单群共享池的深度：够覆盖"派单后有机器人连着回几条"的情况，又不至于每次拉满。 */
const CHAT_POOL_LIMIT = 30;
/**
 * 幂等窗口：同一签名（群+身份+被@者+归一化正文）在这么长时间内只许真正发出一次。
 * 挡「模型工具超时后重试」或「用户手动重发」造成的重复消息。窗口过后（比如用户隔天又派同一句）
 * 视为有意为之，放行。
 */
export const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;

/** 与 db.now() 同格式（本地时间、无毫秒）：字符串可直接比大小，也喂得进 Date.parse。 */
export function isoAfter(ms: number): string {
  const d = new Date(Date.now() + ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function toStatus(value: string): ActionStatus {
  return (OPEN_STATUSES as string[]).includes(value) || value === 'succeeded' || value === 'failed' || value === 'expired'
    ? (value as ActionStatus)
    : 'dispatched';
}

function toCorrelation(value: string | null): CorrelationMethod | null {
  return value === 'thread_reply' || value === 'mention_match' || value === 'unique_pending_actor'
    || value === 'quiescence' || value === 'manual'
    ? value
    : null;
}

function parseSeen(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toAction(row: ActionRow): AssistantAction {
  return {
    id: row.id,
    kind: row.kind,
    status: toStatus(row.status),
    summary: row.summary,
    chatId: row.chat_id,
    chatName: row.chat_name,
    outboundMessageId: row.outbound_message_id,
    idempotencyKey: row.idempotency_key,
    targetActorId: row.target_actor_id,
    targetActorName: row.target_actor_name,
    correlation: toCorrelation(row.correlation),
    resultText: row.result_text,
    lastReplyAt: row.last_reply_at,
    readAt: row.read_at,
    attempts: row.attempts,
    nextPollAt: row.next_poll_at,
    watchDeadlineAt: row.watch_deadline_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── 回复文本分类 ────────────────────────────────────────────────────────────
// 只用来决定「标签」，不用来决定「有没有收到」——原始文本一律随状态返回，
// 所以这套正则判错的最坏后果只是标签不准，不会把结果吞掉。

// 「已经 X」是中文里最常见的成品说法，但实现成 /已同步/ 时有一个坑：
// 已经同步 的字符顺序是 已 经 同 步，已同步 在这里不是它的连续子串，
// 所以没加 (?:已经?) 时 "已经同步" 永远命中不了，分类器一直停在 progress。
// 同样的道理覆盖到所有"已完成/已经完成/已搞定/已经搞定/已创建/已经创建"等变体。
const TERMINAL_PATTERNS: RegExp[] = [
  // 状态型：X 已/已经 完成 / 搞定 / 归档 / ...
  /(?:已经?|已)(?:完成|搞定|办好|处理(?:好|完)|做好|归档|入库|就绪|结束|收尾|收工|落定|交付)/,
  // 动作型：X 已/已经 创建 / 同步 / 部署 / 推送 / ...
  /(?:已经?|已)(?:创建|添加|新增|同步|更新|发送|预订|预约|提交|保存|写入|推送|部署|发布|建好|生成|写好|补齐|送到|补全|归档)/,
  // 报告型开头
  /(?:结果如下|以下是结果|搞定[:：]|完成[:：]|已为你|已经帮你|总结[一一下]+|先说结论|直接说结论)/,
  // 对象-动作绑定：日程/任务/会议 + X 已/已经 创建/...
  /(?:会议|日程|任务|提醒|表|文档|聊天|群|学习|工单|订单|工单)[^。\n]{0,8}(?:已经?|已)(?:创建|安排|添加|预约|预订|建好|生成|写好|同步|更新|发布|归档)/,
  // 「截至现在 / 到这会儿 / 完毕 / 收口」等收尾信号
  /(?:截止|到这(?:会儿|一步|里)|到此|目前|现在)[^。\n]{0,12}(?:完成|搞定|好了|就绪|完毕|收口|收工)/,
];

const ACK_PATTERNS: RegExp[] = [
  /^\s*(好的?|收到|明白|了解|ok|okay|roger|收到啦|收到~)[\s!！。.~,，]*(我|马上|这就|正在|先|来)?/i,
  /(正在(处理|查询|执行|安排|创建|生成|同步)|处理中|请稍等|稍等一下|马上就|这就去)/,
];

/**
 * 「还在继续干」的信号。比终态判定优先：
 * 对方一边发进度截图一边说「还在处理」时，不能因为看到了附件就急着判完成。
 */
const CONTINUATION_PATTERNS: RegExp[] = [
  /(?:稍等|等[一下下]|马上|这就|正在|还在|继续|待续|未完|稍后|过会[儿]?|一会[儿]?)[^。\n]{0,10}(?:处理|查询|执行|生成|同步|上传|整理|补充|发|回|给|做|跑|拉)/,
  /(?:处理中|进行中|进度[:：]|先发|先给|先看|第一步|下一步)/,
];

const isTerminal = (text: string, attachments?: LarkAttachment[]): boolean => {
  if (CONTINUATION_PATTERNS.some((p) => p.test(text))) return false;
  if (TERMINAL_PATTERNS.some((p) => p.test(text))) return true;
  // 对方直接甩了文件/图片过来也算交付：只回一个 pdf 报告时正文基本是空的，
  // 不认这个会一直挂在「继续等」，而用户明明已经拿到东西了。
  return (attachments?.length ?? 0) > 0;
};
const isAckOnly = (text: string): boolean => ACK_PATTERNS.some((p) => p.test(text));

// ── 写入 ────────────────────────────────────────────────────────────────────

export type RecordDispatchInput = {
  chatId: string;
  chatName: string;
  outboundMessageId: string;
  summary: string;
  targetActorId?: string | null;
  targetActorName?: string | null;
  /** 幂等键：同一签名在窗口内只允许真正发出一次。 */
  idempotencyKey?: string | null;
  /** 4.1 起：本动作源自哪条真实消息（Item）。历史动作保持 null，沿用自身字段。 */
  dispatchItemId?: string | null;
};

/** 派单成功后立刻记账。此时还没拿到 thread，也还没拿到自己的 sender_id——由首次轮询补齐。 */
export function recordDispatch(input: RecordDispatchInput): AssistantAction {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO assistant_actions (
       id, kind, status, summary, chat_id, chat_name, outbound_message_id, idempotency_key,
       target_actor_id, target_actor_name, dispatch_item_id, next_poll_at, watch_deadline_at,
       seen_json, attempts, created_at, updated_at
     ) VALUES (?, 'feishu_dispatch', 'dispatched', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, ?)`,
  ).run(
    id,
    // 入库前先解析飞书侧 XML（@提及/卡片/附件），否则派单卡里会把
    // 「<at user_id="ou_xxx">7号</at>」这一长串原文展示给用户。
    sanitizeLarkMarkup(input.summary).slice(0, 2000),
    input.chatId,
    input.chatName.slice(0, 200),
    input.outboundMessageId,
    input.idempotencyKey ?? null,
    input.targetActorId ?? null,
    input.targetActorName ?? null,
    input.dispatchItemId ?? null,
    isoAfter(POLL_BACKOFF_MS[0]),
    isoAfter(WATCH_WINDOW_MS),
    ts,
    ts,
  );
  return getAction(id)!;
}

// ── 幂等 ────────────────────────────────────────────────────────────────────

/** 正文归一化：首尾空白、内部连续空白压成单空格。用于幂等签名，避免「多一个空格」就绕过去重。 */
function normalizeDispatchText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** 幂等签名：群 + 发送身份 + 被@者 + 归一化正文。同一句重复派会算出同一个 key。 */
export function computeIdempotencyKey(chatId: string, as: LarkIdentity, mentionNames: string[], text: string): string {
  const raw = `${chatId}|${as}|${mentionNames.join(',')}|${normalizeDispatchText(text)}`;
  return createHash('sha1').update(raw).digest('hex');
}

/**
 * 窗口内是否已有同签名且「确实发出过」的动作。只认 outbound_message_id 非空的——
 * 发出失败了（为空）的才算真正的重试候选，不应该被去重挡掉。
 */
export function findDuplicateDispatch(key: string): AssistantAction | null {
  const row = db.prepare(
    `SELECT * FROM assistant_actions
       WHERE idempotency_key = ?
         AND created_at > ?
         AND outbound_message_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
  ).get(key, isoAfter(-IDEMPOTENCY_WINDOW_MS)) as ActionRow | undefined;
  return row ? toAction(row) : null;
}

/**
 * 用户手动重发护栏：只有确认没发出去（outbound_message_id 为空）才重发；
 * 已经发出过的一律返回 resent:false，绝不二发。调用方据此给用户「已发送，无需重发」的提示。
 */
export async function retryDispatch(id: string): Promise<{ action: AssistantAction; resent: boolean }> {
  const action = getAction(id);
  if (!action) throw new Error('动作不存在');
  // 已经发出过：不允许重复发送，直接把现有结果还给调用方。
  if (action.outboundMessageId) {
    return { action, resent: false };
  }
  if (!action.chatId) throw new Error('该动作缺少群信息，无法重发');
  // 没发出过：用落库的 summary（已是纯文本）重发；有被@者就顺手再@一次。
  const result = await sendChatMessage({
    chatId: action.chatId,
    text: action.summary,
    mentionNames: action.targetActorName ? [action.targetActorName] : [],
    as: 'user',
    format: 'text',
  });
  if (!result.message_id) throw new Error('重发失败：飞书未返回消息 id');
  const key = computeIdempotencyKey(action.chatId, 'user', action.targetActorName ? [action.targetActorName] : [], action.summary);
  db.prepare(
    `UPDATE assistant_actions SET
       outbound_message_id = ?, idempotency_key = ?, status = 'dispatched',
       next_poll_at = ?, watch_deadline_at = ?, attempts = attempts + 1,
       last_error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(result.message_id, key, isoAfter(POLL_BACKOFF_MS[0]), isoAfter(WATCH_WINDOW_MS), now(), id);
  return { action: getAction(id)!, resent: true };
}

type Patch = {
  status?: ActionStatus;
  correlation?: CorrelationMethod | null;
  resultText?: string | null;
  lastReplyAt?: string | null;
  seen?: string[];
  /** 收到新回复后重置退避，让下一步跟得紧一点。 */
  resetBackoff?: boolean;
  lastError?: string | null;
  outboundPosition?: number | null;
  selfSenderId?: string | null;
  /** 同时写 notified_at（防重复通知）；由 notifyIfNeeded 统一调用，别单独传。 */
  notified?: boolean;
};

function patchAction(id: string, patch: Patch): void {
  const attempts = patch.resetBackoff ? 0 : undefined;
  const row = db.prepare('SELECT attempts FROM assistant_actions WHERE id = ?').get(id) as { attempts: number } | undefined;
  const nextAttempts = attempts ?? (row?.attempts ?? 0) + 1;
  const delay = POLL_BACKOFF_MS[Math.min(Math.max(nextAttempts - 1, 0), POLL_BACKOFF_MS.length - 1)]!;
  db.prepare(
    `UPDATE assistant_actions SET
       status            = COALESCE(?, status),
       correlation       = COALESCE(?, correlation),
       result_text       = COALESCE(?, result_text),
       last_reply_at     = COALESCE(?, last_reply_at),
       seen_json         = COALESCE(?, seen_json),
       outbound_position = COALESCE(?, outbound_position),
       self_sender_id    = COALESCE(?, self_sender_id),
       last_error        = ?,
       attempts          = ?,
       next_poll_at      = ?,
       notified_at       = COALESCE(?, notified_at),
       updated_at        = ?
     WHERE id = ?`,
  ).run(
    patch.status ?? null,
    patch.correlation ?? null,
    patch.resultText ?? null,
    patch.lastReplyAt ?? null,
    patch.seen ? JSON.stringify(patch.seen.slice(-200)) : null,
    patch.outboundPosition ?? null,
    patch.selfSenderId ?? null,
    patch.lastError ?? null,
    nextAttempts,
    isoAfter(delay),
    patch.notified ? now() : null,
    now(),
    id,
  );
}

function markError(id: string, message: string): void {
  patchAction(id, { lastError: message.slice(0, 500) });
}

// ── 查询 ────────────────────────────────────────────────────────────────────

export function getAction(id: string): AssistantAction | null {
  const row = db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(id) as ActionRow | undefined;
  return row ? toAction(row) : null;
}

/** 列表页/最近动作：进行中的排前面，其余按时间倒序。 */
export function listActions(limit = 20): AssistantAction[] {
  const rows = db.prepare(
    `SELECT * FROM assistant_actions
      ORDER BY CASE status WHEN 'dispatched' THEN 0 WHEN 'acked' THEN 1 WHEN 'progress' THEN 2 ELSE 3 END,
               created_at DESC
      LIMIT ?`,
  ).all(Math.max(1, Math.min(Math.trunc(limit), 100))) as ActionRow[];
  return rows.map(toAction);
}

/**
 * 回合开始时的水位线，配合 actionsAfter 精确圈定「本轮新建的动作」。
 * 不用时间戳：db.now() 只有秒级精度，同一秒内的两次请求会互相串。rowid 单调递增，没有这个洞。
 */
export function actionWatermark(): number {
  const row = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS marker FROM assistant_actions').get() as { marker: number };
  return row.marker;
}

export function actionsAfter(watermark: number): AssistantAction[] {
  const rows = db.prepare(
    'SELECT * FROM assistant_actions WHERE rowid > ? ORDER BY rowid',
  ).all(watermark) as ActionRow[];
  return rows.map(toAction);
}

/** 人工结案（L4）：机器人回了但分类器没认出来，或者用户自己确认已经做完了。 */
export function resolveAction(
  id: string,
  input: { status: Extract<ActionStatus, 'succeeded' | 'failed'>; note?: string },
): AssistantAction | null {
  if (!getAction(id)) return null;
  const note = input.note?.trim();
  patchAction(id, {
    status: input.status,
    correlation: 'manual',
    resultText: note ? `人工标记（${input.status === 'succeeded' ? '已完成' : '失败'}）：${note}` : null,
    lastError: null,
    resetBackoff: true,
  });
  return getAction(id);
}

// ── 结果触达 ────────────────────────────────────────────────────────────────

/** 通知文案：说清「谁、在哪个群、回了什么」，不暴露内部字段名。 */
function resultHeadline(row: ActionRow): { title: string; body: string } {
  const who = row.target_actor_name || '机器人';
  const where = row.chat_name ? `#${row.chat_name}` : '飞书群';
  const brief = (row.result_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (row.status === 'succeeded') return { title: `${who} 回你了`, body: `${where} · ${brief || '（无正文）'}` };
  if (row.status === 'failed') return { title: `${who} 回了个失败结果`, body: `${where} · ${brief || '（无正文）'}` };
  return { title: `没等到 ${who} 的回复`, body: `${where} · 盯了 30 分钟没结果，可以手动结案` };
}

/**
 * 终态到达时推一次系统通知。
 *
 * notified_at 守卫是必须的：轮询每 30s 跑一遍，没有它同一个结果会一直弹。
 * 非 macOS 上系统通知不可用，此时静默跳过——前端的未读标记仍然兜得住，
 * 所以通知只是加速触达，不是唯一渠道。
 */
export async function notifyIfNeeded(id: string): Promise<void> {
  const row = db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(id) as ActionRow | undefined;
  if (!row) return;
  if (row.notified_at) return;
  if (row.status !== 'succeeded' && row.status !== 'failed' && row.status !== 'expired') return;
  patchAction(id, { notified: true });
  const { title, body } = resultHeadline(row);
  // 替身最优先：测试里必须完全接管，绝不能落到真实的 osascript
  if (notifyDouble) {
    const result = await notifyDouble(title, body);
    if (!result.ok) console.warn('[actions] 结果通知推送失败（替身）:', result.error);
    return;
  }
  if (!systemNotifySupported) return;
  const result = await sendSystemNotification(title, body);
  if (!result.ok) console.warn('[actions] 结果通知推送失败:', result.error);
}

/** 未读的终态动作：前端据此显示未读数与状态点。 */
export function listUnreadActions(): AssistantAction[] {
  const rows = db.prepare(
    `SELECT * FROM assistant_actions
      WHERE read_at IS NULL AND status IN ('succeeded','failed','expired')
      ORDER BY updated_at DESC LIMIT 20`,
  ).all() as ActionRow[];
  return rows.map(toAction);
}

/** 用户看过就标已读，返回实际更新条数。 */
export function markActionsRead(ids: string[]): number {
  if (!ids.length) return 0;
  const ts = now();
  const update = db.prepare('UPDATE assistant_actions SET read_at = ?, updated_at = ? WHERE id = ? AND read_at IS NULL');
  const run = db.transaction((list: string[]) => {
    let changed = 0;
    for (const id of list) changed += update.run(ts, ts, id).changes;
    return changed;
  });
  return run(ids.slice(0, 50));
}

// ── 轮询 ────────────────────────────────────────────────────────────────────

export type PollSummary = {
  scanned: number;
  updated: number;
  errors: string[];
};

/** 撤回的消息不算数：不能拿一条已被撤回的话当执行结果。 */
function isUsable(message: LarkMessage): boolean {
  return !message.deleted && !!message.message_id;
}

/** 判断一条消息是不是「执行者的回音」——优先按 target_actor_id 精确比对。 */
function actorMatches(actorId: string | null, message: LarkMessage): boolean {
  if (!actorId) return false;
  return message.sender_bot_id === actorId || message.sender_id === actorId;
}

/**
 * 这条回复有没有艾特「派发者本人」。
 *
 * L2 的认领凭据：别人艾特我，才是冲着我这条派单来的。艾特了别人、或者压根没艾特，
 * 都不足以证明归属——群里机器人互相艾特是常事，靠这个区分才能真正抗串单。
 *
 * 派发者身份用 self_sender_id（自己发出派单消息时的 sender_id），
 * 与 mentions[].id 同为 `ou_`/`cli_` 结构，可直接比对。
 * 尚无 self_sender_id（首次轮询还没抓到自己的消息）时返回 false，
 * 宁可这一轮认不到，也不能拿空身份去匹配。
 */
function mentionsDispatcher(message: LarkMessage, selfSenderId: string | null): boolean {
  if (!selfSenderId) return false;
  return (message.mentions ?? []).some((mention) => mention.id && mention.id === selfSenderId);
}

/**
 * 时序守卫：这条回复必须发生在派单之后。
 *
 * L1 有话题本身做容器，不需要这条；L2/L3 都在翻群消息池，
 * 池里混着派单之前的历史消息——不校验位置，一句三个月前的「做完了」会被当成今天的结果。
 *
 * 两个位置都必须已知：任一缺失就是「无法证明晚于派单」，宁可漏认也不猜。
 * 目前没有已验证的替代时间凭据，所以位置缺失一律不认领，不退化成按时间估算。
 */
function isAfterOutbound(message: LarkMessage, outboundPosition: number | null): boolean {
  if (outboundPosition === null) return false;
  if (message.message_position === null) return false;
  return message.message_position > outboundPosition;
}

/** LIKE 转义：message_id 形如 `om_xxx`，下划线本就是通配符，不转义会误伤。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * 这条消息是不是已经被别的动作收过了。
 *
 * L3 是「猜」，只有一道跨动作的闸才敢用：别的动作结案后，它的 seen 记录还在，
 * 这边若只看自己的 seen 就会把同一句回复再捡一遍——同一件事在台账里出现两次。
 * seen_json 是字符串数组，按带引号的 ID 做 LIKE 匹配即可，不必解析整列。
 */
function isClaimedElsewhere(messageId: string, excludeActionId: string): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM assistant_actions
       WHERE id != ? AND seen_json IS NOT NULL AND seen_json LIKE ? ESCAPE '\\'`,
  ).get(excludeActionId, `%"${escapeLike(messageId)}"%`) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

/**
 * 是否算「机器人在说话」。self 是我们自己发消息用的那个 ID，必须排除，
 * 否则会把自己的派单消息当成别人的回音。
 */
function isBotVoice(message: LarkMessage, selfSenderId: string | null): boolean {
  // 撤回的消息不算数：不能拿一条已被撤回的话当执行结果。
  if (message.deleted) return false;
  if (!message.sender_id && !message.sender_bot_id) return false;
  if (selfSenderId && (message.sender_id === selfSenderId || message.sender_bot_id === selfSenderId)) return false;
  // 真人闲聊（sender_type=user 且不带 open_bot_id）永远不算机器人回音。
  if (message.sender_type === 'user' && !message.sender_bot_id) return false;
  return message.sender_type !== 'system';
}

/**
 * 拼给人和模型看的回复文本。
 *
 * 附件信息必须一起带上：正文里附件只被压成 `[文件] x.pdf`（见 collapseContent），
 * 不带 file_key 的话模型看到一个文件名却无从下载，等于白看见。
 */
function formatReplies(entries: Array<{ message: LarkMessage }>): string {
  // 正文超长时逐条给正文定预算，附件行不动——它是「怎么下载」的唯一线索，
  // 被整块切掉比正文被切掉更糟，所以附件不占正文的额度。
  // 单条正文已经被 collapseContent 截到 MESSAGE_TEXT_LIMIT，这里不再二次收紧，
  // 只在多条回复同时出现时按条分摊，保证每条都留得下一句完整的话。
  const budget = Math.min(
    MESSAGE_TEXT_LIMIT,
    Math.max(600, Math.floor(REPLIES_BODY_BUDGET / Math.max(1, entries.length))),
  );
  const blocks = entries.map((entry) => {
    const who = entry.message.sender_name || '机器人';
    let body = entry.message.content;
    if (body.length > budget) body = `${body.slice(0, budget)}…（内容过长已截断）`;
    const files = (entry.message.attachments ?? [])
      .map((file) => `\n  ↳ [附件 ${file.type}] ${file.name}（file_key=${file.file_key}，message_id=${entry.message.message_id}）`)
      .join('');
    return `${who}：${body}${files}`;
  });
  return blocks.join('\n').trim().slice(0, REPLIES_TOTAL_LIMIT);
}

/**
 * 进程级轮询互斥锁：把整轮 poll 串成串行，后来者排队，不并发进入。
 *
 * 为什么需要：`claimed` 认领闸只在单次 `pollChatGroup()` 内有效，而 scheduler 的定时轮询
 * 和 HTTP `/api/assistant/actions/poll` 是两个独立入口，能在同一进程里并发跑起来。
 * 两轮各自新建 `claimed`、各自读到同一条消息、各自通过检查 → 同一句「做完了」进两个 Action。
 * 串行之后，第二轮开始时第一轮已经把 seen 落库，`take()` 和 `isClaimedElsewhere` 都能挡住。
 *
 * 这是进程级锁，不是跨进程锁。当前本地单服务部署够用；将来多进程/多实例部署，
 * 必须换成 SQLite 持久化的 claim/lease（与 4.1 幂等锁同一个已知限制）。
 */
let pollChain: Promise<unknown> = Promise.resolve();

function withPollLock<T>(task: () => Promise<T>): Promise<T> {
  // 这里有两道互为冗余的防护，都是为了让「上一轮炸了」不影响下一轮：
  //  - onRejected 同样执行 task：即使前一轮 rejected，这一轮照常开始；
  //  - 链的 catch：让 pollChain 永远 fulfilled，异常不沿链往下传。
  //
  // 实测（verify-dispatch-42 场景 14 的反向验证）：
  //  - 去掉 onRejected（留 catch）→ 安全，catch 兜住；
  //  - 去掉 catch（留 onRejected）→ 安全，onRejected 兜住；
  //  - 两道都去掉 → 一轮的异常会顺着链传给后续每一轮，所有轮询接连 reject，全部报废。
  //
  // 两道都留着是刻意的，成本为零。想删掉任何一道之前，先跑场景 14。
  const result = pollChain.then(task, task);
  pollChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * 按群聚合轮询：同一个群的 N 个待办共享一次群消息读取，
 * 避免「同一群里挂 5 个派单就把这个群读 5 遍」。
 *
 * 对外入口带进程级互斥锁，真正的实现在 `runPollFeishuDispatches()`。
 */
export function pollFeishuDispatches(): Promise<PollSummary> {
  return withPollLock(() => runPollFeishuDispatches());
}

async function runPollFeishuDispatches(): Promise<PollSummary> {
  const cutoff = now();
  const open = db.prepare(
    `SELECT * FROM assistant_actions
      WHERE kind = 'feishu_dispatch' AND status IN ('dispatched','acked','progress')
      ORDER BY created_at`,
  ).all() as ActionRow[];
  const summary: PollSummary = { scanned: open.length, updated: 0, errors: [] };
  if (!open.length) return summary;

  // 超期的先结案：没拿到终态就如实标 expired，不继续空转
  for (const row of open) {
    if (row.watch_deadline_at && row.watch_deadline_at <= cutoff) {
      patchAction(row.id, {
        status: 'expired',
        correlation: row.correlation ? toCorrelation(row.correlation) : null,
        lastError: null,
      });
      summary.updated += 1;
      // 超期也是「有结果要告诉用户」：等了半小时没回音，用户有权知道
      await notifyIfNeeded(row.id);
    }
  }

  const due = open.filter(
    (row) => (!row.watch_deadline_at || row.watch_deadline_at > cutoff) && (!row.next_poll_at || row.next_poll_at <= cutoff),
  );
  if (!due.length) return summary;

  const byChat = new Map<string, ActionRow[]>();
  for (const row of due) {
    // 没有 chat_id 的动作退化成自成一组，不与别人共享读取
    const key = row.chat_id || `#${row.id}`;
    const group = byChat.get(key);
    if (group) group.push(row);
    else byChat.set(key, [row]);
  }

  // L3 唯一性要看「整群有多少个待办」，不是「这次轮到几个」。
  // 只数 due 会漏掉还在退避期的动作：群里其实挂着两个待办，
  // 其中一个歇着，L3 就会误判成「群里只有这一个」而大胆认领——这是串单的根源。
  const openCountByChat = new Map<string, number>();
  for (const row of open) {
    const key = row.chat_id || `#${row.id}`;
    openCountByChat.set(key, (openCountByChat.get(key) ?? 0) + 1);
  }

  for (const [chatId, group] of byChat) {
    try {
      await pollChatGroup(
        chatId.startsWith('#') ? '' : chatId,
        group,
        openCountByChat.get(chatId) ?? group.length,
        summary,
      );
    } catch (error) {
      const message = (error as Error).message.slice(0, 300);
      summary.errors.push(`${group[0]?.chat_name || chatId}：${message}`);
      for (const row of group) markError(row.id, message);
    }
  }
  return summary;
}

async function pollChatGroup(
  chatId: string,
  group: ActionRow[],
  openCountInChat: number,
  summary: PollSummary,
): Promise<void> {
  // 共享池：一次读取供整组动作的 L2/L3 兜底使用（也是 self_sender_id / outbound_position 的来源）
  let pool: LarkMessage[] = [];
  if (chatId) {
    try {
      pool = await readChat(chatId, { limit: CHAT_POOL_LIMIT, order: 'desc', as: 'user' });
    } catch (error) {
      // 群读不到不该拖垮整组：L1 直查话题不依赖这个池，照常跑
      for (const row of group) markError(row.id, `群消息读取失败：${(error as Error).message.slice(0, 200)}`);
    }
  }
  const ordered = [...pool].reverse(); // 翻成正序，按 message_position 推进

  // 每个动作一份运行态，三轮扫描共用
  const runs = group.map((row) => {
    // 首次轮询补齐自身身份：从池里找出自己那条派单消息，记下 sender_id 与位置
    let selfSenderId = row.self_sender_id;
    let outboundPosition = row.outbound_position;
    if (row.outbound_message_id && (!selfSenderId || outboundPosition === null)) {
      const mine = ordered.find((m) => m.message_id === row.outbound_message_id);
      if (mine) {
        selfSenderId ??= mine.sender_id || null;
        outboundPosition ??= mine.message_position;
        patchAction(row.id, { selfSenderId, outboundPosition, resetBackoff: true });
      }
    }
    return {
      row,
      selfSenderId,
      outboundPosition,
      seen: new Set(parseSeen(row.seen_json)),
      fresh: [] as Array<{ message: LarkMessage; method: CorrelationMethod }>,
    };
  });

  /**
   * 本轮已被认领的消息 ID。铁律：一条回复最多归属一个动作。
   * 同群挂多个待办时，同一条回复可能同时满足多个动作的认领条件，
   * 没有这道闸，同一句「做完了」会进两份 result_text，看的人以为干了两遍。
   */
  const claimed = new Set<string>();
  const take = (run: (typeof runs)[number], message: LarkMessage, method: CorrelationMethod): boolean => {
    if (claimed.has(message.message_id) || run.seen.has(message.message_id)) return false;
    claimed.add(message.message_id);
    run.seen.add(message.message_id);
    run.fresh.push({ message, method });
    return true;
  };

  // ── 第一轮 L1：话题直查。按各自派单消息查话题，天然不会串单 ────────────
  for (const run of runs) {
    const { row } = run;
    if (!row.outbound_message_id) continue;
    try {
      const thread = await readThread(row.outbound_message_id, 'user');
      for (const message of thread.messages) {
        if (!isUsable(message)) continue;
        // 话题本身就是强凭据，所以没有 target 时仍可按「是机器人在说话」收下
        if (row.target_actor_id ? !actorMatches(row.target_actor_id, message) : !isBotVoice(message, run.selfSenderId)) continue;
        take(run, message, 'thread_reply');
      }
    } catch (error) {
      markError(row.id, `话题回复读取失败：${(error as Error).message.slice(0, 200)}`);
    }
  }

  // ── 第二轮 L2：艾特派发者。目标不走话题、在群里新发一条并 @ 我 ────────────
  for (const run of runs) {
    if (run.fresh.length || !ordered.length) continue;
    const { row } = run;
    // 顶层消息池不是强容器，没有明确目标就认不了：群里机器人互相说话是常事。
    // 这里不退化成 isBotVoice，宁可漏认也不串单。
    if (!row.target_actor_id) continue;
    for (const message of ordered) {
      if (!isUsable(message) || !actorMatches(row.target_actor_id, message)) continue;
      if (!mentionsDispatcher(message, run.selfSenderId)) continue;
      // 时序守卫：艾特是强指向信号，但群池里混着派单之前的历史消息。
      // 三个月前艾特过我一句「做完了」，不该被当成今天这次派单的结果。
      // 位置任一缺失 = 无法证明晚于派单 → 不认领。
      if (!isAfterOutbound(message, run.outboundPosition)) continue;
      // 纵深防御：本轮 claimed 闸和进程锁都是运行时措施，这里再查一道「别的动作已收过」，
      // 让「一条回复最多归属一个动作」这条铁律不依赖任何单点。
      if (isClaimedElsewhere(message.message_id, row.id)) continue;
      take(run, message, 'mention_match');
    }
  }

  // ── 第三轮 L3：唯一待办兜底。连 @ 都没有时才敢「猜」────────────────────
  for (const run of runs) {
    if (run.fresh.length || !ordered.length) continue;
    const { row } = run;
    // 守卫一：整个群得只有这一个待办，否则无法判断新消息归属谁。
    // 注意看的是 openCountInChat（全部 open），不是本轮 due 的数量——
    // 退避期的动作也是待办，不算进去就会误判成唯一。
    if (openCountInChat !== 1) continue;
    // 守卫二：没有明确目标同样不猜。
    if (!row.target_actor_id) continue;
    // 守卫三：必须已知自己的派单位置。群太吵时那条消息可能已滑出共享池，
    // 位置未知就证明不了「回复晚于派单」，后面所有时序比较都会失效，不如整轮不猜。
    if (run.outboundPosition === null) continue;
    for (const message of ordered) {
      if (!isUsable(message) || !actorMatches(row.target_actor_id, message)) continue;
      // 守卫四（时序）：回复位置也必须已知且严格晚于派单。
      // 以前 `message_position !== null` 才比较，null 会绕过守卫直接进认领——
      // 等于给时序检查开了个后门，历史机器人发言照样能混进来。
      if (!isAfterOutbound(message, run.outboundPosition)) continue;
      // 守卫五：带了艾特却不是艾特我——这条消息另有归属，连猜的资格都没有。
      // 艾特是明确的指向信号，「艾特了别人还认领过来」正是 4.2 要消灭的串单，
      // 所以这里必须比 L2 更硬：L2 要求艾特我，L3 只敢收压根没艾特的。
      if ((message.mentions ?? []).length > 0 && !mentionsDispatcher(message, run.selfSenderId)) continue;
      // 守卫六：别的动作已经收过的消息，哪怕它已结案，也不能被这边再捡走。
      if (isClaimedElsewhere(message.message_id, row.id)) continue;
      take(run, message, 'unique_pending_actor');
    }
  }

  // ── 统一结算 ────────────────────────────────────────────────────────────
  for (const run of runs) {
    const { row, fresh } = run;
    if (!fresh.length) {
      patchAction(row.id, { seen: [...run.seen], lastError: null });
      continue;
    }

    const terminal = fresh.find((entry) => isTerminal(entry.message.content, entry.message.attachments));
    const status: ActionStatus = terminal
      ? 'succeeded'
      : row.status === 'dispatched'
        ? (isAckOnly(fresh[fresh.length - 1]!.message.content) ? 'acked' : 'progress')
        : 'progress';

    patchAction(row.id, {
      status,
      correlation: terminal?.method ?? fresh[fresh.length - 1]!.method,
      resultText: formatReplies(fresh),
      lastReplyAt: now(),
      // take() 认领时已经同步写进 run.seen，这里整份回写即可
      seen: [...run.seen],
      resetBackoff: true,
      lastError: null,
    });
    summary.updated += 1;
    await notifyIfNeeded(row.id);
  }
}
