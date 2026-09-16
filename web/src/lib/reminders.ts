// 提醒的时间计算：一律生成本地时间、不带时区后缀的 YYYY-MM-DDTHH:mm，
// 与后端 PATCH/POST 的格式校验保持一致。

const pad = (n: number) => String(n).padStart(2, '0');

/** Date → 后端接受的本地时间串（YYYY-MM-DDTHH:mm） */
export function localIsoInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 稍后提醒：从「现在」起算，而不是从原定时间起算 */
export function snoozeAt(minutes: number): string {
  return localIsoInput(new Date(Date.now() + minutes * 60_000));
}

/** 明天同一时间：沿用原提醒的时分，日期顺延一天 */
export function tomorrowSameTime(triggerAt: string): string {
  const base = triggerAt ? new Date(triggerAt) : new Date();
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(base.getHours(), base.getMinutes(), 0, 0);
  return localIsoInput(d);
}

/** 稍后提醒的默认档位：卡片上的「稍后」一键就用它 */
export const SNOOZE_DEFAULT_MINUTES = 10;

/** 稍后提醒的预设档位 */
export const SNOOZE_PRESETS = [
  { minutes: SNOOZE_DEFAULT_MINUTES, label: '10 分钟后' },
  { minutes: 30, label: '30 分钟后' },
  { minutes: 60, label: '1 小时后' },
] as const;

/**
 * 创建区的快捷时间档位。只在点击时求值（传函数返回新数组），
 * 「今天 18:00」这类已过期的档位自动顺延到明天，避免一键造出一条立刻触发的过去提醒。
 */
export function quickTimeOptions(): Array<{ label: string; value: string }> {
  const at = (days: number, h: number, m: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return localIsoInput(d);
  };
  const todayOrTomorrow = (h: number, m: number): string => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d <= new Date()) d.setDate(d.getDate() + 1);
    return localIsoInput(d);
  };
  // 下周一：从明天起找第一个周一（今天恰是周一也给下周一，避免歧义）
  const nextMonday = (): string => {
    const d = new Date();
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    d.setHours(9, 0, 0, 0);
    return localIsoInput(d);
  };
  return [
    { label: '10 分钟后', value: snoozeAt(10) },
    { label: '1 小时后', value: snoozeAt(60) },
    { label: '今天 18:00', value: todayOrTomorrow(18, 0) },
    { label: '明天 09:00', value: at(1, 9, 0) },
    { label: '下周一', value: nextMonday() },
  ];
}
