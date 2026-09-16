/**
 * [INPUT]: 三入口对话、已归一化来源、助手模型循环和本地记忆/用量/会话服务
 * [OUTPUT]: 简短可信回执、零模型记忆/状态查询、可在工作台恢复的 IM 对话
 * [POS]: 助手请求编排边界；复用唯一模型循环，不接管外部执行生命周期
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { modelSessionMessages, startContextSegment } from './assistant-sessions.js';
import { captureLink } from './assistant-direct.js';
import { withModelContext } from './model-call.js';
import { db } from '../db.js';
import { runAssistant, type AssistantReply, type AssistantMessage, type AssistantContext } from './assistant.js';
import type { DispatchRequestContext } from './dispatch-plan.js';
import type { InboundRequest } from './inbound-context.js';
import { handleMemoryCommand, memoryIdentity, memoryPrompt, readAssistantMemory } from './assistant-memory.js';
import { authoritativeReceipt, shortTaskReceipt } from './assistant-receipts.js';
import { measureAssistantRequest } from './assistant-usage.js';
import { getAgentTask } from './agent-orchestrator.js';
import { continueAgentDispatch } from './agent-dispatch.js';
import { appendMessage, ensureSession, seedMessages, sessionMessages } from './assistant-sessions.js';

/** 统一入口包装：显式记忆/状态查询零模型，普通对话共享原有模型循环。 */
async function respond(
  messages: AssistantMessage[], context: AssistantContext,
  dispatch: DispatchRequestContext = { sessionId: null, sourceMessageId: null }, inbound?: InboundRequest,
): Promise<AssistantReply> {
  return withModelContext({ source: inbound?.source ?? 'workbench', sessionId: dispatch.sessionId, messageId: inbound?.sourceMessageId }, () => measureAssistantRequest(inbound?.source ?? 'workbench', async () => {
    const identity = memoryIdentity(inbound, dispatch.sessionId);
    let latest = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    // 只在明确命令下切主题，不能用日期/关键词猜测后丢失上下文。
    const topic = latest.trim().match(/^(?:新话题|开始新话题)(?:[：:]([\s\S]+))?$/);
    if (topic && dispatch.sessionId && dispatch.sourceMessageId) {
      startContextSegment(dispatch.sessionId, dispatch.sourceMessageId);
      latest = topic[1]?.trim() ?? '';
      messages = [{ role: 'user', content: latest }];
      if (!latest) return { reply:'已开始新话题，接下来不带入上一话题的聊天背景。历史记录和已派发任务保留。', drafts:[], captured:null, captureError:null, actions:[], plans:[], agentTasks:[] };
    }
    const memoryReply = handleMemoryCommand(latest, identity);
    const direct = (reply: string): AssistantReply => ({ reply, drafts: [], captured: null, captureError: null, actions: [], plans: [], agentTasks: [] });
    const captured = captureLink(latest, inbound);
    if (captured) return { ...direct(`已保存到随手记：${captured.items[0].target?.title ?? '链接'}。`), captured };
    if (inbound) {
      const continued = continueAgentDispatch(latest, inbound);
      if (continued === 'missing') return direct('当前会话没有可续办的任务，请告诉我任务编号；不会另建一条重复任务。');
      if (continued) return authoritativeReceipt({ ...direct(''), agentTasks: [continued] }, inbound.source);
    }
    if (memoryReply !== null) return direct(memoryReply);
    const taskMatch = latest.trim().match(/^(?:查看任务[：: ]*)?((?:WB-)?\d{8}-\d+)$/i);
    if (taskMatch) {
      const task = getAgentTask(taskMatch[1].toUpperCase());
      const allowed = task && (!inbound || inbound.source === 'workbench' || db.prepare('SELECT id FROM agent_tasks WHERE id = ? AND source = ? AND source_conversation_id = ?').get(task.id, inbound.source, inbound.sourceConversationId));
      return direct(allowed ? shortTaskReceipt(task) : '当前会话下没有找到这个任务。');
    }
    return authoritativeReceipt(await runAssistant(messages, { ...context, memoryBlock: memoryPrompt(readAssistantMemory(identity), identity), source: inbound?.source }, dispatch, inbound), inbound?.source ?? 'workbench');
  }));
}

/** 有稳定身份的 IM 对话落账；未知身份保持无会话，不把不同用户并入同一默认会话。 */
export async function chatWithAssistant(
  messages: AssistantMessage[], context: AssistantContext,
  dispatch: DispatchRequestContext = { sessionId: null, sourceMessageId: null }, inbound?: InboundRequest,
): Promise<AssistantReply> {
  const identity = memoryIdentity(inbound, dispatch.sessionId);
  if (!inbound || inbound.source === 'workbench' || !identity.conversation) return respond(messages, context, dispatch, inbound);
  const key = `im:${identity.conversation}`;
  ensureSession(key, { title: inbound.source === 'weixin' ? '微信对话' : '飞书对话' });
  const latestIndex = messages.map((message) => message.role).lastIndexOf('user');
  seedMessages(key, messages.slice(0, latestIndex));
  const user = appendMessage(key, 'user', inbound.text);
  const history = modelSessionMessages(key).map(({ role, content, images }) => ({ role, content, ...(images?.length ? { images } : {}) }));
  const result = await respond(history, context, { sessionId: key, sourceMessageId: user.id }, inbound);
  appendMessage(key, 'assistant', result.reply, { receipt: result.captured, receiptError: result.captureError,
    actionIds: result.actions.map((a) => a.id), planIds: result.plans.map((p) => p.id), agentTaskIds: result.agentTasks.map((t) => t.id) });
  return result;
}
