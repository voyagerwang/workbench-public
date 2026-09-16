/**
 * [INPUT]: feishu_bot_messages 表中 event_id='relay-poll' 的群聊/私聊消息,以及 .handoff/relay/registry.json 实验任务登记
 * [OUTPUT]: 回执匹配后的 registry 状态迁移(回执含原文与 message_id)、.handoff/relay/board.md 看板(registry 只读投影,随落盘重渲染)、.handoff/relay/reviews 审核卡与 codex 输出快照、指挥部群回执与审核通知
 * [POS]: 编排 V3 阶段 0 已冻结的实验链路(docs/agent-orchestration-handoff-v3.md),默认关闭;
 *        正式链路以 SQLite agent_tasks 为真相源,不读取 .handoff/relay/registry.json 作为权威状态
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 飞书中继派单:回执匹配 + 独立 Codex 审核 + 结果回群。
 * server 只做确定性中继(正则提取回执、登记状态、唤醒审核),不判断业务对错——
 * 结论一律由 codex exec 独立进程写入审核卡,再由这里原文转播回群。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, getSetting } from '../db.js';
import { resolveLarkCli } from './lark-cli.js';
import { isRelayExperimentEnabled } from './feishu-bot.js';

const execFileAsync = promisify(execFile);

// dist 进程 cwd 是 server/,仓库根在上一级;允许环境变量覆盖以便异机部署。
const REPO_ROOT = process.env.WORKBENCH_ROOT ?? path.resolve(process.cwd(), '..');
const RELAY_DIR = path.join(REPO_ROOT, '.handoff', 'relay');
const REGISTRY_FILE = path.join(RELAY_DIR, 'registry.json');
const BOARD_FILE = path.join(RELAY_DIR, 'board.md');
// 回群通知里统一带上看板路径:群消息只有一句话,细节按任务 ID 去看板和任务卡
const BOARD_HINT = `看板 .handoff/relay/board.md`;

type RelayTask = {
  status: 'dispatched' | 'executing' | 'pending_review' | 'approved' | 'blocked' | 'needs_human';
  executor: string;
  dispatched_at: string;
  dispatch_message_id: string | null;
  receipts: Array<{ at: string; sender: string; verdict: string; message_id: string | null; raw?: string }>;
  review_status: 'approved' | 'changes_requested' | 'blocked' | 'timeout' | 'failed' | null;
  review_message_id: string | null;
};
type Registry = Record<string, RelayTask>;

const reviewing = new Set<string>();
let cursorRowId = 0;

// 单写队列:registry 的所有读-改-写(轮询回执匹配、审核退出回调、前置失败转人工)只从这里串行通过,
// 防止多路径各自持有旧快照整体覆盖、丢掉彼此刚写入的状态;board 在每次提交后从同一快照重渲染
let registryQueue: Promise<unknown> = Promise.resolve();
export function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = registryQueue.then(fn, fn);
  registryQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** 审核卡首行协议:第一行必须恰好是 "verdict: APPROVED|CHANGES_REQUESTED|BLOCKED",
 *  整行精确匹配(仅兼容 CRLF),不做大小写/空白/全角冒号/行尾缀任何放宽 */
export function parseFirstLineVerdict(text: string): 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED' | null {
  const firstLine = (text.split('\n', 1)[0] ?? '').replace(/\r$/, '');
  const m = /^verdict: (APPROVED|CHANGES_REQUESTED|BLOCKED)$/.exec(firstLine);
  return (m?.[1] as 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED') ?? null;
}

/** 从消息文本提取执行方回执;人类派单消息同样含 [DONE][id] 字样,调用方必须先按 sender_type 过滤 */
export function matchReceipt(text: string): { verdict: 'DONE' | 'BLOCKED'; taskId: string } | null {
  const m = /\[(DONE|BLOCKED)\]\[([A-Za-z0-9_-]+)\]/.exec(text);
  return m ? { verdict: m[1] as 'DONE' | 'BLOCKED', taskId: m[2]! } : null;
}

