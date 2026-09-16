// 钉钉日历集成：读取指定用户的日程并缓存到本地 events 表。
// 依据官方文档（2026-01 核实）：
// - 日历接口路径参数是 unionId（系统自动用 userid 换取并缓存）
// - calendarId 固定 primary；时间参数 timeMin/timeMax；nextToken 分页
// 凭据来自 settings 表的 dingtalk 配置；未配置时所有函数安全降级。

import { db, getSetting, now, setSetting } from '../db.js';

export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  userId: string; // 企业内部应用的 userid（staffId）
}

interface DingTalkSetting {
  appKey?: string;
  appSecret?: string;
  userId?: string;
  unionIdFor?: Record<string, string>; // userid → unionId 缓存
}

export function getConfig(): DingTalkConfig | undefined {
  const cfg = getSetting<Partial<DingTalkConfig>>('dingtalk');
  if (!cfg?.appKey || !cfg?.appSecret || !cfg?.userId) return undefined;
  return { appKey: cfg.appKey, appSecret: cfg.appSecret, userId: cfg.userId };
}

export function getConfiguredFlag(): { appKey?: string; configured: boolean } {
  const cfg = getSetting<Partial<DingTalkConfig>>('dingtalk') ?? {};
  return { appKey: cfg.appKey, configured: Boolean(cfg.appKey && cfg.appSecret && cfg.userId) };
}

// ---------- access token（内存缓存，约 2h 有效） ----------
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getToken(cfg: DingTalkConfig): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: cfg.appKey, appSecret: cfg.appSecret }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`获取 accessToken 失败 (HTTP ${res.status}) ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { accessToken: string; expireIn: number };
  tokenCache = { token: data.accessToken, expiresAt: Date.now() + data.expireIn * 1000 };
  return tokenCache.token;
}

// ---------- userid → unionId（结果持久缓存到 settings） ----------
async function getUnionId(cfg: DingTalkConfig, token: string): Promise<string> {
  const setting0 = getSetting<DingTalkSetting>('dingtalk') ?? {};
  const cached = setting0.unionIdFor?.[cfg.userId];
  if (cached) return cached;

  // 旧版 oapi 的「查询用户详情」，新 accessToken 兼容
  const res = await fetch(
    `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userid: cfg.userId }),
    },
  );
  const data = (await res.json()) as { errcode?: number; errmsg?: string; result?: { unionid?: string } };
  const unionId = data.result?.unionid;
  if (data.errcode !== 0 || !unionId) {
    throw new Error(`换取 unionId 失败: ${data.errmsg ?? '返回为空'}（请检查 userId 是否正确）`);
  }
  const setting = getSetting<DingTalkSetting>('dingtalk') ?? {};
  setSetting('dingtalk', { ...setting, unionIdFor: { ...(setting.unionIdFor ?? {}), [cfg.userId]: unionId } });
  return unionId;
}

interface DtEvent {
  id: string;
  summary?: string;
  location?: { name?: string };
  organizer?: unknown;
  creator?: unknown;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  isAllDay?: boolean;
}

function organizerName(e: DtEvent): string | null {
  const value = e.organizer ?? e.creator;
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'displayName', 'userName', 'nickname', 'nick']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  }
  return null;
}

function toLocalIso(s: string | undefined): string | null {
  if (!s) return null;
  // 兼容 date(YYYY-MM-DD)、dateTime(+08:00 / Z 结尾) 三种形态，统一转本地无时区 ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const fmtOffset = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`;
};

/** 拉取主日历(primary)中 [今天-7, 今天+14] 的日程（nextToken 翻页），upsert 进本地 events 表 */
export async function syncEvents(): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const cfg = getConfig();
  if (!cfg) return { ok: false, error: '钉钉未配置' };

  try {
    const token = await getToken(cfg);
    const unionId = await getUnionId(cfg, token);
    const headers = { 'x-acs-dingtalk-access-token': token };

    const from = new Date(); from.setDate(from.getDate() - 7); from.setHours(0, 0, 0, 0);
    const to = new Date(); to.setDate(to.getDate() + 14); to.setHours(0, 0, 0, 0);

    const all: DtEvent[] = [];
    let nextToken: string | undefined;
    do {
      const url = new URL(
        `https://api.dingtalk.com/v1.0/calendar/users/${encodeURIComponent(unionId)}/calendars/primary/events`,
      );
      url.searchParams.set('timeMin', fmtOffset(from));
      url.searchParams.set('timeMax', fmtOffset(to));
      url.searchParams.set('maxResults', '100');
      if (nextToken) url.searchParams.set('nextToken', nextToken);

      const res = await fetch(url, { headers });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`读取日程失败 (HTTP ${res.status}) ${t.slice(0, 300)}`);
      }
      const page = (await res.json()) as { events?: DtEvent[]; nextToken?: string };
      all.push(...(page.events ?? []));
      nextToken = page.nextToken;
    } while (nextToken);

    // upsert
    const upsert = db.prepare(`
      INSERT INTO events (id, external_id, title, start_at, end_at, is_all_day, location, organizer, synced_at)
      VALUES (sync_id(), @externalId, @title, @startAt, @endAt, @isAllDay, @location, @organizer, @syncedAt)
      ON CONFLICT(external_id) DO UPDATE SET
        title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at,
        is_all_day = excluded.is_all_day, location = excluded.location, organizer = excluded.organizer, synced_at = excluded.synced_at
    `);
    const tx = db.transaction(() => {
      for (const e of all) {
        const startAt = toLocalIso(e.start?.dateTime ?? e.start?.date);
        if (!startAt || !e.id) continue;
        upsert.run({
          externalId: e.id,
          title: e.summary?.trim() || '(无标题日程)',
          startAt,
          endAt: toLocalIso(e.end?.dateTime ?? e.end?.date),
          isAllDay: e.isAllDay ? 1 : 0,
          location: e.location?.name ?? null,
          organizer: organizerName(e),
          syncedAt: now(),
        });
      }
    });
    tx();
    console.log(`[dingtalk] 同步完成：${all.length} 条日程`);
    return { ok: true, count: all.length };
  } catch (err) {
    tokenCache = null;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
