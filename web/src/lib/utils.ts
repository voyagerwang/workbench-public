import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { addDays, differenceInCalendarDays, format, formatDistanceToNowStrict, isToday, isTomorrow, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import type { Task } from '@/types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 本地 ISO（YYYY-MM-DDTHH:mm）→ Date */
export function parseLocal(s: string): Date {
  return parseISO(s);
}

export const fmtDate = (s: string) => format(parseLocal(s), 'M月d日', { locale: zhCN });
export const fmtTime = (s: string) => format(parseLocal(s), 'HH:mm');
export const fmtDateTime = (s: string) => format(parseLocal(s), 'M月d日 HH:mm', { locale: zhCN });

/** 重复规则的可读标签（ndays:N → 每 N 天）；未知值原样返回 */
export function repeatLabel(rule: string): string {
  if (rule === 'none') return '不重复';
  if (rule === 'daily') return '每天';
  if (rule === 'weekly') return '每周';
  if (rule === 'weekdays') return '工作日';
  if (rule === 'monthly') return '每月';
  const m = rule.match(/^ndays:([1-9]\d*)$/);
  return m ? `每${m[1]}天` : rule;
}

export function relTime(s: string): string {
  return formatDistanceToNowStrict(parseLocal(s), { addSuffix: true, locale: zhCN });
}

/** 提醒倒计时文案 */
export function countdown(s: string): string {
  const d = parseLocal(s);
  if (isToday(d)) return `今天 ${format(d, 'HH:mm')}`;
  if (isTomorrow(d)) return `明天 ${format(d, 'HH:mm')}`;
  return format(d, 'M月d日 HH:mm', { locale: zhCN });
}

export function greeting(): { text: string; sub: string } {
  const h = new Date().getHours();
  const dateStr = format(new Date(), 'M月d日 EEEE', { locale: zhCN });
  const text = h < 5 ? '夜深了' : h < 11 ? '早安' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  return { text, sub: dateStr };
}

export const todayStr = () => format(new Date(), 'yyyy-MM-dd');
export const tomorrowStr = () => format(addDays(new Date(), 1), 'yyyy-MM-dd');
/** 相对今天偏移 offset 天的日期（YYYY-MM-DD），0 = 今天 */
export const dateFromOffset = (offset: number) => format(addDays(new Date(), offset), 'yyyy-MM-dd');
/** 日期 → 相对今天的偏移天数 */
export const offsetOfDate = (s: string) => differenceInCalendarDays(parseLocal(s), new Date());
/** 日期文案：今天 / 明天 / M月d日 周五 */
export const dayLabel = (s: string) =>
  s === todayStr() ? '今天' : s === tomorrowStr() ? '明天' : format(parseLocal(s), 'M月d日 EEEE', { locale: zhCN });
/** 短日期：M月d日 */
export const shortDate = (s: string) => format(parseLocal(s), 'M月d日', { locale: zhCN });

/** 清单展示顺序：未完成在前 → 手动拖拽序优先（从未排过的沉底）→ 优先级 / 时间兑底 */
export function compareTasks(a: Task, b: Task): number {
  const doneDiff = Number(a.status === 'done') - Number(b.status === 'done');
  if (doneDiff) return doneDiff;
  const ao = a.sort_order ?? Number.MAX_SAFE_INTEGER;
  const bo = b.sort_order ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return b.priority - a.priority || b.id - a.id;
}

export function uid(): string {
  return Math.random().toString(36).slice(2);
}
