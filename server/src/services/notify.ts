// 消息通道：把工作台里发生的事推到钉钉 / 飞书群机器人，或 macOS 系统通知中心。
// 钉钉 / 飞书都只依赖「自定义机器人 webhook」，无需开发者权限：
// - 钉钉：群设置 → 智能群助手 → 添加机器人 → 自定义；安全设置可选「加签」或「自定义关键词」
// - 飞书：群设置 → 群机器人 → 添加机器人 → 自定义机器人；安全设置可开「签名校验」
// 凭据存在 settings 表的 notify 键；未配置的通道安全跳过，不报错。
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { createHmac } from 'node:crypto';
import { getSetting } from '../db.js';
import { isWeixinReady, sendClawbotMessage } from '../routes/clawbot.js';

export type NotifyChannelKind = 'dingtalk' | 'feishu';

/** 提醒送达渠道：auto=系统通知兜底+已启用推送；inapp=只应用内；其余为定向单渠道 */
export type ReminderChannel = 'auto' | 'inapp' | 'system' | 'feishu' | 'dingtalk' | 'weixin';

export interface NotifyChannel {
  webhook: string;
  secret?: string;
  enabled: boolean;
}

export interface NotifyConfig {
  prefix: string;
  pushReminders: boolean;
  /** 新建提醒时未显式指定渠道就用它（设置页「默认送达渠道」） */
  defaultChannel: ReminderChannel;
  /** 微信 ClawBot 推送总开关（绑定且未关时才推） */
  weixinEnabled: boolean;
  channels: Record<NotifyChannelKind, NotifyChannel>;
}

/** settings.notify 的存储形态（扁平，两个通道各一组键） */
export interface NotifySetting {
  prefix?: string;
  pushReminders?: boolean;
  defaultChannel?: ReminderChannel;
  /** 微信 ClawBot 是否纳入提醒推送；缺省视为开启 */
  weixinEnabled?: boolean;
  dingtalk?: Partial<NotifyChannel>;
  feishu?: Partial<NotifyChannel>;
}

const read = (): NotifySetting => getSetting<NotifySetting>('notify') ?? {};

const channel = (raw: Partial<NotifyChannel> | undefined): NotifyChannel => ({
  webhook: raw?.webhook?.trim() ?? '',
  secret: raw?.secret?.trim() || undefined,
  enabled: Boolean(raw?.enabled && raw?.webhook?.trim()),
});

export function readNotify(): NotifyConfig {
  const s = read();
  return {
    prefix: s.prefix?.trim() || 'YZ工作台',
    pushReminders: s.pushReminders !== false,
    defaultChannel: s.defaultChannel ?? 'auto',
    channels: { dingtalk: channel(s.dingtalk), feishu: channel(s.feishu) },
    weixinEnabled: s.weixinEnabled !== false,
  };
}

/** 把一条文本推到用户微信（提醒送达 / 事件推送共用） */
export async function sendWeixinNotify(text: string): Promise<SendResult> {
  const r = await sendClawbotMessage(text);
  return { ok: r.ok, error: r.error };
}

/** 系统通知（macOS 通知中心）：零配置兜底渠道，不依赖浏览器开着 */
export const systemNotifySupported = platform() === 'darwin';

export function sendSystemNotification(title: string, text: string): Promise<SendResult> {
  if (!systemNotifySupported) return Promise.resolve({ ok: false, error: '仅支持 macOS 系统通知' });
  const esc = (v: string) => v.replace(/["\\]/g, (c) => `\\${c}`);
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', `display notification "${esc(text)}" with title "${esc(title)}" sound name "Glass"`],
      { timeout: 5000 },
      (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }),
    );
  });
}

/** 给设置页用的状态：只暴露「配了没有」，不回传 webhook 与密钥明文 */
export function notifyStatus() {
  const s = read();
  const one = (raw: Partial<NotifyChannel> | undefined) => {
    const c = channel(raw);
    let hint = '';
    if (c.webhook) {
      try {
        const u = new URL(c.webhook);
        const tail = u.search.slice(0, 10).replace(/^\?/, '');
        hint = `${u.host}${u.pathname}${tail ? `?${tail.slice(0, 4)}…` : ''}`;
      } catch {
        hint = '链接格式无法解析';
      }
    }
    return { configured: Boolean(c.webhook), enabled: c.enabled, hasSecret: Boolean(c.secret), hint };
  };
  return {
    prefix: s.prefix?.trim() || 'YZ工作台',
    pushReminders: s.pushReminders !== false,
    defaultChannel: s.defaultChannel ?? 'auto',
    systemSupported: systemNotifySupported,
    dingtalk: one(s.dingtalk),
    feishu: one(s.feishu),
  };
}

