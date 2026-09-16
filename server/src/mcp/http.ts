// MCP Streamable HTTP 端点（无状态模式）：挂在 /mcp，供 OpenClaw 等外部 agent 接入
// 鉴权复用全局 ACCESS_TOKEN 令牌（x-access-token 请求头已支持）
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';

const SERVER_INFO = { name: 'workbench', version: '0.1.0' };

/** 每个请求独立建 transport/server（stateless），无会话粘性，客户端断开即清理 */
async function handleMcpPost(req: FastifyRequest, reply: FastifyReply) {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // 无状态：不建会话，适合单用户本地部署
    enableJsonResponse: true,      // 用普通 JSON 响应而非 SSE 流，工具调用更省资源
  });
  const server = new McpServer(SERVER_INFO);
  registerTools(server);
  reply.raw.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  // hijack 接管响应：由 SDK 直接写 raw response
  reply.hijack();
  await transport.handleRequest(req.raw, reply.raw, req.body);
}

export async function registerMcp(app: FastifyInstance): Promise<void> {
  app.post('/mcp', handleMcpPost);
  // 无状态模式不支持 GET（SSE 流）与 DELETE（会话终止），按协议返回 405
  app.get('/mcp', (_req, reply) => reply.status(405).send({ error: 'Method Not Allowed: stateless MCP endpoint, use POST' }));
  app.delete('/mcp', (_req, reply) => reply.status(405).send({ error: 'Method Not Allowed: no session to terminate' }));
  console.log('[mcp] Streamable HTTP 端点就绪：POST /mcp');
}
