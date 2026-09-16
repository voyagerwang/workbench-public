// 情绪球接口：今日心情快照、AI 换句、位置设置、天气刷新
// 设计约束：GET /api/mood 必须快（不等待 AI），AI 只由前端在首帧之后异步取。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getMoodPayload, readConfig, recentMoodLines, type MoodKind } from '../services/mood.js';
import { aiLine, peekAiLine } from '../services/mood-voice.js';
import { getWeather, invalidateWeather, resolveCity, weatherStatus } from '../services/weather.js';

export default async function moodRoutes(app: FastifyInstance) {
  // 今日心情快照。seen=1 表示「我刚打开工作台」，服务端据此算久别重逢与连续在场。
  // force=1 同时强刷天气（设置页改城市后用）。
  app.get('/api/mood', async (req) => {
    const q = z.object({
      seen: z.coerce.boolean().default(false),
      force: z.coerce.boolean().default(false),
      rotate: z.coerce.boolean().default(false),
      kind: z.enum(['fresh', 'calm', 'busy', 'heavy', 'cozy', 'lit', 'low', 'sleepy']).optional(),
    }).parse(req.query);
    if (q.force) invalidateWeather();
    const payload = await getMoodPayload({ seen: q.seen, refresh: q.force, forceKind: q.kind as MoodKind | undefined, rotate: q.rotate });
    const cfg = readConfig();
    const cached = cfg.ai ? peekAiLine(payload.dayKey, payload.signals.hour, payload.kind, payload.tone, payload.weather) : null;
    return { ...payload, aiLine: cached, config: cfg, status: weatherStatus(), debugKind: q.kind ?? null };
  });

  // 换个说法：force 重跑一次模型；模型不可用则 ok:true + line:null，前端保留模板句。
  app.post('/api/mood/line', async (req) => {
    const b = z.object({ force: z.boolean().default(false) }).partial().parse(req.body ?? {});
    const payload = await getMoodPayload({});
    if (!readConfig().ai) return { ok: true, line: null, template: payload.line, kind: payload.kind, ai: false };
    const line = await aiLine(
      {
        kind: payload.kind,
        valence: payload.valence,
        arousal: payload.arousal,
        tone: payload.tone,
        signals: payload.signals,
        weather: payload.weather,
        solar: payload.solar,
        fallback: payload.line,
        recentLines: recentMoodLines(8),
      },
      b.force,
    );
    return { ok: true, line, template: payload.line, kind: payload.kind, ai: readConfig().ai };
  });

  // 城市 → 坐标（存进 general.location），顺手把天气拉回来给前端做即时反馈
  app.post('/api/mood/location', async (req) => {
    const b = z.object({ city: z.string().max(60) }).parse(req.body ?? {});
    const res = await resolveCity(b.city);
    if (!res.ok) throw app.httpErrors.badRequest(res.error);
    invalidateWeather();
    return { ok: true, location: res.loc, weather: await getWeather(true) };
  });

  app.post('/api/mood/weather/refresh', async () => {
    invalidateWeather();
    return { ok: true, weather: await getWeather(true), status: weatherStatus() };
  });
}
