/**
 * [INPUT]: 固定 Cola CLI、独占 scope 和冻结的文档任务包（或文本模式的会话编号）；本地服务 JSON 结束回执
 * [OUTPUT]: 返回内容型 ExecutorAdapter；文档模式渲染验收清单，文本模式直返 Markdown 正文；工具步骤/超时拒绝，停止仅指 CLI 进程
 * [POS]: Cola 文档生成与内容线文本总结适配，不宣称原生目录绑定或工具沙箱；文档成果写入复用 execution-probe
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ExecutorAdapter, ExecutorExit } from './executor-contract.js';
import { renderDocumentResult, type FrozenDocumentPacket } from './document-task-packet.js';

const receiptSchema = z.object({
  promptId: z.string().min(1), response: z.string().max(50_000), timedOut: z.boolean(), steps: z.array(z.unknown()),
  model: z.string().max(200).optional(),
  usage: z.object({ inputTokens: z.number().finite().nonnegative(), outputTokens: z.number().finite().nonnegative(),
    cacheReadTokens: z.number().finite().nonnegative().optional(), totalTokens: z.number().finite().nonnegative().optional() }).optional(),
});
export function colaDocumentAdapter(config: { binary: string; packet?: FrozenDocumentPacket; waitMs: number; env?: NodeJS.ProcessEnv;
  /** 内容线文本总结模式：不接文档任务包，直接把回执 response 作为 Markdown 正文返回。 */
  textOnly?: boolean; sessionId?: string }): ExecutorAdapter {
  if (config.textOnly) {
    if (config.packet) throw new Error('Cola 文本模式不接受文档任务包');
    if (!config.sessionId || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/.test(config.sessionId)) throw new Error('Cola 会话编号不合法');
  } else if (!config.packet) throw new Error('Cola 文档模式缺少冻结任务包');
  const packet = config.packet;
  const scope = config.textOnly ? String(config.sessionId) : `bridge:g0:document:${packet!.taskId}`;
  return {
    capabilities: { protocolVersion: 1, id: config.textOnly ? 'cola-text' : 'cola-document', projectDirectory: false, artifactDelivery: 'returned-content',
      progressEvents: false, cancellation: 'local-process', resume: false },
    start({ prompt, onEvent }) {
      // cwd 不传给 Cola 服务端；scope 与绝对项目路径不构成软件的文件权限控制。
      const child = spawn(config.binary, ['message', '--session', scope, '--json', prompt], {
        shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...(config.env ?? process.env), COLA_CLI_TIMEOUT_MS: String(config.waitMs) },
      });
      let stdout = ''; let bytes = 0; let error: string | null = null; let closed = false;
      let stopping = false; let timer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (closed || !child.pid) return;
        try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') error = '未能停止 Cola CLI'; }
      };
      const interrupt = () => { if (closed || stopping) return; stopping = true; kill('SIGTERM'); timer = setTimeout(() => kill('SIGKILL'), 2000); };
      const completion = new Promise<ExecutorExit>((resolve) => {
        child.on('error', () => { error = 'Cola CLI 启动失败'; });
        child.stdout.setEncoding('utf8');
        const receive = (chunk: string | Buffer, output: boolean) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 200_000) { error = 'Cola 回执超过大小上限'; interrupt(); return; }
          if (output) stdout += chunk;
        };
        child.stdout.on('data', (chunk: string) => receive(chunk, true));
        child.stderr.on('data', (chunk: Buffer) => receive(chunk, false));
        child.on('close', (exitCode, signal) => {
          closed = true; if (timer) clearTimeout(timer);
          const result: ExecutorExit = { exitCode, signal, localProcessClosed: true, protocolCompleted: false, usage: null, error, remoteOutcomeUnknown: true };
          try {
            if (exitCode !== 0 || stopping || error) throw new Error(error ?? 'Cola CLI 未正常完成；服务端状态需核对');
            const receipt = receiptSchema.parse(JSON.parse(stdout));
            onEvent({ type: 'accepted', sessionId: receipt.promptId });
            if (receipt.usage) result.usage = { inputTokens: receipt.usage.inputTokens, outputTokens: receipt.usage.outputTokens,
              cachedInputTokens: receipt.usage.cacheReadTokens ?? null, reportedTotalTokens: receipt.usage.totalTokens, inputIncludesCache: false };
            result.modelAlias = receipt.model;
            if (receipt.timedOut) throw new Error('Cola 等待超时，服务端状态未知，不可自动重派');
            result.remoteOutcomeUnknown = false;
            if (receipt.steps.length) throw new Error('Cola 使用了工具；不符合本次返回内容的验收范围');
            if (config.textOnly) {
              const body = receipt.response.trim();
              if (!body) throw new Error('Cola 返回正文为空');
              result.artifactContent = body;
            } else {
              result.artifactContent = renderDocumentResult(receipt.response, packet!);
            }
            result.protocolCompleted = true;
          } catch (cause) { result.error = cause instanceof z.ZodError || cause instanceof SyntaxError ? 'Cola 返回格式或任务关联不符合约定' : (cause as Error).message; }
          resolve(result);
        });
      });
      return { completion, interrupt };
    },
  };
}
