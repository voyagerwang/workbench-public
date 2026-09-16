// 随手记分类的本地兜底规则：AI 分诊不可用时保证捕获流程仍可用
export type FragType = 'task' | 'note' | 'reminder';

const REMINDER_INTENT = /提醒我|提醒一下|到点提醒|定时提醒|闹钟|通知我|别忘了在|不要忘记在|记得在(?:今天|明天|后天|本周|下周|\d{1,2}月|周)[^\n，。；;]*/;
const TASK_INTENT = /^(帮我)?(买|拿|交|发|写|寄|还|缴|订|约|预约|修|办|取|充|删|回复|联系|下载|安装|升级|续费|检查|提交|审批|确认|跟进|整理|准备|编写|撰写|查看|阅读|学习|规划|安排|收集|同步|更新|设计|开发|测试|处理|填写|预订|报名|支付|申请|核对|发送|完成|了解|沟通|讨论|对齐|对一下|梳理)/;
const TASK_PHRASE = /(?:待办|要做|需要做|要(?:对|了解|沟通|讨论|梳理|确认)|计划(?:去|做|完成|处理)|打算(?:去|做|完成|处理)|准备(?:去|做|完成|处理)|我需要|我要|去办|处理一下|(?:创建|添加|安排|设置)(?:一个|一条)?(?:任务|清单|todo|待办))/i;
const NOTE_INTENT = /^(记录|备忘|笔记|资料|链接|参考|背景|定义|说明|想法|灵感|了解到|学习笔记|摘录|收藏)/;
const DATE_PREFIX = /^(?:(?:今天|明天|后天|本周[一二三四五六日天]|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天])\s*|(?:\d{1,2}月\d{1,2}[日号])\s*)/;

/** 提取时间表达 → 本地 ISO；没有则 null */
export function extractWhen(content: string): string | null {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const at = (base: Date, h: number, m: number) => {
    const d = new Date(base);
    d.setHours(h, m, 0, 0);
    return d;
  };

  // 今天/明天/后天 + (上午/下午) + 点分
  const m1 = content.match(/(今天|今晚|明天|后天)?\s*(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})[点:：]\s*(半|\d{1,2})?分?/);
  if (m1) {
    let base = now;
    if (m1[1]?.includes('明')) { base = new Date(now); base.setDate(base.getDate() + 1); }
    if (m1[1]?.includes('后')) { base = new Date(now); base.setDate(base.getDate() + 2); }
    let h = Number(m1[3]);
    const m = m1[4] === '半' ? 30 : Number(m1[4] ?? 0);
    const pm = /下午|傍晚|晚上/.test(m1[2] ?? '');
    const am = /凌晨|早上|上午/.test(m1[2] ?? '');
    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
    if (h >= 0 && h < 24) {
      let d = at(base, h, m);
      // 没写早晚且时间已过 → 顺延一天
      if (!m1[1] && !m1[2] && d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
      return fmt(d);
    }
  }

  // 星期表达：周X / 星期X / 下周X
  const m2 = content.match(/(下周|下周|星期|周)([一二三四五六日天])/);
  if (m2) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = map[m2[2]];
    const d = new Date(now);
    let diff = (target - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    if (m2[1] === '下周') diff += 7;
    d.setDate(d.getDate() + diff);
    d.setHours(9, 0, 0, 0);
    return fmt(d);
  }

  // 纯 HH:mm
  const m3 = content.match(/(\d{1,2}):(\d{2})/);
  if (m3) {
    const h = Number(m3[1]), m = Number(m3[2]);
    if (h >= 0 && h < 24 && m < 60) {
      let d = at(now, h, m);
      if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
      return fmt(d);
    }
  }
  // 只给了日子没给钟点：按时段兜一个小时（没写时段就上午 9 点），让“明天提醒我拿快递”也能算出时间
  const dayWord = /今晚|今天|明天|后天|大后天/.exec(content)?.[0];
  const monthDay = /(\d{1,2})月(\d{1,2})[日号]/.exec(content);
  if (dayWord || monthDay) {
    const periodHour: Record<string, number> = { 凌晨: 7, 早上: 9, 上午: 9, 中午: 12, 下午: 15, 傍晚: 18, 晚上: 20 };
    const period = /凌晨|早上|上午|中午|下午|傍晚|晚上/.exec(content)?.[0];
    const d = new Date(now);
    if (dayWord) {
      d.setDate(d.getDate() + ({ 今晚: 0, 今天: 0, 明天: 1, 后天: 2, 大后天: 3 } as Record<string, number>)[dayWord]);
      d.setHours(dayWord === '今晚' ? 20 : periodHour[period ?? ''] ?? 9, 0, 0, 0);
    } else {
      d.setMonth(Number(monthDay![1]) - 1, Number(monthDay![2]));
      d.setHours(periodHour[period ?? ''] ?? 9, 0, 0, 0);
      if (d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1);
    }
    return fmt(d);
  }
  return null;
}

/**
 * 提醒语带明确交付动作时（“明天提醒我交材料”），条目应该同时进清单：
 * 提醒负责“何时通知我”，清单负责“这件事做没做完”。
 * 只关心通知的场景（喝水/打卡/休息/活动）不命中，保持纯提醒。
 */
