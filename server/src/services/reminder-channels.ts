import { z } from 'zod';

export const deliveryChannels = ['inapp', 'system', 'feishu', 'dingtalk', 'weixin'] as const;
export type DeliveryChannel = (typeof deliveryChannels)[number];
export type ReminderChannel = 'auto' | DeliveryChannel | `${DeliveryChannel},${string}`;

/** 兼容单渠道；组合必须全部合法，禁止 auto 混入并规范排序去重。 */
export const reminderChannelSchema = z.string().max(100).refine((value) =>
  value === 'auto' || (value.length > 0 && value.split(',').every((part) =>
    deliveryChannels.includes(part as DeliveryChannel))), '请选择有效的提醒渠道',
).transform((value): ReminderChannel => value === 'auto' ? 'auto'
  : deliveryChannels.filter((part) => value.split(',').includes(part)).join(',') as ReminderChannel);
