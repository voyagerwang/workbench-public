import { modelFetch } from './model-call.js';
// AI 润色：不是让模型写鸡汤，而是让它「在信号约束下重写这一句」。
// 只在首帧之后异步触发、按「天 + 时段 + 心情」缓存、任何失败都返回 null——规则模板永远先上屏。

import { z } from 'zod';
import { getSetting, setSetting } from '../db.js';
import type { MoodKind, MoodSignals, MoodTone } from './mood.js';
import type { SolarSnapshot } from './solar.js';
import type { WeatherNow } from './weather.js';

export type VoiceInput = {
  kind: MoodKind;
  valence: number;
  arousal: number;
  tone: MoodTone;
  signals: MoodSignals;
  weather: WeatherNow | null;
  solar: SolarSnapshot;
  fallback: string;
  /** 最近说过的话（新→旧）：别重复意象，最好能接得上话头 */
  recentLines?: string[];
};

const MAX_LEN = 22;
const CACHE_KEY = 'mood_line_ai';

type AiCache = { bucket: string; kind: MoodKind; tone: MoodTone; text: string; wcode: number | null };
type ModelBody = {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  choices?: Array<{ message?: { content?: string } }>;
};

/** 半天一个时段：哲理句不需要频繁换，说得越少越有分量 */
const bucketOf = (dayKey: string, hour: number) => `${dayKey}T${hour < 12 ? 'am' : 'pm'}`;
function modelConfig() {
  const saved = getSetting<Record<string, unknown>>('model') ?? {};
  const baseUrl = (typeof saved.baseUrl === 'string' ? saved.baseUrl : '').trim().replace(/\/+$/, '');
  const model = typeof saved.model === 'string' ? saved.model.trim() : '';
  const apiKey = typeof saved.apiKey === 'string' ? saved.apiKey.trim() : '';
  if (!baseUrl || !model || !apiKey) return null;
  return {
    baseUrl, model, apiKey,
    wireApi: saved.wireApi === 'chat_completions' ? ('chat_completions' as const) : ('responses' as const),
  };
}

const TONE_BRIEF: Record<MoodTone, string> = {
  温和: '轻松、友好，像一句不打扰人的随想，不哄、不亲昵',
  中性: '清楚、自然地观察时间、天气或日常细节',
  冷淡: '极简、有一点留白，但不表现疏离或不耐烦',
  毒舌: '机灵、略带幽默，可以调侃天气或钟表，但绝不调侃用户',
};

