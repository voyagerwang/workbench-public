// 助手分诊展示层：一条内容落到了哪个模块、什么时候，以及怎么跳过去看
import type { QueryClient } from '@tanstack/react-query';
import type { CaptureResult, FragmentTarget, FragmentType } from '@/types';
import { qk } from '@/lib/api';
import { countdown, dayLabel, fmtTime, offsetOfDate, repeatLabel, todayStr } from '@/lib/utils';

/** 分诊会同时动四个地方，统一一次刷完 */
export function invalidateTriage(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: qk.fragments });
  qc.invalidateQueries({ queryKey: qk.tasks });
  qc.invalidateQueries({ queryKey: ['notes'] });
  qc.invalidateQueries({ queryKey: qk.reminders });
  qc.invalidateQueries({ queryKey: qk.mood });
}

export const MODULE_LABEL: Record<FragmentType, string> = { task: '清单', note: '随手记', reminder: '提醒' };

export type ChipTone = 'accent' | 'ok' | 'warn' | 'muted';

/** 碎片卡片上的落点标签；未分诊与目标失效也有对应说法 */
export function targetChips(target: FragmentTarget | null, type: FragmentType | null): Array<{ text: string; tone: ChipTone }> {
  if (!type) return [{ text: '待分诊', tone: 'muted' }];
  if (!target || target.missing) return [{ text: `${MODULE_LABEL[type]}里的条目已删除`, tone: 'muted' }];

  const chips: Array<{ text: string; tone: ChipTone }> = [];
  if (target.trashed) chips.push({ text: `${MODULE_LABEL[type]}里的条目在回收站`, tone: 'muted' });

  if (target.module === 'task') {
    chips.push({
      text: target.planned_date ? `清单 · ${dayLabel(target.planned_date)}` : '清单 · 未排期',
      tone: target.planned_date === todayStr() ? 'accent' : 'muted',
    });
    if (target.repeat_rule && target.repeat_rule !== 'none') {
      chips.push({ text: repeatLabel(target.repeat_rule), tone: 'muted' });
    }
    // 挂在清单项上的联动提醒：说明这条同时也会到点通知
    if (target.remind_at) chips.push({ text: `提醒 ${countdown(target.remind_at)}`, tone: 'warn' });
    if (target.project_name) chips.push({ text: target.project_name, tone: 'muted' });
    if (target.status === 'done') chips.push({ text: '已完成', tone: 'ok' });
  } else if (target.module === 'reminder') {
    chips.push({ text: target.trigger_at ? `提醒 · ${countdown(target.trigger_at)}` : '提醒', tone: 'warn' });
    if (target.repeat_rule && target.repeat_rule !== 'none') {
      chips.push({ text: repeatLabel(target.repeat_rule), tone: 'muted' });
    }
    if (target.status === 'fired') chips.push({ text: '已到点', tone: 'muted' });
    if (target.status === 'done') chips.push({ text: '已确认', tone: 'ok' });
  } else {
    chips.push({ text: '随手记', tone: 'ok' });
  }
  return chips;
}

/** 点落点标签跳到对应模块；随手记定位到条目，清单定位到那一天 */
export function targetRoute(type: FragmentType, target: FragmentTarget | null): string {
  if (type === 'note') return target?.id ? `/notes?note=${target.id}` : '/notes';
  if (type === 'reminder') return '/reminders';
  return target?.planned_date ? `/?day=${target.planned_date}` : '/';
}

/** 捕获成功后的人话总结：告诉用户内容被分到了哪里 */
export function captureSummary(result: CaptureResult): string {
  const parts = result.items.map((item) => {
    const label = MODULE_LABEL[item.type];
    const t = item.target;
    if (item.type === 'task') {
      const day = t?.planned_date ? dayLabel(t.planned_date) : '未排期';
      const repeat = t?.repeat_rule && t.repeat_rule !== 'none' ? `，${repeatLabel(t.repeat_rule)}` : '';
      return t?.remind_at ? `${label}（${day}${repeat}）+ 提醒（${fmtTime(t.remind_at)}）` : `${label}（${day}${repeat}）`;

    }
    if (item.type === 'reminder') return `${label}（${t?.trigger_at ? countdown(t.trigger_at) : '待定时'}）`;
    return label;
  });
  const uniq = [...new Set(parts)];
  const splitHint = result.split ? `拆成 ${result.items.length} 条 · ` : '';
  return `${splitHint}已分发到 ${uniq.join('、')}`;
}

/** 首页清单卡片的日期跳转参数 → 相对今天的偏移 */
export function dayParamToOffset(day: string | null): number {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 0;
  return offsetOfDate(day);
}