function loadRegistry(): Registry { try { return JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as Registry; } catch { return {}; } }

const STATUS_LABELS: Record<RelayTask['status'], string> = {
  dispatched: '待执行', executing: '执行中', pending_review: '待审核',
  approved: '已通过', blocked: '已阻塞', needs_human: '转人工',
};
const REVIEW_LABELS: Record<NonNullable<RelayTask['review_status']>, string> = {
  approved: '通过', changes_requested: '返工', blocked: '阻塞', timeout: '超时', failed: '失败',
};

function localNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 看板是 registry 的只读投影:群和本文件都只当视图,状态只认 registry.json(单写者原则) */
export function renderRelayBoard(registry: Registry, generatedAt: string): string {
  const ids = Object.keys(registry).sort();
  const rows = ids.map((id) => {
    const t = registry[id]!;
    const receipts = t.receipts.length ? t.receipts.map((r) => `${r.verdict}(${r.sender})`).join(' ') : '—';
    const review = t.review_status ? REVIEW_LABELS[t.review_status] : '—';
    const dispatched = t.dispatched_at.slice(5, 16).replace('T', ' ');
    // 投影要诚实:卡不存在就明说缺失,不渲染死链(PING-005 就是没有任务卡)
    const link = (label: string, file: string) => existsSync(path.join(RELAY_DIR, file)) ? `[${label}](${file})` : `${label}缺失`;
    return `| ${id} | ${STATUS_LABELS[t.status] ?? t.status} | ${t.executor} | ${dispatched} | ${receipts} | ${review} | ${link('任务', `tasks/${id}.md`)} · ${link('审核', `reviews/${id}.md`)} |`;
  });
  return [
    '# 中继任务看板(自动生成,勿手编)',
    '',
    '> 真相源是 registry.json,本文件由 relay-dispatch 在每次状态迁移时整体重渲染;任务细节看各任务卡,群里只说短话。',
    `> 更新: ${generatedAt} · 任务数 ${ids.length}`,
    '',
    '| 任务 | 状态 | 执行方 | 派发 | 回执 | 审核 | 卡片 |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

async function saveRegistry(registry: Registry): Promise<void> {
  await mkdir(RELAY_DIR, { recursive: true });
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  try { await writeFile(BOARD_FILE, renderRelayBoard(registry, localNow()), 'utf8'); }
  catch (error) { console.warn('[relay] 看板渲染失败:', (error as Error).message.slice(0, 200)); }
}

function codexCommand(): string {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex';
  return existsSync(bundled) ? bundled : 'codex';
}

/** 扫描收件表里未处理的 relay 行,提取 [DONE|BLOCKED][task_id] 回执并推进状态 */
export async function processRelayReceipts(): Promise<{ matched: string[]; reviews: string[] }> {
  // 阶段 0 冻结:实验链路默认禁用,防御性二次闸门(即使被未来调用方绕过调度器开关也不会拉起 Codex)
  if (!isRelayExperimentEnabled()) return { matched: [], reviews: [] };
  const matched: string[] = [];
  const reviews: string[] = [];
  if (cursorRowId === 0) {
    const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS max FROM feishu_bot_messages WHERE event_id = 'relay-poll'").get() as { max: number };
    cursorRowId = row.max; // 冷启动跳过存量,回执幂等由 registry 状态守卫
  }
  const rows = db.prepare(
    "SELECT id, message_id, content FROM feishu_bot_messages WHERE event_id = 'relay-poll' AND id > ? ORDER BY id ASC",
  ).all(cursorRowId) as Array<{ id: number; message_id: string | null; content: string }>;
  for (const row of rows) {
    cursorRowId = row.id;
    let parsed: { sender?: { name?: string; sender_type?: string }; content?: string } = {};
    try { parsed = JSON.parse(row.content); } catch { continue; }
    const text = parsed.content ?? '';
    // 派单指令本身就含 "[DONE][id]" 字样,而执行方(7号/zcode)都是 bot;
    // 人类发的消息一律不算回执,防止派单人自匹配抢先开审(PING-007 实证踩过)
    if (parsed.sender?.sender_type === 'user') continue;
    const receipt = matchReceipt(text);
    if (!receipt) continue;
    const verdict = receipt.verdict;
    const taskId = receipt.taskId;
    let blocked = false;
    let startReview = false;
    // 单写闸内只做"读最新账本→改→存";审核启动在闸外(见下),避免不可重入自锁
    await withRegistryLock(async () => {
      const registry = loadRegistry();
      const task = registry[taskId];
      // 只有未开审的任务才收回执:pending_review 及终态一律忽略,防止确认卡片里的
      // [DONE][id] 字样和审核消息把回执记重、把已审任务拖回待审。
      if (!task || (task.status !== 'dispatched' && task.status !== 'executing')) return;
      // Codex 审核需要可核验的证据:保留回执原文与真实 message_id,否则它只见到自报的 verdict 会以证据不足拒审
      task.receipts.push({ at: new Date().toISOString(), sender: parsed.sender?.name ?? 'unknown', verdict, message_id: row.message_id ?? null, raw: text.slice(0, 500) });
      matched.push(taskId);
      if (verdict === 'BLOCKED') {
        task.status = 'needs_human';
        blocked = true;
      } else {
        task.status = 'pending_review';
        startReview = true;
      }
      await saveRegistry(registry);
    });
    // 发群消息和审核启动都在闸外:群发送有 20s 超时,审核前置失败路径要自己取锁提交转人工
    if (blocked) await sendRelayMessage(`[BLOCKED][${taskId}] 执行方回报阻塞,已转人工处理(不自动重试)。${BOARD_HINT}`);
    else if (startReview && await spawnCodexReview(taskId)) reviews.push(taskId);
  }
  return { matched, reviews };
}

/** 唤醒独立 codex exec 写审核卡;单飞守卫防止同任务重复审核。返回是否真正启动。
 *  必须在 registry 单写闸之外调用:前置失败转人工要自己取锁提交。
 *  审核前置失败(目录建不了、旧卡删不掉)一律转人工,绝不带着残留审核卡/快照开审 */
export async function spawnCodexReview(taskId: string): Promise<boolean> {
  if (reviewing.has(taskId)) return false;
  const reviewFile = path.join(RELAY_DIR, 'reviews', `${taskId}.md`);
  // -o 捕获的是 codex 最终对话消息,会整文件覆盖同名路径,绝不能与审核卡同路径,否则卡片被冲掉、verdict 只能靠最终消息里恰好提到
  const outputSnapshot = path.join(RELAY_DIR, 'reviews', `${taskId}.out.md`);
  const abortReview = async (reason: string) => {
    console.error(`[relay] 审核 ${taskId} 前置失败: ${reason}`);
    await withRegistryLock(async () => {
      const reg = await loadRegistryFresh();
      const task = reg[taskId];
      if (task) { task.review_status = 'failed'; task.status = 'needs_human'; await saveRegistry(reg); }
    });
    void sendRelayMessage(`[REVIEW][${taskId}] Codex 审核前置失败(${reason}),已转人工。${BOARD_HINT}`);
    return false;
  };
  try { await mkdir(path.join(RELAY_DIR, 'reviews'), { recursive: true }); } catch { return await abortReview('审核目录创建失败'); }
  // 清掉上一轮返工残留的审核卡/快照;只容忍文件本就不存在,其他删除错误必须中止本轮审核
  try { unlinkSync(reviewFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return await abortReview('旧审核卡删除失败'); }
  try { unlinkSync(outputSnapshot); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return await abortReview('旧快照删除失败'); }
  reviewing.add(taskId);
  const child = spawn(codexCommand(), [
    'exec', '-C', REPO_ROOT, '-o', outputSnapshot,
    `读 .handoff/relay/registry.json 中 ${taskId} 的登记与回执(含 raw 回执原文与 message_id),并核对 .handoff/relay/tasks/${taskId}.md 任务卡。` +
    `这是通信链路 PING 类测试任务:回执原文含 [DONE][${taskId}] 即合格。` +
    `把审核结论写入 .handoff/relay/reviews/${taskId}.md,第一行必须是 "verdict: APPROVED" 或 "verdict: CHANGES_REQUESTED" 或 "verdict: BLOCKED",随后给理由。不要修改任何其他文件。`,
  ], { stdio: 'ignore', env: process.env });
  console.log(`[relay] Codex 审核进程已启动 pid=${child.pid ?? 'null'} task=${taskId}`);
  child.on('error', (error) => {
    console.error('[relay] Codex 审核进程启动失败:', (error as Error).message);
  });
  child.on('exit', async (code, signal) => {
    reviewing.delete(taskId);
    console.log(`[relay] Codex 审核进程退出 task=${taskId} code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    // 审核卡首行协议:第一行必须精确合法,不做全文搜索,防止最终消息里恰好提到的字样被误当结论
    let verdictText = '';
    try { verdictText = (await readFile(reviewFile, 'utf8')).slice(0, 600); } catch { verdictText = ''; }
    let verdict = parseFirstLineVerdict(verdictText);
    if (!verdict) {
      // 审核卡缺失或首行无效时,退回 codex 最终消息快照的首行;再无效就走转人工
      try { verdictText = (await readFile(outputSnapshot, 'utf8')).slice(0, 600); } catch { verdictText = ''; }
      verdict = parseFirstLineVerdict(verdictText);
    }
    // 账本改动进单写闸;群通知在闸外发,别用 20s 的发送超时挡其他任务
    let notice: string | null = null;
    await withRegistryLock(async () => {
      // 审核期间 matcher 可能已写盘,必须基于最新 registry 改终态,否则改动会被覆盖
      const reg = await loadRegistryFresh();
      const task = reg[taskId];
      if (!task) { console.warn(`[relay] 审核 ${taskId} 退出但 registry 无此任务,忽略`); return; }
      if (code !== 0 || !verdict) {
        task.review_status = 'failed';
        task.status = 'needs_human';
        notice = `[REVIEW][${taskId}] Codex 审核异常(退出码 ${code ?? 'null'},无有效 verdict),已转人工。${BOARD_HINT}`;
      } else {
        task.review_status = verdict === 'APPROVED' ? 'approved' : verdict === 'BLOCKED' ? 'blocked' : 'changes_requested';
        task.status = verdict === 'APPROVED' ? 'approved' : verdict === 'BLOCKED' ? 'needs_human' : 'dispatched';
        const receiptLine = verdictText.split('\n').slice(1).join(' ').trim().slice(0, 200);
        notice = `[REVIEW][${taskId}] ${verdict}${receiptLine ? ` — ${receiptLine}` : ''}(Codex 独立审核)。${BOARD_HINT}`;
      }
      await saveRegistry(reg);
    });
    if (notice) await sendRelayMessage(notice);
  });
  return true;
}

async function loadRegistryFresh(): Promise<Registry> { try { return JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) as Registry; } catch { return {}; } }

/** 以用户身份把审核结论发回中继群 */
async function sendRelayMessage(text: string): Promise<void> {
  try {
    const chatId = getSetting<{ relayChatId?: string }>('feishuBot')?.relayChatId;
    if (!chatId) return;
    const cliPath = process.env.LARK_CLI_PATH || await resolveLarkCli();
    if (!cliPath) return;
    await execFileAsync(cliPath, ['im', '+messages-send', '--chat-id', chatId, '--as', 'user', '--text', text, '--json'], { timeout: 20_000, env: process.env, maxBuffer: 1024 * 1024 });
  } catch (error) {
    console.warn('[relay] 群发失败:', (error as Error).message.slice(0, 200));
  }
}
