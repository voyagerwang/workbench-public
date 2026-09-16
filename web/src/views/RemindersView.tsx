import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlarmClock, AlertTriangle, ArrowRight, Ban, BellOff, BellRing, Check, ChevronDown, Clock,
  Layers, ListChecks, MessageSquare, Monitor, MoreVertical, PanelTop, Plus, Repeat, RotateCw, Search, Send, SlidersHorizontal, Smartphone,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import { linkify } from '@/lib/linkify';
import { SNOOZE_PRESETS, localIsoInput, quickTimeOptions, snoozeAt, tomorrowSameTime } from '@/lib/reminders';
import { notifyDeleted } from '@/lib/trash';
import { TaskDetailDialog } from '@/components/TaskDetailDialog';
import { NotifyStatusChip } from '@/components/NotifyStatusChip';
import { askNotifyPermission, openNotificationSettings } from '@/lib/notify-actions';
import { useNotifyPermission, type NotifyPermission } from '@/lib/notify-permission';
import { DateTimePicker } from '@/ui/datetime-picker';
import { MenuButton, type MenuItem } from '@/ui/menu';
import type { Reminder, ReminderChannel, ReminderPatch, Settings } from '@/types';
import { cn, countdown, fmtDateTime, fmtTime, relTime, repeatLabel } from '@/lib/utils';
import { Card, CardBody } from '@/ui/card';
import { Button } from '@/ui/button';
import { Input } from '@/ui/form';
import { EllipsisText, EmptyState, SectionTitle } from '@/ui/primitives';
import type { RepeatRule } from '@/types';

/** 新建提醒的可选重复规则（每 N 天主要靠对话创建，界面只给常用项） */
const REPEAT_OPTIONS: Array<{ value: RepeatRule; label: string }> = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
];

const WEEKDAY_OPTIONS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
] as const;

function weekdayOf(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
}

