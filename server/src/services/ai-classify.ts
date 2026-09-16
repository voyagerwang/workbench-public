import { modelFetch } from './model-call.js';
import { z } from 'zod';
import { getSetting } from '../db.js';
import { extractRecurringSchedule, repeatRuleSchema, type RepeatRule } from './recurrence.js';
import { classify, extractWhen, hasReminderIntent, reminderNeedsTask, type FragType } from './classify.js';
import { normalizeTags } from './tags.js';

export type AiTriageItem = {
  type: FragType;
  content: string;
  plannedDate?: string | null;
  remindAt?: string | null;
  repeatRule?: RepeatRule;
  /** 同时进清单与提醒：提醒式语句带了交付动作 */
  dual?: boolean;
  confidence?: number;
  needsReview?: boolean;
  splitReason?: string | null;
  /**
   * 随手记标签。**只有用户明确点名要打的标签才填**，
   * 模型自己归纳的主题词一律不许写进来（下面 applyGuardrails 会对非 note 类型再兜一道）。
   */
  tags?: string[];
};

export type AiTriageAnalysis = {
  confidence: number;
  needsReview: boolean;
  splitReason: string | null;
};

const itemSchema = z.object({
  type: z.enum(['task', 'note', 'reminder']),
  content: z.string().trim().min(1).max(4000),
  plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  remindAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/).nullable().optional(),
  repeatRule: repeatRuleSchema.nullable().optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  needsReview: z.boolean().default(false),
  splitReason: z.string().trim().max(300).nullable().optional(),
  // 模型可能给 null（"用户没提标签"），统一折成 undefined，下游只看「有没有」
  tags: z.array(z.string().trim().min(1).max(40)).max(10).nullish().transform((v) => v ?? undefined),
});

const resultSchema = z.object({ items: z.array(itemSchema).min(1).max(8) });

type ModelResponse = {
  error?: { message?: string } | string;
  message?: string;
  choices?: Array<{ message?: { content?: string } }>;
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};

function responseText(body: ModelResponse): string {
  return body.output_text
    || body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text
    || body.choices?.[0]?.message?.content
    || '';
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* try extracting the first JSON object below */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('模型没有返回有效 JSON');
}

function localDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 只接受 YYYY-MM-DDTHH:mm[:ss]，其余当没有时间 */
function normalizeRemindAt(value?: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/.exec(value.trim());
  return m ? `${m[1]}T${m[2]}:00` : null;
}

function applyGuardrails(item: AiTriageItem, sourceContent = item.content): AiTriageItem {
  const localType = classify(item.content);
  const itemRecurring = extractRecurringSchedule(item.content);
  const sourceRecurring = itemRecurring ?? extractRecurringSchedule(sourceContent);
  const recurring = item.type === 'task' || localType === 'task' ? sourceRecurring : null;
  const at = normalizeRemindAt(item.remindAt) ?? normalizeRemindAt(extractWhen(item.content));
  // 标签只归随手记：清单与提醒没有标签字段，带了也会被丢掉
  const tags = item.type === 'note' ? normalizeTags(item.tags ?? []) : undefined;

  // 明显的行动句不能被模型吞成 note 或 reminder；周期词必须保留为结构化任务语义。
  if (item.type !== 'task' && localType === 'task' && !hasReminderIntent(sourceContent)) {
    return {
      ...item,
      type: 'task',
      plannedDate: recurring?.plannedDate ?? item.plannedDate ?? null,
      repeatRule: recurring?.repeatRule ?? item.repeatRule ?? 'none',
      remindAt: null,
      confidence: Math.min(item.confidence ?? 0.8, 0.65),
      needsReview: true,
      dual: false,
      tags: undefined,
    };
  }

  // 明显的行动句不能被模型吞成 note；提醒意图不能被模型丢掉。
  if (item.type === 'note' && (localType === 'task' || localType === 'reminder')) {
    return {
      ...item,
      type: localType,
      remindAt: localType === 'reminder' ? at : null,
      plannedDate: localType === 'task' ? recurring?.plannedDate ?? item.plannedDate ?? at?.slice(0, 10) ?? null : null,
      repeatRule: localType === 'task' ? recurring?.repeatRule ?? item.repeatRule ?? 'none' : 'none',
      confidence: Math.min(item.confidence ?? 0.8, 0.65),
      needsReview: true,
      tags: undefined,
    };
  }

  if (item.type === 'reminder') {
    if (at && reminderNeedsTask(item.content)) {
      return {
        ...item,
        type: 'task',
        plannedDate: recurring?.plannedDate ?? at.slice(0, 10),
        remindAt: at,
        repeatRule: recurring?.repeatRule ?? item.repeatRule ?? 'none',
        dual: true,
        tags: undefined,
      };
    }
    return { ...item, type: 'reminder', plannedDate: null, remindAt: at, dual: false, tags: undefined };
  }

  if (item.type === 'task') {
    // 模型漏填时间但原文有明确提醒词 → 补上联动提醒
    const remind = at ?? (hasReminderIntent(item.content) ? normalizeRemindAt(extractWhen(item.content)) : null);
    return {
      ...item,
      plannedDate: recurring?.plannedDate ?? item.plannedDate ?? at?.slice(0, 10) ?? null,
      repeatRule: recurring?.repeatRule ?? item.repeatRule ?? 'none',

      remindAt: remind,
      dual: Boolean(remind),
      tags: undefined,
    };
  }

  return { ...item, plannedDate: null, remindAt: null, repeatRule: 'none', dual: false, tags };
}

