import { modelFetch } from '../services/model-call.js';
/**
 * [INPUT]: HTTP 请求——设置读写(含 feishuBot 配置及其 relayExperimentEnabled 开关)、飞书 bot 消息发送、
 *          通知与模型连通性测试、周回顾的查询/保存/重置、数据导出
 * [OUTPUT]: GET/PUT /api/settings、POST /api/feishu/bot/send、POST /api/notify/test、POST /api/model/test、POST /api/image-model/test、
 *           GET/POST /api/review/weekly(+save/reset/weeks)、GET /api/export
 * [POS]: 服务端杂项路由:设置中心、周回顾、数据导出;relayExperimentEnabled 经此持久化,
 *        中继实验链路开关默认 false(冻结态见 services/relay-dispatch.ts)
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, getSetting, setSetting } from '../db.js';
import { nextTrigger } from '../scheduler.js';
import { readConfig } from '../services/mood.js';
import { notifyStatus, sendNotify, type NotifyChannelKind, type NotifySetting } from '../services/notify.js';
import { exportCodexMcpBundle } from '../services/knowledge-connectors.js';
import { feishuBotStatus, saveFeishuBot, sendFeishuBotMessage } from '../services/feishu-bot.js';
import { imageModelStatus, testImageModel } from '../services/image-gen.js';

function mondayOf(d: Date): Date {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // 周一为 0
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

const fmt = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
};

function settingsPayload() {
  const ding = (getSetting<Record<string, string>>('dingtalk') ?? {}) as Record<string, string>;
  const model = getSetting<Record<string, unknown>>('model') ?? {};
  return {
    dingtalk: {
      appKey: ding.appKey ?? '',
      userId: ding.userId ?? '',
      hasSecret: Boolean(ding.appSecret),
    },
    model: {
      provider: typeof model.provider === 'string' ? model.provider : 'OpenAI 兼容',
      baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : 'https://api.openai.com/v1',
      model: typeof model.model === 'string' ? model.model : '',
      hasApiKey: Boolean(model.apiKey),
      wireApi: model.wireApi === 'chat_completions' ? 'chat_completions' : 'responses',
      reasoningEffort: typeof model.reasoningEffort === 'string' ? model.reasoningEffort : 'high',
      assistantReasoningEffort: typeof model.assistantReasoningEffort === 'string' ? model.assistantReasoningEffort : 'low',
      disableResponseStorage: model.disableResponseStorage !== false,
    },
    notify: notifyStatus(),
    imageModel: imageModelStatus(),
    general: getSetting('general') ?? { accent: 'violet' },
    mood: readConfig(),
    feishuBot: feishuBotStatus(),
  };
}

export default async function miscRoutes(app: FastifyInstance) {
  // ---------- 设置 ----------
  app.get('/api/settings', () => settingsPayload());

  app.put('/api/settings', (req) => {
    const b = z.object({
      dingtalk: z.object({
        appKey: z.string().optional(),
        appSecret: z.string().optional(), // 空字符串 = 不修改
        userId: z.string().optional(),
      }).partial().optional(),
      model: z.object({
        provider: z.string().max(80).optional(),
        baseUrl: z.string().max(500).optional(),
        model: z.string().max(160).optional(),
        apiKey: z.string().max(1000).optional(), // 空字符串 = 不修改
        wireApi: z.enum(['responses', 'chat_completions']).optional(),
        reasoningEffort: z.string().max(30).optional(),
        assistantReasoningEffort: z.enum(['', 'low', 'medium', 'high', 'xhigh']).optional(),
        disableResponseStorage: z.boolean().optional(),
      }).partial().optional(),
      general: z.object({
        accent: z.string().optional(),
        theme: z.enum(['auto', 'light', 'dark']).optional(),
        appName: z.string().max(40).optional(), // 工作台名称（侧栏/标题栏/通知前缀展示）
        appAvatar: z.string().max(500).optional(), // 头像/Logo 图片 URL（/api/uploads）
        shortcut: z.string().max(40).optional(), // 全局搜索快捷键，如 'mod+k'
        location: z.object({
          name: z.string().max(60),
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
        }).partial().optional(),
      }).partial().optional(),
      mood: z.object({
        enabled: z.boolean().optional(),
        tone: z.enum(['温和', '中性', '冷淡', '毒舌']).optional(),
        ai: z.boolean().optional(),
        whisper: z.boolean().optional(),
        character: z.enum(['ball', 'nimbo', 'twinkle']).optional(),
        name: z.string().max(20).optional(),
      }).partial().optional(),
      imageModel: z.object({
        provider: z.string().max(80).optional(),
        baseUrl: z.string().max(500).optional(),
        model: z.string().max(160).optional(),
        apiKey: z.string().max(1000).optional(), // 空字符串 = 不修改
        aspect: z.enum(['1:1', '3:2', '2:3', '16:9', '9:16']).optional(),
      }).partial().optional(),
      feishuBot: z.object({ appId: z.string().max(200).optional(), appSecret: z.string().max(500).optional(), verificationToken: z.string().max(500).optional(), encryptKey: z.string().max(500).optional(), relayChatId: z.string().max(100).optional(), relayChatIds: z.array(z.string().max(100)).max(10).optional(), relayExperimentEnabled: z.boolean().optional() }).partial().optional(),
      ics: z.object({ url: z.string() }).partial().optional(),
      notify: z.object({
        prefix: z.string().max(30).optional(),
        pushReminders: z.boolean().optional(),
        defaultChannel: z.enum(['auto', 'inapp', 'system', 'feishu', 'dingtalk']).optional(), // 提醒默认送达渠道
        dingtalk: z.object({
          webhook: z.string().max(600).optional(), // 空字符串 = 清除
          secret: z.string().max(300).optional(),   // 空字符串 = 清除，不传 = 不修改
          enabled: z.boolean().optional(),
        }).partial().optional(),
        feishu: z.object({
          webhook: z.string().max(600).optional(),
          secret: z.string().max(300).optional(),
          enabled: z.boolean().optional(),
        }).partial().optional(),
      }).partial().optional(),
    }).parse(req.body);

    if (b.dingtalk) {
      const cur = getSetting<Record<string, string>>('dingtalk') ?? {};
      const next = { ...cur };
      if (b.dingtalk.appKey !== undefined) next.appKey = b.dingtalk.appKey.trim();
      if (b.dingtalk.userId !== undefined) next.userId = b.dingtalk.userId.trim();
      if (b.dingtalk.appSecret) next.appSecret = b.dingtalk.appSecret.trim();
      setSetting('dingtalk', next);
    }
    if (b.model) {
      const cur = getSetting<Record<string, unknown>>('model') ?? {};
      const next = { ...cur };
      if (b.model.provider !== undefined) next.provider = b.model.provider.trim();
      if (b.model.baseUrl !== undefined) next.baseUrl = b.model.baseUrl.trim().replace(/\/+$/, '');
      if (b.model.model !== undefined) next.model = b.model.model.trim();
      if (b.model.apiKey) next.apiKey = b.model.apiKey.trim();
      if (b.model.wireApi !== undefined) next.wireApi = b.model.wireApi;
      if (b.model.reasoningEffort !== undefined) next.reasoningEffort = b.model.reasoningEffort.trim();
      if (b.model.assistantReasoningEffort !== undefined) next.assistantReasoningEffort = b.model.assistantReasoningEffort;
      if (b.model.disableResponseStorage !== undefined) next.disableResponseStorage = b.model.disableResponseStorage;
      setSetting('model', next);
    }
    if (b.imageModel) {
      const cur = getSetting<Record<string, unknown>>('image_model') ?? {};
      const next = { ...cur };
      if (b.imageModel.provider !== undefined) next.provider = b.imageModel.provider.trim();
      if (b.imageModel.baseUrl !== undefined) next.baseUrl = b.imageModel.baseUrl.trim().replace(/\/+$/, '');
      if (b.imageModel.model !== undefined) next.model = b.imageModel.model.trim();
      if (b.imageModel.apiKey) next.apiKey = b.imageModel.apiKey.trim();
      if (b.imageModel.aspect !== undefined) next.aspect = b.imageModel.aspect;
      setSetting('image_model', next);
    }
    if (b.general) setSetting('general', { ...(getSetting('general') as object ?? {}), ...b.general });
    if (b.mood) setSetting('mood', {
      ...(getSetting('mood') as object ?? {}),
      ...b.mood,
      ...(b.mood.name !== undefined ? { name: b.mood.name.trim() } : {}),
    });
    if (b.feishuBot) saveFeishuBot(b.feishuBot);
    if (b.notify) {
      const cur = getSetting<NotifySetting>('notify') ?? {};
      const next: NotifySetting = { ...cur };
      if (b.notify.prefix !== undefined) next.prefix = b.notify.prefix.trim();
      if (b.notify.pushReminders !== undefined) next.pushReminders = b.notify.pushReminders;
      if (b.notify.defaultChannel !== undefined) next.defaultChannel = b.notify.defaultChannel;
      for (const kind of ['dingtalk', 'feishu'] as const) {
        const patch = b.notify[kind];
        if (!patch) continue;
        const merged = { ...(cur[kind] ?? {}) };
        if (patch.webhook !== undefined) {
          const url = patch.webhook.trim();
          if (url) {
            let parsed: URL;
            try { parsed = new URL(url); } catch { throw app.httpErrors.badRequest('Webhook 地址格式不正确'); }
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
              throw app.httpErrors.badRequest('Webhook 地址需以 http(s):// 开头');
            }
          }
          merged.webhook = url;
        }
        if (patch.secret !== undefined) {
          if (patch.secret.trim()) merged.secret = patch.secret.trim();
          else delete merged.secret;
        }
        if (patch.enabled !== undefined) merged.enabled = patch.enabled;
        if (!merged.webhook) merged.enabled = false;
        next[kind] = merged;
      }
      setSetting('notify', next);
    }
    return settingsPayload();
  });

  app.post('/api/feishu/bot/send', async (req) => {
    const b = z.object({ receiveIdType: z.enum(['open_id', 'chat_id', 'email', 'user_id']).default('chat_id'), receiveId: z.string().min(1), text: z.string().min(1).max(10000) }).parse(req.body ?? {});
    return { ok: true, ...(await sendFeishuBotMessage(b.receiveIdType, b.receiveId, b.text)) };
  });

  // 消息通道试发：填了就用填入的值，没填回落到已保存的凭据
  app.post('/api/notify/test', async (req): Promise<{ ok: true }> => {
    const b = z.object({
      channel: z.enum(['dingtalk', 'feishu']),
      webhook: z.string().max(600).optional(),
      secret: z.string().max(300).optional(),
      text: z.string().max(500).optional(),
    }).parse(req.body ?? {});
    const prefix = getSetting<NotifySetting>('notify')?.prefix?.trim() || 'YZ工作台';
    const text = b.text?.trim() || `${prefix} · 通道测试：看到这条就说明配置对了`;
    const r = await sendNotify(b.channel as NotifyChannelKind, text, { webhook: b.webhook, secret: b.secret });
    if (!r.ok) throw app.httpErrors.badGateway(r.error ?? '发送失败');
    return { ok: true };
  });

  // OpenAI 兼容模型连接测试。密钥只在服务端读取和使用，不回传给浏览器。
  app.post('/api/model/test', async (req) => {
    const override = z.object({
      provider: z.string().max(80).optional(),
      baseUrl: z.string().max(500).optional(),
      model: z.string().max(160).optional(),
      apiKey: z.string().max(1000).optional(),
      wireApi: z.enum(['responses', 'chat_completions']).optional(),
      reasoningEffort: z.string().max(30).optional(),
      disableResponseStorage: z.boolean().optional(),
    }).parse(req.body ?? {});
    const saved = getSetting<Record<string, unknown>>('model') ?? {};
    const savedBaseUrl = typeof saved.baseUrl === 'string' ? saved.baseUrl : '';
    const savedModel = typeof saved.model === 'string' ? saved.model : '';
    const savedApiKey = typeof saved.apiKey === 'string' ? saved.apiKey : '';
    const baseUrl = (override.baseUrl?.trim() || savedBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = override.model?.trim() || savedModel;
    const apiKey = override.apiKey?.trim() || savedApiKey;
    const wireApi = override.wireApi ?? (saved.wireApi === 'chat_completions' ? 'chat_completions' : 'responses');
    const savedEffort = typeof saved.reasoningEffort === 'string' ? saved.reasoningEffort : '';
    const reasoningEffort = override.reasoningEffort?.trim() || savedEffort || 'low';
    const disableResponseStorage = override.disableResponseStorage ?? saved.disableResponseStorage !== false;
    if (!model) throw app.httpErrors.badRequest('请先填写模型名称');
    if (!apiKey) throw app.httpErrors.badRequest('请先填写 API Key');
    try { new URL(baseUrl); } catch { throw app.httpErrors.badRequest('Base URL 格式不正确'); }

    const endpoint = `${baseUrl}/${wireApi === 'responses' ? 'responses' : 'chat/completions'}`;
    const requestBody = wireApi === 'responses'
      ? {
          model,
          input: 'Reply with OK only.',
          reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
          store: !disableResponseStorage,
        }
      : {
          model,
          messages: [{ role: 'user', content: 'Reply with OK only.' }],
          store: !disableResponseStorage,
        };

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await modelFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(20_000),
      }, 'model_test');
    } catch (error) {
      const err = error as Error & { cause?: Error & { code?: string } };
      const cause = err.cause;
      const code = cause?.code ?? '';
      const host = new URL(baseUrl).host;
      if (err.name === 'TimeoutError' || code.includes('TIMEOUT')) {
        throw app.httpErrors.gatewayTimeout(
          `连接超时：无法连接 ${host}。请检查中转站是否在线，以及本机网络、VPN 或代理设置。`,
        );
      }
      throw app.httpErrors.badGateway(
        `无法连接模型服务 ${host}：${cause?.message || err.message}`,
      );
    }

    const host = new URL(baseUrl).host;
    const raw = await response.text();
    let body: {
      error?: { message?: string } | string;
      message?: string;
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    } = {};
    let parsed = false;
    try { body = JSON.parse(raw) as typeof body; parsed = true; } catch { /* 非 JSON：很可能是站点首页 HTML */ }
    if (!response.ok) {
      const upstreamMessage = typeof body.error === 'string'
        ? body.error
        : body.error?.message || body.message || raw;
      throw app.httpErrors.badGateway(
        `中转站返回 HTTP ${response.status}：${upstreamMessage.slice(0, 500) || '未提供错误详情'}`,
      );
    }
    // 连接通、HTTP 200，但返回的不是合法模型响应（典型：Base URL 漏了 /v1，拿到站点首页）。
    // 旧逻辑只判 response.ok，会把这种 200+HTML 误报成「连接正常」，导致假阳性。
    if (!parsed) {
      throw app.httpErrors.badGateway(
        `连接 ${host} 成功，但返回的不是合法的模型响应（很可能是站点首页而非 API）。请检查 Base URL 是否漏了 /v1 后缀（应为 https://<域名>/v1）。`,
      );
    }
    const responseText = body.output_text
      || body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text
      || body.choices?.[0]?.message?.content
      || '';
    if (!responseText) {
      throw app.httpErrors.badGateway(
        `连接 ${host} 成功，但响应里没有有效的回复内容（choices/output 为空）。请确认模型名与路径正确。`,
      );
    }
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      model: body.model ?? model,
      wireApi,
      endpoint,
      reply: responseText.trim(),
    };
  });

  // 生图模型连接测试：真实生成一张小图验证链路。密钥只在服务端使用，不回传浏览器。
  // 尺寸兼容逻辑（比例就近映射 + 报错学习重试）在 services/image-gen.ts 内。
  app.post('/api/image-model/test', async (req) => {
    const override = z.object({
      baseUrl: z.string().max(500).optional(),
      model: z.string().max(160).optional(),
      apiKey: z.string().max(1000).optional(),
    }).parse(req.body ?? {});
    try { new URL((override.baseUrl?.trim() || imageModelStatus().baseUrl)); } catch { throw app.httpErrors.badRequest('Base URL 格式不正确'); }
    try {
      return await testImageModel(override);
    } catch (error) {
      const message = (error as Error).message;
      if (/请先填写/.test(message)) throw app.httpErrors.badRequest(message);
      throw app.httpErrors.badGateway(message);
    }
  });

  // ---------- 周回顾（按整周：本周 / 上周 / 自选某年某月的第几周） ----------
  app.get('/api/review/weekly', (req) => {
    const q = z.object({
      offset: z.coerce.number().int().min(0).max(520).default(0),
      weekStart: z.string().optional().transform((v) => (v ? v.slice(0, 10) : undefined)),
    }).parse(req.query);

    let start: Date;
    if (q.weekStart) {
      start = new Date(q.weekStart + 'T00:00:00');
    } else {
      start = mondayOf(new Date());
      start.setDate(start.getDate() - q.offset * 7);
    }
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const s = fmt(start), e = fmt(end);
    const isCurrentWeek = !q.weekStart && q.offset === 0;

    const completedTasks = db.prepare(
      `SELECT t.*, p.domain AS domain, p.name AS project_name FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.status='done' AND t.deleted_at IS NULL AND t.completed_at >= ? AND t.completed_at < ?
       ORDER BY t.completed_at DESC`,
    ).all(s, e) as Array<Record<string, unknown>>;

    const perDay = db.prepare(
      `SELECT substr(completed_at, 1, 10) AS d, COUNT(*) AS n FROM tasks
       WHERE status='done' AND deleted_at IS NULL AND completed_at >= ? AND completed_at < ? GROUP BY d`,
    ).all(s, e) as Array<{ d: string; n: number }>;

    const byDomain = db.prepare(
      `SELECT COALESCE(p.domain,'none') AS k, COUNT(*) AS n FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.status='done' AND t.deleted_at IS NULL AND t.completed_at >= ? AND t.completed_at < ? GROUP BY k`,
    ).all(s, e) as Array<{ k: string; n: number }>;

    const newNotes = (db.prepare(
      'SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?',
    ).get(s, e) as { n: number }).n;
    const newFragments = (db.prepare(
      "SELECT COUNT(*) AS n FROM fragments WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?",
    ).get(s, e) as { n: number }).n;

    // 停滞项目：active 且本周没有完成任务、且 open 任务 > 0
    const stagnant = db.prepare(
      `SELECT p.id, p.name, p.domain,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status != 'done') AS open_tasks,
        (SELECT MAX(t.completed_at) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL) AS last_done
       FROM projects p WHERE p.status = 'active' AND p.deleted_at IS NULL
         AND open_tasks > 0 AND (last_done IS NULL OR last_done < ?)
       ORDER BY last_done IS NOT NULL DESC, last_done DESC`,
    ).all(s) as Array<Record<string, unknown>>;

    const upcomingReminders = db.prepare(
      `SELECT * FROM reminders WHERE status='pending' AND deleted_at IS NULL ORDER BY trigger_at ASC LIMIT 10`,
    ).all();

    // 用户编辑过的自定义段落：{ sectionIndex: content }，content 是去序号的纯内容（前端展示时再加 1. 2.）
    const overrideRows = db.prepare(
      `SELECT section_index, content FROM weekly_report_overrides WHERE week_start = ?`,
    ).all(s.slice(0, 10)) as Array<{ section_index: number; content: string }>;
    const overrides: Record<number, string> = {};
    for (const r of overrideRows) overrides[r.section_index] = r.content;

    let nextTasks: Array<Record<string, unknown>> = [];
    if (isCurrentWeek) {
      const nextStart = new Date(end);
      const nextEnd = new Date(nextStart);
      nextEnd.setDate(nextEnd.getDate() + 7);
      nextTasks = db.prepare(
        `SELECT t.*, p.domain AS domain, p.name AS project_name FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.deleted_at IS NULL AND t.status != 'done'
           AND t.planned_date >= ? AND t.planned_date < ?
         ORDER BY t.priority DESC, t.planned_date ASC, t.created_at ASC`,
      ).all(fmt(nextStart), fmt(nextEnd)) as Array<Record<string, unknown>>;
    }

    return {
      weekStart: s,
      isCurrentWeek,
      stats: {
        completedTasks: completedTasks.length,
        workDone: byDomain.find((r) => r.k === 'work')?.n ?? 0,
        lifeDone: byDomain.find((r) => r.k === 'life')?.n ?? 0,
        noneDone: byDomain.find((r) => r.k === 'none')?.n ?? 0,
        newNotes, newFragments,
        activeProjects: (db.prepare("SELECT COUNT(*) AS n FROM projects WHERE status='active' AND deleted_at IS NULL")
          .get() as { n: number }).n,
      },
      perDay,
      recentCompleted: completedTasks,
      nextWeekTasks: nextTasks.slice(0, 30),
      stagnant,
      upcomingReminders,
      overrides,
    };
  });

  // ---------- 周报自定义段落：保存 / 清除 ----------
  // 用户在周报卡片编辑时输入的内容（已含序号）。保存前把行首序号剥掉，按 (weekStart, sectionIndex) 落库。
  // 不入 sync_entities：周报内容是个人化编辑结果，不跨设备同步。
  // 行首序号识别：`1.` `2、` `3)` `4 ` `(1)` `*` `-` `•` 都视作可剥前缀
  const LEADING_NUM_RE = /^\s*(?:\d+[.、)\s]\s*|[(*\-+•]\s*|（\s*\d+\s*）\s*)/;

  app.post('/api/review/weekly/save', async (req) => {
    const body = z.object({
      weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      // sections: 与 sectionTitles 等长的字符串数组；空字符串表示"清空该段"（恢复自动生成）
      sections: z.array(z.string()).max(8),
    }).parse(req.body);
    const { weekStart, sections } = body;
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (let i = 0; i < sections.length; i += 1) {
        const cleaned = sections[i]
          .split('\n')
          .map((line) => line.replace(LEADING_NUM_RE, '').trimEnd())
          .join('\n');
        if (cleaned.trim() === '') {
          // 空段落直接清掉，下次回退到自动生成
          db.prepare('DELETE FROM weekly_report_overrides WHERE week_start = ? AND section_index = ?').run(weekStart, i);
        } else {
          db.prepare(
            `INSERT INTO weekly_report_overrides (week_start, section_index, content, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(week_start, section_index) DO UPDATE SET
               content = excluded.content, updated_at = excluded.updated_at`,
          ).run(weekStart, i, cleaned, now);
        }
      }
    });
    tx();
    return { ok: true, weekStart, updatedAt: now };
  });

  app.post('/api/review/weekly/reset', async (req) => {
    const body = z.object({
      weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(req.body);
    db.prepare('DELETE FROM weekly_report_overrides WHERE week_start = ?').run(body.weekStart);
    return { ok: true, weekStart: body.weekStart };
  });

  // ---------- 某年某月各周是否有数据（周选择器打点用） ----------
  app.get('/api/review/weeks', (req) => {
    const q = z.object({
      year: z.coerce.number().int(),
      month: z.coerce.number().int().min(1).max(12),
    }).parse(req.query);
    const { year, month } = q;
    const firstMonday = mondayOf(new Date(year, month - 1, 1));
    const lastOfMonth = new Date(year, month, 0);
    const out: Array<{ weekN: number; weekStart: string; weekEnd: string; hasData: boolean }> = [];
    let cur = new Date(firstMonday);
    let weekN = 1;
    while (cur <= lastOfMonth) {
      const ws = new Date(cur);
      const we = new Date(cur);
      we.setDate(we.getDate() + 7);
      const s = fmt(ws);
      const e = fmt(we);
      const n = (db.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE status='done' AND deleted_at IS NULL AND completed_at >= ? AND completed_at < ?",
      ).get(s, e) as { n: number }).n;
      out.push({
        weekN,
        weekStart: s.slice(0, 10),
        weekEnd: fmt(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 6)).slice(0, 10),
        hasData: n > 0,
      });
      cur.setDate(cur.getDate() + 7);
      weekN += 1;
    }
    return out;
  });

  // ---------- 导出 ----------
  app.get('/api/export', async () => ({
    format: 'yz-workbench-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    projects: db.prepare('SELECT * FROM projects').all(),
    tasks: db.prepare('SELECT * FROM tasks').all(),
    fragments: db.prepare('SELECT * FROM fragments').all(),
    notes: db.prepare('SELECT * FROM notes').all(),
    prompts: db.prepare('SELECT * FROM prompts').all(),
    knowledgeArchives: db.prepare('SELECT * FROM knowledge_archives').all(),
    knowledge: {
      // Keep the legacy top-level fields above for older importers, while the
      // grouped section makes the complete knowledge payload explicit.
      notes: db.prepare('SELECT * FROM notes').all(),
      archives: db.prepare('SELECT * FROM knowledge_archives').all(),
      syncHistory: db.prepare('SELECT * FROM knowledge_sync_history').all(),
    },
    // 导出与界面同口径：回收站里的软删提醒不该出现在备份里
    reminders: db.prepare('SELECT * FROM reminders WHERE deleted_at IS NULL').all(),
    events: db.prepare('SELECT * FROM events').all(),
    mcp: await exportCodexMcpBundle(),
  }));
}
