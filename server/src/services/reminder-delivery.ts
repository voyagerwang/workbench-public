// 提醒送达：到点之后「发到哪、发没发成、失败了怎么办」全在这一层。
// 单独成文件是因为 routes/time.ts（重发接口）和 scheduler.ts（触发检查）都要用它——
// 塞进 scheduler 会让 routes/time ↔ scheduler 变成循环依赖。
//
// 核心约定：每条提醒都有一张回执（reminders.delivery_* 字段）。
// 发之前没有回执、发失败没人知道，是「提醒到底响没响」这个问题最大的黑洞。
import { db, now } from '../db.js';
import { isWeixinReady } from '../routes/clawbot.js';
import { readNotify, sendNotify, sendSystemNotification, sendWeixinNotify } from './notify.js';

export type DeliveryKind = 'system' | 'feishu' | 'dingtalk' | 'weixin';

/** 投递回执用到的提醒行 */
export interface DeliveryRow {
  id: number;
  message: string;
  trigger_at: string;
  channel: string;
  delivery_attempts: number;
  status?: string;
}

const CHANNEL_LABEL: Record<string, string> = {
  auto: '自动', inapp: '应用内', system: '系统通知', feishu: '飞书', dingtalk: '钉钉', weixin: '微信',
};

/** 失败退避：第 1 次失败等 30s，第 2 次等 2min，第 3 次失败后不再自动重试（留给用户手动重发） */
const RETRY_BACKOFF_MS = [30_000, 120_000];
export const DELIVERY_MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

/**
 * 与 now() 同格式的「本地时间」字符串。
 * next_retry_at 必须用它：toISOString() 给的是 UTC，比北京时间早 8 小时，
 * 拿它跟本地的 now() 比大小会导致失败重试永远等不到触发时刻。
 */