/** 喂给模型的是「它看见了什么」，不是「帮我写句好话」 */
function buildPrompt(input: VoiceInput): string {
  const S = input.signals;
  const bits = [
    `现在是 ${S.hour} 点多，${S.weekend ? '周末' : '工作日'}`,
    input.weather ? `外面：${input.weather.label}${input.weather.heat ? '，闷热' : input.weather.cold ? '，冷' : ''}` : '天气未知',
    `天光${input.solar.daylight > 0.8 ? '很足' : input.solar.daylight > 0.5 ? '还行' : input.solar.daylight > 0.22 ? '偏暗' : '已是夜里'}`,
    input.solar.termToday ? `今天${input.solar.termToday}` : '',
    input.solar.termNext ? `下一个节气是${input.solar.termNext.name}` : '',
  ].filter(Boolean);

  return [
    '你是桌面上一只安静的小精灵，一个不搅扰的存在。你的工作是偶尔替世界说一句话，然后继续待着。',
    '你只观察世界：天气、光线、季节、时间、日常物件。你从不盘点用户的待办，也不关心进度——工作信息一个字都不能出现。',
    `语气：${TONE_BRIEF[input.tone]}。`,
    '根据时间、天光、天气或季节，写一句轻松、有趣或略带哲理的原创中文随想：',
    `- ${bits.join('\n- ')}`,
    '形式要求（很重要）：',
    '1) 一句完整、读得通的话，6–22 字；像一个有趣的观察，而不是通知或建议；',
    '2) 只说一件事，不拼接无关观察；可以有一点哲理，但不要写成鸡汤或格言口号；',
    '3) 可以使用关于天气、光线、时间和日常物件的简单比喻；禁止描述用户的身体、触感、姿态或亲密关系；',
    '4) 禁止“软绵绵、软一点、抱住、陪着你、乖、宝贝、心里、肩背、温柔地”等可能引起关系或身体联想的说法；',
    '5) 尽量不用第二人称；允许问号、允许省略号；',
    '6) 不出现任何数字（阿拉伯数字与「三场」「两件」这类量词数字也不行）；',
    '7) 不用感叹号；不催促、不表扬、不打气、不喊口号、不写鸡汤、不引用或伪造名人名言；',
    '8) 不猜用户情绪、动机或状态，不说“你累了”“你在逃避”“不像你的风格”等没有证据的判断；',
    '9) 绝不主动提工作、待办、任务、会议、项目、进度、安排、优先级、逾期、提醒、知识库或回收站；',
    '10) 你写的天气、季节必须和上面给的实况一致：外面在下毛毛雨就不能写雷，是阴天就不能写烈日；',
    '11) 不提天气接口、不提自己是模型、不说「作为」。',
    ...(S.hour >= 23 || S.hour < 5 ? ['12) 现在是深夜，句子要更短更轻，像自言自语。'] : []),
    ...(input.recentLines?.length
      ? [`最近几天它说过的话（换意象、换角度，不要复述或近似复述；如果今天的话头能自然接上其中一件，可以接）：\n   ${input.recentLines.map((l) => `· ${l}`).join('\n   ')}`]
      : []),
    '分寸参照（只学它的克制，不许抄句子）：',
    `   ${input.fallback}`,
    '写不出比参照更好的就返回 {"lines":[]}。',
    '按「最想说的排最前」给三句候选。只返回 JSON：{"lines":["首选","次选","再次"]}',
  ].join('\n');
}

const schema = z.object({ lines: z.array(z.string().trim()).max(6).default([]) });

/** 天气一致性守门：句子里的天气意象必须和实况对得上（「嘴上打雷、头顶毛毛雨」直接拒收） */
function weatherConsistent(line: string, weather: WeatherNow | null | undefined): boolean {
  if (!weather) return true;
  if (/雷|闪电/.test(line) && !weather.storm) return false;
  if (/雪|霜/.test(line) && !weather.snow) return false;
  if (/雨/.test(line) && weather.rain <= 0 && !weather.storm) return false;
  if (/烈日|骄阳|暴晒|炙热/.test(line) && !weather.heat) return false;
  return true;
}

