import { z } from 'zod';

export type RepeatRule = 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | `ndays:${number}`;

/** 有限枚举值（ndays:N 走正则单独校验） */
export const REPEAT_RULE_ENUM = ['none', 'daily', 'weekly', 'weekdays', 'monthly'] as const;

/** repeat_rule 的统一校验：枚举 + 每 N 天（ndays:3）；用 refine 保住字面量类型 */
export const repeatRuleSchema: z.ZodType<RepeatRule, z.ZodTypeDef, string> = z.string().refine(
  (v): v is RepeatRule => (REPEAT_RULE_ENUM as readonly string[]).includes(v) || /^ndays:[1-9]\d*$/.test(v),
  { message: `repeat_rule 需为 ${REPEAT_RULE_ENUM.join('/')} 或 ndays:N` },
);

/** 解析 ndays:N 里的间隔天数；非 ndays 规则返回 null */
export function repeatIntervalDays(rule: string): number | null {
  const m = rule.match(/^ndays:([1-9]\d*)$/);
  return m ? Number(m[1]) : null;
}

const WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function dateOnly(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 同一天序号的“下个月”：1月31日 → 2月28日，而不是溢出到3月 */
function addMonthsClamped(d: Date, months: number): Date {
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

/** 将“每周五/每个工作日/每天/每月X号/每N天”归一成可落库的周期任务计划。 */
export function extractRecurringSchedule(content: string, from = new Date()): { repeatRule: RepeatRule; plannedDate: string } | null {
  const text = content.trim();

  // 每 N 天要先于“每天”判断，避免被“每天”截胡
  const everyN = text.match(/每\s*(\d{1,3})\s*天/);
  if (everyN) {
    const days = Math.min(Number(everyN[1]), 365);
    const next = new Date(from);
    next.setDate(next.getDate() + days);
    return { repeatRule: `ndays:${days}`, plannedDate: dateOnly(next) };
  }

  // 每月X号（“每月”不带号则视为每月同一天）
  const monthly = text.match(/每月\s*(?:(\d{1,2})\s*[号日])?/);
  if (monthly) {
    const day = monthly[1] ? Math.min(Number(monthly[1]), 31) : from.getDate();
    const next = addMonthsClamped(new Date(from), 1);
    next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
    return { repeatRule: 'monthly', plannedDate: dateOnly(next) };
  }

  const weekday = text.match(/每(?:周|星期)([一二三四五六日天])/);
  if (weekday) {
    const target = WEEKDAY[weekday[1]!];
    const next = new Date(from);
    let diff = (target - next.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    next.setDate(next.getDate() + diff);
    return { repeatRule: 'weekly', plannedDate: dateOnly(next) };
  }

  if (/每(?:个)?工作日|周一到周五|星期一到星期五/.test(text)) {
    const next = new Date(from);
    do next.setDate(next.getDate() + 1); while (next.getDay() === 0 || next.getDay() === 6);
    return { repeatRule: 'weekdays', plannedDate: dateOnly(next) };
  }

  if (/每天|每日/.test(text)) {
    const next = new Date(from);
    next.setDate(next.getDate() + 1);
    return { repeatRule: 'daily', plannedDate: dateOnly(next) };
  }

  if (/每周|每星期/.test(text)) {
    const next = new Date(from);
    next.setDate(next.getDate() + 7);
    return { repeatRule: 'weekly', plannedDate: dateOnly(next) };
  }

  return null;
}

/** 计算周期任务完成后的下一次计划日期。 */
export function nextRecurringDate(plannedDate: string, rule: RepeatRule): string | null {
  if (rule === 'none') return null;
  const d = new Date(`${plannedDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const interval = repeatIntervalDays(rule);
  if (interval !== null) d.setDate(d.getDate() + interval);
  else if (rule === 'daily') d.setDate(d.getDate() + 1);
  else if (rule === 'weekly') d.setDate(d.getDate() + 7);
  else if (rule === 'monthly') addMonthsClamped(d, 1);
  else {
    do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
  }
  return dateOnly(d);
}

/** 去掉模型可能重复写进任务标题开头的周期前缀。 */
export function stripRecurringPrefix(content: string): string {
  return content.trim()
    // 模型有时会把输出格式标签（todo/任务/清单）写进标题。
    .replace(/^\s*(?:todo|任务|清单|待办清单|待办)\s*[:：-]?\s*/iu, '')
    // 用户说“创建每周五...的任务”时，标题只保留真正要做的动作。
    .replace(/^\s*(?:帮我)?(?:创建|添加|安排|设置)(?:一个|一条)?\s*/u, '')
    .replace(/^(?:每(?:周|星期)(?:[一二三四五六日天])?|每(?:个)?工作日|周一到周五|星期一到星期五|每月(?:\d{1,2}\s*[号日])?|每\s*\d{1,3}\s*天|每天|每日)\s*(?:的)?[，,、:：]?\s*/u, '')
    .replace(/\s*(?:的)?(?:任务|清单|待办清单|待办|todo)\s*$/iu, '')
    .trim() || content.trim();
}
