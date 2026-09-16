/**
 * [INPUT]: SQLite 本地数据(reminders、派发计划等)、钉钉/ICS/CalDAV 日历源、飞书与钉钉知识库快照、
 *          飞书派单回音台账、飞书中继群与 agent 私聊消息(仅 relayExperimentEnabled===true 时轮询)、
 *          YZ工作台 飞书私聊长连接事件(lark-cli event consume，feishuBot.chatEnabled≠false)
 * [OUTPUT]: 提醒到期触发与送达退避重试、日历周期同步、知识基线每日增量更新、派单回音追踪、
 *           过期派发计划清理、正式只读Agent任务执行/验收/通知、本地转写成果原子归档、中继实验链路收件与回执处理(默认冻结)、
 *           飞书私聊长连接入站子进程生命周期
 * [POS]: 服务端后台定时调度中枢;secondary 设备停用有外部副作用的任务;
 *        中继实验属编排 V3 阶段 0,开关在 feishuBot.relayExperimentEnabled,默认关闭
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { db, now, newId } from './db.js';
import { getConfig, syncEvents } from './services/dingtalk.js';
import { getCaldavFlag } from './services/caldav.js';
import { getIcsUrl, syncCaldav, syncIcs } from './routes/time.js';
import { deliverRows, retryFailedDeliveries, type DeliveryRow } from './services/reminder-delivery.js';
import { refreshFeishuKb } from './services/feishu-kb.js';
import { refreshDingtalkKbSnapshot } from './routes/knowledge.js';
import { repeatIntervalDays } from './services/recurrence.js';
import { pollFeishuDispatches } from './services/assistant-actions.js';
import { expirePlans } from './services/dispatch-plan.js';
import { pollRelayMessages, isRelayExperimentEnabled, compensatePendingFeishuChats } from './services/feishu-bot.js';
import { startFeishuChatIngress } from './services/feishu-chat-ingress.js';
import { processRelayReceipts } from './services/relay-dispatch.js';
import { createExecutionCoordinator } from './services/execution-coordinator.js';
import { configureExecutionSignals, executionConcurrency } from './services/execution-signals.js';
import { dispatchConfig } from './services/agent-dispatch.js';
import { dispatchRuntime, contentRuntime } from './services/agent-dispatch.js';
import { deliverAgentNotifications, recoverAgentNotifications } from './services/agent-notifications.js';

const FIRE_INTERVAL_MS = 15_000;
const SYNC_INTERVAL_MS = 5 * 60_000;
// 派单回音的兜底扫描频率。动作级退避（20s→2min）由台账自己控制，这里只保证"总会被扫到"。
const ACTION_POLL_INTERVAL_MS = 30_000;
/** 确认窗口是 15 分钟，30s 扫一次足够密：最坏情况也就多挂半分钟。 */
const PLAN_EXPIRY_INTERVAL_MS = 30_000;
const KB_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 知识基线快照：每日一次增量更新

