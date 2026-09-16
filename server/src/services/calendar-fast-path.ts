/**
 * [INPUT]: 用户最新消息、现有日历时间解析与钉钉创建能力
 * [OUTPUT]: 明确单日程请求的零模型执行结果，或 null（交回通用助手）
 * [POS]: 助手语义层之前的低成本日程入口；只处理无参与人歧义的确定性请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { extractWhen } from './classify.js';
import { createDingtalkEvent } from './dingtalk-mcp.js';
import type { AssistantMessage, AssistantReply } from './assistant.js';

const INTENT = /(?:创建|安排|预约|加到日历|约一下)[^\n]{0,80}(?:日程|会议|会面|沟通|对齐)/i;
const RANGE = /(\d{1,2})(?:点|:)(\d{0,2})?\s*(?:到|至|-|~)\s*(\d{1,2})(?:点|:)(\d{0,2})?/;
const ISO_DATE = /(\d{4}-\d{2}-\d{2})/;

function hhmm(hour: string, minute?: string): string | null {
  const h = Number(hour); const m = minute ? Number(minute) : 0;
  return Number.isInteger(h) && h >= 0 && h < 24 && Number.isInteger(m) && m >= 0 && m < 60
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : null;
}

function result(reply: string): AssistantReply {
  return { reply, captured: null, captureError: null, drafts: [], actions: [], plans: [], agentTasks: [] };
}

export async function tryCalendarFastPath(messages: AssistantMessage[]): Promise<AssistantReply | null> {
  const text = [...messages].reverse().find((message) => message.role === 'user')?.content?.trim() ?? '';
  if (!INTENT.test(text)) return null;
  if (/(?:和|跟|与|邀请|参加|参与人|会议室|忙闲|找个时间|推荐)/.test(text)) return null;

  const range = text.match(RANGE);
  if (!range) return result('请补充日程的开始和结束时间，例如“明天 15 点到 16 点”。');
  const startClock = hhmm(range[1], range[2]);
  const endClock = hhmm(range[3], range[4]);
  if (!startClock || !endClock) return result('时间格式无法识别，请使用“15:00 到 16:00”这样的写法。');

  const explicitDate = text.match(ISO_DATE)?.[1];
  const parsedStart = extractWhen(text);
  const date = explicitDate ?? parsedStart?.slice(0, 10);
  if (!date) return result('请补充具体日期，例如“明天”或“2026-09-08”。');
  const startAt = `${date}T${startClock}`;
  const endAt = `${date}T${endClock}`;
  if (endAt <= startAt) return result('结束时间需要晚于开始时间，请重新给出时间范围。');

  const title = text
    .replace(INTENT, '')
    .replace(ISO_DATE, '')
    .replace(RANGE, '')
    .replace(/^[\s，,：:]+|[\s，,。.!！]+$/g, '')
    .trim();
  if (!title) return result('请补充日程标题。');

  try {
    const created = await createDingtalkEvent({ title: title.slice(0, 100), startAt, endAt, attendeeUserIds: [] });
    const eventId = typeof created.id === 'string' ? created.id : null;
    if (!eventId) return result('钉钉没有返回日程 ID，暂时无法确认是否创建成功。');
    return result(`已创建日程「${title.slice(0, 100)}」，时间 ${startAt} 至 ${endAt}。`);
  } catch (error) {
    return result(`日程创建失败：${(error as Error).message}`);
  }
}
