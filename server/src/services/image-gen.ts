/**
 * [INPUT]: image_model 设置（OpenAI images 协议：baseUrl/model/apiKey/aspect）、生图提示词与画面比例
 * [OUTPUT]: 生图结果（图片写入 data/uploads，返回 /api/files/ 可展示地址）、image_model 状态摘要
 * [POS]: 小精灵 workbench_generate_image 工具的执行层；密钥只存本机 SQLite，不回传前端；
 *        调用统一走 modelFetch 计入用量台账。
 *        尺寸按"比例"表达，服务端映射为模型实际支持的尺寸：内置常见模型候选，若模型不认，
 *        从 400 报错里解析出该模型支持的尺寸清单（学习）并就近重试一次，清单缓存在设置里
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataDir, getSetting, setSetting } from '../db.js';
import { modelFetch } from './model-call.js';
import { queueSyncFile } from './supabase-sync.js';

export interface ImageModelSetting {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  aspect: Aspect;
}

export type Aspect = '1:1' | '3:2' | '2:3' | '16:9' | '9:16';

const ASPECTS: Aspect[] = ['1:1', '3:2', '2:3', '16:9', '9:16'];
const ASPECT_RATIO: Record<Aspect, number> = { '1:1': 1, '3:2': 3 / 2, '2:3': 2 / 3, '16:9': 16 / 9, '9:16': 9 / 16 };

/** 首选目标：2K 级别（约 420 万像素），比例对不上时优先保比例 */
const TARGET_AREA = 2048 * 2048;

/** 每种比例的内置候选（OpenAI 标准尺寸在前，常见国产/中转 2K 尺寸在后，兜底） */
const PRESET_CANDIDATES: Record<Aspect, string[]> = {
  '1:1': ['2048x2048', '1024x1024'],
  '3:2': ['2496x1664', '1536x1024', '1792x1024'],
  '2:3': ['1664x2496', '1024x1536', '1024x1792'],
  '16:9': ['2752x1536', '1792x1024'],
  '9:16': ['1536x2752', '1024x1792'],
};

const uploadsDir = join(dataDir, 'uploads');
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

export function readImageModelSetting(): ImageModelSetting {
  const raw = (getSetting<Record<string, unknown>>('image_model') ?? {}) as Record<string, unknown>;
  const aspect = ASPECTS.includes(raw.aspect as Aspect) ? (raw.aspect as Aspect) : '1:1';
  return {
    provider: typeof raw.provider === 'string' ? raw.provider : 'OpenAI 兼容',
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : 'https://api.openai.com/v1',
    model: typeof raw.model === 'string' ? raw.model : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    aspect,
  };
}

export function imageModelStatus() {
  const s = readImageModelSetting();
  const raw = getSetting<Record<string, unknown>>('image_model') ?? {};
  const learned = Array.isArray(raw.allowedSizes) ? (raw.allowedSizes as string[]).length : 0;
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    aspect: s.aspect,
    hasApiKey: Boolean(s.apiKey),
    // 已从报错中学习到模型支持的尺寸数；>0 说明尺寸映射已校准
    learnedSizes: learned,
  };
}

