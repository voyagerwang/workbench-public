import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { api, qk } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ReminderChannel, Settings, SingleReminderChannel } from '@/types';

const CHANNELS: Array<{ key: SingleReminderChannel; name: string }> = [
  { key: 'inapp', name: '应用内' }, { key: 'system', name: 'macOS 系统通知' },
  { key: 'feishu', name: '飞书' }, { key: 'dingtalk', name: '钉钉' }, { key: 'weixin', name: '微信' },
];
export function channelLabel(value: string): string {
  if (value === 'auto') return '跟随设置';
  return value.split(',').map((key) => CHANNELS.find((c) => c.key === key)?.name ?? key).join('、');
}

export function DeliveryMethodPicker({ value, onChange, notify, defaults = false, disabled = false }: {
  value: ReminderChannel;
  onChange: (value: ReminderChannel) => void;
  notify?: Settings['notify'];
  defaults?: boolean;
  disabled?: boolean;
}) {
  const { data: claw } = useQuery({ queryKey: qk.clawbot, queryFn: api.clawbotStatus });
  const status = (key: SingleReminderChannel): { ready: boolean; note: string; href?: string } => {
    if (key === 'inapp') return { ready: true, note: '需打开工作台页面' };
    if (key === 'system') return { ready: Boolean(notify?.systemSupported), note: notify?.systemSupported ? '由本机服务发送，请在系统中允许通知' : '当前服务端不支持 macOS 通知' };
    const href = `/settings#settings-notify-${key}`;
    if (key === 'weixin' && !claw?.bound) return { ready: false, note: '未绑定 · 去扫码绑定', href };
    if ((key === 'feishu' || key === 'dingtalk') && !notify?.[key]?.configured) return { ready: false, note: '未配置 · 去配置', href };
    if (notify?.pushReminders === false) return { ready: false, note: '外部推送已暂停 · 去开启', href: '/settings#settings-notify-channels' };
    const enabled = key === 'weixin' ? notify?.weixinEnabled !== false : notify?.[key]?.enabled;
    return { ready: Boolean(enabled), note: enabled ? '已启用' : '已停用 · 去开启', href };
  };
  const effective = defaults || value !== 'auto' ? value : notify?.defaultChannel ?? 'auto';
  const targets = CHANNELS.filter((c) => status(c.key).ready && (effective === 'auto' || effective.split(',').includes(c.key))).map((c) => c.name);
  if (!defaults && value === 'auto' && !targets.includes('应用内')) targets.unshift('应用内');
  const toggle = (key: SingleReminderChannel) => {
    const selected = value === 'auto' ? [] : value.split(',');
    const next = selected.includes(key) ? selected.filter((c) => c !== key) : [...selected, key];
    // 保持至少一个渠道；取消最后一项回到应用内，不意外切回全部外发。
    onChange((CHANNELS.filter((c) => next.includes(c.key)).map((c) => c.key).join(',') || 'inapp') as ReminderChannel);
  };
  return (
    <div className="space-y-2.5">
      <button type="button" aria-pressed={value === 'auto'} disabled={disabled} onClick={() => onChange('auto')}
        className={cn('rounded-lg border px-3 py-2 text-xs', value === 'auto' ? 'border-accent/45 bg-accent-dim text-accent' : 'border-line text-ink-2')}>
        {defaults ? '全部可用渠道' : '跟随设置'}
      </button>
      <p className="text-[11px] text-ink-3">{defaults ? '默认送达' : '当前送达'}：{targets.join('、') || '应用内兜底'}。下方可自定义多选。</p>
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label="送达渠道（可多选）">
        {CHANNELS.map(({ key, name }) => {
          const state = status(key);
          const selected = value !== 'auto' && value.split(',').includes(key);
          return <div key={key} className={cn('rounded-lg border px-2.5 py-2', selected ? 'border-accent/45 bg-accent-dim' : 'border-line bg-surface-1')}>
            <button type="button" role="checkbox" aria-checked={selected} aria-label={name} disabled={disabled || (!state.ready && !selected)} onClick={() => toggle(key)} className="flex w-full items-center gap-2 text-left text-xs disabled:opacity-60">
              <span className={cn('flex size-5 shrink-0 items-center justify-center rounded border', selected ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong')}>
                {selected && <Check className="size-3.5" />}
              </span>
              <span>{name}</span>
            </button>
            {state.href && !state.ready
              ? <Link to={state.href} className="mt-1 block text-[10px] text-accent hover:underline">{state.note}</Link>
              : <p className="mt-1 text-[10px] text-ink-3">{state.note}</p>}
          </div>;
        })}
      </div>
      {!defaults && <div className="flex justify-end"><Link to="/settings#settings-notify" className="text-[11px] text-accent hover:underline">配置通知渠道</Link></div>}
    </div>
  );
}