/** 周几变化时把首次提醒顺延到最近的目标星期，并保留原时间。 */
function alignTriggerToWeekday(value: string, targetDay: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(T.*)$/.exec(value);
  if (!m) return value;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  date.setDate(date.getDate() + (targetDay - date.getDay() + 7) % 7);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}${m[4]}`;
}

function reminderRepeatLabel(reminder: Reminder): string {
  if (reminder.repeat_rule !== 'weekly') return repeatLabel(reminder.repeat_rule);
  const day = weekdayOf(reminder.trigger_at);
  const label = WEEKDAY_OPTIONS.find((item) => item.value === day)?.label;
  return label ? `每周${label}` : '每周';
}

function scheduleDateLabel(value: string): string {
  const day = weekdayOf(value);
  const label = WEEKDAY_OPTIONS.find((item) => item.value === day)?.label;
  return `${fmtDateTime(value)}${label ? ` 周${label}` : ''}`;
}

/** 送达渠道选项 */
export const CHANNEL_OPTIONS = [
  { value: 'auto', label: '自动（应用内 + 可用通知）' },
  { value: 'inapp', label: '只应用内' },
  { value: 'system', label: 'macOS 系统通知' },
  { value: 'feishu', label: '飞书机器人' },
  { value: 'dingtalk', label: '钉钉机器人' },
  { value: 'weixin', label: '微信 ClawBot' },
] as const;

/** 渠道短标签（列表里显示用） */
const CHANNEL_SHORT: Record<string, string> = {
  auto: '自动', inapp: '应用内', system: '系统', feishu: '飞书', dingtalk: '钉钉', weixin: '微信',
};

type NotifySettings = Settings['notify'];

/** 待触发列表的分组顺序：越急的越靠前 */
const PENDING_SECTIONS = [
  { key: 'overdue', title: '已逾期', danger: true },
  { key: 'today', title: '今天', danger: false },
  { key: 'tomorrow', title: '明天', danger: false },
  { key: 'later', title: '更晚', danger: false },
] as const;

/** 已完成历史默认摊开的条数，其余折叠进「展开更早」 */
const DONE_PREVIEW_COUNT = 8;

/** 列表筛选下拉：极简封装 MenuButton，选中项打勾 */
function FilterMenu({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  const current = options.find((o) => o.value === value);
  const active = value !== options[0].value;
  const items: MenuItem[] = options.map((o) => ({
    key: o.value,
    label: o.value === value ? `✓ ${o.label}` : o.label,
    onSelect: () => onChange(o.value),
  }));
  return (
    <MenuButton
      title={`按${label}筛选`}
      items={items}
      width={150}
      className={cn(
        'flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2.5 text-[11px] transition-colors',
        active
          ? 'border-accent/50 bg-accent-dim text-accent'
          : 'border-line bg-surface-1 text-ink-2 hover:border-line-strong hover:text-ink',
      )}
    >
      <SlidersHorizontal className={cn('size-3', active ? 'text-accent' : 'text-ink-4')} />
      {label}：{current?.label ?? '不限'}
    </MenuButton>
  );
}

function isDeliveryReady(channel: ReminderChannel, permission: NotifyPermission, notify?: NotifySettings, weixinReady?: boolean): boolean {
  if (channel === 'auto' || channel === 'inapp') return true;
  if (channel === 'system') return permission === 'granted';
  if (channel === 'weixin') return Boolean(weixinReady);
  return Boolean(notify?.[channel]?.enabled);
}

function DeliveryMethodPicker({ value, onChange, permission, notify, onEnableSystem }: {
  value: ReminderChannel;
  onChange: (channel: ReminderChannel) => void;
  permission: NotifyPermission;
  notify?: NotifySettings;
  onEnableSystem: () => void;
}) {
  const { data: claw } = useQuery({ queryKey: qk.clawbot, queryFn: api.clawbotStatus });
  const weixinReady = Boolean(claw?.bound) && (notify?.weixinEnabled !== false);
  const pushed = notify?.pushReminders === false
    ? []
    : [
        notify?.feishu?.enabled ? '飞书' : null,
        notify?.dingtalk?.enabled ? '钉钉' : null,
        weixinReady ? '微信' : null,
      ].filter(Boolean) as string[];
  const autoTargets = [
    '应用内',
    permission === 'granted' ? '系统通知' : null,
    ...pushed,
  ].filter(Boolean).join('、');

  const methods: Array<{
    value: ReminderChannel;
    name: string;
    note: string;
    icon: React.ReactNode;
    ready: boolean;
  }> = [
    { value: 'auto', name: '自动', note: `当前送达：${autoTargets}`, icon: <BellRing />, ready: true },
    { value: 'inapp', name: '只应用内', note: '始终可用，不依赖系统权限', icon: <PanelTop />, ready: true },
    {
      value: 'system',
      name: '系统通知',
      note: permission === 'granted' ? '通知已开启' : permission === 'denied' ? '通知被拦截' : '尚未开启',
      icon: <Monitor />,
      ready: permission === 'granted',
    },
    {
      value: 'feishu',
      name: '飞书',
      note: notify?.feishu?.enabled ? '机器人推送中' : notify?.feishu?.configured ? '已配置但未启用' : '尚未配置',
      icon: <MessageSquare />,
      ready: Boolean(notify?.feishu?.enabled),
    },
    {
      value: 'dingtalk',
      name: '钉钉',
      note: notify?.dingtalk?.enabled ? '机器人推送中' : notify?.dingtalk?.configured ? '已配置但未启用' : '尚未配置',
      icon: <MessageSquare />,
      ready: Boolean(notify?.dingtalk?.enabled),
    },
    {
      value: 'weixin',
      name: '微信 ClawBot',
      note: claw?.bound ? (notify?.weixinEnabled === false ? '推送已关闭' : '提醒推到微信') : '尚未绑定，请先扫码绑定',
      icon: <Smartphone />,
      ready: weixinReady,
    },
  ];

  return (
    <div className="space-y-2.5">
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="送达方式">
        {methods.map((method) => {
          const selected = value === method.value;
          return (
            <button
              key={method.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={!method.ready}
              onClick={() => {
                if (method.ready) {
                  onChange(method.value);
                  return;
                }
                if (method.value === 'system') onEnableSystem();
                else toast.info(`请先在通知设置中启用${method.name}`);
              }}
              className={cn(
                'flex min-h-12 items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
                selected
                  ? 'border-accent/45 bg-accent-dim'
                  : 'border-line bg-surface-1 hover:border-line-strong hover:bg-surface-2',
                !method.ready && !selected && 'opacity-65',
              )}
            >
              <span className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5',
                selected ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-ink-3',
              )}>
                {selected ? <Check /> : method.icon}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
                  {method.name}
                  <span className={cn('size-1.5 rounded-full', method.ready ? 'bg-ok' : 'bg-ink-4')} />
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-ink-4">{method.note}</span>
              </span>
            </button>
          );
        })}
      </div>

      {permission !== 'granted' && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/25 bg-warn/8 px-2.5 py-2 text-[11px] text-ink-3">
          <BellOff className="size-3.5 shrink-0 text-warn" />
          <span className="min-w-0 flex-1">
            系统通知未开启，自动方式目前仍会保留应用内提醒。
          </span>
          {permission !== 'unsupported' && (
            <button type="button" onClick={onEnableSystem} className="font-medium text-warn hover:underline">
              {permission === 'denied' ? '去系统设置' : '开启通知'}
            </button>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Link to="/settings#settings-notify" className="text-[10px] text-ink-4 transition-colors hover:text-accent">
          管理系统通知与推送通道
        </Link>
      </div>
    </div>
  );
}

export function RemindersView() {
  const qc = useQueryClient();
  const defaultChannelApplied = useRef(false);
  const [message, setMessage] = useState('');
  const [triggerAt, setTriggerAt] = useState('');
  const [repeatRule, setRepeatRule] = useState<RepeatRule>('none');
  const [weeklyDay, setWeeklyDay] = useState(() => new Date().getDay());
  const [channel, setChannel] = useState<ReminderChannel>('auto');
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  // P3：列表组织——关键词搜索 + 基础筛选（纯前端过滤，列表接口已保证 pending 优先不被 500 条上限挤掉）
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'done'>('all');
  const [repeatFilter, setRepeatFilter] = useState<'all' | 'repeat' | 'once'>('all');
  const [channelFilter, setChannelFilter] = useState<'all' | ReminderChannel>('all');
  const [linkedFilter, setLinkedFilter] = useState<'all' | 'linked' | 'unlinked'>('all');
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set());
  const toggleSeries = (key: string) => setExpandedSeries((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const { permission, refresh: refreshNotifyPermission } = useNotifyPermission();
  const { data: claw } = useQuery({ queryKey: qk.clawbot, queryFn: api.clawbotStatus });

  const { data: settings } = useQuery({
    queryKey: qk.settings,
    queryFn: api.settings,
    staleTime: 60_000,
  });
  const weixinReady = Boolean(claw?.bound) && (settings?.notify?.weixinEnabled !== false);
  const defaultChannel = settings?.notify?.defaultChannel ?? 'auto';
  const usableDefaultChannel = isDeliveryReady(defaultChannel, permission, settings?.notify, weixinReady) ? defaultChannel : 'auto';
  const scheduledTriggerAt = repeatRule === 'weekly'
    ? alignTriggerToWeekday(triggerAt, weeklyDay)
    : triggerAt;

  useEffect(() => {
    if (!settings || defaultChannelApplied.current) return;
    defaultChannelApplied.current = true;
    setChannel(usableDefaultChannel);
  }, [settings, usableDefaultChannel]);

  const { data: reminders, isLoading } = useQuery({
    queryKey: qk.reminders,
    queryFn: api.reminders,
    refetchInterval: 15_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.reminders });

  const createMut = useMutation({
    mutationFn: () => api.createReminder({ message: message.trim(), triggerAt: scheduledTriggerAt, repeatRule, channel }),
    onSuccess: () => {
      setMessage(''); setTriggerAt(''); setRepeatRule('none'); setChannel(usableDefaultChannel); setDeliveryOpen(false);
      toast.success('提醒已就位', {
        description: `送达方式：${CHANNEL_SHORT[channel] ?? channel}`,
      });
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const completeMut = useMutation({
    mutationFn: ({ id, completeTask }: { id: number; completeTask?: boolean }) =>
      api.updateReminder(id, completeTask ? { status: 'done', completeLinkedTask: true } : { status: 'done' }),
    onSuccess: (_, { completeTask }) => {
      toast.success(completeTask ? '提醒与清单项已完成' : '提醒已完成');
      qc.invalidateQueries({ queryKey: qk.tasks });
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  /** 手动重发：自动重试放弃后用户自己再点一次 */
  const resendMut = useMutation({
    mutationFn: (id: number) => api.resendReminder(id),
    onSuccess: () => { toast.success('已重新发送'); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  /** 稍后提醒：回到待触发并清掉本次触发痕迹，不生成新实例 */
  const snoozeMut = useMutation({
    mutationFn: ({ id, triggerAt }: { id: number; triggerAt: string }) =>
      api.updateReminder(id, { status: 'pending', triggerAt }),
    onSuccess: (_, { triggerAt }) => { toast.success(`已延后到 ${fmtDateTime(triggerAt)}`); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const editMut = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: ReminderPatch }) => api.updateReminder(id, patch),
    onSuccess: () => { toast.success('提醒已更新'); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteReminder(id),
    onSuccess: (_, id) => { invalidate(); notifyDeleted(qc, 'reminders', id); },
  });
  /** 停止重复系列：本条留着转成一次性，后续期次全部取消 —— 重复提醒唯一真正的「取消」入口 */
  const stopSeriesMut = useMutation({
    mutationFn: (id: number) => api.stopReminderSeries(id),
    onSuccess: (res) => {
      toast.success(res.stopped > 0
        ? `已停止重复：本次保留，后续 ${res.stopped} 期已取消`
        : '已转为一次性提醒，本次响完即止');
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  /** 合并重复实例：同一刻被建了 N 份时只留一条，否则到点会连响 N 次 */
  const dedupeMut = useMutation({
    mutationFn: (id: number) => api.dedupeReminder(id),
    onSuccess: (res) => {
      toast.success(res.removed > 0 ? `已合并 ${res.removed} 条重复提醒` : '没有发现重复实例');
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const groups = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const list = (reminders ?? []).filter((r) => {
      if (statusFilter === 'active' && r.status === 'done') return false;
      if (statusFilter === 'done' && r.status !== 'done') return false;
      if (repeatFilter === 'repeat' && r.repeat_rule === 'none') return false;
      if (repeatFilter === 'once' && r.repeat_rule !== 'none') return false;
      if (channelFilter !== 'all' && (r.channel ?? 'auto') !== channelFilter) return false;
      if (linkedFilter === 'linked' && !r.linked_task_id) return false;
      if (linkedFilter === 'unlinked' && r.linked_task_id) return false;
      if (kw && !`${r.message}\n${r.task_title ?? ''}`.toLowerCase().includes(kw)) return false;
      return true;
    });
    // 待触发按本地日期分桶：已逾期 / 今天 / 明天 / 更晚（跨月/跨年由日期串比较天然兜住）
    const today = localIsoInput(new Date()).slice(0, 10);
    const tomorrow = localIsoInput(new Date(Date.now() + 86_400_000)).slice(0, 10);
    const pendingList = list.filter((r) => r.status === 'pending')
      .sort((a, b) => a.trigger_at.localeCompare(b.trigger_at));
    const bucketOf = (r: Reminder) => {
      const day = r.trigger_at.slice(0, 10);
      return day < today ? 'overdue' : day === today ? 'today' : day === tomorrow ? 'tomorrow' : 'later';
    };
    return {
      fired: list.filter((r) => r.status === 'fired'),
      overdue: pendingList.filter((r) => bucketOf(r) === 'overdue'),
      today: pendingList.filter((r) => bucketOf(r) === 'today'),
      tomorrow: pendingList.filter((r) => bucketOf(r) === 'tomorrow'),
      later: pendingList.filter((r) => bucketOf(r) === 'later'),
      // 完成历史倒序：默认摊开的 8 条是「最近完成的」，而不是列表接口顺序里的最旧 8 条
      done: list.filter((r) => r.status === 'done')
        .sort((a, b) => (b.fired_at ?? b.trigger_at).localeCompare(a.fired_at ?? a.trigger_at)),
    };
  }, [reminders, search, statusFilter, repeatFilter, channelFilter, linkedFilter]);

  // 系列计数：同一 series_id 的期数，>1 才值得在行上标出来
  const seriesCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of reminders ?? []) {
      if (!r.series_id) continue;
      m.set(r.series_id, (m.get(r.series_id) ?? 0) + 1);
    }
    return m;
  }, [reminders]);

  /**
   * 重复实例：同一内容 + 同一规则 + 同一时刻被建了 N 份（触发瞬间被重复处理过、或手抖连点），
   * 到点会连响 N 次。口径必须和后端 dedupe 接口一致，否则按钮点了没反应。
   */
  const dupCounts = useMemo(() => {
    const open = (reminders ?? []).filter((r) => r.status !== 'done');
    const key = (r: Reminder) => `${r.message}|${r.repeat_rule}|${r.trigger_at}`;
    const buckets = new Map<string, number>();
    for (const r of open) buckets.set(key(r), (buckets.get(key(r)) ?? 0) + 1);
    const m = new Map<number, number>();
    for (const r of open) m.set(r.id, buckets.get(key(r)) ?? 1);
    return m;
  }, [reminders]);

  /** 系列里还有几期没处理：让用户点「停止重复」之前就知道会取消掉多少期 */
  const seriesSiblings = useMemo(() => {
    const open = (reminders ?? []).filter((r) => r.status !== 'done' && r.repeat_rule !== 'none');
    // 与后端 stop-series 同口径：有 series_id 按系列归组，没有（历史数据）就按内容 + 规则
    const key = (r: Reminder) => (r.series_id ? `s:${r.series_id}` : `m:${r.message}|${r.repeat_rule}`);
    const buckets = new Map<string, number>();
    for (const r of open) buckets.set(key(r), (buckets.get(key(r)) ?? 0) + 1);
    const m = new Map<number, number>();
    for (const r of open) m.set(r.id, (buckets.get(key(r)) ?? 1) - 1);
    return m;
  }, [reminders]);

  /** 已完成历史按系列归组：同一重复系列的已完成记录合并成一行，点击再展开，避免长期重复提醒把这里撑爆 */
  const doneGroups = useMemo(() => {
    const map = new Map<string, Reminder[]>();
    for (const r of groups.done) {
      const key = r.series_id
        ? `s:${r.series_id}`
        : r.repeat_rule !== 'none'
          ? `m:${r.message}|${r.repeat_rule}`
          : `i:${r.id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return [...map.entries()].map(([key, list]) => ({ key, list }));
  }, [groups.done]);

  const handleTriggerChange = (value: string) => {
    setTriggerAt(value);
  };

  const handleRepeatChange = (rule: RepeatRule) => {
    setRepeatRule(rule);
    if (rule === 'weekly') setWeeklyDay(weekdayOf(triggerAt) ?? new Date().getDay());
  };

  const handleWeeklyDayChange = (day: number) => {
    setWeeklyDay(day);
  };

  const submitReminder = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && triggerAt && !createMut.isPending) createMut.mutate();
  };

  const enableSystemNotifications = async () => {
    if (permission === 'denied') {
      openNotificationSettings();
      return;
    }
    if (permission === 'default') {
      await askNotifyPermission();
      refreshNotifyPermission();
    }
  };

  const hasActiveFilters = Boolean(search.trim()) || statusFilter !== 'all' || repeatFilter !== 'all'
    || channelFilter !== 'all' || linkedFilter !== 'all';

  const clearAllFilters = () => {
    setSearch(''); setStatusFilter('all'); setRepeatFilter('all'); setChannelFilter('all'); setLinkedFilter('all');
  };

  /** 进行中的行（到点区 danger、待触发区 normal），四处分组共用一份 props */
  const renderActiveRow = (r: Reminder, opts?: { danger?: boolean }) => (
    <RemRow
      key={r.id}
      reminder={r}
      tone={opts?.danger ? 'danger' : 'normal'}
      onComplete={(completeOpts) => completeMut.mutate({ id: r.id, ...completeOpts })}
      onSnooze={(triggerAt) => snoozeMut.mutate({ id: r.id, triggerAt })}
      onSave={(patch) => editMut.mutate({ id: r.id, patch })}
      onResend={() => resendMut.mutate(r.id)}
      busy={busyId(r.id, completeMut, snoozeMut, editMut, resendMut, stopSeriesMut, dedupeMut)}
      permission={permission}
      notify={settings?.notify}
      onEnableSystem={() => { void enableSystemNotifications(); }}
      onDelete={() => deleteMut.mutate(r.id)}
      seriesCount={r.series_id ? seriesCounts.get(r.series_id) : undefined}
      dupCount={dupCounts.get(r.id)}
      seriesSiblings={seriesSiblings.get(r.id)}
      onStopSeries={() => stopSeriesMut.mutate(r.id)}
      onDedupe={() => dedupeMut.mutate(r.id)}
    />
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex items-center justify-between gap-3 px-1">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">提醒</h1>
          <p className="mt-0.5 text-sm text-ink-3">到点弹通知；错过也不会丢，会标红等你知道</p>
        </div>
        <NotifyStatusChip />
      </header>

      {/* 新建 */}
      <Card className="overflow-hidden">
        <form onSubmit={submitReminder}>
          <CardBody className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_220px_auto]">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="提醒我…"
              aria-label="提醒内容"
              className="h-10 min-w-0 bg-surface-1 px-3.5"
            />
            <DateTimePicker
              value={triggerAt}
              onChange={handleTriggerChange}
              placeholder={repeatRule === 'none' ? '提醒日期和时间' : '从哪天开始'}
              className="h-10 w-full bg-surface-1 text-xs"
            />
            <Button
              type="submit"
              size="lg"
              variant="primary"
              disabled={!message.trim() || !triggerAt || createMut.isPending}
              className="h-10 px-4"
            >
              <Plus /> 添加
            </Button>
          </CardBody>

          <div className="border-t border-line bg-surface-2/45 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-0.5 text-[11px] font-medium text-ink-3">重复</span>
              <div className="flex max-w-full items-center overflow-x-auto rounded-lg border border-line bg-surface-1 p-0.5 no-scrollbar">
                {REPEAT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={repeatRule === option.value}
                    onClick={() => handleRepeatChange(option.value)}
                    className={cn(
                      'h-7 shrink-0 rounded-md px-2.5 text-[11px] font-medium transition-colors',
                      repeatRule === option.value
                        ? 'bg-accent-dim text-accent'
                        : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                aria-expanded={deliveryOpen}
                onClick={() => setDeliveryOpen((open) => !open)}
                className="ml-auto flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
              >
                <SlidersHorizontal className="size-3.5" />
                送达方式：{CHANNEL_SHORT[channel] ?? channel}
                <ChevronDown className={cn('size-3 transition-transform', deliveryOpen && 'rotate-180')} />
              </button>
            </div>

            {/* 快捷时间：只填充时间输入框，仍走「添加」的完整校验；已过期的档位自动顺延（见 quickTimeOptions） */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[11px] font-medium text-ink-3">快捷</span>
              {quickTimeOptions().map((q) => (
                <button
                  key={q.label}
                  type="button"
                  aria-label={`快捷填入 ${q.label}`}
                  onClick={() => setTriggerAt(q.value)}
                  className={cn(
                    'h-6 rounded-md border px-2 text-[11px] transition-colors',
                    triggerAt === q.value
                      ? 'border-accent/50 bg-accent-dim text-accent'
                      : 'border-line bg-surface-1 text-ink-3 hover:border-line-strong hover:text-ink',
                  )}
                >
                  {q.label}
                </button>
              ))}
            </div>

            <AnimatePresence initial={false}>
              {repeatRule === 'weekly' && (
                <motion.div
                  key="weekly-days"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2.5 space-y-2.5 border-t border-line pt-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mr-0.5 text-[11px] font-medium text-ink-3">每周</span>
                      <div className="flex items-center gap-1" role="group" aria-label="选择每周几提醒">
                        {WEEKDAY_OPTIONS.map((day) => (
                          <button
                            key={day.value}
                            type="button"
                            aria-label={`周${day.label}`}
                            aria-pressed={weeklyDay === day.value}
                            onClick={() => handleWeeklyDayChange(day.value)}
                            className={cn(
                              'flex size-7 items-center justify-center rounded-md text-[11px] font-medium transition-colors',
                              weeklyDay === day.value
                                ? 'bg-accent text-accent-ink'
                                : 'border border-line bg-surface-1 text-ink-3 hover:border-line-strong hover:text-ink',
                            )}
                          >
                            {day.label}
                          </button>
                        ))}
                      </div>
                      <span className="text-[10px] text-ink-4">星期设置不会改动开始日期</span>
                    </div>
                    <div aria-live="polite" className="flex min-h-6 flex-wrap items-center gap-1.5 border-l-2 border-accent/35 pl-2 text-[10px] text-ink-4">
                      {triggerAt ? (
                        <>
                          <span>从 {scheduleDateLabel(triggerAt)} 开始</span>
                          <ArrowRight className="size-3 text-ink-4" />
                          <span className="font-medium text-accent">首次提醒 {scheduleDateLabel(scheduledTriggerAt)}</span>
                        </>
                      ) : (
                        <span>选择开始日期和时间后，这里会显示首次实际提醒</span>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}

              {deliveryOpen && (
                <motion.div
                  key="delivery-settings"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2.5 border-t border-line pt-2.5">
                    <DeliveryMethodPicker
                      value={channel}
                      onChange={setChannel}
                      permission={permission}
                      notify={settings?.notify}
                      onEnableSystem={() => { void enableSystemNotifications(); }}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </form>
      </Card>

      {/* 搜索与筛选：纯前端过滤，列表量级（≤500）下没有开销 */}
      <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-line px-1 pt-5">
        <div className="relative min-w-0 flex-1 sm:min-w-[200px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-4" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索提醒内容或清单项…"
            aria-label="搜索提醒"
            className="h-8 w-full bg-surface-1 pl-8 pr-7 text-xs"
          />
          {search && (
            <button
              type="button"
              aria-label="清除搜索"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-4 transition-colors hover:text-ink-2"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <FilterMenu
          label="状态" value={statusFilter} onChange={(v) => setStatusFilter(v as typeof statusFilter)}
          options={[{ value: 'all', label: '全部' }, { value: 'active', label: '进行中' }, { value: 'done', label: '已完成' }]}
        />
        <FilterMenu
          label="重复" value={repeatFilter} onChange={(v) => setRepeatFilter(v as typeof repeatFilter)}
          options={[{ value: 'all', label: '不限' }, { value: 'repeat', label: '重复' }, { value: 'once', label: '一次性' }]}
        />
        <FilterMenu
          label="渠道" value={channelFilter} onChange={(v) => setChannelFilter(v as typeof channelFilter)}
          options={[{ value: 'all', label: '不限' }, ...CHANNEL_OPTIONS.map((c) => ({ value: c.value, label: CHANNEL_SHORT[c.value] ?? c.label }))]}
        />
        <FilterMenu
          label="关联" value={linkedFilter} onChange={(v) => setLinkedFilter(v as typeof linkedFilter)}
          options={[{ value: 'all', label: '不限' }, { value: 'linked', label: '有关联任务' }, { value: 'unlinked', label: '无关联任务' }]}
        />
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 text-[11px] text-ink-3 transition-colors hover:border-line-strong hover:text-ink"
          >
            <X className="size-3" /> 清除筛选
          </button>
        )}
      </div>

      {/* 送达失败聚合提示：失败沉在列表里容易被忽略，集中顶到最上面让用户一眼看到 */}
      {(() => {
        const failed = (reminders ?? []).filter((r) => r.delivery_status === 'failed').length;
        if (failed === 0) return null;
        return (
          <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-[12px] text-ink-2">
            <AlertTriangle className="size-4 shrink-0 text-warn" />
            <span className="flex-1">
              有 <span className="font-semibold text-warn">{failed}</span> 条提醒送达失败，可在对应提醒处手动重发。
            </span>
            {hasActiveFilters && (
              <button type="button" onClick={clearAllFilters} className="shrink-0 font-medium text-warn hover:underline">
                清除筛选
              </button>
            )}
          </div>
        );
      })()}

      {/* 已触发待处置 */}
      {groups.fired.length > 0 && (
        <section className="space-y-2">
          <SectionTitle count={groups.fired.length}>到点了</SectionTitle>
          <AnimatePresence initial={false}>
            {groups.fired.map((r) => renderActiveRow(r, { danger: true }))}
          </AnimatePresence>
        </section>
      )}

      {/* 待触发：按 已逾期 / 今天 / 明天 / 更晚 分组，扫一眼就知道轻重缓急 */}
      {PENDING_SECTIONS.filter((s) => groups[s.key].length > 0).map((s) => (
        <section key={s.key} className="space-y-2">
          <SectionTitle count={groups[s.key].length}>{s.title}</SectionTitle>
          <AnimatePresence initial={false}>
            {groups[s.key].map((r) => renderActiveRow(r, { danger: s.danger }))}
          </AnimatePresence>
        </section>
      ))}
      {!isLoading
        && groups.fired.length === 0
        && groups.overdue.length + groups.today.length + groups.tomorrow.length + groups.later.length === 0
        && groups.done.length === 0 && (
        <EmptyState
          icon={<AlarmClock />}
          title={hasActiveFilters ? '没有匹配的提醒' : '没有排期中的提醒'}
          desc={hasActiveFilters ? '换一下搜索词或筛选条件试试' : '上面输入内容和时间就能加一个'}
          action={hasActiveFilters ? (
            <button
              type="button"
              onClick={clearAllFilters}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-line-strong hover:bg-surface"
            >
              清除全部筛选
            </button>
          ) : undefined}
          className="card py-10"
        />
      )}

      {/* 已完成：默认折叠，避免重复提醒的长期历史挤掉待处理区；同系列合并成一行，点击再展开 */}
      {groups.done.length > 0 && (
        <section className="space-y-2">
          <SectionTitle count={groups.done.length}>已完成</SectionTitle>
          {!historyExpanded ? (
            <button
              type="button"
              onClick={() => setHistoryExpanded(true)}
              className="flex h-9 w-full items-center justify-center gap-1 rounded-lg border border-dashed border-line bg-surface-1 text-[11px] text-ink-3 transition-colors hover:border-line-strong hover:text-ink-2"
            >
              展开最近完成的 {Math.min(groups.done.length, DONE_PREVIEW_COUNT)} 条
              <ChevronDown className="size-3" />
            </button>
          ) : (
            <>
              {doneGroups.map(({ key, list }) => {
                if (list.length === 1) {
                  const r = list[0];
                  return (
                    <RemRow key={r.id} reminder={r} tone="muted"
                      onDelete={() => deleteMut.mutate(r.id)}
                      seriesCount={r.series_id ? seriesCounts.get(r.series_id) : undefined}
                      dupCount={dupCounts.get(r.id)}
                      seriesSiblings={seriesSiblings.get(r.id)}
                      onStopSeries={() => stopSeriesMut.mutate(r.id)}
                      onDedupe={() => dedupeMut.mutate(r.id)} />
                  );
                }
                const latest = list.reduce((a, b) => ((b.fired_at ?? b.trigger_at) > (a.fired_at ?? a.trigger_at) ? b : a));
                const open = expandedSeries.has(key);
                return (
                  <div key={key} className="space-y-2">
                    <button
                      type="button"
                      onClick={() => toggleSeries(key)}
                      className="card card-hover flex w-full items-center gap-2 px-3.5 py-3 text-left"
                    >
                      <Layers className="size-4 shrink-0 text-ink-4" />
                      <span className="min-w-0 flex-1 truncate text-sm text-ink-3">{linkify(list[0].message)}</span>
                      <span className="shrink-0 text-[10px] text-ink-4">已完成 {list.length} 期</span>
                      <span className="shrink-0 font-mono text-xs tnum text-ink-4">{relTime(latest.fired_at ?? latest.trigger_at)}</span>
                      <ChevronDown className={cn('size-3 shrink-0 text-ink-4 transition-transform', open && 'rotate-180')} />
                    </button>
                    {open && list.map((r) => (
                      <RemRow key={r.id} reminder={r} tone="muted"
                        onDelete={() => deleteMut.mutate(r.id)}
                        seriesCount={r.series_id ? seriesCounts.get(r.series_id) : undefined}
                        dupCount={dupCounts.get(r.id)}
                        seriesSiblings={seriesSiblings.get(r.id)}
                        onStopSeries={() => stopSeriesMut.mutate(r.id)}
                        onDedupe={() => dedupeMut.mutate(r.id)} />
                    ))}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => setHistoryExpanded(false)}
                className="flex h-8 w-full items-center justify-center gap-1 rounded-lg border border-line bg-surface-1 text-[11px] text-ink-3 transition-colors hover:border-line-strong hover:text-ink-2"
              >
                收起历史
                <ChevronDown className="size-3 rotate-180" />
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** 这一行是否有请求在途（三个 mutation 的 variables 形状不同，统一在这里比对 id） */
function busyId(id: number, ...muts: Array<{ isPending: boolean; variables?: unknown }>): boolean {
  return muts.some((m) => {
    if (!m.isPending) return false;
    const v = m.variables;
    if (v === id) return true;
    return typeof v === 'object' && v !== null && (v as { id?: number }).id === id;
  });
}

function draftOf(r: Reminder) {
  return {
    message: r.message,
    triggerAt: r.trigger_at.slice(0, 16),
    repeatRule: r.repeat_rule as RepeatRule,
    channel: (r.channel ?? 'auto') as ReminderChannel,
  };
}

const DELIVERY_LABEL: Record<string, string> = { system: '系统通知', feishu: '飞书', dingtalk: '钉钉' };

/**
 * 送达回执徽章。之前「发没发出去」是黑盒：失败只进日志，界面上和发送成功长得一样。
 * 现在失败会把原因和重试状态露出来，并给一个手动重发的入口。
 */
function DeliveryBadge({ reminder: r, onResend, busy }: {
  reminder: Reminder;
  onResend?: () => void;
  busy?: boolean;
}) {
  const status = r.delivery_status ?? 'none';
  // none=还没到点，pending=正在发，skipped=只应用内（网页端自己会弹），这几种都不值得占地方
  if (status === 'none' || status === 'pending' || status === 'skipped') return null;

  const note = r.channel_note ? `\n${r.channel_note}` : '';

  if (status === 'sent') {
    const sent = (r.delivered_channels ?? '').split(',').filter(Boolean);
    return (
      <span
        className="flex shrink-0 items-center gap-1 text-[10px] text-ok"
        title={`已送达：${sent.map((c) => DELIVERY_LABEL[c] ?? c).join('、') || '—'}${r.last_delivery_at ? ` · ${fmtDateTime(r.last_delivery_at)}` : ''}${note}`}
      >
        <Send className="size-2.5" /> 已送达
      </span>
    );
  }

  const attempts = r.delivery_attempts ?? 0;
  const willRetry = Boolean(r.next_retry_at);
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span
        className="flex items-center gap-1 rounded border border-warn/35 bg-warn/10 px-1.5 py-px text-[10px] text-warn"
        title={`${r.delivery_error ?? '发送失败'}${willRetry && r.next_retry_at ? `\n将在 ${fmtTime(r.next_retry_at)} 自动重试` : `\n已重试 ${attempts} 次仍未成功，可手动重发`}${note}`}
      >
        <AlertTriangle className="size-2.5" />
        {willRetry ? `送达失败 · ${fmtTime(r.next_retry_at!)}重试` : '送达失败'}
      </span>
      {onResend && (
        <Button size="xsIcon" variant="ghost" title="重新发送" onClick={(e) => { e.stopPropagation(); onResend(); }} disabled={busy}>
          <RotateCw className="size-3" />
        </Button>
      )}
    </span>
  );
}

/** 联动任务入口：点开直接看清单项详情，省得用户自己去今日页里翻 */
function LinkedTaskChip({ reminder: r }: { reminder: Reminder }) {
  const taskId = r.linked_task_id ?? null;
  const [open, setOpen] = useState(false);
  const { data: tasks } = useQuery({
    queryKey: qk.tasks,
    queryFn: api.tasks,
    enabled: open && taskId !== null,
    staleTime: 30_000,
  });
  if (!taskId) return null;
  const task = tasks?.find((t) => t.id === taskId);
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        data-detail-opener=""
        className="flex shrink-0 items-center gap-1 rounded border border-line px-1 py-px text-[10px] text-ink-4 transition-colors hover:border-line-strong hover:text-ink-2"
        title="这条提醒挂在清单项上，点开查看"
      >
        <ListChecks className="size-2.5" />
        清单：{r.task_title ?? `#${taskId}`}
      </button>
      {open && task && <TaskDetailDialog task={task} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

function RemRow({
  reminder: r,
  tone = 'normal',
  onComplete,
  onSnooze,
  onSave,
  onResend,
  busy,
  permission,
  notify,
  onEnableSystem,
  onDelete,
  seriesCount,
  dupCount,
  seriesSiblings,
  onStopSeries,
  onDedupe,
}: {
  reminder: Reminder;
  tone?: 'normal' | 'danger' | 'muted';
  /** 完成：事项已处理完。与「关闭提示」是两回事，这里只表达完成。 */
  onComplete?: (opts?: { completeTask?: boolean }) => void;
  /** 稍后提醒：把这条回到待触发，不产生新实例 */
  onSnooze?: (triggerAt: string) => void;
  /** 保存编辑（只传改动过的字段） */
  onSave?: (patch: ReminderPatch) => void;
  /** 手动重发一次到点通知（送达失败后） */
  onResend?: () => void;
  busy?: boolean;
  permission?: NotifyPermission;
  notify?: NotifySettings;
  onEnableSystem?: () => void;
  onDelete: () => void;
  /** 同一系列的期数（含本条）；>1 才显示系列徽章 */
  seriesCount?: number;
  /** 同一时刻被重复建了多份：>1 显示「合并重复」入口 */
  dupCount?: number;
  /** 同系列里除本条外还剩几期：点「停止重复」前让用户心里有数 */
  seriesSiblings?: number;
  /** 停止重复系列：本条转一次性，后续期次全部取消 */
  onStopSeries?: () => void;
  /** 合并重复实例：同刻多份只留本条 */
  onDedupe?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<null | 'delete' | 'stop' | 'dedupe'>(null);
  const [completing, setCompleting] = useState(false);
  const [draft, setDraft] = useState(() => draftOf(r));
  const cardRef = useRef<HTMLDivElement>(null);

  // 打开编辑时从最新数据重新起稿。依赖用字段指纹而不是 r 本身：列表每 15s 轮询会换出新对象，
  // 直接依赖 r 会把用户正在输入的内容冲掉。
  const fieldSignature = `${r.message}|${r.trigger_at}|${r.repeat_rule}|${r.channel}`;
  useEffect(() => {
    if (editing) setDraft(draftOf(r));
  }, [editing, fieldSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  // 点击卡片外部或按 Esc：收起编辑面板与各类确认/完成面板。
  // 日期选择面板（[data-datetime-picker-panel]）和浮层菜单（.pop-panel）是 portal，
  // 点了不算「外部」，否则会误关编辑。
  useEffect(() => {
    if (!editing && !confirming && !completing) return;
    const dismiss = () => {
      setEditing(false);
      setConfirming(null);
      setCompleting(false);
    };
    const onPointer = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-datetime-picker-panel]') || t.closest('.pop-panel')) return;
      if (cardRef.current && cardRef.current.contains(t)) return;
      dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [editing, confirming, completing]);

  const editable = Boolean(onSave);
  const muted = tone === 'muted';

  const snoozeItems: MenuItem[] = [
    ...SNOOZE_PRESETS.map((preset) => ({
      key: `${preset.minutes}m`,
      label: preset.label,
      hint: fmtTime(snoozeAt(preset.minutes)),
      onSelect: () => onSnooze?.(snoozeAt(preset.minutes)),
    })),
    {
      key: 'tomorrow',
      label: '明天同一时间',
      hint: fmtTime(tomorrowSameTime(r.trigger_at)),
      onSelect: () => onSnooze?.(tomorrowSameTime(r.trigger_at)),
    },
    {
      key: 'custom',
      label: '自定义时间…',
      onSelect: () => { setDraft(draftOf(r)); setEditing(true); },
    },
  ];

  const submitEdit = () => {
    if (!onSave) return;
    const patch: ReminderPatch = {};
    const message = draft.message.trim();
    if (!message) { toast.error('提醒内容不能为空'); return; }
    if (message !== r.message) patch.message = message;
    if (draft.triggerAt !== r.trigger_at.slice(0, 16)) patch.triggerAt = draft.triggerAt;
    if (draft.repeatRule !== r.repeat_rule) patch.repeatRule = draft.repeatRule;
    if (draft.channel !== (r.channel ?? 'auto')) patch.channel = draft.channel;
    if (Object.keys(patch).length === 0) { setEditing(false); return; }
    onSave(patch);
    setEditing(false);
  };

  const confirmCopy = confirming
    ? confirming === 'delete'
      ? { verb: '删除', desc: '删除后可在回收站恢复' }
      : confirming === 'stop'
        ? { verb: '停止重复', desc: seriesSiblings && seriesSiblings > 0 ? `后续 ${seriesSiblings} 期也会被取消` : '后续所有期次都会被取消' }
        : { verb: '合并重复', desc: dupCount && dupCount > 1 ? `将删除同刻的 ${dupCount - 1} 条重复` : '将删除重复实例' }
    : null;

  const runConfirm = () => {
    if (confirming === 'delete') onDelete();
    else if (confirming === 'stop') onStopSeries?.();
    else if (confirming === 'dedupe') onDedupe?.();
    setConfirming(null);
  };

  // 已完成历史不进入编辑面板，只留一个「删除」入口在「更多」里
  const moreItems: MenuItem[] = muted
    ? [{ key: 'delete', label: '删除', tone: 'danger', onSelect: () => setConfirming('delete') }]
    : [];

  return (
    <Card
      ref={cardRef}
      className={cn(
        'card-hover',
        tone === 'danger' && 'border-danger/35 bg-danger/8',
        muted && 'border-line/70 bg-surface-1',
      )}>
      <CardBody
        className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-2 p-3.5',
          editable && !editing && !confirming && !completing && 'cursor-pointer',
        )}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest('button') || target.closest('a') || target.closest('input') || target.closest('textarea') || target.closest('select')) return;
          if (editable && !editing && !confirming && !completing) setEditing(true);
        }}
      >
        {tone === 'danger'
          ? <BellRing className="size-4 shrink-0 text-danger" />
          : muted
            ? null
            : <AlarmClock className="size-4 shrink-0 text-ink-4" />}

        <EllipsisText className={cn('min-w-0 flex-1 text-sm', muted && 'text-ink-3')}>
          {linkify(r.message)}
        </EllipsisText>

        <span
          className={cn('shrink-0 font-mono text-xs tnum', tone === 'danger' ? 'text-danger' : muted ? 'text-ink-4' : 'text-ink-3')}
          title={`${fmtDateTime(r.trigger_at)}${r.fired_at ? ` · 已响于 ${fmtDateTime(r.fired_at)}` : ''}`}
        >
          {tone === 'normal' ? countdown(r.trigger_at)
            : tone === 'danger' ? '已到点'
            : relTime(r.fired_at ?? r.trigger_at)}
        </span>

        {!muted && r.repeat_rule !== 'none' && (
          <span className="flex shrink-0 items-center rounded border border-accent/30 bg-accent-dim px-1 py-px text-[10px] text-accent">
            <Repeat className="mr-0.5 size-2.5" />{reminderRepeatLabel(r)}
          </span>
        )}

        {/* 重复系列徽章：同一系列的各期在这里都能看到，用户才知道「这条只是其中一期」 */}
        {!muted && seriesCount !== undefined && seriesCount > 1 && (
          <span
            className="flex shrink-0 items-center rounded border border-line px-1 py-px text-[10px] text-ink-4"
            title={`同一重复系列共 ${seriesCount} 期记录`}
          >
            <Layers className="mr-0.5 size-2.5" />系列 · {seriesCount} 期
          </span>
        )}

        {!muted && r.channel && r.channel !== 'auto' && (
          <span className="shrink-0 text-[10px] text-ink-4">
            {CHANNEL_SHORT[r.channel] ?? r.channel}
          </span>
        )}

        <LinkedTaskChip reminder={r} />
        {!muted && <DeliveryBadge reminder={r} onResend={onResend} busy={busy} />}

        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {confirming && confirmCopy ? (
            <div className="flex w-full items-center gap-2 rounded-lg border border-warn/30 bg-warn/5 px-2 py-1 sm:ml-auto sm:w-auto">
              <span className="text-[11px] text-warn">{confirmCopy.desc}</span>
              <Button size="sm" variant="dangerGhost" disabled={busy} onClick={runConfirm}>
                确认{confirmCopy.verb}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                取消
              </Button>
            </div>
          ) : completing ? (
            <div className="flex w-full items-center gap-2 rounded-lg border border-warn/30 bg-warn/5 px-2 py-1 sm:ml-auto sm:w-auto">
              <span className="text-[11px] text-warn">
                {r.linked_task_id ? '同时完成关联的清单项？' : '完成此提醒？'}
              </span>
              {r.linked_task_id ? (
                <>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { onComplete?.(); setCompleting(false); }}>
                    只完成提醒
                  </Button>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => { onComplete?.({ completeTask: true }); setCompleting(false); }}>
                    一起完成
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => { onComplete?.(); setCompleting(false); }}>
                  确认完成
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCompleting(false)}>
                取消
              </Button>
            </div>
          ) : (
            <>
              {onSnooze && (
                <MenuButton
                  title="延后到指定时间再提醒"
                  items={snoozeItems}
                  width={190}
                  className="flex h-7 items-center gap-1 rounded-lg border border-line bg-surface-2 px-2 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
                >
                  <Clock className="size-3.5" /> 稍后
                </MenuButton>
              )}
              {onComplete && (
                <Button
                  size="sm"
                  variant="secondary"
                  title={r.linked_task_id ? '完成：可选择是否同步完成清单项' : '完成此提醒'}
                  aria-label={r.linked_task_id ? '完成（可选择同步清单项）' : '完成此提醒'}
                  onClick={() => setCompleting(true)}
                  disabled={busy}
                  className="h-7 px-2.5 text-xs"
                >
                  完成
                </Button>
              )}
              {muted && moreItems.length > 0 && (
                <MenuButton
                  title="更多操作"
                  items={moreItems}
                  width={120}
                  className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <MoreVertical className="size-4" />
                </MenuButton>
              )}
            </>
          )}
        </div>
      </CardBody>

      <AnimatePresence initial={false}>
        {editing && editable && (
          <motion.div
            key="row-editor"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-2.5 border-t border-line bg-surface-2/35 px-3.5 py-3">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_200px]">
                <Input
                  value={draft.message}
                  onChange={(e) => setDraft((d) => ({ ...d, message: e.target.value }))}
                  placeholder="提醒内容"
                  aria-label="提醒内容"
                  className="h-9 bg-surface-1 px-3 text-sm"
                />
                <DateTimePicker
                  value={draft.triggerAt}
                  onChange={(v) => setDraft((d) => ({ ...d, triggerAt: v }))}
                  className="h-9 w-full bg-surface-1 text-xs"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium text-ink-3">重复</span>
                <div className="flex max-w-full items-center overflow-x-auto rounded-lg border border-line bg-surface-1 p-0.5 no-scrollbar">
                  {REPEAT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={draft.repeatRule === option.value}
                      onClick={() => setDraft((d) => ({ ...d, repeatRule: option.value }))}
                      className={cn(
                        'h-7 shrink-0 rounded-md px-2.5 text-[11px] font-medium transition-colors',
                        draft.repeatRule === option.value
                          ? 'bg-accent-dim text-accent'
                          : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {/* 界面上没有的周期（如每 N 天）保持原值，避免一编辑就被悄悄改成「不重复」 */}
                {!REPEAT_OPTIONS.some((o) => o.value === draft.repeatRule) && (
                  <span className="text-[10px] text-ink-4">当前：{repeatLabel(r.repeat_rule)}（保持）</span>
                )}
              </div>

              {r.repeat_rule !== 'none' && (
                <p className="rounded-lg border border-warn/25 bg-warn/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-3">
                  <BellOff className="mr-1 inline size-3 text-warn" />
                  这是重复提醒，本次修改只作用于当前这一次，后续期次保持原样。
                  {onStopSeries && <> 要彻底停掉整个系列，点下方「停止重复」。</>}
                </p>
              )}

              {permission && onEnableSystem && (
                <div className="border-t border-line pt-2.5">
                  <DeliveryMethodPicker
                    value={draft.channel}
                    onChange={(channel) => setDraft((d) => ({ ...d, channel }))}
                    permission={permission}
                    notify={notify}
                    onEnableSystem={onEnableSystem}
                  />
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="dangerGhost" onClick={() => setConfirming('delete')} disabled={busy}>
                    删除
                  </Button>
                  {!muted && r.repeat_rule !== 'none' && onStopSeries && (
                    <Button size="sm" variant="ghost" onClick={() => { setEditing(false); onStopSeries(); }}
                      disabled={busy} className="text-warn hover:border-warn/40">
                      <Ban className="size-3.5" /> 停止重复（取消后续所有期次）
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button>
                  <Button size="sm" variant="primary" disabled={busy} onClick={submitEdit}>保存</Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}