/** 计算重复提醒的下一次触发时间 */
export function nextTrigger(triggerAt: string, rule: string): string | null {
  if (rule === 'none') return null;
  const d = new Date(triggerAt);
  const interval = repeatIntervalDays(rule);
  if (interval !== null) d.setDate(d.getDate() + interval);
  else switch (rule) {
    case 'daily': d.setDate(d.getDate() + 1); break;
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'monthly': {
      // 同日序号顺延一个月，月末自动收敛（1月31日 → 2月28日）
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
      break;
    }
    case 'weekdays': {
      do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
      break;
    }
    default: return null;
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fireDueReminders(): void {
  const due = db.prepare(
    "SELECT id, message, trigger_at, repeat_rule, channel, linked_task_id, series_id FROM reminders WHERE status = 'pending' AND trigger_at <= ? AND deleted_at IS NULL",
  ).all(now()) as Array<{ id: number; message: string; trigger_at: string; repeat_rule: string; channel: string; linked_task_id: number | null; series_id: string | null }>;
  if (due.length === 0) return;

  const ts = now();
  const fired: typeof due = [];
  for (const r of due) {
    // 每次触发都把回执重置回「待投递」：上一轮的失败/降级说明不该串到新一期。
    // WHERE 里带上 status = 'pending' 是幂等闸门：同一批到期提醒被重复处理时
    // （调度重入、多进程、同步回放），第二次 UPDATE 影响行数为 0，直接跳过，
    // 否则每个重复路径都会再插一条下一期，重复提醒会一期期翻倍。
    const updated = db.prepare(
      `UPDATE reminders
          SET status = 'fired', fired_at = ?, delivery_status = 'pending', delivery_attempts = 0,
              delivery_error = NULL, delivered_channels = '', channel_note = NULL, next_retry_at = NULL
        WHERE id = ? AND status = 'pending' AND deleted_at IS NULL`,
    ).run(ts, r.id);
    if (updated.changes === 0) continue; // 已被别的路径处理过
    fired.push(r);

    const next = nextFutureTrigger(r.trigger_at, r.repeat_rule);
    if (next) {
      // 双保险：同一内容同一时刻已经排了一期就不再插。历史脏数据（同一提醒被建了多份）
      // 也能在下一轮收敛，而不是每期继续各自复制。
      const dup = db.prepare(
        `SELECT id FROM reminders
          WHERE message = ? AND repeat_rule = ? AND trigger_at = ? AND status = 'pending' AND deleted_at IS NULL
          LIMIT 1`,
      ).get(r.message, r.repeat_rule, next) as { id: number } | undefined;
      if (dup) continue;

      // 重复提醒：生成下一期 pending 实例（保留送达渠道、关联任务，并继承系列标识）
      // 老数据没有 series_id：现场补一个，让这一系列从现在起可被归组
      const seriesId = r.series_id ?? String(newId());
      db.prepare("UPDATE reminders SET series_id = ? WHERE id = ? AND series_id IS NULL").run(seriesId, r.id);
      db.prepare('INSERT INTO reminders (id, message, trigger_at, repeat_rule, channel, linked_task_id, series_id, status) VALUES (sync_id(), ?, ?, ?, ?, ?, ?, ?)')
        .run(r.message, next, r.repeat_rule, r.channel, r.linked_task_id ?? null, seriesId, 'pending');
    }
  }
  void deliverRows(fired.map((r): DeliveryRow => ({ id: r.id, message: r.message, trigger_at: r.trigger_at, channel: r.channel, delivery_attempts: 0 })));
}

/**
 * 重复提醒的下一期时间，并保证落在未来。
 * 关机 / 服务停了几天后再启动，老逻辑只会加一个周期，算出来的时间仍在过去，
 * 于是下一拍又立刻触发，一路补弹到追上当下。这里直接跳到第一个未来的期次：
 * 中间错过的期次不再补，只保留一次「已响」的记录。
 */
function nextFutureTrigger(triggerAt: string, rule: string): string | null {
  let next = nextTrigger(triggerAt, rule);
  let guard = 0;
  while (next && next <= now() && guard++ < 366) {
    const advanced = nextTrigger(next, rule);
    if (!advanced || advanced <= next) break; // 规则算不出更晚的时间，停手
    next = advanced;
  }
  return next;
}

// ---------- 送达回执 ----------
// 实现在 services/reminder-delivery.ts：重发接口（routes/time.ts）也要用，
// 放在这里会让 routes/time ↔ scheduler 循环依赖。

let lastSync = 0;
let lastIcsSync = 0;
let lastCaldavSync = 0;
let lastKbRefresh = 0;

/** 知识基线快照每日增量更新：只抓云端变动文档；失败只记日志，不影响其他调度 */
async function refreshKnowledgeBaseline(): Promise<void> {
  if (Date.now() - lastKbRefresh < KB_REFRESH_INTERVAL_MS) return;
  lastKbRefresh = Date.now();
  const result = await refreshFeishuKb();
  if (!result.ok) console.warn('[kb] 每日快照增量更新失败:', result.error);
  else console.log('[kb] 每日快照增量更新完成');
}

/** 钉钉本地快照每日增量更新：内容没变的文档会自动跳过 */
function refreshDingtalkKb(): void {
  const job = refreshDingtalkKbSnapshot();
  if (job) console.log('[kb] 钉钉快照每日增量更新已启动');
}

/** 飞书派单回音追踪：失败只记日志，绝不影响提醒与日历同步 */
async function pollActions(): Promise<void> {
  try {
    const summary = await pollFeishuDispatches();
    if (summary.updated) console.log(`[actions] 派单回音更新 ${summary.updated}/${summary.scanned} 条`);
    for (const error of summary.errors) console.warn('[actions] 轮询失败:', error);
  } catch (error) {
    console.warn('[actions] 轮询异常:', (error as Error).message);
  }
}

/** 飞书中继群收件:实验链路(编排 V3 阶段 0 冻结),默认关闭;
 *  启用需显式设置 feishuBot.relayExperimentEnabled=true。失败只记日志 */
let relayPolling = false;
async function pollRelay(): Promise<void> {
  // single-flight:上一轮未结束(含群通知 20s 超时)时不叠加下一轮,配合 registry 单写闸防交错
  if (relayPolling) return;
  relayPolling = true;
  try {
    if (!isRelayExperimentEnabled()) return;
    const result = await pollRelayMessages();
    if (result.error) console.warn('[relay] 拉取失败:', result.error);
    else if (result.inserted) console.log(`[relay] 中继群新消息 ${result.inserted}/${result.scanned} 条`);
    const { matched, reviews } = await processRelayReceipts();
    if (matched.length) console.log(`[relay] 回执匹配 ${matched.join(',')}`);
    if (reviews.length) console.log(`[relay] 已唤醒 Codex 审核: ${reviews.join(',')}`);
  } catch (error) {
    console.warn('[relay] 轮询异常:', (error as Error).message);
  } finally {
    relayPolling = false;
  }
}

export function startScheduler(): void {
  // 双设备同步时只让 primary 设备执行有外部副作用的后台任务，避免同一提醒发送两次、
  // 两台机器同时刷新云日历/知识库。secondary 仍完整读写本地数据并参与 Supabase 同步。
  if ((process.env.WORKBENCH_DEVICE_ROLE ?? 'primary').toLowerCase() === 'secondary') {
    console.log('[scheduler] 当前设备为 secondary：已停用提醒推送、日历与知识库后台刷新');
    return;
  }
  // 唯一主服务启动恢复未知态；不扫描或重放历史 drafted 任务。
  dispatchRuntime().recoverInterrupted();
  contentRuntime().recover();
  recoverAgentNotifications();
  // YZ工作台 飞书私聊长连接入口：secondary 已被上方闸门拦住，这里只在 primary 起
  void startFeishuChatIngress();
  const coordinator=createExecutionCoordinator({
    lanes:[{limit:()=>executionConcurrency(dispatchConfig()?.maxConcurrentJobs),tick:()=>dispatchRuntime().tick()},
      {limit:()=>executionConcurrency(dispatchConfig()?.maxConcurrentContentJobs),tick:()=>contentRuntime().tick()}],
    deliver:deliverAgentNotifications,onError:error=>console.warn('[agent-execution]',error),
  });
  const {wake,notify}=coordinator;
  configureExecutionSignals(wake,coordinator.settled);
  wake();void notify();
  // 仅兜底持久队列/通知恢复与日额度变化；正常领取、续派和通知全部由事件触发。
  setInterval(()=>{wake();void notify();},60000);
  setInterval(fireDueReminders, FIRE_INTERVAL_MS);
  // 送达失败的退避重试，与触发检查同频（30s/2min 的等待由 next_retry_at 自己控制）
  setInterval(retryFailedDeliveries, FIRE_INTERVAL_MS);
  // 启动时先扫一次：服务停了一阵子，期间到点的提醒别让用户再干等一个周期
  fireDueReminders();
  retryFailedDeliveries();
  setInterval(() => void pollActions(), ACTION_POLL_INTERVAL_MS);
  // 飞书中继群消息轮询(用户身份):未配置 relayChatId 时自动空转
  console.log(isRelayExperimentEnabled()
    ? '[relay] 实验链路已启用:轮询指挥部群与 agent 私聊,回执将触发 Codex 审核'
    : '[relay] 实验链路已冻结(relayExperimentEnabled≠true):不轮询、不审核');
  setInterval(() => void pollRelay(), ACTION_POLL_INTERVAL_MS);
  // 飞书私聊入站的补偿扫描（编排 V3 阶段 1，独立于已冻结的 relay 实验开关）：
  // webhook 先落账后异步处理，模型失败/进程重启滞留在 pending/replying 的行由这里推进，保证至少处理一次
  setInterval(() => {
    void compensatePendingFeishuChats().catch((error) => console.warn('[relay] 入站补偿扫描异常:', (error as Error).message));
  }, ACTION_POLL_INTERVAL_MS);
  // 待确认计划 15 分钟过期。不扫的话过期只是「数据库里的一段文字」，
  // 界面上仍会挂着一张其实已经点不动的确认卡。
  setInterval(() => {
    const expired = expirePlans();
    if (expired > 0) console.log(`[dispatch] 已过期 ${expired} 个未确认的派发计划`);
  }, PLAN_EXPIRY_INTERVAL_MS);
  // 启动时先扫一次：服务重启期间机器人可能已经回过了，别让用户干等一个周期
  void pollActions();
  void pollRelay();
  void compensatePendingFeishuChats().catch((error) => console.warn('[relay] 入站补偿扫描异常:', (error as Error).message));
  void expirePlans();
  setInterval(async () => {
    if (getConfig() && Date.now() - lastSync >= SYNC_INTERVAL_MS) {
      lastSync = Date.now();
      const res = await syncEvents();
      if (!res.ok) console.warn('[dingtalk] 自动同步失败:', res.error);
    }
    if (getIcsUrl() && Date.now() - lastIcsSync >= SYNC_INTERVAL_MS) {
      lastIcsSync = Date.now();
      const res = await syncIcs();
      if (!res.ok) console.warn('[ics] 自动同步失败:', res.error);
    }
    if (getCaldavFlag().configured && Date.now() - lastCaldavSync >= SYNC_INTERVAL_MS) {
      lastCaldavSync = Date.now();
      const res = await syncCaldav();
      if (!res.ok) console.warn('[caldav] 自动同步失败:', res.error);
    }
    void refreshKnowledgeBaseline();
    refreshDingtalkKb();
  }, SYNC_INTERVAL_MS);
  console.log('[scheduler] 已启动：提醒检查 15s（到点可推钉钉/飞书，失败退避重试）/ 日历同步 5min / 知识基线每日增量更新');
}
