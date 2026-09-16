// ICS 日历解析：无需钉钉开发者权限的替代日历源
// 支持订阅 URL 与手动导入 .ics 文件；时间统一转本地无时区 ISO

export interface IcsEvent {
  uid: string;
  title: string;
  startAt: string; // 本地 ISO
  endAt: string | null;
  isAllDay: boolean;
  location: string | null;
  organizer: string | null;
  rrule?: string;          // 原始 RRULE 值（重复规则）
  exdates?: string[];      // EXDATE 值列表（排除的实例时间）
  recurrenceId?: string;   // RECURRENCE-ID 值（例外/覆盖实例）
}

/** 解析 ICS 文本（处理折行、VEVENT 块、常见时间形态） */
export function parseICS(raw: string): IcsEvent[] {
  // 展开折行：以空格/Tab 开头的行属于上一行
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .reduce<string[]>((acc, line) => {
      if (/^[ \t]/.test(line) && acc.length) acc[acc.length - 1] += line.slice(1);
      else acc.push(line);
      return acc;
    }, []);

  const events: IcsEvent[] = [];
  let cur: Record<string, string> | null = null;

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) { cur = {}; continue; }
    if (line.startsWith('END:VEVENT')) {
      if (cur) {
        const ev = buildEvent(cur);
        if (ev) events.push(ev);
      }
      cur = null;
      continue;
    }
    if (!cur || !line.includes(':')) continue;
    const idx = line.indexOf(':');
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const key = left.split(';')[0].toUpperCase();
    if (['UID', 'SUMMARY', 'LOCATION', 'ORGANIZER', 'DTSTART', 'DTEND', 'RRULE', 'RECURRENCE-ID'].includes(key)) {
      cur[key] = value;
      if (key === 'ORGANIZER') {
        const cn = /(?:^|;)CN=([^;:]+)/i.exec(left)?.[1];
        if (cn) cur.ORGANIZER_CN = cn;
      }
      if (left.toUpperCase().includes('VALUE=DATE')) cur[`${key}_DATE`] = '1';
    } else if (key === 'EXDATE') {
      // EXDATE 可能多行、每行逗号分隔多个值
      cur.EXDATE = cur.EXDATE ? `${cur.EXDATE},${value}` : value;
    }
  }
  return events;
}

/** ICS 参数值清洗：钉钉的 CN 常写成 CN="张三"（带成对双引号），同时还原 \, \; 转义 */
function unparam(s: string | undefined): string | null {
  if (!s) return null;
  const v = s
    .trim()
    .replace(/^"+/, '')
    .replace(/"+$/, '')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .trim();
  return v || null;
}

function buildEvent(p: Record<string, string>): IcsEvent | null {
  if (!p.DTSTART || !p.UID) return null;
  const start = toLocal(p.DTSTART, p.DTSTART_DATE === '1');
  if (!start) return null;
  const end = p.DTEND ? toLocal(p.DTEND, p.DTEND_DATE === '1') : null;
  return {
    uid: p.UID,
    title: (p.SUMMARY ?? '').trim() || '(无标题日程)',
    startAt: start.iso,
    endAt: end?.iso ?? null,
    isAllDay: start.allDay,
    location: p.LOCATION?.trim() ?? null,
    organizer: unparam(p.ORGANIZER_CN) ?? unparam(p.ORGANIZER?.replace(/^mailto:/i, '')),
    rrule: p.RRULE?.trim() || undefined,
    exdates: p.EXDATE ? p.EXDATE.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    recurrenceId: p['RECURRENCE-ID']?.trim() || undefined,
  };
}

// ---------- RRULE 重复规则展开 ----------

const DAY = 86_400_000;
const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

interface RRule { freq: string; interval: number; untilMs?: number; count?: number; byday?: number[] }

function parseRRule(v: string): RRule | null {
  const parts: Record<string, string> = {};
  for (const seg of v.split(';')) {
    const i = seg.indexOf('=');
    if (i > 0) parts[seg.slice(0, i).toUpperCase()] = seg.slice(i + 1);
  }
  const freq = (parts.FREQ ?? '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const interval = Math.max(1, parseInt(parts.INTERVAL ?? '1', 10) || 1);
  const untilMs = parts.UNTIL ? icsToDate(parts.UNTIL)?.getTime() : undefined;
  const count = parts.COUNT ? parseInt(parts.COUNT, 10) : undefined;
  const byday = parts.BYDAY
    ?.split(',').map((d) => WEEKDAYS[d.trim().slice(-2).toUpperCase()]).filter((n) => n !== undefined);
  return { freq, interval, untilMs, count, byday };
}

/** ICS 时间值 → 本地 Date（Z 结尾按 UTC，其余按本地） */
function icsToDate(v: string): Date | null {
  v = v.trim();
  if (/^\d{8}$/.test(v)) return new Date(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8));
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, y, mo, dd, hh, mi, ss, z] = m;
  return z
    ? new Date(Date.UTC(+y, +mo - 1, +dd, +hh, +mi, +(ss ?? 0)))
    : new Date(+y, +mo - 1, +dd, +hh, +mi, +(ss ?? 0));
}

const pad = (n: number) => String(n).padStart(2, '0');
const locIso = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** 把单个带 RRULE 的主定义展开成窗口内的实例（uid 加实例时间戳保证唯一） */
function generateInstances(m: IcsEvent, wsMs: number, weMs: number): IcsEvent[] {
  const rule = parseRRule(m.rrule!);
  if (!rule) return [m];
  const start = new Date(m.startAt);
  const startMs = +start;
  const durMs = m.endAt ? Math.max(0, +new Date(m.endAt) - startMs) : (m.isAllDay ? DAY : 3_600_000);
  const exSet = new Set<number>();
  for (const x of m.exdates ?? []) {
    const t = icsToDate(x)?.getTime();
    if (t !== undefined) exSet.add(t);
  }
  const hh = start.getHours(), mi = start.getMinutes(), ss = start.getSeconds();
  const out: IcsEvent[] = [];
  const make = (d: Date): IcsEvent => ({
    uid: `${m.uid}#${locIso(d).replace(/[-:]/g, '')}`,
    title: m.title,
    startAt: locIso(d),
    endAt: m.endAt ? locIso(new Date(+d + durMs)) : null,
    isAllDay: m.isAllDay,
    location: m.location,
    organizer: m.organizer,
  });
  let produced = 0;
  const emit = (c: Date): boolean => {
    const t = +c;
    if (rule.untilMs !== undefined && t > rule.untilMs) return false;
    produced++;
    if (rule.count !== undefined && produced > rule.count) return false;
    if (t >= wsMs && t <= weMs && t >= startMs && !exSet.has(t)) out.push(make(c));
    return t <= weMs; // 超出窗口终点即可停止
  };

  if (rule.freq === 'DAILY') {
    for (let i = 0; i < 1000; i++) if (!emit(new Date(startMs + i * rule.interval * DAY))) break;
  } else if (rule.freq === 'WEEKLY') {
    const days = rule.byday?.length ? rule.byday : [start.getDay()];
    const weekAnchor = new Date(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay());
    for (let w = 0; w < 120; w++) {
      const base = new Date(weekAnchor.getFullYear(), weekAnchor.getMonth(), weekAnchor.getDate() + w * 7 * rule.interval);
      const cands = days
        .map((d) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + d, hh, mi, ss))
        .sort((a, b) => +a - +b);
      let stop = false;
      for (const c of cands) {
        if (+c < startMs) continue;
        if (!emit(c)) { stop = true; break; }
      }
      if (stop || base > new Date(weMs)) break;
    }
  } else if (rule.freq === 'MONTHLY') {
    for (let i = 0; i < 240; i++) {
      const y = start.getFullYear(), mo = start.getMonth() + i * rule.interval;
      const dim = new Date(y, mo + 1, 0).getDate();
      if (!emit(new Date(y, mo, Math.min(start.getDate(), dim), hh, mi, ss))) break;
    }
  } else {
    for (let i = 0; i < 120; i++) {
      if (!emit(new Date(start.getFullYear() + i * rule.interval, start.getMonth(), start.getDate(), hh, mi, ss))) break;
    }
  }
  return out.length ? out : [m]; // 展开失败兜底：至少保留原事件
}

