// CalDAV 客户端：钉钉日历同步（用户名 + 专用密码，无需开发者权限）
// 流程：.well-known/caldav → principal → calendar-home-set → calendar 集合 → REPORT calendar-query
// 事件解析复用 ICS 解析器（calendar-data 即 VCALENDAR 文本）
import { XMLParser } from 'fast-xml-parser';
import { getSetting } from '../db.js';
import { parseICS, expandEvents, type IcsEvent } from './ics.js';

export interface CaldavConfig {
  username: string;
  password: string;
  server: string; // https://calendar.dingtalk.com
}

export function getCaldavConfig(): CaldavConfig | undefined {
  const c = getSetting<Partial<CaldavConfig>>('caldav');
  if (!c?.username || !c?.password) return undefined;
  return {
    username: c.username,
    password: c.password,
    server: (c.server || 'https://calendar.dingtalk.com').replace(/\/+$/, ''),
  };
}

export function getCaldavFlag(): { configured: boolean; username: string; server: string } {
  const c = getCaldavConfig();
  return c
    ? { configured: true, username: c.username, server: c.server }
    : { configured: false, username: '', server: '' };
}

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false });

/** 统一转数组 */
const arr = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function authHeader(cfg: CaldavConfig): string {
  return `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
}

async function davFetch(url: string, cfg: CaldavConfig, method: 'PROPFIND' | 'REPORT', body: string, depth: string): Promise<{ xml: Record<string, unknown>; href: string | null }> {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(current, {
      method,
      redirect: 'manual', // 自己跟 30x，保持 PROPFIND/REPORT 方法
      headers: {
        Authorization: authHeader(cfg),
        Depth: depth,
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body,
    });
    // 集合 URL 尾斜杠缺失时服务端常 30x，跟随重定向重发同一请求
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`${method} ${current} → HTTP ${res.status}（无重定向目标）`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status === 401) throw new Error('认证失败：请检查用户名与专用密码（专用密码只显示一次，可重新获取）');
    if (!res.ok) throw new Error(`${method} ${current} → HTTP ${res.status}`);
    const text = await res.text();
    return { xml: (text.trim() ? parser.parse(text) : {}) as Record<string, unknown>, href: current };
  }
  throw new Error('重定向次数过多');
}

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`;

const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set/></D:prop>
</D:propfind>`;

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:resourcetype/><D:displayname/></D:prop>
</D:propfind>`;

function reportBody(win: { start: Date; end: Date }): string {
  // 拉取窗口：过去 30 天 ~ 未来 180 天
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${fmt(win.start)}" end="${fmt(win.end)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
}

interface DavResponse { href?: string; propstat?: Array<{ prop?: Record<string, unknown> }> }
const asMultistatus = (xml: unknown): DavResponse[] => {
  const ms = (xml as { multistatus?: { response?: DavResponse | DavResponse[] } })?.multistatus;
  return ms ? arr(ms.response) : [];
};

function propOf(r: DavResponse): Record<string, unknown> {
  const ps = arr(r.propstat);
  return (ps.find((p) => p.prop)?.prop ?? {}) as Record<string, unknown>;
}

/** href 转绝对 URL；集合地址统一保留/补全尾斜杠（钉钉对无斜杠集合会 301） */
function absUrl(base: string, href: string | undefined): string {
  if (!href) return base;
  const abs = href.startsWith('http') ? href : new URL(href, base).toString();
  return abs.endsWith('/') ? abs : `${abs}/`;
}

/** 拉取全部日程 */
export async function fetchCaldavEvents(cfg: CaldavConfig): Promise<IcsEvent[]> {
  // 1. principal：.well-known 重定向或直接探测
  let principalUrl: string;
  try {
    const wk = await davFetch(`${cfg.server}/.well-known/caldav`, cfg, 'PROPFIND', PROPFIND_PRINCIPAL, '0');
    principalUrl = wk.href ?? cfg.server;
  } catch {
    principalUrl = cfg.server;
  }
  let xml = (await davFetch(principalUrl, cfg, 'PROPFIND', PROPFIND_PRINCIPAL, '0')).xml;
  const principalHref = (propOf(asMultistatus(xml)[0] ?? {})['current-user-principal'] as { href?: string } | undefined)?.href;
  if (principalHref) principalUrl = absUrl(principalUrl, principalHref);

  // 2. calendar-home-set
  xml = (await davFetch(principalUrl, cfg, 'PROPFIND', PROPFIND_HOME, '0')).xml;
  const homeHref = (propOf(asMultistatus(xml)[0] ?? {})['calendar-home-set'] as { href?: string } | undefined)?.href;
  if (!homeHref) throw new Error('未找到日历主目录（calendar-home-set），请确认服务器地址');
  const homeUrl = absUrl(principalUrl, homeHref);

  // 3. 列出 calendar 集合
  xml = (await davFetch(homeUrl, cfg, 'PROPFIND', PROPFIND_CALENDARS, '1')).xml;
  let calendars = asMultistatus(xml)
    .map((r) => ({ url: absUrl(homeUrl, r.href), prop: propOf(r) }))
    .filter(({ prop }) => {
      const rt = prop['resourcetype'] as Record<string, unknown> | undefined;
      return rt && ('calendar' in rt);
    });
  if (!calendars.length) calendars = [{ url: homeUrl, prop: {} }]; // home 本身就是集合的兜底

  // 4. 逐日历 REPORT（窗口与查询一致：过去 30 天 ~ 未来 180 天）
  const win = { start: new Date(Date.now() - 30 * 86400_000), end: new Date(Date.now() + 180 * 86400_000) };
  const events: IcsEvent[] = [];
  for (const cal of calendars) {
    const rx = (await davFetch(cal.url, cfg, 'REPORT', reportBody(win), '1')).xml;
    for (const r of asMultistatus(rx)) {
      const data = propOf(r)['calendar-data'];
      const text = typeof data === 'string' ? data : (data as { '#text'?: string; _?: string } | undefined)?._ ?? (data as { '#text'?: string } | undefined)?.['#text'];
      if (!text) continue;
      // 钉钉返回的 ICS 里换行是 &#13;/&#10; 实体，需还原为真实换行
      const cleaned = String(text).replace(/&#13;|&#xD;/gi, '').replace(/&#10;|&#xA;/gi, '\n');
      if (!cleaned.includes('BEGIN:VEVENT')) continue;
      events.push(...parseICS(cleaned));
    }
  }
  // 展开 RRULE 重复事件（钉钉不响应 expand 参数，只能客户端展开），再按 uid 去重
  const expanded = expandEvents(events, win.start.toISOString(), win.end.toISOString());
  const seen = new Set<string>();
  return expanded.filter((e) => (seen.has(e.uid) ? false : (seen.add(e.uid), true)));
}