// ---------- 签名 ----------

/** 钉钉加签：sign = urlEncode(base64(HMAC-SHA256(key=secret, data=`ts\nsecret`))) */
function dingTalkSign(secret: string, ts: number): string {
  const sign = createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
  return encodeURIComponent(sign);
}

/** 飞书签名校验：sign = base64(HMAC-SHA256(key=`ts\nsecret`, data='')) */
function feishuSign(secret: string, ts: number): string {
  return createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
}

function buildBody(kind: NotifyChannelKind, text: string, secret?: string) {
  if (kind === 'dingtalk') return { msgtype: 'text', text: { content: text } };
  const ts = Math.floor(Date.now() / 1000);
  return {
    ...(secret ? { timestamp: String(ts), sign: feishuSign(secret, ts) } : {}),
    msg_type: 'text',
    content: { text },
  };
}

/** 取签名用的时间戳（钉钉要毫秒，写进 query） */
function dingTalkQuery(secret?: string): string {
  if (!secret) return '';
  const ts = Date.now();
  return `&timestamp=${ts}&sign=${dingTalkSign(secret, ts)}`;
}

export interface SendResult { ok: boolean; error?: string }

/**
 * 往单个通道发一条文本。override 用于「保存前先测一把」：
 * 传了就优先用传入值，缺省回落到已保存的凭据。
 */
export async function sendNotify(
  kind: NotifyChannelKind,
  text: string,
  override?: { webhook?: string; secret?: string },
): Promise<SendResult> {
  const saved = channel(read()[kind]);
  const webhook = (override?.webhook?.trim() || saved.webhook).trim();
  const secret = (override?.secret?.trim() || saved.secret || '').trim() || undefined;
  if (!webhook) return { ok: false, error: '还没填 Webhook 地址' };
  try { new URL(webhook); } catch { return { ok: false, error: 'Webhook 地址格式不正确' }; }

  const url = kind === 'dingtalk' ? `${webhook}${dingTalkQuery(secret)}` : webhook;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(kind, text, kind === 'feishu' ? secret : undefined)),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await res.text().catch(() => '');
    let data: { errcode?: number; errmsg?: string; code?: number; msg?: string } = {};
    try { data = JSON.parse(raw) as typeof data; } catch { /* 保留原始文本用于报错 */ }
    const code = data.errcode ?? data.code;
    if (!res.ok || (code !== undefined && code !== 0)) {
      const message = data.errmsg || data.msg || raw.slice(0, 200) || `HTTP ${res.status}`;
      const tip = kind === 'dingtalk'
        ? '（常见原因：安全设置的关键词/加签不匹配，或机器人已被移出群）'
        : '（常见原因：签名校验/关键词/IP 白名单不匹配）';
      return { ok: false, error: `${message} ${tip}` };
    }
    return { ok: true };
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError') return { ok: false, error: '发送超时（10s）' };
    return { ok: false, error: `发送失败：${e.message}` };
  }
}

/** 往所有已启用的通道推一条消息（前缀按设置补上，供调度器/业务事件调用） */
export async function pushNotify(text: string, opts: { withPrefix?: boolean } = {}): Promise<Partial<Record<NotifyChannelKind | 'weixin', SendResult>>> {
  const cfg = readNotify();
  const body = opts.withPrefix === false ? text : `${cfg.prefix} · ${text}`;
  const out: Partial<Record<NotifyChannelKind | 'weixin', SendResult>> = {};
  for (const kind of ['dingtalk', 'feishu'] as const) {
    if (!cfg.channels[kind].enabled) continue;
    out[kind] = await sendNotify(kind, body);
  }
  if (cfg.weixinEnabled && isWeixinReady()) {
    out.weixin = await sendWeixinNotify(body);
  }
  return out;
}
