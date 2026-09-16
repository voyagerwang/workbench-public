// 本地天文计算：太阳高度角、天光系数、日出日落、24 节气、月相。
// 全部离线可算，用于让情绪球的「气色」跟着真实天光走，而不是跟着心情走。

const RAD = Math.PI / 180;
const DAYMS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

const daysSinceJ2000 = (d: Date) => d.getTime() / DAYMS - 0.5 + J1970 - J2000;
const solarMeanAnomaly = (d: number) => RAD * (357.5291 + 0.98560028 * d);
/** 黄经：M + 中心差 + 近日点 + π */
const eclipticLongitude = (m: number) =>
  m
  + RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m))
  + RAD * 102.9372
  + Math.PI;
const rightAscension = (l: number) => Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY), Math.cos(l));
const declination = (l: number) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(l));
/** 本地恒星时（弧度）。lw 传「西经量」= -东经，所以这里是 - lw（SunCalc 同式） */
const siderealTime = (d: number, lw: number) => RAD * 280.16 + RAD * 360.9856235 * d - lw;

const smoothstep = (t: number) => t * t * (3 - 2 * t);

export type SunPosition = {
  /** 高度角（弧度，>0 表示在地平线之上） */
  altitude: number;
  /** 方位角（弧度，从北顺时针） */
  azimuth: number;
};

/** 太阳位置（与 SunCalc/NOAA 同一套简化式，角分级误差，够驱动色相与亮度） */
export function sunPosition(date: Date, lat: number, lng: number): SunPosition {
  const d = daysSinceJ2000(date);
  const l = eclipticLongitude(solarMeanAnomaly(d));
  const dec = declination(l);
  const h = siderealTime(d, RAD * -lng) - rightAscension(l);
  const phi = RAD * lat;
  return {
    altitude: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h)),
    azimuth: Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)),
  };
}

/**
 * 天光系数 0.12–1：太阳视高度角从 -6°（民用晨昏蒙影）到 +24° 之间平滑上升。
 * 没有坐标时退化为按本地小时的钟点曲线，保证界面永远有天光。
 */
export function daylightFactor(date: Date, lat?: number, lng?: number): number {
  if (lat == null || lng == null) {
    const h = date.getHours() + date.getMinutes() / 60;
    const t = Math.max(0, Math.min(1, (Math.sin(((h - 6) / 12) * Math.PI) + 0.12) / 1.12));
    return 0.14 + 0.86 * t;
  }
  const alt = sunPosition(date, lat, lng).altitude / RAD;
  const t = Math.max(0, Math.min(1, (alt + 6) / 30));
  return 0.12 + 0.88 * smoothstep(t);
}

/** 日出/日落：2 分钟步长找视高度角过 -0.833° 的时刻（极昼/极夜返回 null） */
export function sunEventTime(date: Date, lat: number, lng: number, rise: boolean): Date | null {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), rise ? 4 : 15, 0, 0);
  let prev = sunPosition(start, lat, lng).altitude / RAD + 0.833;
  for (let k = 1; k <= 420; k++) {
    const t = new Date(+start + k * 120_000);
    const alt = sunPosition(t, lat, lng).altitude / RAD + 0.833;
    if (rise ? prev < 0 && alt >= 0 : prev > 0 && alt <= 0) return t;
    prev = alt;
  }
  return null;
}

const TERM_C = [
  5.4055, 20.12, 3.87, 18.73, 5.63, 20.646, 4.81, 20.1, 5.52, 21.04, 5.678, 21.37,
  7.108, 22.83, 7.5, 23.13, 7.646, 23.042, 8.318, 23.438, 7.438, 22.36, 7.18, 21.94,
];
const TERM_NAMES = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
  '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
];

/** 24 节气日期（21 世纪通用式，个别年份可能偏 1 天，只用于文案素材） */
export function solarTerms(year: number): Array<{ name: string; date: Date }> {
  const y = year % 100;
  return TERM_NAMES.map((name, i) => {
    const month = Math.floor(i / 2) + 1;
    const day = Math.floor(y * 0.2422 + TERM_C[i]) - Math.floor(y / 4);
    return { name, date: new Date(year, month - 1, day) };
  });
}

/** 今天是不是某个节气；以及 3 天内即将到来的节气 */
export function termContext(date: Date): { today: string | null; next: { name: string; days: number } | null } {
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const list = solarTerms(date.getFullYear());
  for (const t of list) {
    if (+new Date(t.date.getFullYear(), t.date.getMonth(), t.date.getDate()) === +midnight) {
      return { today: t.name, next: null };
    }
  }
  const upcoming = list.filter((t) => t.date >= midnight).sort((a, b) => +a.date - +b.date)[0];
  if (!upcoming) return { today: null, next: null };
  const days = Math.round((+new Date(upcoming.date.getFullYear(), upcoming.date.getMonth(), upcoming.date.getDate()) - +midnight) / DAYMS);
  return { today: null, next: days <= 3 ? { name: upcoming.name, days } : null };
}

const MOON_NAMES = ['新月', '蛾眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月'];

/** 月相 0–1（0=新月）与名称 */
export function moonPhase(date: Date): { phase: number; name: string; illuminated: number } {
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  const phase = ((((date.getTime() - ref) / DAYMS) % synodic) + synodic) / synodic;
  return {
    phase,
    name: MOON_NAMES[Math.round(phase * 8) % 8],
    illuminated: (1 - Math.cos(2 * Math.PI * phase)) / 2,
  };
}

export type SolarSnapshot = {
  altitudeDeg: number | null;
  daylight: number;
  sunrise: string | null;
  sunset: string | null;
  /** 距日出/日落分钟数（负数=已过），用于「天要黑了」这类稀有句 */
  minutesToSunEvent: number | null;
  sunEventKind: 'rise' | 'set' | null;
  termToday: string | null;
  termNext: { name: string; days: number } | null;
  moon: { name: string; illuminated: number };
};

const hhmm = (d: Date | null) =>
  d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null;

export function solarSnapshot(date: Date, lat?: number, lng?: number): SolarSnapshot {
  const hasLoc = lat != null && lng != null;
  const alt = hasLoc ? sunPosition(date, lat!, lng!).altitude / RAD : null;
  const rise = hasLoc ? sunEventTime(date, lat!, lng!, true) : null;
  const set = hasLoc ? sunEventTime(date, lat!, lng!, false) : null;
  const next = rise && rise > date ? { d: rise, kind: 'rise' as const } : set ? { d: set, kind: 'set' as const } : null;
  const terms = termContext(date);
  const moon = moonPhase(date);
  return {
    altitudeDeg: alt == null ? null : +alt.toFixed(1),
    daylight: +daylightFactor(date, lat, lng).toFixed(3),
    sunrise: hhmm(rise),
    sunset: hhmm(set),
    minutesToSunEvent: next ? Math.round((+next.d - +date) / 60000) : null,
    sunEventKind: next ? next.kind : null,
    termToday: terms.today,
    termNext: terms.next,
    moon: { name: moon.name, illuminated: +moon.illuminated.toFixed(2) },
  };
}
