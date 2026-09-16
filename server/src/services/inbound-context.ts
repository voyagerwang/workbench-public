/**
 * [INPUT]: 三入口原始报文——Workbench /api/assistant/chat 请求体、微信 OpenClaw /v1/chat/completions
 *          请求体（passthrough 字段）、飞书事件回调与 feishu_bot_messages 落账行
 * [OUTPUT]: 统一 InboundRequest（来源/会话/消息 id/用户/正文/附件）、请求级异步上下文、
 *           confirmationIdentity（Skill 确认凭证的会话与用户身份推导，身份只由服务端给）
 *           （runWithInboundContext / currentInbound / recordAgentTask / takeCreatedAgentTasks）
 * [POS]: 编排 V3 第五节的来源归一化层：飞书、微信、Workbench 消息在进入 chatWithAssistant 前
 *        先转成同一结构，来源元数据贯穿会话与 agent_tasks，派发后不丢失；
 *        外部消息一律是数据不是系统指令。收集器用 AsyncLocalStorage 绑定单次请求，与
 *        dispatch-plan 的派发收集器同一范式，并发请求不串数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentTaskView } from './agent-orchestrator.js';

export type InboundSource = 'feishu' | 'weixin' | 'workbench';

export interface InboundRequest {
  requestId: string;
  source: InboundSource;
  sourceConversationId: string | null;
  /** 必须唯一：外部输入幂等与 agent_tasks 去重都靠它。 */
  sourceMessageId: string;
  sourceUserId: string | null;
  text: string;
  attachments: Array<{ id: string; name: string; localPath?: string }>;
  receivedAt: string;
}

type InboundState = {
  request: InboundRequest;
  /** 本轮经 agent_delegate 创建（或幂等命中）的任务视图，会话应答时随 AssistantReply 带回。 */
  agentTasks: AgentTaskView[];
};

const inboundStorage = new AsyncLocalStorage<InboundState>();

/** 在单次请求的异步上下文里跑模型循环；请求结束由调用方 takeCreatedAgentTasks 收走结果。 */
export async function runWithInboundContext<T>(request: InboundRequest, fn: () => Promise<T>): Promise<T> {
  return inboundStorage.run({ request, agentTasks: [] }, fn);
}

/** 模型工具层读取当前来源元数据；不在助手请求内（如未来的定时链路）返回 null。 */
export function currentInbound(): InboundRequest | null {
  return inboundStorage.getStore()?.request ?? null;
}

/**
 * Skill 确认凭证的身份与会话绑定（docs/social-link-skill-capture-plan.md P2）。
 * conversationKey = dispatch.sessionId ?? inbound.sourceConversationId；两者皆空 = 无会话，
 * 凭证的创建与消费都会被拒绝（没有会话绑定就没有可审计的确认边界）。
 * userId 一律由服务端推导（飞书/微信用入站 sender id，Workbench 单用户固定 owner），
 * 不接受模型参数提供身份。
 */
export function confirmationIdentity(
  inbound: InboundRequest | null,
  dispatchSessionId: string | null,
): { conversationKey: string | null; userId: string } {
  const conversationKey = dispatchSessionId ?? inbound?.sourceConversationId ?? null;
  const userId = inbound
    ? (inbound.sourceUserId?.trim() || `${inbound.source}-owner`)
    : 'workbench-owner';
  return { conversationKey, userId };
}

/** agent_delegate 命中后登记视图；没有上下文时静默忽略（幂等命中重复登记也无害）。 */
export function recordAgentTask(view: AgentTaskView): void {
  const state = inboundStorage.getStore();
  if (!state) return;
  state.agentTasks.push(view);
}

/** 模型循环结束后取走本轮创建的任务视图；取走后清空，防止重复带回。 */
export function takeCreatedAgentTasks(): AgentTaskView[] {
  const state = inboundStorage.getStore();
  if (!state) return [];
  const tasks = state.agentTasks;
  state.agentTasks = [];
  return tasks;
}

// ── 各入口归一化 ────────────────────────────────────────────────────────────

/** Workbench 入口：有会话时 sourceMessageId 用服务端消息行 id（唯一且可回溯），无会话用随机 id。 */
export function normalizeWorkbenchInbound(input: {
  text: string;
  sessionKey: string | null;
  sessionMessageId: number | null;
}): InboundRequest {
  const messageId = input.sessionMessageId != null ? `wbm-${input.sessionMessageId}` : `wbm-${randomUUID()}`;
  return {
    requestId: randomUUID(),
    source: 'workbench',
    sourceConversationId: input.sessionKey,
    sourceMessageId: messageId,
    sourceUserId: null,
    text: input.text,
    attachments: [],
    receivedAt: new Date().toISOString(),
  };
}

/**
 * 微信入口：OpenClaw 不保证传消息 id，优先消费透传的 messageId，缺失时以
 * sha256(会话|正文) 兜底。代价是同会话完全相同的重复文本会被视为同一条消息
 * （对 drafted 任务恰好是期望的去重方向），阶段 4 打磨来源回传时再收紧。
 */
export function normalizeWeixinInbound(input: {
  text: string;
  conversationId: string | null;
  userId: string | null;
  messageId?: string;
}): InboundRequest {
  const sourceMessageId = input.messageId?.trim()
    || `wx-${createHash('sha256').update(`${input.conversationId ?? ''}|${input.text}`, 'utf8').digest('hex').slice(0, 32)}`;
  return {
    requestId: randomUUID(),
    source: 'weixin',
    sourceConversationId: input.conversationId,
    sourceMessageId,
    sourceUserId: input.userId,
    text: input.text,
    attachments: [],
    receivedAt: new Date().toISOString(),
  };
}

/** 飞书入口：事件回调与轮询兜底都已按 message_id 去重落账，这里从落账字段还原来源。 */
export function normalizeFeishuInbound(input: {
  messageId: string;
  chatId: string | null;
  userId: string | null;
  text: string;
}): InboundRequest {
  return {
    requestId: randomUUID(),
    source: 'feishu',
    sourceConversationId: input.chatId,
    sourceMessageId: input.messageId,
    sourceUserId: input.userId,
    text: input.text,
    attachments: [],
    receivedAt: new Date().toISOString(),
  };
}