function parseSize(text: string): { w: number; h: number } | null {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(text.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** 从候选里挑比例最接近目标、分辨率最接近 2K 的尺寸 */
function pickSize(candidates: string[], aspect: Aspect): string | null {
  const target = ASPECT_RATIO[aspect];
  const parsed = candidates
    .map((text) => ({ text, size: parseSize(text) }))
    .filter((item): item is { text: string; size: { w: number; h: number } } => item.size !== null);
  if (!parsed.length) return null;
  parsed.sort((a, b) => {
    const score = (item: { size: { w: number; h: number } }) => {
      const ratioDiff = Math.abs(Math.log((item.size.w / item.size.h) / target));
      const areaDiff = Math.abs(Math.log((item.size.w * item.size.h) / TARGET_AREA));
      return ratioDiff * 4 + areaDiff; // 比例权重远大于分辨率
    };
    return score(a) - score(b);
  });
  return parsed[0].text;
}

/** 模型不认尺寸的报错里通常带支持清单，解析出来记到设置里（学习一次，永久生效） */
function learnSizesFromError(message: string): string[] {
  const match = /(?:one of|支持|尺寸)[^:：]*[:：]\s*([0-9x，,\s]+)/i.exec(message);
  if (!match) return [];
  const sizes = match[1].split(/[,，\s]+/).map((s) => s.trim()).filter((s) => parseSize(`${s}`) !== null);
  return [...new Set(sizes)];
}

function saveLearnedSizes(sizes: string[]): void {
  const cur = getSetting<Record<string, unknown>>('image_model') ?? {};
  setSetting('image_model', { ...cur, allowedSizes: sizes });
}

function loadLearnedSizes(): string[] {
  const raw = getSetting<Record<string, unknown>>('image_model') ?? {};
  return Array.isArray(raw.allowedSizes) ? (raw.allowedSizes as unknown[]).filter((s): s is string => typeof s === 'string') : [];
}

async function callGenerations(endpoint: string, apiKey: string, model: string, prompt: string, size: string | undefined) {
  return modelFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, ...(size ? { size } : {}), n: 1 }),
    signal: AbortSignal.timeout(180_000),
  }, 'image_gen');
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function saveImageFile(bytes: Buffer, mime: string): string {
  const ext = Object.values(MIME_BY_EXT).includes(mime)
    ? Object.entries(MIME_BY_EXT).find(([, m]) => m === mime)![0]
    : 'png';
  const name = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.${ext}`;
  writeFileSync(join(uploadsDir, name), bytes);
  queueSyncFile(name);
  return `/api/files/${name}`;
}

interface UpstreamBody {
  error?: { message?: string } | string;
  message?: string;
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  model?: string;
}

/** 调用 OpenAI images 协议生图；b64 和 URL 两种返回都支持，图统一落本机 uploads。 */
export async function generateImage(prompt: string, aspect?: Aspect): Promise<{ url: string; model: string; size: string; revisedPrompt?: string; remoteUrl?: string }> {
  const cfg = readImageModelSetting();
  if (!cfg.model) throw new Error('还没有配置生图模型，请先在设置 → AI 模型 → 生图模型中填写');
  if (!cfg.apiKey) throw new Error('生图模型缺少 API Key，请到设置中补填');
  const wanted = aspect && ASPECTS.includes(aspect) ? aspect : cfg.aspect;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/images/generations`;

  const learned = loadLearnedSizes();
  let size = learned.length ? pickSize(learned, wanted) : null;
  const attempts: Array<{ size?: string; learned: boolean }> = [];
  if (size) attempts.push({ size, learned: false });
  for (const candidate of PRESET_CANDIDATES[wanted]) {
    if (candidate !== size) attempts.push({ size: candidate, learned: false });
  }
  if (!attempts.length) attempts.push({ learned: false }); // 实在没有任何候选就不带 size

  let lastError: string | null = null;
  for (let i = 0; i < attempts.length + 1; i++) {
    const attempt = attempts[i];
    const response = await callGenerations(endpoint, cfg.apiKey, cfg.model, prompt, attempt?.size);
    const raw = await response.text();
    let body: UpstreamBody = {};
    try { body = JSON.parse(raw) as UpstreamBody; } catch { /* 保留原始文本用于报错 */ }
    if (response.ok) {
      const item = body.data?.[0];
      if (!item) throw new Error('生图服务没有返回图片数据');
      let localUrl: string | undefined;
      if (item.b64_json) {
        localUrl = saveImageFile(Buffer.from(item.b64_json, 'base64'), 'image/png');
      } else if (item.url) {
        // URL 形式：下载回本机，避免上游链接过期后图片失效
        const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
        if (!imgRes.ok) throw new Error(`下载生成的图片失败：HTTP ${imgRes.status}`);
        const mime = imgRes.headers.get('content-type')?.split(';')[0] ?? 'image/png';
        if (!Object.values(MIME_BY_EXT).includes(mime)) throw new Error(`生成的图片格式不支持：${mime}`);
        localUrl = saveImageFile(Buffer.from(await imgRes.arrayBuffer()), mime);
      }
      if (!localUrl) throw new Error('生图服务返回内容里既没有图片数据也没有链接');
      return {
        url: localUrl,
        model: body.model ?? cfg.model,
        size: attempt?.size ?? '模型默认',
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
        remoteUrl: item.b64_json ? undefined : item.url,
      };
    }

    const message = typeof body.error === 'string' ? body.error : body.error?.message || body.message || raw;
    lastError = `HTTP ${response.status}：${message.slice(0, 500) || '未提供错误详情'}`;
    // 尺寸不被认可：从报错学习支持清单，按比例就近挑一个重试
    const parsed = learnSizesFromError(message);
    if (response.status === 400 && parsed.length) {
      if (JSON.stringify(parsed) !== JSON.stringify(learned)) saveLearnedSizes(parsed);
      const retry = pickSize(parsed, wanted);
      if (retry && retry !== attempt?.size) {
        attempts.splice(i + 1, 0, { size: retry, learned: true });
      }
    }
  }
  throw new Error(`生图服务调用失败，最后报错 ${lastError}`);
}

/** 连接测试：真实生成一张小图。同样走"不认尺寸→学习→就近重试"的路径。 */
export async function testImageModel(override: { baseUrl?: string; model?: string; apiKey?: string }): Promise<{ ok: true; latencyMs: number; model: string; endpoint: string }> {
  const cfg = readImageModelSetting();
  const baseUrl = (override.baseUrl?.trim() || cfg.baseUrl).replace(/\/+$/, '');
  const model = override.model?.trim() || cfg.model;
  const apiKey = override.apiKey?.trim() || cfg.apiKey || '';
  if (!model) throw new Error('请先填写生图模型名称');
  if (!apiKey) throw new Error('请先填写 API Key');
  const endpoint = `${baseUrl}/images/generations`;
  const startedAt = Date.now();

  let learned = loadLearnedSizes();
  const queue: Array<string | undefined> = learned.length ? [pickSize(learned, '1:1') ?? undefined, undefined] : [undefined];
  let lastStatus = 0;
  let lastMessage = '';
  for (let i = 0; i < queue.length; i++) {
    const response = await callGenerations(endpoint, apiKey, model, 'a small blue circle on white background', queue[i]);
    const raw = await response.text();
    let body: UpstreamBody = {};
    try { body = JSON.parse(raw) as UpstreamBody; } catch { /* 保留原始文本用于报错 */ }
    if (response.ok && body.data?.length) {
      return { ok: true, latencyMs: Date.now() - startedAt, model, endpoint };
    }
    lastStatus = response.status;
    lastMessage = typeof body.error === 'string' ? body.error : body.error?.message || body.message || raw;
    if (response.status === 400) {
      const parsed = learnSizesFromError(lastMessage);
      if (parsed.length) {
        if (JSON.stringify(parsed) !== JSON.stringify(learned)) saveLearnedSizes(parsed);
        learned = parsed;
        const retry = pickSize(parsed, '1:1');
        if (retry && !queue.includes(retry)) queue.push(retry);
      }
    }
  }
  throw new Error(lastStatus ? `生图服务返回 HTTP ${lastStatus}：${lastMessage.slice(0, 500) || '未提供错误详情'}` : '生图服务没有返回图片数据，请确认模型名称是否为生图模型');
}