const REMINDER_WITH_DELIVERABLE = /(?:写|交|提交|发送|发|回复|联系|约|预约|开会|讨论|对齐|沟通|准备|整理|收集|检查|核对|填写|处理|购买|买|订|支付|缴|还|取|拿|修|办|报名|申请|确认|跟进|梳理|编写|撰写|查看|阅读|学习|更新|升级|续费|完成|同步)/;

export const hasReminderIntent = (content: string) => REMINDER_INTENT.test(content);

/** 该提醒是否需要同时落一条清单项 */
export function reminderNeedsTask(content: string): boolean {
  return REMINDER_WITH_DELIVERABLE.test(content.replace(DATE_PREFIX, ''));
}

/** 进清单时把「什么时候 + 提醒我」这层通知语剔掉，只留要做的事（原文仍保留在碎片里） */
const LEAD_NOISE = /^\s*(?:(?:这|下|上)?(?:周|星期)[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|今天|今晚|明天|后天|大后天)?\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(?:\d{1,2}\s*[点:：]\s*(?:半|\d{1,2}\s*分?)?)?\s*(?:左右|之前|以前|前)?\s*[，,、]?\s*(?:请\s*)?(?:记得|别忘了|不要忘记|不要忘|提醒我|提醒一下|提醒|通知我|通知一下)\s*[，,、:：]?\s*/;

/** 清单项标题：剔掉通知语后的动作本身；剔空了就保留原文 */
export function actionableTitle(content: string): string {
  const text = content.trim();
  // 只在确实有通知语的时候动手，“3 点开会”这种时间开场白不该被剔掉
  if (!REMINDER_INTENT.test(text) && !/^(?:记得|别忘了|不要忘记|不要忘)/.test(text)) return text;
  const stripped = text.replace(LEAD_NOISE, '').trim();
  return stripped.length >= 2 ? stripped : text;
}

export function classify(content: string): FragType {
  // 提醒是“希望系统在某时刻通知我”，必须有明确的提醒意图；“记得做”本身仍是任务。
  if (REMINDER_INTENT.test(content)) return 'reminder';
  const trimmed = content.trim();
  // “创建/添加/安排一个任务”本身就是明确的任务意图，不能因为动作词不在句首而落成笔记。
  if (/(?:创建|添加|安排|设置)(?:一个|一条)?[\s\S]{0,120}(?:任务|清单|todo|待办)/i.test(trimmed)) return 'task';
  // “记录：提交周报”是记录内容，不是要求提交周报；先识别这种明确的笔记语境。
  if (NOTE_INTENT.test(trimmed) && !TASK_PHRASE.test(trimmed)) return 'note';
  const actionText = trimmed.replace(DATE_PREFIX, '');
  if (/^(?:每(?:周|星期)(?:[一二三四五六日天])?|每(?:个)?工作日|周一到周五|星期一到星期五|每天|每日)\s*(?:的)?/.test(actionText)
    && /(?:写|做|交|发|整理|准备|提交|检查|联系|更新|完成|处理|学习|复盘|汇报)/.test(actionText)) return 'task';
  if (/^(?:清单|待办清单|todo)\s*[:：]/i.test(actionText)) return 'task';
  if (TASK_INTENT.test(actionText) || TASK_PHRASE.test(trimmed) || /(?:记得|别忘了|不要忘)(?:做|去|交|提交|整理|联系|发|完成|检查|处理|买|回复)/.test(content)) return 'task';
  return 'note';
}

/** 规则兜底版的完整分诊：除类型外还给出计划日期与提醒时间，供无模型时直接落库 */
export function classifyDetailed(content: string): TriageDraft {
  const when = extractWhen(content);
  if (REMINDER_INTENT.test(content)) {
    if (reminderNeedsTask(content) && when) {
      return { type: 'task', remindAt: when, plannedDate: when.slice(0, 10), dual: true };
    }
    return { type: 'reminder', remindAt: when };
  }
  const type = classify(content);
  return type === 'task' ? { type, plannedDate: when ? when.slice(0, 10) : null } : { type };
}

/**
 * 无模型时只拆明确的清单行，避免把自然语言中的“和/并且”误拆成多个事项。
 * 每行必须带项目符号或编号，且至少有两行，才认为用户明确表达了多个事项。
 */
export function splitConservative(content: string): string[] {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 2 && lines.every((line) => /^(?:[-*•]|\d+[.)、])\s*/.test(line))) {
    const items = lines.map((line) => line.replace(/^(?:[-*•]|\d+[.)、])\s*/, '').trim()).filter(Boolean);
    return items.length >= 2 && items.length <= 8 ? items : [content.trim()];
  }

  // “另外/此外/同时”明确引入第二个事项，且两段都像行动句时才拆分。
  const parts = content.split(/(?:。|！|？|；|;|(?:\s|，|,)*(?:另外|此外|同时)(?:\s|，|,)*)/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 8 && parts.every((part) => classify(part) !== 'note')) return parts;
  return [content.trim()];
}

export type TriageDraft = {
  type: FragType;
  plannedDate?: string | null;
  remindAt?: string | null;
  /** 提醒语义同时生成了清单项 + 提醒 */
  dual?: boolean;
};

/** 明天 9 点（提醒的兜底时间） */
export function tomorrowNine(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
