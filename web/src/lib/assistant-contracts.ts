/**
 * [INPUT]: 工作台捕获结果、通用条目类型与助手 REST 契约
 * [OUTPUT]: 助手对话、派发、会话及消息类型
 * [POS]: 从共享类型抽出的助手契约，types.ts 保持兼容导出
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { CaptureResult, FragmentType } from '../types';
// ---------- 助手 AI 对话 ----------
export type AssistantMessage = { role: 'user' | 'assistant'; content: string; images?: string[] };

export type AssistantContext = {
  kind: 'global' | 'task' | 'document';
  taskId?: number;
  /** 文档场景引用笔记，身份不依赖标题。 */
  noteId?: number;
  title?: string;
  content?: string;
  knowledgeArchiveIds?: number[] | 'all';
  /** 资料场景的稳定资料引用（source_key），重发时服务端据此恢复正文。 */
  knowledgeSourceKey?: string;
  /** 本轮手动挂载的本机 Skill id，服务端会读出 SKILL.md 正文拼进提示词。 */
  skillIds?: string[];
};

export type RepeatRule = 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | `ndays:${number}`;

export type AssistantDraft = {
  type: FragmentType;
  content: string;
  plannedDate: string | null;
  remindAt: string | null;
  repeatRule: RepeatRule;
  reason: string | null;
  /** 随手记标签：助手只在用户明确指定时带上，AI 猜的不写 */
  tags?: string[];
};


/** 派出去的外部动作状态。dispatched 之后由后台轮询推进，超期一律 expired（不冒充完成）。 */
export type AssistantActionStatus = 'dispatched' | 'acked' | 'progress' | 'succeeded' | 'failed' | 'expired';

/** 系统怎么认出这条回复的——串单时靠它判断可信度。必须与服务端 assistant-actions.ts 保持一致。 */
export type CorrelationMethod = 'thread_reply' | 'mention_match' | 'unique_pending_actor' | 'quiescence' | 'manual';

export type AssistantAction = {
  id: string;
  kind: string;
  status: AssistantActionStatus;
  summary: string;
  chatId: string | null;
  chatName: string | null;
  outboundMessageId: string | null;
  /** 新派发链路中所属的真实消息；历史 action 为 null。 */
  dispatchItemId?: string | null;
  idempotencyKey?: string | null;
  targetActorId: string | null;
  targetActorName: string | null;
  correlation: CorrelationMethod | null;
  /** 抓到的原始回复。就算分类器没认出终态，用户也能自己看到机器人说了什么。 */
  resultText: string | null;
  lastReplyAt: string | null;
  /** 用户是否已读结果。null = 还没看过，前端该给未读提示。 */
  readAt: string | null;
  attempts: number;
  nextPollAt: string | null;
  watchDeadlineAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AssistantDispatchPlanStatus =
  | 'pending_confirmation'
  | 'dispatching'
  | 'dispatched'
  | 'partial_failed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type AssistantDispatchItemStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'recalling' | 'recalled';

export type AssistantDispatchTarget = {
  id: string;
  actorId: string;
  actorName: string;
  expectsReply: boolean;
  action: AssistantAction | null;
};

/** 一条真实飞书消息。多个目标可以共享同一条消息，但各自拥有 child action。 */
export type AssistantDispatchItem = {
  id: string;
  itemOrder: number;
  status: AssistantDispatchItemStatus;
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
  targets: AssistantDispatchTarget[];
};

/** 一次不可变的派发意图。动态状态每次从服务端读取，不写进消息快照。 */
export type AssistantDispatchPlan = {
  id: string;
  status: AssistantDispatchPlanStatus;
  confirmationRequired: boolean;
  confirmationReasons: Array<'multiple_items' | 'multiple_targets' | 'multiple_chats' | string>;
  itemCount: number;
  targetCount: number;
  chatCount: number;
  expiresAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  items: AssistantDispatchItem[];
};

/**
 * 一次对话轮的落库凭证。由服务端直接写入后返回，前端据此渲染凭证卡——
 * 不依赖模型话术，避免"模型说记下了但其实没记"这种最糟的失败。
 */
export type AssistantReply = {
  reply: string;
  /** 服务端已落库的结果；null 表示本轮没有新条目 */
  captured: CaptureResult | null;
  /** 落库失败说明；非空 = 确实没记上，前端必须如实提示，不能装作成功 */
  captureError: string | null;
  /** 归一化后的草稿（与 captured.items 一一对应），诊断用 */
  drafts: AssistantDraft[];
  /** 本轮派出去的外部动作（飞书派单）。后台持续跟踪，前端只展示不推断。 */
  actions: AssistantAction[];
  /** 本轮创建的原子派发计划；批量计划可能正等待用户确认。 */
  plans: AssistantDispatchPlan[];
  agentTasks: import('./assistant-runtime').AgentTask[];
  /** 服务端会话快照（没传 sessionKey 时为 null） */
  session: AssistantSessionRecord | null;
  /** 本轮真正写进库里的两条消息（用户 + 助手）。前端把它们追加到本地缓存即可。 */
  appended: StoredAssistantMessage[];
};

/** 服务端保存的一条消息。凭证与动作 id 跟消息一起存，刷新后原样还原。 */
export type StoredAssistantMessage = {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  /** 随消息发送的图片（/api/files/xxx 本地地址），刷新后原样还原。 */
  images?: string[];
  receipt: CaptureResult | null;
  receiptError: string | null;
  actionIds: string[];
  planIds: string[];
  agentTaskIds: string[];
  createdAt: string;
};

export type AssistantSessionRecord = {
  id: string;
  kind: 'global' | 'task' | 'document';
  refId: string | null;
  title: string;
  /** auto=默认态可覆盖 / fallback=已用首句话兜底 / named=模型起过名 / user=用户改过，系统永不覆盖 */
  titleState: 'auto' | 'fallback' | 'named' | 'user';
  summary: string | null;
  model: string | null;
  messageCount: number;
  actionCount: number;
  pinned: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
