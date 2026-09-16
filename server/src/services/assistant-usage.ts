/**
 * [INPUT]: 单次助手请求与模型响应的 usage（Chat Completions / Responses）
 * [OUTPUT]: 请求级调用次数、已报告 token、缺失覆盖率和耗时台账
 * [POS]: 助手成本观测边界；记录失败尝试，不估造供应商未报告的 token 或价格
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { db, now } from '../db.js';

type UsageState = { calls: number; reported: number; input: number; output: number; cached: number; cacheReported: number };
const storage = new AsyncLocalStorage<UsageState>();
export function beginModelCall(): void { const state = storage.getStore(); if (state) state.calls += 1; }
export function recordModelUsage(usage: unknown): void {
  const state = storage.getStore();
  if (!state || !usage || typeof usage !== 'object') return;
  const raw = usage as Record<string, any>;
  const input = raw.input_tokens ?? raw.prompt_tokens;
  const output = raw.output_tokens ?? raw.completion_tokens;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!valid(input) || !valid(output)) return;
  state.reported += 1; state.input += input; state.output += output;
  const cached = raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens;
  if (valid(cached)) { state.cached += cached; state.cacheReported += 1; }
}

export async function measureAssistantRequest<T>(source: string, fn: () => Promise<T>): Promise<T> {
  const state: UsageState = { calls: 0, reported: 0, input: 0, output: 0, cached: 0, cacheReported: 0 };
  const started = Date.now();
  let outcome = 'failed';
  return storage.run(state, async () => {
    try { const result = await fn(); outcome = 'returned'; return result; }
    finally {
      db.prepare(`INSERT INTO assistant_usage (id, source, model_calls, reported_calls, input_tokens, output_tokens,
        cached_tokens, cache_reported_calls, duration_ms, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), source, state.calls, state.reported, state.input, state.output, state.cached,
          state.cacheReported, Date.now() - started, outcome, now());
    }
  });
}

export function assistantUsageSummary() {
  return db.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(model_calls), 0) AS modelCalls,
    COALESCE(SUM(reported_calls), 0) AS reportedCalls, COALESCE(SUM(input_tokens), 0) AS inputTokens,
    COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
    COALESCE(SUM(cache_reported_calls), 0) AS cacheReportedCalls,
    COALESCE(SUM(outcome = 'failed'), 0) AS failedRequests
    FROM (SELECT * FROM assistant_usage ORDER BY rowid DESC LIMIT 100)`).get();
}
