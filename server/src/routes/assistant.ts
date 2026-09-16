/**
 * [INPUT]: HTTP 请求——/api/assistant/chat（会话对话，构建 Workbench 来源 InboundRequest）、
 *          会话档案 CRUD、独立笔记 noteId 引用、草稿确认、派单动作台账查询/结案/重试、派发计划确认/取消/重试/撤回
 * [OUTPUT]: 助手应答与会话/任务/记忆/用量/接入状态 REST；固定探针成果只读文本，不接受任意路径
 * [POS]: Workbench 入口的编排 V3 阶段 1 接线点：用户消息落库后归一化为 InboundRequest
 *        再进 chatWithAssistant，与飞书/微信入口共享同一意图契约
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { modelSessionMessages } from '../services/assistant-sessions.js';
import { modelUsageForDay } from '../services/model-call.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAgentTask, listAgentTasks, sessionTaskActivity } from '../services/agent-orchestrator.js';
import { memoryIdentity, readAssistantMemory, saveAssistantMemory, listMemoryEntries, addMemoryEntry, setMemoryEntryStatus, deleteMemoryEntry } from '../services/assistant-memory.js';
import { executorReadiness, executorArtifact } from '../services/executor-readiness.js';
import { agentResult, prepareAgentDispatch, setDispatchPaused, dispatchConfig,reviseDispatchedTask,agentTaskActions,switchContentExecutor } from '../services/agent-dispatch.js';
import {retryAgentNotification} from '../services/agent-notifications.js';
import { getExecutionPreference, setExecutionPreference, clearExecutionPreference } from '../services/agent-preferences.js';
import { agentTaskUsage, agentTaskEvents } from '../services/agent-task-usage.js';
import { assistantUsageSummary } from '../services/assistant-usage.js';
import { chatWithAssistant } from '../services/assistant.js';
import { normalizeWorkbenchInbound } from '../services/inbound-context.js';
import { acceptAssistantDrafts } from '../services/triage.js';
import { repeatRuleSchema } from '../services/recurrence.js';
import { generateConversationTitle } from '../services/conversation-title.js';
import { getAction, listActions, listUnreadActions, markActionsRead, pollFeishuDispatches, resolveAction, retryDispatch } from '../services/assistant-actions.js';
import {
  appendMessage, autoTitleFromFirstMessage, deleteSession, ensureSession, getSession,
  listSessions, readSession, renameSession, rewindForResend, seedMessages, sessionMessages, resolveNoteSession,
} from '../services/assistant-sessions.js';
import {
  cancelPlan, confirmPlan, expirePlans, getPlan, recallItem, retryItem,
} from '../services/dispatch-plan.js';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(20_000),
});

const contextSchema = z.object({
  kind: z.enum(['global', 'task', 'document']).default('global'),
  taskId: z.number().int().positive().optional(),
  noteId: z.number().int().positive().optional(),
  title: z.string().max(1000).optional(),
  content: z.string().max(100_000).optional(),
  knowledgeArchiveIds: z.union([
    z.literal('all'),
    z.array(z.number().int().positive()).max(100),
  ]).optional(),
  knowledgeSourceKey: z.string().min(1).max(500).optional(),
  skillIds: z.array(z.string().length(24)).max(3).optional(),
}).refine((value) => value.noteId === undefined || (value.kind === 'document' && value.taskId === undefined), { message: '笔记引用仅允许用于文档上下文' });

const draftSchema = z.object({
  type: z.enum(['task', 'note', 'reminder']),
  content: z.string().trim().min(1).max(4000),
  plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  remindAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/).nullable().optional(),
  repeatRule: repeatRuleSchema.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).nullish().transform((v) => v ?? undefined),
});

/** 送进模型的最大轮数：超出部分仍在会话里躺着，只是不再占用上下文窗口。 */
const MODEL_WINDOW = 24;