/** 展开重复事件：主定义按 RRULE 生成实例，例外（RECURRENCE-ID）覆盖对应实例 */
export function expandEvents(events: IcsEvent[], windowStartIso: string, windowEndIso: string): IcsEvent[] {
  const wsMs = +new Date(windowStartIso);
  const weMs = +new Date(windowEndIso);
  const out: IcsEvent[] = [];
  const byUid = new Map<string, IcsEvent[]>();
  for (const e of events) {
    const l = byUid.get(e.uid) ?? [];
    l.push(e);
    byUid.set(e.uid, l);
  }
  for (const group of byUid.values()) {
    const masters = group.filter((e) => e.rrule);
    if (!masters.length) { out.push(...group); continue; }
    const overrides = new Map<number, IcsEvent>();
    for (const e of group) {
      if (e.recurrenceId) {
        const t = icsToDate(e.recurrenceId)?.getTime();
        if (t !== undefined) overrides.set(t, e);
      }
    }
    for (const master of masters) {
      const covered = new Set<number>();
      for (const inst of generateInstances(master, wsMs, weMs)) {
        const t = +new Date(inst.startAt);
        covered.add(t);
        const ov = overrides.get(t);
        out.push(ov ? { ...ov, uid: inst.uid } : inst);
      }
      // 例外实例没匹配到主实例（被 EXDATE 排除等）：窗口内直接输出
      for (const [t, ov] of overrides) {
        if (t >= wsMs && t <= weMs && !covered.has(t)) {
          out.push({ ...ov, uid: `${ov.uid}#${locIso(new Date(t)).replace(/[-:]/g, '')}` });
        }
      }
    }
    // 同组里既非主定义也非例外的普通事件
    for (const e of group) if (!e.rrule && !e.recurrenceId && !masters.includes(e)) out.push(e);
  }
  return out;
}

function toLocal(v: string, dateOnly = false): { iso: string; allDay: boolean } | null {
  v = v.trim();
  // 纯日期：20260825
  if (/^\d{8}$/.test(v) || dateOnly) {
    const d = v.slice(0, 4), m = v.slice(4, 6), day = v.slice(6, 8);
    if (!d || !m || !day) return null;
    return { iso: `${d}-${m}-${day}T00:00:00`, allDay: true };
  }
  // 20260825T090000Z（UTC）/ 20260825T090000（本地浮动或 TZID，按本地时区处理）
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, y, mo, dd, hh, mi, ss, z] = m;
  if (z) {
    const d = new Date(Date.UTC(+y, +mo - 1, +dd, +hh, +mi, +(ss ?? 0)));
    const p2 = (n: number) => String(n).padStart(2, '0');
    return {
      iso: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`,
      allDay: false,
    };
  }
  return { iso: `${y}-${mo}-${dd}T${hh}:${mi}:${ss ?? '00'}`, allDay: false };
}

/** 拉取订阅源并解析 */
export async function fetchIcs(url: string): Promise<IcsEvent[]> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`拉取 ICS 失败 (HTTP ${res.status})`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('内容不是有效的 ICS 日历');
  return parseICS(text);
}
