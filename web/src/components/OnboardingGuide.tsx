// 上手引导：今日页顶部的三步清单卡。都完成或用户关掉后就不再出现（localStorage 记忆）。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bot, CalendarDays, Check, BellRing, ChevronRight, X } from 'lucide-react';
import { api, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

const DISMISS_KEY = 'wb.onboarding.dismissed';

export function OnboardingGuide() {
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 60_000 });
  const { data: eventStatus } = useQuery({ queryKey: qk.eventStatus, queryFn: api.eventStatus, staleTime: 60_000 });
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');

  const modelDone = Boolean(settings?.model.hasApiKey && settings.model.model);
  const calendarDone = Boolean(
    eventStatus && (eventStatus.dingtalk.configured || eventStatus.ics.configured || eventStatus.caldav.configured),
  );
  // 系统通知是零配置兜底：macOS 上天然可用，显式选过送达渠道或配了 webhook 也算配好
  const notifyDone = Boolean(
    settings?.notify && (
      settings.notify.dingtalk.enabled
      || settings.notify.feishu.enabled
      || settings.notify.systemSupported
      || (settings.notify.defaultChannel && settings.notify.defaultChannel !== 'auto')
    ),
  );

  const steps = [
    {
      id: 'settings-orb', icon: Bot, done: modelDone, required: true,
      title: '配置模型', desc: '助手对话、自动分发、AI 能力都靠它', hint: settings?.model.hasApiKey ? '还差模型名称' : '填 Base URL 和 API Key',
    },
    {
      id: 'settings-calendar', icon: CalendarDays, done: calendarDone, required: false,
      title: '接入日历', desc: 'ICS 订阅或钉钉 CalDAV，今日页直接看日程', hint: '可选 · 推荐',
    },
    {
      id: 'settings-notify', icon: BellRing, done: notifyDone, required: false,
      title: '配置提醒推送', desc: '不配置也有 macOS 系统通知兜底', hint: '可选 · 想要飞书/钉钉提醒再配',
    },
  ];

  const remaining = steps.filter((s) => !s.done);
  if (dismissed || !settings || remaining.length === 0) return null;

  return (
    <div className="relative rounded-2xl border border-accent/25 bg-accent-dim/40 px-4 py-3.5 sm:px-5">
      <button
        onClick={() => { localStorage.setItem(DISMISS_KEY, '1'); setDismissed(true); }}
        title="不再显示"
        className="absolute right-2.5 top-2.5 rounded-md p-1 text-ink-4 transition-colors hover:bg-surface-2 hover:text-ink-2"
      >
        <X className="size-3.5" />
      </button>

      <p className="text-sm font-medium text-ink">
        还差 {remaining.length} 步就绪 · 剩下的是把工作台配成你自己的
      </p>

      <div className="mt-2.5 grid grid-cols-1 gap-1.5 md:grid-cols-3">
        {steps.map((s) => (
          <Link
            key={s.id}
            to={`/settings#${s.id}`}
            className={cn(
              'group flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors',
              s.done
                ? 'border-ok/20 bg-ok/5 opacity-70'
                : 'border-line bg-surface-1/80 hover:border-accent/40 hover:bg-surface-1',
            )}
          >
            <span className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-lg border',
              s.done ? 'border-ok/30 bg-ok/10 text-ok' : 'border-line bg-surface-2 text-ink-3 group-hover:text-accent',
            )}>
              {s.done ? <Check className="size-3.5" /> : <s.icon className="size-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                {s.title}
                {!s.required && <span className="rounded-full bg-surface-2 px-1.5 py-px text-[10px] font-normal text-ink-4">可选</span>}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-ink-3">{s.done ? '已完成' : s.desc}</span>
            </span>
            {!s.done && <ChevronRight className="size-3.5 shrink-0 text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />}
          </Link>
        ))}
      </div>

      <p className="mt-2 px-0.5 text-[11px] text-ink-4">
        提示：数据全部在本机 SQLite；快捷键 {settings.general?.shortcut?.replace('mod', '⌘') || '⌘K'} 全局搜索，随时找得到东西。
      </p>
    </div>
  );
}
