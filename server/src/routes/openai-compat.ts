/**
 * [INPUT]: OpenClaw 的 /v1/chat/completions 请求（仅限 127.0.0.1；透传 user/messageId 作微信来源元数据）
 * [OUTPUT]: OpenAI Chat Completions 兼容应答（含 SSE 伪流式）；内部转调 chatWithAssistant 并携带 weixin InboundRequest
 * [POS]: 微信入口的唯一通道适配器（编排 V3 阶段 1 接线点）：不运行第二套模型或提示词，
 *        模型、工具、人格与意图契约均以工作台配置和小精灵为唯一来源
 *        OpenClaw 独立运行上下文信封不作为用户正文入账，避免覆盖紧邻的真实请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { chatWithAssistant, type AssistantMessage } from '../services/assistant.js';
import { normalizeWeixinInbound } from '../services/inbound-context.js';
import { readWeixinIdentity } from './clawbot.js';
import { createHash } from 'node:crypto';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([
    z.string(),
    z.array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough()),
  ]).nullable().optional(),
});

const requestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1).max(40),
  stream: z.boolean().optional().default(false),
}).passthrough();

function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => typeof part === 'object' && part && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function completion(model: string, reply: string) {
  return {
    id: `chatcmpl-workbench-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
  };
}

export default async function openaiCompatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/chat/completions', async (req, reply) => {
    // 该接口会间接触发工作台的写工具，只允许本机 OpenClaw 调用。
    // 工作台仍可监听 0.0.0.0 提供手机访问，但不把模型代理暴露到局域网。
    const ip = req.ip.replace(/^::ffff:/, '');
    if (ip !== '127.0.0.1' && ip !== '::1') {
      return reply.code(403).send({ error: 'assistant model proxy is local-only' });
    }
    const body = requestSchema.parse(req.body ?? {});
    const messages: AssistantMessage[] = body.messages
      .filter((message): message is typeof message & { role: 'user' | 'assistant' } => message.role !== 'system')
      .map((message) => ({ role: message.role, content: contentText(message.content) }))
      // OpenClaw 在正文后追加 role=user 的内部信封；它不是新一轮用户输入。
      // 同时匹配固定前缀与完整边界，仅移除独立信封，保留普通正文中的引用。
      .filter((message) => !(message.role === 'user'
        && message.content.startsWith('OpenClaw runtime context for the immediately preceding user message.\n')
        && message.content.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')
        && message.content.endsWith('<<<END_OPENCLAW_INTERNAL_CONTEXT>>>')))
      .filter((message) => message.content.length > 0)
      .slice(-24);
    if (!messages.some((message) => message.role === 'user')) {
      throw app.httpErrors.badRequest('请求中没有用户消息');
    }

    // OpenClaw 的兼容 provider 不透传 user；仅在本机唯一绑定账号时使用服务端 owner。
    const owner = readWeixinIdentity();
    const user = typeof body.user === 'string' && body.user.trim() ? body.user.trim() : owner?.target ?? null;
    const requestId = typeof body.messageId === 'string' ? body.messageId
      : `wx-request-${createHash('sha256').update(JSON.stringify([user, messages])).digest('hex')}`;
    const result = await chatWithAssistant(messages, { kind: 'global' }, undefined,
      // 编排 V3 阶段 1：微信来源元数据归一化后与 Workbench/飞书走同一 chatWithAssistant 契约。
      // OpenClaw 透传的 user（wxid）作会话标识；messageId 可选，缺失时按会话+正文哈希兜底。
      normalizeWeixinInbound({
        text: [...messages].reverse().find((message) => message.role === 'user')?.content ?? '',
        conversationId: user,
        userId: user,
        messageId: requestId,
      }));
    const model = body.model?.trim() || 'workbench/assistant';
    const payload = completion(model, result.reply);

    // OpenClaw 默认可能要求流式响应；工作台内部仍是一次完整生成，
    // 这里只把最终答案包装成一个合法的 SSE chunk，避免再引入第二套流式逻辑。
    if (body.stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      reply.raw.write(`data: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: { role: 'assistant', content: result.reply }, finish_reason: null }] })}\n\n`);
      reply.raw.write(`data: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return reply;
    }
    return payload;
  });
}
