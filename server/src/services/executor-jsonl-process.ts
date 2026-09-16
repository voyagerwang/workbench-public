/**
 * [INPUT]: 应用装配的可执行文件/argv/环境、固定目录和 JSONL 消费函数
 * [OUTPUT]: 有界 stdout/stderr、进程 close 与仅针对本次进程组的停止句柄
 * [POS]: CLI 执行器共用进程层；不解释供应商成功状态或业务成果
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { spawn } from 'node:child_process';

export function executorJsonlProcess(config: {
  binary: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; prompt: string;
  onLine: (line: string) => void; onStderr?: (text: string) => void;
}) {
  const child = spawn(config.binary, config.args, { cwd: config.cwd, env: config.env ?? process.env,
    shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; let bytes = 0; let closed = false; let stopping = false; let error: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = (value: NodeJS.Signals) => {
    if (closed || !child.pid) return;
    try { if (process.platform === 'win32') child.kill(value); else process.kill(-child.pid, value); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') error = '无法确认本机执行进程已停止'; }
  };
  const interrupt = () => { if (closed || stopping) return; stopping = true; signal('SIGTERM'); timer = setTimeout(() => signal('SIGKILL'), 2000); };
  const line = (value: string) => {
    if (!value.trim() || error) return;
    try { config.onLine(value); } catch { error = '执行器事件协议无效'; interrupt(); }
  };
  const completion = new Promise<{ exitCode: number | null; signal: string | null; localProcessClosed: true; error: string | null }>((resolve) => {
    child.on('error', () => { error = '执行器进程启动失败'; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2_000_000) { error = '执行器输出超过限制'; interrupt(); return; }
      buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const value of lines) line(value);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) { error = '执行器输出超过限制'; interrupt(); return; }
      try { config.onStderr?.(chunk.toString('utf8')); } catch { error = '执行器诊断处理失败'; interrupt(); }
    });
    child.stdin.on('error', () => { /* 结束状态统一以 close 为准 */ });
    child.on('close', (exitCode, exitSignal) => {
      closed = true; if (timer) clearTimeout(timer);
      if (buffer.trim()) line(buffer);
      resolve({ exitCode, signal: exitSignal, localProcessClosed: true, error });
    });
    child.stdin.end(config.prompt);
  });
  return { completion, interrupt };
}