export function localAfter(ms: number): string {
  const d = new Date(Date.now() + ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 按提醒的渠道设置决定实际往哪发。
 * 用户明确选了定向渠道（飞书/钉钉）但那个渠道没配好时，降级到系统通知并写明原因——
 * 不静默改成 auto：那样界面上用户看到的还是「飞书」，实际却走的系统通知，等于骗人。
 */
export function planDelivery(channel: string): { channels: DeliveryKind[]; note: string | null } {
  const cfg = readNotify();
  switch (channel) {
    case 'inapp':
      return { channels: [], note: null };
    case 'system':
      return { channels: ['system'], note: null };
    case 'feishu':
    case 'dingtalk':
      return cfg.channels[channel].enabled
        ? { channels: [channel], note: null }
        : { channels: ['system'], note: `${CHANNEL_LABEL[channel]}未配置或未启用，本次已降级为系统通知` };
    case 'weixin':
      return cfg.weixinEnabled && isWeixinReady()
        ? { channels: ['weixin'], note: null }
        : { channels: ['system'], note: '微信未绑定或未启用，本次已降级为系统通知' };
    default: {
      // auto：系统通知兜底 + 总开关打开时追加已启用的外部渠道
      const candidates = cfg.pushReminders ? (['feishu', 'dingtalk', 'weixin'] as const) : [];
      const external = candidates.filter((k) => {
        if (k === 'weixin') return cfg.weixinEnabled && isWeixinReady();
        return cfg.channels[k].enabled;
      });
      return { channels: ['system', ...external], note: null };
    }
  }
}

const hhmm = (iso: string) => iso.slice(11, 16);

function bodyFor(list: DeliveryRow[]): string {
  return list.length === 1
    ? `提醒到点 · ${hhmm(list[0]!.trigger_at)} ${list[0]!.message}`
    : `${list.length} 条提醒到点\n${list.map((r) => `- ${hhmm(r.trigger_at)} ${r.message}`).join('\n')}`;
}

async function sendTo(kind: DeliveryKind, prefix: string, text: string) {
  if (kind === 'weixin') return { kind, ...(await sendWeixinNotify(`${prefix} · ${text}`)) };
  const r = kind === 'system'
    ? await sendSystemNotification(prefix, text)
    : await sendNotify(kind, `${prefix} · ${text}`);
  return { kind, ...r };
}

/** 一次到点多条时按渠道汇总成一条消息，别把通知中心刷屏 */
export async function deliverRows(rows: DeliveryRow[]): Promise<void> {
  if (rows.length === 0) return;
  const cfg = readNotify();
  const buckets = new Map<string, { kinds: DeliveryKind[]; note: string | null; rows: DeliveryRow[] }>();
  for (const row of rows) {
    const plan = planDelivery(row.channel);
    if (plan.channels.length === 0) {
      // 只应用内：服务端什么都不发，由网页端投递。回执记 skipped，与「发送失败」区分开
      writeReceipt(row.id, {
        status: 'skipped', error: null, channels: '', note: null,
        attempts: row.delivery_attempts, retryAt: null,
      });
      continue;
    }
    const key = plan.channels.join(',');
    const bucket = buckets.get(key) ?? { kinds: plan.channels, note: plan.note, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    const results = await Promise.all(bucket.kinds.map((kind) => sendTo(kind, cfg.prefix, bodyFor(bucket.rows))));
    const sent = results.filter((r) => r.ok).map((r) => r.kind);
    const failures = results.filter((r) => !r.ok);
    for (const row of bucket.rows) {
      const attempts = row.delivery_attempts + 1;
      const retryAt = failures.length > 0 && attempts < DELIVERY_MAX_ATTEMPTS
        ? localAfter(RETRY_BACKOFF_MS[attempts - 1] ?? 120_000)
        : null;
      const error = failures.length === 0
        ? null
        : failures.map((f) => `${CHANNEL_LABEL[f.kind]}：${f.error ?? '未知错误'}`).join('；');
      writeReceipt(row.id, {
        // 只要有任一渠道送达就算成功：用户确实收到了，剩下的渠道失败只是降级，不值得再自动重试
        status: sent.length > 0 ? 'sent' : 'failed',
        error,
        channels: sent.join(','),
        note: bucket.note,
        attempts,
        retryAt,
      });
    }
  }
}

function writeReceipt(id: number, p: {
  status: 'sent' | 'failed' | 'skipped';
  error: string | null;
  channels: string;
  note: string | null;
  attempts: number;
  retryAt: string | null;
}): void {
  // 只给仍处于 fired 的记录写回执：投递是异步的，期间用户可能已经完成或延后了，
  // 这时回写回执会把「已延后」的那条又标成送达失败。
  db.prepare(
    `UPDATE reminders
        SET delivery_status = ?, delivery_attempts = ?, delivery_error = ?, delivered_channels = ?,
            channel_note = ?, next_retry_at = ?, last_delivery_at = ?
      WHERE id = ? AND status = 'fired'`,
  ).run(p.status, p.attempts, p.error, p.channels, p.note, p.retryAt, now(), id);
}

/**
 * 手动重发（界面上的「重新发送」）：重置退避计数再发一次。
 * 自动重试已经放弃了的记录也允许重发，否则用户只剩删除一条路。
 */
export async function resendReminder(id: number): Promise<{ ok: boolean; error?: string }> {
  const row = db.prepare(
    'SELECT id, message, trigger_at, channel, status, delivery_attempts FROM reminders WHERE id = ? AND deleted_at IS NULL',
  ).get(id) as DeliveryRow | undefined;
  if (!row) return { ok: false, error: '提醒不存在或已删除' };
  if (row.status !== 'fired') return { ok: false, error: '只有已到点的提醒可以重发' };
  db.prepare("UPDATE reminders SET delivery_status = 'pending', delivery_attempts = 0, next_retry_at = NULL WHERE id = ?").run(id);
  await deliverRows([{ ...row, delivery_attempts: 0 }]);
  const after = db.prepare('SELECT delivery_status, delivery_error FROM reminders WHERE id = ?').get(id) as
    | { delivery_status: string; delivery_error: string | null }
    | undefined;
  if (after?.delivery_status === 'sent' || after?.delivery_status === 'skipped') return { ok: true };
  return { ok: false, error: after?.delivery_error ?? '发送失败' };
}

/** 失败退避重试：只重试仍处于 fired 的提醒——用户已完成或延后就别再打扰 */
export function retryFailedDeliveries(): void {
  const rows = db.prepare(
    `SELECT id, message, trigger_at, channel, delivery_attempts FROM reminders
      WHERE status = 'fired' AND deleted_at IS NULL AND delivery_status = 'failed'
        AND next_retry_at IS NOT NULL AND next_retry_at <= ?`,
  ).all(now()) as DeliveryRow[];
  if (rows.length === 0) return;
  console.warn(`[scheduler] 提醒送达失败，退避重试 ${rows.length} 条`);
  void deliverRows(rows);
}
