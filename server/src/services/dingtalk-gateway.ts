/**
 * [INPUT]: 已授权的钉钉 MCP 网关地址与工具参数，依赖官方 MCP SDK 管理会话
 * [OUTPUT]: 工具能力探测、单次调用与业务结果解包；失败保留错误码，不自动重试写操作
 * [POS]: 日历与知识连接器共用的传输边界，避免把握手成功、工具错误或空回执当作业务成功
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function withDingtalkGateway<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'yz-workbench', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url.replace(/[`'"\s]/g, ''))));
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** 同时检查 MCP isError 与钉钉业务信封；优先采用 structuredContent。 */
export function unwrapDingtalkResult(result: unknown): Record<string, unknown> {
  const envelope = (result ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(envelope.content) ? envelope.content as Array<{ type?: string; text?: string }> : [];
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
  if (envelope.isError === true) throw new Error(`钉钉工具调用失败：${text.slice(0, 600) || 'isError=true'}`);
  let payload = envelope.structuredContent;
  if (payload == null) {
    try { payload = JSON.parse(text); } catch { throw new Error(`钉钉返回了无法识别的结果：${text.slice(0, 300)}`); }
  }
  if (!payload || typeof payload !== 'object') throw new Error('钉钉未返回有效的业务回执');
  const row = payload as Record<string, unknown>;
  if (row.success === false || row.error) {
    throw new Error(`钉钉调用失败${row.errorCode ? `（${row.errorCode}）` : ''}：${String(row.errorMsg ?? row.error ?? 'success=false')}`);
  }
  // 仅解包业务信封；查询会议室本身也有 result 数组和分页字段，必须保留。
  return (row.success === true && row.result != null ? row.result : row) as Record<string, unknown>;
}

const toolCache = new Map<string, { expires: number; names: string[] }>();

export async function listDingtalkTools(url: string): Promise<string[]> {
  const cached = toolCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.names;
  const names = await withDingtalkGateway(url, async (client) => {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      names.push(...page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
    } while (cursor);
    return names;
  });
  toolCache.set(url, { names, expires: Date.now() + 60_000 });
  return names;
}

export async function callDingtalkTool(url: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return withDingtalkGateway(url, async (client) => unwrapDingtalkResult(await client.callTool({ name, arguments: args })));
}
