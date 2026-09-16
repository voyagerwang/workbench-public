// 天气：Open-Meteo（免密钥）+ 本地缓存；未配置位置时完全不联网。
// 缓存写在 settings 表里（键 mood_weather），失败时退回上次结果或 null——天气只是素材，不是依赖。

import { db, getSetting, now, setSetting } from '../db.js';

export type Location = { name: string; lat: number; lon: number; admin?: string };

export type WeatherNow = {
  code: number;
  label: string;
  tempC: number;
  feelsC: number;
  humidity: number;
  windKph: number;
  precipMm: number;
  cloudCover: number;
  /** 0–1，降水强度观感（驱动球面水珠） */
  rain: number;
  /** 0–1，云量（驱动亮度/饱和） */
  cloud: number;
  tempMax: number;
  tempMin: number;
  precipChance: number;
  /** 天气对心情的价性贡献 */
  valence: number;
  heat: boolean;
  cold: boolean;
  storm: boolean;
  snow: boolean;
  fetchedAt: string;
  stale: boolean;
};

type GeoResult = { name: string; latitude: number; longitude: number; admin1?: string; country?: string };

/** WMO 天气码 → 中文描述 + 价性 + 视觉强度 */
const WMO: Array<[number[], { label: string; valence: number; rain: number; cloud: number }]> = [
  [[0], { label: '晴', valence: 0.28, rain: 0, cloud: 0 }],
  [[1], { label: '大致晴朗', valence: 0.18, rain: 0, cloud: 0.15 }],
  [[2], { label: '局部多云', valence: 0.06, rain: 0, cloud: 0.45 }],
  [[3], { label: '阴', valence: -0.08, rain: 0, cloud: 0.8 }],
  [[45, 48], { label: '雾', valence: -0.1, rain: 0, cloud: 0.6 }],
  [[51, 53, 55], { label: '毛毛雨', valence: -0.12, rain: 0.6, cloud: 0.75 }],
  [[56, 57], { label: '冻毛毛雨', valence: -0.24, rain: 0.6, cloud: 0.8 }],
  [[61], { label: '小雨', valence: -0.14, rain: 0.8, cloud: 0.85 }],
  [[63], { label: '中雨', valence: -0.2, rain: 1, cloud: 0.9 }],
  [[65], { label: '大雨', valence: -0.32, rain: 1, cloud: 0.95 }],
  [[66, 67], { label: '冻雨', valence: -0.3, rain: 0.9, cloud: 0.9 }],
  [[71, 73], { label: '下雪', valence: -0.02, rain: 0.3, cloud: 0.85 }],
  [[75, 77], { label: '大雪', valence: -0.05, rain: 0.5, cloud: 0.9 }],
  [[80, 81], { label: '阵雨', valence: -0.14, rain: 0.85, cloud: 0.8 }],
  [[82], { label: '强阵雨', valence: -0.26, rain: 1, cloud: 0.9 }],
  [[85, 86], { label: '阵雪', valence: -0.04, rain: 0.5, cloud: 0.85 }],
  [[95], { label: '雷阵雨', valence: -0.3, rain: 1, cloud: 0.92 }],
  [[96, 99], { label: '雷雨伴冰雹', valence: -0.4, rain: 1, cloud: 0.95 }],
];

export function describeWmo(code: number) {
  for (const [codes, v] of WMO) if (codes.includes(code)) return v;
  return { label: '未知天况', valence: 0, rain: 0, cloud: 0.4 };
}

export function getLocation(): Location | null {
  const g = getSetting<{ location?: Location }>('general');
  const l = g?.location;
  if (!l || typeof l.lat !== 'number' || typeof l.lon !== 'number') return null;
  return l;
}

/** 城市名 → 坐标（结果缓存在 settings.mood_geo，避免每次保存都打接口） */
export async function resolveCity(city: string): Promise<{ ok: true; loc: Location } | { ok: false; error: string }> {
  const name = city.trim();
  if (!name) return { ok: false, error: '请填写城市名' };
  const cache = getSetting<Record<string, Location>>('mood_geo') ?? {};
  if (cache[name]) {
    saveLocation(cache[name]);
    return { ok: true, loc: cache[name] };
  }
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&format=json&name=${encodeURIComponent(name)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { ok: false, error: `地理编码失败 (HTTP ${res.status})` };
    const body = (await res.json()) as { results?: GeoResult[] };
    const hit = body.results?.[0];
    if (!hit) return { ok: false, error: `没找到「${name}」，换个城市名试试` };
    const loc: Location = {
      name: hit.name,
      lat: +hit.latitude.toFixed(4),
      lon: +hit.longitude.toFixed(4),
      admin: hit.admin1 ?? hit.country ?? '',
    };
    setSetting('mood_geo', { ...cache, [name]: loc });
    saveLocation(loc);
    return { ok: true, loc };
  } catch (err) {
    return { ok: false, error: `无法连接地理编码服务：${err instanceof Error ? err.message : String(err)}` };
  }
}

