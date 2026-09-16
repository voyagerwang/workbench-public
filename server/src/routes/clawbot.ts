/**
 * [INPUT]: 本机 OpenClaw CLI、单账号绑定状态与请求推送的来源身份
 * [OUTPUT]: 微信绑定路由、可信 owner 身份和带消息 ID 的发送回执
 * [POS]: 微信通道边界；校验发送目标及 CLI 结果，未知送达状态不得冒认失败或成功
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { FastifyInstance } from 'fastify';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const CHANNEL = 'openclaw-weixin';
const LOG_PATH = join(tmpdir(), 'workbench-clawbot-login.log');

// ---------- openclaw 可执行文件解析（LaunchAgent / nvm 环境下 PATH 可能不含 nvm bin） ----------

let cachedBin: string | null = null;
let cachedNode: string | null = null;

/** openclaw 要求的 node 版本：>=22.22.3 <23 | >=24.15 <25 | >=25.9 */
function nodeSatisfiesOpenclaw(v: string): boolean {
  const [majS, minS, patchS] = v.replace(/^v/, '').split('.');
  const maj = Number(majS); const min = Number(minS); const patch = Number(patchS);
  if (maj === 22) return min > 22 || (min === 22 && patch >= 3);
  if (maj === 24) return min >= 15;
  if (maj === 25) return min >= 9;
  return maj > 25;
}

/** 找一个能跑 openclaw 的 node 解释器（避开系统默认的 22.22.2） */
function findNodeForOpenclaw(): string | null {
  if (cachedNode) return cachedNode;
  const candidates: string[] = [];
  try {
    const nvm = join(homedir(), '.nvm/versions/node');
    if (existsSync(nvm)) {
      for (const v of readdirSync(nvm).sort().reverse()) candidates.push(join(nvm, v, 'bin', 'node'));
    }
  } catch { /* ignore */ }
  candidates.push(process.execPath);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const v = execFileSync(p, ['-v'], { timeout: 5000, encoding: 'utf8' }).trim();
      if (nodeSatisfiesOpenclaw(v)) { cachedNode = p; return p; }
    } catch { /* ignore */ }
  }
  cachedNode = null;
  return null;
}

/**
 * 返回 openclaw 入口 mjs 的绝对路径。
 * 之前返回 `bin/openclaw` 符号链接，靠 shebang 里的 `env node` 解析解释器，
 * 在系统默认 node 22.22.2 环境下会触发 openclaw 的版本报错——即使 server 自身用别的 node 启动。
 * 改为返回 mjs 绝对路径，配合 findNodeForOpenclaw() 用兼容 node 显式执行，彻底摆脱 PATH 干扰。
 */
function findOpenclaw(): string | null {
  if (cachedBin) return cachedBin;
  const candidates: string[] = [];
  try {
    const nvm = join(homedir(), '.nvm/versions/node');
    if (existsSync(nvm)) {
      for (const v of readdirSync(nvm).sort()) {
        const p = join(nvm, v, 'lib/node_modules/openclaw/openclaw.mjs');
        if (existsSync(p)) candidates.push(p);
      }
    }
  } catch { /* nvm 目录不存在时忽略 */ }
  try {
    const g = execFileSync('npm', ['root', '-g'], { timeout: 5000, encoding: 'utf8' }).trim();
    const p = join(g, 'openclaw/openclaw.mjs');
    if (existsSync(p)) candidates.push(p);
  } catch { /* 全局未安装时忽略 */ }
  cachedBin = candidates[candidates.length - 1] ?? null;
  return cachedBin;
}

