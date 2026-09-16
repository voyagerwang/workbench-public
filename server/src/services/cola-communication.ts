/**
 * [INPUT]: Cola CLI 官方 JSON 回执、探针预期 nonce/项目和专用 scope
 * [OUTPUT]: 消息往返核验与供应商原始用量口径；超时不视为成功
 * [POS]: Cola 通信证据解析，不宣称具有指定目录写入、取消或恢复能力
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { z } from 'zod';

const receiptSchema = z.object({
  promptId: z.string().min(1), model: z.string().optional(), version: z.string().optional(),
  timedOut: z.boolean(), durationMs: z.number().nonnegative(), completedAt: z.number().optional(),
  response: z.string(), steps: z.array(z.unknown()),
  usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(), totalTokens: z.number().nonnegative() }).optional(),
});

export function verifyColaCommunication(raw: unknown, expected: { nonce: string; project: string; scope: string }) {
  const receipt = receiptSchema.parse(raw);
  if (receipt.timedOut) throw new Error('Cola 等待超时；CLI 退出码不能证明服务端已停止或已完成');
  if (receipt.steps.length) throw new Error('通信探针执行了未约定的工具步骤，不能按无工具探针验收');
  const response = z.object({ nonce: z.literal(expected.nonce), project: z.literal(expected.project), summary: z.string().min(1) })
    .parse(JSON.parse(receipt.response));
  return {
    protocolVersion: 1, id: 'cola-communication', scope: expected.scope, promptId: receipt.promptId,
    state: 'communication_only', checkedAt: new Date(receipt.completedAt ?? Date.now()).toISOString(),
    durationMs: receipt.durationMs, modelAlias: receipt.model ?? null, cliReportedVersion: receipt.version ?? null,
    summary: response.summary, usage: receipt.usage ?? null,
    projectExecutionVerified: false, cancellationVerified: false, recoveryVerified: false,
  };
}