export default async function assistantRoutes(app: FastifyInstance) {
  app.post('/api/assistant/note-session', (req) => {
    const input = z.object({
      noteId: z.number().int().positive().optional(),
      draftKey: z.string().regex(/^document:draft:[0-9a-f-]{36}$/).optional(),
      title: z.string().max(1000).optional(),
    }).refine((value) => value.noteId !== undefined || value.draftKey !== undefined, { message: '缺少笔记或草稿身份' }).parse(req.body);
    return { session: resolveNoteSession(input) };
  });
  app.get('/api/assistant/agent-tasks', () => ({ tasks: listAgentTasks(100) }));
  // S19 长期执行者/模型偏好：查看、设置、撤销；解析规则=临时指定>长期偏好>默认。
  app.get('/api/assistant/execution-preferences', () => ({ preference: getExecutionPreference() }));
  app.put('/api/assistant/execution-preferences', (req) => {
    const body = z.object({
      executor: z.string().trim().min(1).max(60),
      model: z.string().trim().min(1).max(120).nullable().optional(),
      costPolicy: z.enum(['unspecified', 'free_only']).optional(),
    }).parse(req.body ?? {});
    return { preference: setExecutionPreference(body) };
  });
  app.delete('/api/assistant/execution-preferences', () => ({ cleared: clearExecutionPreference() }));
  app.get('/api/assistant/agent-tasks/:id/actions',(req,reply)=>{
    const {id}=z.object({id:z.string().regex(/^(?:WB-)?\d{8}-\d+$/)}).parse(req.params);
    const actions=agentTaskActions(id);return actions??reply.code(404).send({error:'任务不存在'});
  });
  app.get('/api/assistant/execution', () => ({ enabled: dispatchConfig()?.enabled === true, paused: dispatchConfig()?.paused !== false }));
  app.post('/api/assistant/execution/pause', (req) => setDispatchPaused(z.object({ paused: z.boolean() }).parse(req.body).paused));
  app.post('/api/assistant/agent-tasks/:id/dispatch', (req) => ({ task: prepareAgentDispatch(z.object({ id: z.string().regex(/^(?:WB-)?\d{8}-\d+$/) }).parse(req.params).id) }));
  // 阶段②包2：整任务换执行器续办（仅内容任务；执行中拒换；成果原位交接）。模型经 agent_switch_executor 工具提交，服务端握最终闸门。
  app.post('/api/assistant/agent-tasks/:id/switch-executor', (req) => {
    const { id } = z.object({ id: z.string().regex(/^(?:WB-)?\d{8}-\d+$/) }).parse(req.params);
    const body = z.object({ executor: z.string().min(1).max(60), reason: z.string().max(300).optional(), sessionKey: z.string().min(1).max(200) }).parse(req.body ?? {});
    const inbound = normalizeWorkbenchInbound({ text: `换执行者为 ${body.executor}`, sessionKey: body.sessionKey, sessionMessageId: null });
    return { task: switchContentExecutor(inbound, body.executor, id, body.reason) };
  });
  app.post('/api/assistant/agent-tasks/:id/revise',(req,reply)=>{
    const {id}=z.object({id:z.string().regex(/^(?:WB-)?\d{8}-\d+$/)}).parse(req.params);
    const input=z.object({conversationId:z.string().min(1).max(200),expectedAttempt:z.number().int().positive(),requestId:z.string().min(1).max(200),feedback:z.string().trim().min(1).max(2000)}).strict().parse(req.body);
    try{return reviseDispatchedTask({...input,taskId:id});}catch(e){return reply.code(409).send({error:(e as Error).message});}
  });
  app.post('/api/assistant/agent-tasks/:id/retry-notification',async(req,reply)=>{
    const {id}=z.object({id:z.string().regex(/^(?:WB-)?\d{8}-\d+$/)}).parse(req.params);
    const input=z.object({conversationId:z.string().min(1).max(200),attempt:z.number().int().positive()}).strict().parse(req.body);
    if(!dispatchConfig()?.stageA?.enabled||dispatchConfig()?.stageA?.conversationId!==input.conversationId)return reply.code(409).send({error:'A阶段未启用或来源会话不匹配'});
    try{return await retryAgentNotification({...input,taskId:id,source:'workbench'});}catch(e){return reply.code(409).send({error:(e as Error).message});}
  });
  app.get('/api/assistant/agent-tasks/:id/result', (req, reply) => {
    const { id } = z.object({ id: z.string().regex(/^(?:WB-)?\d{8}-\d+$/) }).parse(req.params);
    const result = agentResult(id);
    return result ? reply.header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(result.content)
      : reply.code(404).send({ error: '成果尚未生成或凭证已失效' });
  });
  // S20 任务级阶段用量：执行/验收分阶段展示；未知用量不记 0，不虚称供应商单次硬封顶。
  app.get('/api/assistant/agent-tasks/:id/usage', (req, reply) => {
    const { id } = z.object({ id: z.string().regex(/^(?:WB-)?\d{8}-\d+$/) }).parse(req.params);
    const usage = agentTaskUsage(id);
    return usage ? { usage } : reply.code(404).send({ error: '任务不存在' });
  });
  // 阶段②包1 任务全过程事实链：含内容线关键节点（登记/领取/转写/总结用量/保存/失败）。
  app.get('/api/assistant/agent-tasks/:id/events', (req, reply) => {
    const { id } = z.object({ id: z.string().regex(/^(?:WB-)?\d{8}-\d+$/) }).parse(req.params);
    const result = agentTaskEvents(id);
    return result ? result : reply.code(404).send({ error: '任务不存在' });
  });
  app.get('/api/assistant/agent-tasks/:id', (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const task = getAgentTask(id);
    return task ? { task } : reply.code(404).send({ error: '任务不存在' });
  });
  app.get('/api/assistant/usage/calls', (req) => {
    const { day } = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
    return modelUsageForDay(day);
  });
  app.get('/api/assistant/usage', () => assistantUsageSummary());
  app.get('/api/assistant/executors', () => ({ executors: executorReadiness() }));
  app.get('/api/assistant/executors/:executor/artifact', (req, reply) => {
    const { executor } = z.object({ executor: z.enum(['cola-document', 'workbuddy-cli']) }).parse(req.params);
    const artifact = executorArtifact(executor);
    if (!artifact) return reply.code(404).send({ error: '尚无有效文档成果，或文件已改变' });
    return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
      .type('text/plain; charset=utf-8').send(artifact.content);
  });
  app.get('/api/assistant/memory/:key', (req) => {
    const { key } = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    const identity = memoryIdentity(undefined, key);
    return { ...readAssistantMemory(identity), entries: listMemoryEntries(identity) };
  });
  app.patch('/api/assistant/memory/:key', (req) => {
    const { key } = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    const patch = z.object({ instructions: z.string().trim().max(600).optional(), projectId: z.number().int().positive().nullable().optional() }).strict().parse(req.body);
    return saveAssistantMemory(memoryIdentity(undefined, key), patch);
  });
  // 记忆条目：面板手动增删停用；身份与对话写入一致，按入口隔离。
  app.post('/api/assistant/memory/:key/entries', (req) => {
    const { key } = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    const body = z.object({
      content: z.string().trim().min(1).max(600),
      kind: z.enum(['preference', 'fact', 'skill_preference', 'task_preference']).default('preference'),
    }).parse(req.body);
    return addMemoryEntry(memoryIdentity(undefined, key), body.content, body.kind, 'manual');
  });
  app.patch('/api/assistant/memory/:key/entries/:id', (req) => {
    const params = z.object({ key: z.string().min(1).max(200), id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ status: z.enum(['active', 'disabled']) }).parse(req.body);
    return setMemoryEntryStatus(memoryIdentity(undefined, params.key), params.id, body.status);
  });
  app.delete('/api/assistant/memory/:key/entries/:id', (req) => {
    const params = z.object({ key: z.string().min(1).max(200), id: z.coerce.number().int().positive() }).parse(req.params);
    deleteMemoryEntry(memoryIdentity(undefined, params.key), params.id);
    return { ok: true };
  });
  // 会话由服务端持有：前端只发这一轮的新消息，历史从这里读，不再靠浏览器回传整段。
  // 这样刷新、换浏览器、换设备看到的都是同一份对话，也不会出现「凭证还在但上下文没了」的孤儿状态。
  app.post('/api/assistant/chat', async (req) => {
    const body = z.object({
      /** 本轮用户输入。不传则退回旧契约：从 messages 里取最后一条 user 消息。纯图片消息可空。 */
      message: z.string().trim().max(20_000).optional(),
      /** 随消息发送的图片（/api/files/xxx 本地地址），最多 9 张。纯图片消息时本字段为唯一内容。 */
      images: z.array(z.string().min(1).max(500)).max(9).optional(),
      /** 旧契约兼容：整段历史。有 sessionKey 时会被服务端记录覆盖。 */
      messages: z.array(messageSchema).max(24).optional(),
      context: contextSchema.default({ kind: 'global' }),
      /** 会话 key（页面派生：global:今天 / task:123）。不传 = 不落库，纯一次性调用。 */
      sessionKey: z.string().trim().min(1).max(200).optional(),
      /** 老会话的本地缓存：仅当服务端该会话还没有任何消息时补种一次。 */
      seed: z.array(messageSchema).max(40).optional(),
    }).parse(req.body);

    const incoming = body.messages ?? [];
    const text = body.message ?? [...incoming].reverse().find((item) => item.role === 'user')?.content ?? '';
    const images = body.images?.filter((url) => url.trim()).slice(0, 9);
    if (!text.trim() && !images?.length) throw Object.assign(new Error('没有要发送的内容'), { statusCode: 400 });

    // 没有 sessionKey 时保持旧行为（纯函数式调用，不留痕）
    if (!body.sessionKey) {
      const history = body.message
        ? [...incoming, { role: 'user' as const, content: text, ...(images?.length ? { images } : {}) }]
        : incoming;
      if (!history.length) throw Object.assign(new Error('没有要发送的内容'), { statusCode: 400 });
      const result = await chatWithAssistant(history.slice(-MODEL_WINDOW), body.context, undefined,
        normalizeWorkbenchInbound({ text, sessionKey: null, sessionMessageId: null }));
      return { ...result, session: null, appended: [] };
    }

    const key = body.sessionKey;
    const meta = {
      kind: body.context.kind,
      refId: body.context.noteId != null
        ? `note:${body.context.noteId}`
        : body.context.taskId != null
          ? String(body.context.taskId)
          : body.context.knowledgeSourceKey
            ? `knowledge:${body.context.knowledgeSourceKey}`
            : null,
      title: body.context.title?.trim() || undefined,
    };

    ensureSession(key, meta);
    seedMessages(key, body.seed ?? incoming, meta);
    // 用户输入先落库再调模型：模型卡住或进程重启，用户说过的话也不该跟着丢。
    const userMessage = appendMessage(key, 'user', text, images?.length ? { images } : {});
    autoTitleFromFirstMessage(key);

    const history = modelSessionMessages(key)
      .map(({ role, content, images: msgImages }) => ({ role, content, ...(msgImages?.length ? { images: msgImages } : {}) }))
      .slice(-MODEL_WINDOW);
    // 派发计划要挂到本轮用户消息上：确认卡随会话历史一起恢复，
    // 刷新之后才能重新看到「还等着你确认」的那张卡。
    const result = await chatWithAssistant(history, body.context, {
      sessionId: key,
      sourceMessageId: userMessage.id,
    }, normalizeWorkbenchInbound({ text, sessionKey: key, sessionMessageId: userMessage.id }));

    const assistantMessage = appendMessage(key, 'assistant', result.reply, {
      receipt: result.captured,
      receiptError: result.captureError,
      actionIds: result.actions.map((action) => action.id),
      planIds: result.plans.map((plan) => plan.id),
      agentTaskIds: result.agentTasks.map((task) => task.id),
    });
    // 首句话即标题，用户可改名；不为装饰性标题额外调用模型。

    return {
      ...result,
      session: getSession(key),
      appended: [userMessage, assistantMessage],
    };
  });

  // 重新发送 / 重新生成：把最后一轮退回重跑，**不新开会话**。
  // 只允许动最后一轮——中间那条重发会把其后的对话一起丢掉，那是「分叉新会话」的语义，
  // 聊天产品的通行做法也是只对最后一条做原地重跑（ChatGPT 的 regenerate 同理）。
  app.post('/api/assistant/chat/resend', async (req, reply) => {
    const body = z.object({ sessionKey: z.string().trim().min(1).max(200) }).parse(req.body);
    const key = body.sessionKey;
    const found = getSession(key);
    if (!found) return reply.code(404).send({ error: '会话不存在' });

    const rewind = rewindForResend(key);
    if (!rewind) return reply.code(400).send({ error: '这个会话还没有可重新发送的消息' });

    // 上下文按会话档案还原：重发不再有前端传来的 context，任务/笔记/资料引用要从 ref_id 读回来，
    // 否则清单详情里的重发会变成一次「无来源」的全局对话。
    const refId = found.refId ?? '';
    const context = {
      kind: found.kind,
      ...(found.kind === 'task' && Number.isFinite(Number(refId)) && Number(refId) > 0 ? { taskId: Number(refId) } : {}),
      ...(found.kind === 'document' && refId.startsWith('note:') ? { noteId: Number(refId.slice(5)) } : {}),
      ...(found.kind === 'document' && refId.startsWith('knowledge:') ? { knowledgeSourceKey: refId.slice(10) } : {}),
      title: found.title,
    };

    const userMessage = appendMessage(key, 'user', rewind.text, rewind.images?.length ? { images: rewind.images } : {});
    const history = modelSessionMessages(key)
      .map(({ role, content }) => ({ role, content }))
      .slice(-MODEL_WINDOW);
    const result = await chatWithAssistant(history, context, {
      sessionId: key,
      sourceMessageId: userMessage.id,
    }, normalizeWorkbenchInbound({ text: rewind.text, sessionKey: key, sessionMessageId: userMessage.id }));

    const assistantMessage = appendMessage(key, 'assistant', result.reply, {
      receipt: result.captured,
      receiptError: result.captureError,
      actionIds: result.actions.map((action) => action.id),
      planIds: result.plans.map((plan) => plan.id),
      agentTaskIds: result.agentTasks.map((task) => task.id),
    });

    return {
      ...result,
      session: getSession(key),
      appended: [userMessage, assistantMessage],
      /** 被重跑覆盖掉的旧消息条数：前端据此把本地那一轮先摘掉，再换成新两条 */
      replaced: rewind.removed,
    };
  });

  // ── 会话档案 ──────────────────────────────────────────────────────────

  // 会话列表圆点：按会话聚合活跃任务状态（running/attention/queued），5-10 秒轮询即可。
  app.get('/api/assistant/sessions/activity', () => ({ activity: sessionTaskActivity() }));
  app.get('/api/assistant/sessions', (req) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      archived: z.coerce.boolean().default(false),
    }).parse(req.query);
    return { sessions: listSessions(query.limit, query.archived) };
  });

  app.get('/api/assistant/sessions/:key', (req, reply) => {
    const params = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    const found = readSession(params.key);
    if (!found) return reply.code(404).send({ error: '会话不存在' });
    return found;
  });

  app.patch('/api/assistant/sessions/:key', (req, reply) => {
    const params = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    const body = z.object({ title: z.string().trim().min(1).max(60) }).parse(req.body);
    const session = renameSession(params.key, body.title);
    if (!session) return reply.code(404).send({ error: '会话不存在' });
    return { session };
  });

  app.delete('/api/assistant/sessions/:key', (req, reply) => {
    const params = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    if (!deleteSession(params.key)) return reply.code(404).send({ error: '会话不存在' });
    return { ok: true as const };
  });

  // 为对话内容起一个概括性标题（存知识库/笔记时用）；模型不可用时返回 null，前端兜底
  app.post('/api/assistant/conversation-title', async (req) => {
    const body = z.object({ content: z.string().trim().min(1).max(20_000) }).parse(req.body);
    return { title: await generateConversationTitle(body.content) };
  });

  app.post('/api/assistant/accept-drafts', (req) => {
    const body = z.object({ drafts: z.array(draftSchema).min(1).max(8) }).parse(req.body);
    return acceptAssistantDrafts(body.drafts.map((draft) => ({ ...draft, repeatRule: draft.repeatRule ?? 'none' })));
  });

  // ── 派单动作台账：派出去的事要有回音 ──────────────────────────────────
  // 后台调度每 30s 轮询一次；这几个接口供前端展示与手动介入。

  app.get('/api/assistant/actions', (req) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    return { actions: listActions(query.limit) };
  });

  /**
   * 未读的终态结果。静态路径要注册在 /:id 之前，避免被参数路由吃掉。
   * 前端靠它显示未读数——机器人回没回，不打开对话也能知道。
   */
  app.get('/api/assistant/actions/unread', () => ({ actions: listUnreadActions() }));

  app.get('/api/assistant/actions/:id', (req, reply) => {
    const params = z.object({ id: z.string().min(1).max(200) }).parse(req.params);
    const action = getAction(params.id);
    if (!action) return reply.code(404).send({ error: '动作不存在' });
    return { action };
  });

  /** 手动结案：分类器没认出终态、或用户自己确认已经做完了。 */
  app.post('/api/assistant/actions/:id/resolve', (req, reply) => {
    const params = z.object({ id: z.string().min(1).max(200) }).parse(req.params);
    const body = z.object({
      status: z.enum(['succeeded', 'failed']),
      note: z.string().trim().max(2000).optional(),
    }).parse(req.body);
    const action = resolveAction(params.id, body);
    if (!action) return reply.code(404).send({ error: '动作不存在' });
    return { action };
  });

  /** 用户看过结果了：清未读。不传 ids 就全清。 */
  app.post('/api/assistant/actions/read', (req) => {
    const body = z.object({ ids: z.array(z.string().min(1).max(200)).max(50).optional() }).parse(req.body ?? {});
    if (!body.ids) {
      const ids = listUnreadActions().map((action) => action.id);
      return { updated: markActionsRead(ids) };
    }
    return { updated: markActionsRead(body.ids) };
  });

  /**
   * 手动重发护栏：只有确认没发出去（outbound_message_id 为空）才真正重发；
   * 已经发出过的返回 resent:false + 409，绝不二发。挡「用户重试造成重复发送」。
   */
  app.post('/api/assistant/actions/:id/retry', async (req, reply) => {
    const params = z.object({ id: z.string().min(1).max(200) }).parse(req.params);
    try {
      const { action, resent } = await retryDispatch(params.id);
      return reply.code(resent ? 200 : 409).send({ action, resent });
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message.includes('不存在') ? 404 : 400).send({ error: message });
    }
  });

  /** 不等下一个调度周期，立刻扫一遍（用户点了刷新）。 */
  app.post('/api/assistant/actions/poll', async () => await pollFeishuDispatches());

  // ── 原子派发计划（4.1）────────────────────────────────────────────────────
  // 这四个接口是模型侧 feishu_dispatch 的下半段：模型只负责登记意图，
  // 群、正文、对象、身份全部读服务端冻结的数据，请求里多传一个字段都不认。

  const planIdParams = z.object({ id: z.string().min(1).max(200) });

  /** 只允许空 body：客户端想塞正文/群/目标/身份/confirm 一律被 schema 挡掉。 */
  const emptyBody = z.object({}).strict();

  const fail = (reply: { code: (n: number) => { send: (v: unknown) => unknown } }, error: unknown) => {
    const message = (error as Error).message || '操作失败';
    const status = message.includes('不存在') ? 404
      // 状态冲突：请求本身合法，但目标当前不在这个状态上，重试也没用。
      : /过期|已取消|已经开始发送|只有发送失败|只有已发送的条目可以撤回|已超过 5 分钟/.test(message) ? 409
        // 下游故障：请求合法且状态也对，是飞书那边没办成。
        : /timed?\s*out|timeout|ECONNRESET|ECONNABORTED|socket hang up|ETIMEDOUT/i.test(message) ? 502
          : 400;
    return reply.code(status).send({ error: message });
  };

  app.get('/api/assistant/dispatch-plans/:id', (req, reply) => {
    const params = planIdParams.parse(req.params);
    const plan = getPlan(params.id);
    if (!plan) return reply.code(404).send({ error: '派发计划不存在' });
    // 读取顺带收口过期：前端拿到的一定是新鲜状态，不必为「还能不能确认」再打一次接口。
    expirePlans(params.id);
    return { plan: getPlan(params.id) ?? plan };
  });

  /**
   * 确认发送。CAS 抢到执行权的那个请求才会真正发网络请求；
   * 重复点击只返回当前计划，绝不二发。
   */
  app.post('/api/assistant/dispatch-plans/:id/confirm', async (req, reply) => {
    const params = planIdParams.parse(req.params);
    emptyBody.parse(req.body ?? {});
    try {
      return { plan: await confirmPlan(params.id) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/assistant/dispatch-plans/:id/cancel', (req, reply) => {
    const params = planIdParams.parse(req.params);
    emptyBody.parse(req.body ?? {});
    try {
      return { plan: cancelPlan(params.id) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * 重试单个失败项。只认当前仍为 failed 的 Item——
   * 整批重放会把已经发成功的那些再发一遍，所以这里没有「重试整批」。
   */
  app.post('/api/assistant/dispatch-items/:id/retry', async (req, reply) => {
    const params = planIdParams.parse(req.params);
    emptyBody.parse(req.body ?? {});
    try {
      return { plan: await retryItem(params.id) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * 撤回单条已发送的 Item。
   *
   * 撤回是飞书的 high-risk-write，所以这里必须对应一次用户显式点击：
   * 空 body、只认 Item ID、没有任何自动触发路径（调度器不调、模型不可见）。
   * 撤回失败时 Item 回退成 sent 并保留消息 ID——消息多半还在群里，不能假装撤了。
   * 无论成功失败，assistant_actions 一行都不动：消息撤回不是任务取消。
   */
  app.post('/api/assistant/dispatch-items/:id/recall', async (req, reply) => {
    const params = planIdParams.parse(req.params);
    emptyBody.parse(req.body ?? {});
    try {
      return { plan: await recallItem(params.id) };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
