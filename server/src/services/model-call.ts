/**
 * [INPUT]: 模型 HTTP 请求、用途与可选可信来源关联
 * [OUTPUT]: 每次调用独立用量台账（含失败与缺失），不保存提示词、密钥或供应商错误正文
 * [POS]: 所有工作台模型 HTTP 调用的计量边界；与旧请求汇总表不得相加
 * [PROTOCOL]: 变更时检查 server/CLAUDE.md
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
type Context = { source?: string; taskId?: string | null; sessionId?: string | null; messageId?: string | null };
const context = new AsyncLocalStorage<Context>();
export function currentModelContext(): Context { return context.getStore() ?? {}; }
export function withModelContext<T>(meta: Context, fn: () => T): T { return context.run(meta, fn); }
type Transport = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export async function modelFetch(url: string, init: RequestInit, purpose: string, transport: Transport = (u, i) => fetch(u, i)): Promise<Response> {
  const meta = context.getStore() ?? {};
  let request: any = {}; try { request = JSON.parse(String(init.body)); } catch { /* missing is observable */ }
  const tools = request.tools ?? [];
  const started = Date.now(); let outcome = 'transport_failed'; let body: any = {};
  try {
    const response = await transport(url, init);
    const raw = await response.text();
    try { body = JSON.parse(raw); } catch { /* provider did not report usage */ }
    outcome = response.ok ? 'returned' : 'http_failed';
    return new Response(raw, { status: response.status });
  } finally {
    const usage = body.usage ?? {};
    db.prepare(`INSERT INTO model_call_usage (id,purpose,source,session_id,message_id,provider_host,requested_model,observed_model,input_tokens,output_tokens,cached_tokens,reasoning_tokens,prompt_chars,tool_chars,tool_count,outcome,duration_ms,created_at,task_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), purpose, meta.source ?? null, meta.sessionId ?? null, meta.messageId ?? null,
      new URL(url).host, String(request.model ?? ''), typeof body.model === 'string' ? body.model : null,
      number(usage.input_tokens ?? usage.prompt_tokens), number(usage.output_tokens ?? usage.completion_tokens),
      number(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens),
      number(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens),
      JSON.stringify(request.messages ?? request.input ?? '').length, JSON.stringify(tools).length,
      Array.isArray(tools) ? tools.length : 0, outcome, Date.now() - started, now(), meta.taskId ?? null);
  }
}
export function modelUsageForDay(day: string) {
  const rows = db.prepare('SELECT * FROM model_call_usage WHERE created_at >= ? AND created_at < ? ORDER BY created_at, rowid').all(day, day + 'Z');
  return { day, scope: 'model_call_usage_only', historicalBackfill: false, calls: rows };
}