/** 分诊专用超时：比普通问答宽一些，否则拆句与推理容易在 8s 被掉断，退化成规则分诊 */
export const TRIAGE_TIMEOUT_MS = 12_000;

/** 使用设置页中的 OpenAI 兼容模型判断类型，并按需拆分为多个独立条目。未配置模型时返回 null。 */
export async function classifyWithAI(content: string): Promise<{ items: AiTriageItem[]; analysis: AiTriageAnalysis } | null> {
  const saved = getSetting<Record<string, unknown>>('model') ?? {};
  const baseUrl = (typeof saved.baseUrl === 'string' ? saved.baseUrl : '').trim().replace(/\/+$/, '');
  const model = typeof saved.model === 'string' ? saved.model.trim() : '';
  const apiKey = typeof saved.apiKey === 'string' ? saved.apiKey.trim() : '';
  if (!baseUrl || !model || !apiKey) return null;

  const wireApi = saved.wireApi === 'chat_completions' ? 'chat_completions' : 'responses';
  const reasoningEffort = typeof saved.reasoningEffort === 'string' ? saved.reasoningEffort.trim() : '';
  // 分诊是短分类任务，不需要用户给聊天设的高推理档位；卡一下能省掉大半超时退规则
  const triageEffort = !reasoningEffort || reasoningEffort === 'medium' || reasoningEffort === 'high' || reasoningEffort === 'xhigh'
    ? 'low'
    : reasoningEffort;
  const disableResponseStorage = saved.disableResponseStorage !== false;
  const endpoint = `${baseUrl}/${wireApi === 'responses' ? 'responses' : 'chat/completions'}`;
  const prompt = `你是个人工作台的随手记分诊助手。今天是 ${localDate()}（本地时间）。\n` +
    '按“先分类、后判断是否拆分”的顺序处理输入。每个输出项必须能独立完成、独立记录或独立触发提醒。\n' +
    '分类决策：\n' +
    '1) reminder：用户只想要“到点通知我”，本身没有可勾选的完成结果，例如“提醒我喝水”“下班打卡”。没有提醒意图时，不要仅因出现“记得/时间”就判 reminder。\n' +
    '2) task：存在明确执行动作和可勾选的完成结果，例如提交、整理、联系、购买、准备、检查、跟进；“我要/需要/计划/准备做”也优先是 task。计划日期是 plannedDate。\n' +
    '3) note：事实、知识、链接、背景、想法或资料本身，没有要求我执行动作；“记录：提交周报的模板链接”整体是 note，不能被其中的动作词带偏。\n' +
    '周期规则：用户说“每周五/每星期五/每个工作日/每天/每月X号/每N天”等重复执行时，必须输出 repeatRule（weekly/weekdays/daily/monthly/ndays:N），不要把周期词只留在 content；plannedDate 填下一次实际执行日期。仅说“周五”或“下周五”但没有“每”时，repeatRule 必须为 none，plannedDate 填对应的一次性日期。\n' +
    '“明天提醒我交材料”这类既给了通知点又有交付物的句子：选 task，并把时间填进 remindAt（系统会同时建清单项和挂在它上面的联动提醒），不要拆成两条。\n' +
    '拆分决策：只有出现两个或以上独立的完成标准、交付物、负责人或时间点才拆分。\n' +
    '保留为一条的情况：一个目标的必要步骤、同一交付物的描述、并列但不需要分别跟踪的内容（如“整理桌面，包括擦桌子和收文件”）。\n' +
    '需要拆分的情况：不同交付物/动作/负责人/日期（如“整理周报，并把结论发给老板”→两个 task；“准备周会：收集数据、整理 PPT、发会议邀请”→三个 task）。不要把背景、复盘结构或解释段落拆成事项。\n' +
    '每项只保留一个主要动作和一个结果，不补充输入中没有的信息；最多 8 项。无法确定时宁可保留一条，并将 needsReview 设为 true。\n' +
    'task 可填 plannedDate（YYYY-MM-DD）；周期任务必须同时填 repeatRule，repeatRule 为 weekly 时 plannedDate 是下一次执行日；有明确通知时间时（包括挂在 task 上的提醒）填 remindAt（YYYY-MM-DDTHH:mm）；reminder 尽量填出 remindAt，无法确定时填 null。不要凭空补时间。confidence 为 0 到 1；发生拆分时 splitReason 简述拆分依据，否则为 null。\n' +
    'tags（只给 note 用）规则：**只有用户明确说出要打什么标签时才填**——出现“加标签/打个标签/标记为/标签是/用 X 标签/归到 X”这类明确指令，或标签以 # 开头已经写在原文里。用户没提标签时一律省略 tags，不许按内容主题自己归纳标签。标签不带 # 前缀，每条不超过 40 字，最多 10 条。\n' +
    '必须只返回 JSON，不要 Markdown 或解释，格式：{"items":[{"type":"task|note|reminder","content":"...","plannedDate":"YYYY-MM-DD或null","remindAt":"YYYY-MM-DDTHH:mm或null","repeatRule":"none|daily|weekly|weekdays|monthly|ndays:N或null","confidence":0.0,"needsReview":false,"splitReason":"...或null","tags":["..."]或省略}]}。保留原意，不要凭空添加事项。\n' +
    `输入：${content}`;

  const requestBody = wireApi === 'responses'
    ? {
        model,
        input: prompt,
        reasoning: triageEffort ? { effort: triageEffort } : undefined,
        store: !disableResponseStorage,
      }
    : {
        model,
        messages: [{ role: 'user', content: prompt }],
        store: !disableResponseStorage,
      };

  let response: Response;
  try {
    response = await modelFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(TRIAGE_TIMEOUT_MS),
    }, 'triage');
  } catch (error) {
    throw new Error(`模型连接失败：${(error as Error).message}`);
  }

  const raw = await response.text();
  let body: ModelResponse = {};
  try { body = JSON.parse(raw) as ModelResponse; } catch { /* use raw in the error below */ }
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : body.error?.message || body.message || raw;
    throw new Error(`模型返回 HTTP ${response.status}：${message.slice(0, 300)}`);
  }

  const parsed = resultSchema.safeParse(parseJson(responseText(body)));
  if (!parsed.success) throw new Error('模型返回的分类结果格式不正确');
  const items = parsed.data.items.map((item) => applyGuardrails({ ...item, repeatRule: item.repeatRule ?? 'none' }, content));
  return {
    items,
    analysis: {
      confidence: Math.min(...items.map((item) => item.confidence ?? 0.8)),
      needsReview: items.some((item) => item.needsReview),
      splitReason: items.length > 1 ? (items.find((item) => item.splitReason)?.splitReason ?? '检测到多个独立完成结果') : null,
    },
  };
}