function run(bin: string, args: string[], timeoutMs = 25_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const node = findNodeForOpenclaw() ?? process.execPath;
  return new Promise((resolve) => {
    execFile(node, [bin, ...args], { timeout: timeoutMs, env: process.env }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

// ---------- 登录进程管理 ----------

type LoginState = { child: ReturnType<typeof spawn> | null; startedAt: number };
const login: LoginState = { child: null, startedAt: 0 };

function killLogin(): void {
  if (login.child?.pid) {
    try { login.child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
  login.child = null;
}

/** 解析状态输出：- openclaw-weixin <account>: enabled, configured, running */
function parseStatus(text: string): { bound: boolean; running: boolean; account: string | null } {
  const lines = text.split('\n').filter((l) => l.includes(CHANNEL));
  let bound = false;
  let running = false;
  let account: string | null = null;
  for (const line of lines) {
    const m = line.match(new RegExp(`${CHANNEL}\\s+(\\S+?):\\s*(.+)$`));
    const rest = m?.[2] ?? line;
    const acc = m?.[1] ?? null;
    if (acc && acc !== 'default') account = acc;
    if (rest.includes('configured') && acc !== 'default') bound = true;
    if (rest.includes('running')) { bound = true; running = true; if (acc) account = acc; }
  }
  return { bound, running, account };
}

async function probeStatus() {
  const bin = findOpenclaw();
  if (!bin) return { installed: false, bound: false, running: false, account: null as string | null };
  const r = await run(bin, ['channels', 'status', '--probe'], 30_000);
  return { installed: true, ...parseStatus(r.stdout + r.stderr) };
}

// ---------- 微信主动推送（提醒送达用） ----------

const WEIXIN_DIR = join(homedir(), '.openclaw', 'openclaw-weixin');

/** 同步读取已绑定微信账号与「我自己」的目标标识（userId）。未绑定返回 null。 */
export function readWeixinIdentity(): { account: string; target: string } | null {
  try {
    const listPath = join(WEIXIN_DIR, 'accounts.json');
    if (!existsSync(listPath)) return null;
    const ids: unknown = JSON.parse(readFileSync(listPath, 'utf8'));
    if (!Array.isArray(ids) || ids.length !== 1) return null;
    const account = ids[0];
    if (typeof account !== 'string' || !/^[A-Za-z0-9_-]+$/.test(account)) return null;
    const acctPath = join(WEIXIN_DIR, 'accounts', `${account}.json`);
    if (!existsSync(acctPath)) return null;
    const data = JSON.parse(readFileSync(acctPath, 'utf8')) as { userId?: string };
    if (typeof data.userId !== 'string' || !data.userId.trim()) return null;
    return { account, target: data.userId };
  } catch {
    return null;
  }
}

/** 微信是否已绑定且可推送（同步判断，不依赖 openclaw 二进制） */
export function isWeixinReady(): boolean {
  return readWeixinIdentity() !== null;
}

/**
 * 主动往用户微信推一条文本（提醒到点通知）。
 * 底层走 openclaw message send；账号与目标从本机 openclaw 状态文件读取，不硬编码。
 */
export type ClawbotSendResult = { ok: boolean; error?: string; messageId?: string; outcome: 'sent' | 'failed' | 'unknown' };

/** CLI 可以输出前导日志；只接受唯一、位于末尾的 JSON 对象，不凭展示文案判断送达。 */
export function parseClawbotSendReceipt(stdout: string, code = 0): ClawbotSendResult {
  if (code !== 0) return { ok: false, outcome: 'unknown', error: '微信发送进程异常结束，送达状态未知，请勿自动重发' };
  const lines = stdout.trim().split(/\r?\n/);
  const candidates: unknown[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trimStart().startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(lines.slice(i).join('\n'));
      // 前缀含另一个 JSON 对象时不猜测哪条才是这次发送的权威回执。
      if (lines.slice(0, i).some((line) => line.trimStart().startsWith('{'))) continue;
      candidates.push(parsed);
    } catch { /* 前导日志或未闭合 JSON 不构成回执。 */ }
  }
  if (candidates.length !== 1) return { ok: false, outcome: 'unknown', error: '微信发送未取得唯一 JSON 回执，送达状态未知' };
  const value = candidates[0];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, outcome: 'unknown', error: '微信发送回执格式无效' };
  const receipt = value as Record<string, unknown>;
  if (receipt.action !== 'send' || receipt.channel !== CHANNEL || receipt.dryRun !== false || receipt.error) {
    return { ok: false, outcome: 'unknown', error: '微信发送回执与本次操作不符' };
  }
  if (typeof receipt.messageId !== 'string' || !receipt.messageId.trim()) {
    return { ok: false, outcome: 'failed', error: '微信发送未产生消息 ID，可能被通道取消' };
  }
  return { ok: true, outcome: 'sent', messageId: receipt.messageId.trim() };
}

export async function sendClawbotMessage(text: string, expectedTarget?: string): Promise<ClawbotSendResult> {
  const identity = readWeixinIdentity();
  if (!identity) return { ok: false, outcome: 'failed', error: '微信未绑定唯一账号，请先在设置页检查 ClawBot 绑定' };
  if (expectedTarget !== undefined && expectedTarget !== identity.target) {
    return { ok: false, outcome: 'failed', error: '任务来源与当前微信绑定用户不一致，未发送' };
  }
  const bin = findOpenclaw();
  if (!bin) return { ok: false, outcome: 'failed', error: '未安装 OpenClaw' };
  const r = await run(bin, [
    'message', 'send', '--json',
    '--channel', CHANNEL,
    '--account', identity.account,
    '--target', identity.target,
    '-m', text,
  ], 30_000);
  return parseClawbotSendReceipt(r.stdout, r.code);
}

// ---------- 路由 ----------

export default async function clawbotRoutes(app: FastifyInstance) {
  app.get('/api/clawbot/status', async () => probeStatus());

  // 发起绑定：杀掉旧登录进程，重新起一个，二维码写入 LOG_PATH
  app.post('/api/clawbot/bind', async () => {
    const bin = findOpenclaw();
    if (!bin) throw app.httpErrors.badRequest('未找到 openclaw 命令，请先安装 OpenClaw（npm install -g openclaw@latest）');
    killLogin();
    const fd = openSync(LOG_PATH, 'w');
    const node = findNodeForOpenclaw() ?? process.execPath;
    const child = spawn(node, [bin, 'channels', 'login', `--channel=${CHANNEL}`], {
      env: process.env,
      stdio: ['ignore', fd, fd],
      detached: false,
    });
    closeSync(fd);
    login.child = child;
    login.startedAt = Date.now();
    child.on('exit', () => { if (login.child === child) login.child = null; });
    return { ok: true, startedAt: login.startedAt };
  });

  // 轮询二维码：登录进程活着 → 返回最新二维码链接；进程退出 → 探测是否绑定成功
  app.get('/api/clawbot/bind/qr', async () => {
    const alive = Boolean(login.child?.pid);
    let qrUrl: string | null = null;
    if (existsSync(LOG_PATH)) {
      const text = readFileSync(LOG_PATH, 'utf8');
      const urls = text.match(/https:\/\/liteapp\.weixin\.qq\.com\/[^\s'"]+/g);
      qrUrl = urls?.[urls.length - 1] ?? null;
    }
    if (alive) return { alive: true, qrUrl, bound: false, running: false };
    const status = await probeStatus();
    return { alive: false, qrUrl, ...status };
  });

  // 取消本次扫码登录
  app.post('/api/clawbot/cancel', () => {
    killLogin();
    return { ok: true };
  });

  // 解绑
  app.post('/api/clawbot/unbind', async () => {
    const bin = findOpenclaw();
    if (!bin) throw app.httpErrors.badRequest('未找到 openclaw 命令');
    killLogin();
    await run(bin, ['channels', 'logout', `--channel=${CHANNEL}`], 30_000);
    const status = await probeStatus();
    if (status.bound) {
      // logout 未生效时尝试按账号解绑
      if (status.account) {
        await run(bin, ['channels', 'logout', `--channel=${CHANNEL}`, `--account=${status.account}`], 30_000);
      }
    }
    const after = await probeStatus();
    return { ok: !after.bound, ...after };
  });
}