/** 单句硬校验：长度、无数字、不喊、不说 AI、不把两件事拼在一句里；天气意象必须与实况一致 */
function accept(raw: string | null, weather?: WeatherNow | null): string | null {
  if (!raw) return null;
  const line = raw.replace(/^["'“「]+|["'”」]+$/g, '').trim();
  if (!line || line.toLowerCase() === 'null') return null;
  if (line.length < 6 || line.length > MAX_LEN) return null;
  if (/[!！、]/.test(line)) return null;                                       // 不喊、不堆词
  if (/[0-9０-９]/.test(line)) return null;                                     // 不报数
  if (/[一二两三四五六七八九十]\s*[个件场项条次]\s*(会|事|天|点|分钟)/.test(line)) return null; // 不用量词报数
  if (/(作为|我是|AI|人工智能|模型|接口|数据)/.test(line)) return null;
  if (/(软绵绵|软一点|抱住|陪着你|宝贝|乖|心里|肩背|温柔地|不像你的风格|你在逃避|别硬撑)/.test(line)) return null;
  if (/(工作|待办|任务|会议|项目|进度|安排|优先级|逾期|提醒|知识库|回收站|顺延|整理)/.test(line)) return null;
  const parts = line.split(/[,，]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 2) return null;
  if (parts.length === 2 && parts.some((p) => p.length < 5)) return null;      // 碎短句并列
  if (!weatherConsistent(line, weather)) return null;
  return line;
}

function extractText(body: ModelBody): string {
  return body.output_text
    || body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text
    || body.choices?.[0]?.message?.content
    || '';
}

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { /* 抓第一个花括号块 */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error('模型没有返回有效 JSON');
}

/** 本时段已生成过的 AI 文案——让头部重进时不必再等模型（天气码参与 key，天况变了就作废重写） */
export function peekAiLine(dayKey: string, hour: number, kind: MoodKind, tone: MoodTone, weather: WeatherNow | null): string | null {
  const cache = getSetting<AiCache | undefined>(CACHE_KEY);
  const wcode = weather?.code ?? null;
  if (!cache || cache.bucket !== bucketOf(dayKey, hour) || cache.kind !== kind || cache.tone !== tone || cache.wcode !== wcode) return null;
  return accept(cache.text, weather);
}

/** 生成（或取回）本时段的 AI 文案；不可用时返回 null，调用方回落模板句 */
async function generateAiLine(input: VoiceInput, force = false): Promise<string | null> {
  const model = modelConfig();
  if (!model) return null;

  const bucket = bucketOf(input.signals.date, input.signals.hour);
  const wcode = input.weather?.code ?? null;
  if (!force) {
    const cached = peekAiLine(input.signals.date, input.signals.hour, input.kind, input.tone, input.weather);
    if (cached) return cached;
  }

  const prompt = buildPrompt(input);
  const endpoint = `${model.baseUrl}/${model.wireApi === 'responses' ? 'responses' : 'chat/completions'}`;
  const requestBody = model.wireApi === 'responses'
    ? { model: model.model, input: prompt, reasoning: { effort: 'low' }, store: false }
    : { model: model.model, messages: [{ role: 'user', content: prompt }], temperature: 1 };

  let response: Response;
  try {
    response = await modelFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(9000),
    }, 'mood_line');
  } catch { return null; }
  if (!response.ok) return null;

  let body: ModelBody = {};
  try { body = JSON.parse(await response.text()) as ModelBody; } catch { return null; }
  let parsed: unknown;
  try { parsed = parseJson(extractText(body)); } catch { return null; }
  const got = schema.safeParse(parsed);
  if (!got.success) return null;

  // 模型自己排了序：取第一条合格的，不要随机挑（随机容易挑到最用力的那句）；和最近说过的话太像的也淘汰
  const cands = got.data.lines.map((c) => accept(c, input.weather));
  const recent = input.recentLines ?? [];
  const similar = (a: string, b: string) => a === b || (a.length > 4 && b.length > 4 && (a.includes(b) || b.includes(a)));
  if (process.env.MOOD_DEBUG) console.log('[mood-voice] tone=%s raw=%j', input.tone, got.data.lines);
  const line = cands.filter((c): c is string => c !== null && !recent.some((r) => similar(r, c)))[0] ?? null;
  if (!line) return null;
  setSetting(CACHE_KEY, { bucket, kind: input.kind, tone: input.tone, text: line, wcode });
  return line;
}

// 一个账号的装饰文案串行去重；失败短暂冷却，防止刷新页面反复付费。
let pendingLine: { key: string; promise: Promise<string | null> } | null = null;
const cooldown = new Map<string, number>();
export async function aiLine(input: VoiceInput, force = false): Promise<string | null> {
  const key = JSON.stringify([bucketOf(input.signals.date,input.signals.hour),input.kind,input.tone,input.weather?.code]);
  if (pendingLine) return pendingLine.key === key ? pendingLine.promise : null;
  if (!force && (cooldown.get(key) ?? 0) > Date.now()) return null;
  const promise = generateAiLine(input,force);
  pendingLine = {key,promise};
  try { const line = await promise; if (!line) cooldown.set(key,Date.now()+300000); return line; }
  finally { pendingLine = null; for (const [k,t] of cooldown) if (t <= Date.now()) cooldown.delete(k); }
}
