/**
 * [INPUT]: lark-cli event consume im.message.receive_v1 --as bot 的 stdout NDJSON 事件流
 * [OUTPUT]: 长连接入站子进程生命周期（启动/停止/异常退避重启），逐行解析为 FeishuChatEvent 交给
 *           ingestFeishuChatEvent 落账，运行态回写 feishuChatIngressRuntime 供状态接口展示
 * [POS]: YZ工作台 飞书私聊入口的传输层；只在 primary 设备启动（与调度器同一 secondary 闸门），
 *        chatEnabled=false 或找不到 lark-cli 时不启动；非正常退出按指数退避重启（5s 起步 60s 封顶），
 *        连续稳定 30 分钟清零；本进程退出钩子尽力 SIGTERM 子进程——kill -9 残留的孤儿消费者
 *        仍写同一张台账且 message_id 去重，事件被哪个消费者接收都能正确落账一次
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { feishuChatIngressRuntime, ingestFeishuChatEvent, isFeishuChatEnabled, type FeishuChatEvent } from './feishu-bot.js';
import { resolveLarkCli } from './lark-cli.js';

const RESTART_BASE_MS = 5_000;
const RESTART_MAX_MS = 60_000;
const STABLE_RESET_MS = 30 * 60_000;

/** 纯函数：一行 stdout → 事件对象；空行/诊断行/非 JSON 返回 null。供解析与验证脚本复用。 */
export function parseIngressLine(line: string): FeishuChatEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as FeishuChatEvent;
  } catch {
    return null;
  }
}

/** 纯函数：不应启动入站时返回原因；可启动返回 null。闸门与日志共用。 */
export function ingressGateReason(env: NodeJS.ProcessEnv, chatEnabled: boolean): string | null {
  if ((env.WORKBENCH_DEVICE_ROLE ?? 'primary').toLowerCase() === 'secondary') return 'secondary-device';
  if (!chatEnabled) return 'chat-disabled';
  return null;
}

let child: ChildProcess | null = null;
let stopRequested = false;
let restartTimer: NodeJS.Timeout | null = null;

function clearRestartTimer(): void {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
}

function noteError(message: string): void {
  feishuChatIngressRuntime.lastError = message.slice(0, 300);
}

function spawnConsumer(cliPath: string): void {
  const startedAt = new Date().toISOString();
  // stdin 必须保持打开：lark-cli event consume 把 stdin EOF 视为退出信号（AI 子进程约定）。
  // 用 pipe 且永不写入——本进程退出时管道关闭，消费者随之干净退出，不残留孤儿连接。
  const proc = spawn(cliPath, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  child = proc;
  stopRequested = false;
  feishuChatIngressRuntime.running = true;
  feishuChatIngressRuntime.startedAt = startedAt;
  console.log(`[feishu-chat] 长连接入站已启动 pid=${proc.pid}`);

  const stdout = proc.stdout;
  if (stdout) {
    const rl = createInterface({ input: stdout });
    rl.on('line', (line) => {
      const event = parseIngressLine(line);
      if (!event) return;
      feishuChatIngressRuntime.lastEventAt = new Date().toISOString();
      try {
        const result = ingestFeishuChatEvent(event);
        if (!result.recorded) console.warn('[feishu-chat] 事件缺 message_id，未落账');
        else if (!result.duplicate && result.chatted) console.log(`[feishu-chat] 入站 ${event.message_type ?? 'message'} ${event.message_id ?? ''}`);
      } catch (error) {
        noteError(`落账异常: ${(error as Error).message}`);
        console.warn('[feishu-chat] 入站落账异常:', (error as Error).message.slice(0, 200));
      }
    });
  }
  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim().split('\n').pop();
    if (line) noteError(line);
  });
  proc.on('error', (error) => noteError(`进程错误: ${(error as Error).message}`));
  proc.on('exit', (code, signal) => {
    child = null;
    feishuChatIngressRuntime.running = false;
    if (stopRequested) { console.log('[feishu-chat] 长连接入站已停止'); return; }
    const lastEventAt = feishuChatIngressRuntime.lastEventAt ? Date.parse(feishuChatIngressRuntime.lastEventAt) : 0;
    const startedMs = Date.parse(startedAt);
    if (startedMs && Date.now() - Math.max(startedMs, lastEventAt) > STABLE_RESET_MS) feishuChatIngressRuntime.restarts = 0;
    feishuChatIngressRuntime.restarts += 1;
    const delay = Math.min(RESTART_BASE_MS * 2 ** Math.min(feishuChatIngressRuntime.restarts - 1, 10), RESTART_MAX_MS);
    console.warn(`[feishu-chat] 入站退出 code=${code} signal=${signal}${feishuChatIngressRuntime.lastError ? ` err=${feishuChatIngressRuntime.lastError.slice(0, 160)}` : ''}，${Math.round(delay / 1000)}s 后重启（第 ${feishuChatIngressRuntime.restarts} 次）`);
    restartTimer = setTimeout(() => { restartTimer = null; void startFeishuChatIngress(); }, delay);
    restartTimer.unref?.();
  });
}

/** 启动长连接入站（幂等）。闸门不满足时记录日志后直接返回，不视为错误。 */
export async function startFeishuChatIngress(): Promise<void> {
  if (child || restartTimer) return;
  const gate = ingressGateReason(process.env, isFeishuChatEnabled());
  if (gate) { console.log(`[feishu-chat] 长连接入站未启动：${gate}`); return; }
  const cliPath = process.env.LARK_CLI_PATH || await resolveLarkCli();
  if (!cliPath) { console.warn('[feishu-chat] 长连接入站未启动：未找到 lark-cli'); return; }
  spawnConsumer(cliPath);
}

/** 停止入站（停止后不再自动重启；再次 start 恢复）。 */
export function stopFeishuChatIngress(): void {
  stopRequested = true;
  clearRestartTimer();
  restartTimer = null;
  if (child?.pid) {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
  child = null;
  feishuChatIngressRuntime.running = false;
}

// 本进程退出（含 process.exit 路径）时尽力带走到期子进程；kill -9 场景由孤儿消费者
// 同库去重 + bus 守护进程 30s 自动回收兜底，见头部 [POS]。
process.on('exit', () => {
  if (child?.pid) {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
});
