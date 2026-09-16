/**
 * [INPUT]: Fastify 错误对象（ZodError / 服务层抛出的业务错误 / 未知内部错误）
 * [OUTPUT]: 统一 JSON 错误响应——{ error, code?, validation? }；code 只透传服务层显式声明的 publicCode
 * [POS]: 全局错误契约边界（KB15-P0-MAJ-001 R1 收窄定稿）：业务稳定 code 必须经 publicCode 显式声明
 *        才出 HTTP 边界，内部错误的 code（如 SQLITE_BUSY）不得泄露；500 记日志不回显细节
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { ZodError } from 'zod';

type HttpError = Error & { statusCode?: number; validation?: unknown; publicCode?: unknown };

/**
 * 统一错误处理器：
 * - ZodError → 400 + 可读字段说明 + validation；
 * - 带 publicCode 的业务错误 → 按 statusCode 返回并携带稳定 code（客户端按 code 分支，不解析文案）；
 * - 其余（含内部错误的裸 code）→ 不携带 code，避免向客户端泄露实现细节。
 */
export function httpErrorHandler(err: HttpError, _req: unknown, reply: { status: (n: number) => { send: (v: unknown) => unknown } }): unknown {
  if (err instanceof ZodError) {
    return reply.status(400).send({
      error: err.issues.map((issue) => `${issue.path.join('.') || '输入'}：${issue.message}`).join('；'),
      validation: err.issues,
    });
  }
  const status = err.statusCode ?? 500;
  if (status >= 500) console.error('[error]', err);
  const code = typeof err.publicCode === 'string' && err.publicCode ? { code: err.publicCode } : {};
  return reply.status(status).send({ error: err.message, ...code, validation: err.validation });
}