function saveLocation(loc: Location) {
  const general = (getSetting<Record<string, unknown>>('general') ?? {}) as Record<string, unknown>;
  setSetting('general', { ...general, location: loc });
}

const TTL_MS = 45 * 60_000;

/** 取当前天气；命中缓存则不打网络。失败/无位置返回 null（调用方按「无天气信号」降级）。 */
export async function getWeather(force = false): Promise<WeatherNow | null> {
  const loc = getLocation();
  if (!loc) return null;
  const cache = getSetting<{ at: number; data: WeatherNow }>('mood_weather');
  if (!force && cache && Date.now() - cache.at < TTL_MS) return { ...cache.data, stale: false };

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(loc.lat));
  url.searchParams.set('longitude', String(loc.lon));
  url.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,precipitation,weather_code,relative_humidity_2m,wind_speed_10m,cloud_cover',
  );
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  );
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '1');

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      current?: Record<string, number>;
      daily?: Record<string, number[]>;
    };
    const c = body.current ?? {};
    const d = body.daily ?? {};
    const code = Math.round(c.weather_code ?? -1);
    const meta = describeWmo(code);
    const feels = typeof c.apparent_temperature === 'number' ? c.apparent_temperature : c.temperature_2m ?? 20;
    const wind = c.wind_speed_10m ?? 0;
    let valence = meta.valence;
    if (feels >= 35) valence -= 0.22;
    else if (feels >= 31) valence -= 0.1;
    else if (feels <= 2) valence -= 0.08;
    if (wind >= 35) valence -= 0.1;
    const data: WeatherNow = {
      code,
      label: meta.label,
      tempC: Math.round((c.temperature_2m ?? 0) * 10) / 10,
      feelsC: Math.round(feels * 10) / 10,
      humidity: Math.round(c.relative_humidity_2m ?? 0),
      windKph: Math.round(wind),
      precipMm: c.precipitation ?? 0,
      cloudCover: Math.round(c.cloud_cover ?? meta.cloud * 100),
      rain: meta.rain,
      cloud: Math.max(meta.cloud, Math.round((c.cloud_cover ?? 0) / 100)),
      tempMax: Math.round(d.temperature_2m_max?.[0] ?? 0),
      tempMin: Math.round(d.temperature_2m_min?.[0] ?? 0),
      precipChance: Math.round(d.precipitation_probability_max?.[0] ?? 0),
      valence: Math.max(-0.6, Math.round(valence * 100) / 100),
      heat: feels >= 33,
      cold: feels <= 4,
      storm: code >= 95,
      snow: [71, 73, 75, 77, 85, 86].includes(code),
      fetchedAt: now(),
      stale: false,
    };
    setSetting('mood_weather', { at: Date.now(), data });
    return data;
  } catch (err) {
    console.warn('[weather] 获取失败:', err instanceof Error ? err.message : err);
    // 断网/超时：能用旧值就用旧值，标 stale 让前端知道这是回忆不是实况
    if (cache) {
      const ageMin = Math.round((Date.now() - cache.at) / 60000);
      if (ageMin < 60 * 12) return { ...cache.data, stale: true };
    }
    return null;
  }
}

/** 位置状态：设置页与情绪球都要用，一次查询搞定 */
export function weatherStatus() {
  const loc = getLocation();
  const cache = getSetting<{ at: number; data: WeatherNow }>('mood_weather');
  const fresh = Boolean(cache && Date.now() - cache.at < TTL_MS);
  return {
    configured: Boolean(loc),
    location: loc ?? null,
    cached: Boolean(cache),
    fresh,
    cacheAgeMin: cache ? Math.round((Date.now() - cache.at) / 60000) : null,
  };
}

/** 手动清缓存（改城市 / 点「换个说法」时用） */
export function invalidateWeather(): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run('mood_weather');
}
