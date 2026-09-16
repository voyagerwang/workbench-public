/**
 * [INPUT]: 依赖任务、日程、提醒、项目 API 与共享 UI/状态能力，依赖 hover 浮层协调器管理预览生命周期
 * [OUTPUT]: 对外提供 TodayView 今日工作台，聚合清单、日程、提醒与项目概览
 * [POS]: views 的首页编排层；日程行提供延迟 hover 预览，并复用详情抽屉完成编辑
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  AlarmClock, AlertTriangle, ArrowRight, BellRing, CalendarDays, Check, Clock, Clock3, Inbox,
  ListChecks, MapPin, Plus, RefreshCw, Sparkles, UserRound, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import { SNOOZE_DEFAULT_MINUTES, snoozeAt } from '@/lib/reminders';
import { dayParamToOffset } from '@/lib/triage';
import { useTaskReorder } from '@/lib/reorder';
import { compareTasks, countdown, dateFromOffset, dayLabel, fmtTime, shortDate, todayStr, cn } from '@/lib/utils';
import { Card, CardBody, CardHeader, CardTitle } from '@/ui/card';
import { Button } from '@/ui/button';
import { Input } from '@/ui/form';
import { DateTimePicker } from '@/ui/datetime-picker';
import { DomainBadge, EllipsisText, EmptyState, Progress, Skeleton } from '@/ui/primitives';
import { linkify } from '@/lib/linkify';
import { claimHoverLayer, releaseHoverLayer } from '@/lib/hover-layer';
import { MoodHeader } from '@/components/MoodHeader';
import { OnboardingGuide } from '@/components/OnboardingGuide';
import { pulseMood } from '@/store/mood';
import { SortableTaskItem } from '@/components/TaskItem';
import { CreateEventDialog } from '@/components/CreateEventDialog';
import { MeetingDetailDialog } from '@/components/MeetingDetailDialog';
import type { CalendarEvent } from '@/types';

export function TodayView() {
  return (
    <div className="space-y-5">
      {/* 今日脸色：情绪球（天气 + 日程 + 清单压力 + 天光） */}
      <MoodHeader />

      {/* 上手引导：三步配齐模型/日历/推送，完成或关掉后不再出现 */}
      <OnboardingGuide />

      {/* Bento Grid */}
      <div className="grid grid-cols-12 gap-4">
        <TodayTasksWidget />
        <ScheduleWidget />
        <RemindersWidget />
        <ProjectsWidget />
      </div>
    </div>
  );
}

/* ---------------- 清单（今日） ---------------- */
function TodayTasksWidget() {
  const qc = useQueryClient();
  const [newTitle, setNewTitle] = useState('');
  // 逾期提醒条「今日不再提示」：记在 localStorage，隔天自动失效
  const [overdueDismissed, setOverdueDismissed] = useState(() => {
    try { return localStorage.getItem('overdue-dismissed'); } catch { return null; }
  });
  // 只看今天；?day=YYYY-MM-DD 保留为分发落点的深链（临时查看某一天，可一键回到今天）
  const [params, setParams] = useSearchParams();
  const viewOffset = dayParamToOffset(params.get('day'));
  const d = todayStr();
  const target = dateFromOffset(viewOffset);
  const reorderMut = useTaskReorder();

  // 按下 6px 才算拖拽，避免和点击打开详情打架
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const { data: tasks, isLoading } = useQuery({ queryKey: qk.tasks, queryFn: api.tasks });

  const createMut = useMutation({
    mutationFn: api.createTask,
    onSuccess: () => {
      setNewTitle('');
      qc.invalidateQueries({ queryKey: qk.tasks });
      qc.invalidateQueries({ queryKey: qk.mood });
      pulseMood('capture');
    },
  });

  const todays = useMemo(() =>
    (tasks ?? [])
      .filter(
        (t) => t.planned_date === target || (!t.planned_date && t.due_at && t.due_at.slice(0, 10) === target),
      )
      .sort(compareTasks), [tasks, target]);

  const open = todays.filter((t) => t.status !== 'done');
  const doneCount = todays.length - open.length;

  const overdue = useMemo(() =>
    (tasks ?? []).filter(
      (t) => t.status !== 'done' && t.planned_date && t.planned_date < d,
    ), [tasks, d]);

  // 没排期、没截止日、也不在任何一个项目里的清单项：哪个模块都显示不到，给个入口接住
  const unscheduled = useMemo(() =>
    (tasks ?? []).filter(
      (t) => t.status !== 'done' && !t.planned_date && !t.project_id && !(t.due_at && t.due_at.slice(0, 10) >= d),
    ), [tasks, d]);

  // 拖拽落点：本地先换序（乐观更新在 useTaskReorder 里），再整组落库
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = todays.map((t) => t.id);
    const from = ids.indexOf(Number(active.id));
    const to = ids.indexOf(Number(over.id));
    if (from < 0 || to < 0) return;
    reorderMut.mutate(arrayMove(ids, from, to));
  };

  const backToToday = () => {
    params.delete('day');
    setParams(params, { replace: true });
  };

  return (
    <Card className="col-span-12 lg:col-span-6">
      <CardHeader>
        <CardTitle>
          <ListChecks className="size-4 text-accent" /> {viewOffset === 0 ? '今日清单' : `${shortDate(target)}清单`}
        </CardTitle>
        <div className="flex items-center gap-2">
          <span className="tnum font-mono text-xs text-ink-3">{doneCount}/{todays.length}</span>
          {viewOffset !== 0 && (
            <button
              onClick={backToToday}
              className="rounded-full border border-accent/30 bg-accent-dim px-2 py-0.5 text-[11px] text-accent transition-colors hover:brightness-110"
            >
              回到今天
            </button>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-3 p-4">
        {isLoading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
        ) : todays.length === 0 ? (
          <EmptyState
            icon={<Sparkles />}
            title={viewOffset === 0 ? '今天还是一张白纸' : `${dayLabel(target)}还是一张白纸`}
            desc={viewOffset === 0
              ? '在下方输入第一件想做的事，或去项目池把清单项排进今天'
              : '这是分发落点指向的那一天，安排清单去日历页'}
            action={
              <Link to="/projects"><Button variant="secondary" size="sm">看看项目池</Button></Link>
            }
          />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={todays.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {todays.map((t) => <SortableTaskItem key={t.id} task={t} />)}
            </SortableContext>
          </DndContext>
        )}

        {viewOffset === 0 && overdue.length > 0 && overdueDismissed !== d && (
          <div className="relative rounded-lg border border-warn/20 bg-warn/5 px-3 py-2 pr-8 text-xs text-warn">
            有 {overdue.length} 个早于今天的清单项未完成 ·{' '}
            <button
              className="underline underline-offset-2"
              onClick={() => {
                Promise.allSettled(overdue.map((t) => api.updateTask(t.id, { plannedDate: d })))
                  .then(() => {
                toast.success('已全部挪到今天');
                qc.invalidateQueries({ queryKey: qk.tasks });
                qc.invalidateQueries({ queryKey: qk.mood });
                pulseMood('snooze', '轻一点了');
              });
              }}
            >
              全部挪到今天
            </button>
            {/* 用户可以暂时不管：当天不再提示，明天会重新出现 */}
            <button className="absolute right-2 top-1/2 -translate-y-1/2 text-warn/60 hover:text-warn" aria-label="今日不再提示" onClick={() => { setOverdueDismissed(d); try { localStorage.setItem('overdue-dismissed', d); } catch { /* 忽略 */ } }}>
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {/* 未排期兜底：避免分诊出来的清单项谁都不显示 */}
        {viewOffset === 0 && unscheduled.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-1/60 px-3 py-2 text-xs text-ink-3">
            <Inbox className="mt-px size-3.5 shrink-0 text-ink-4" />
            <span className="min-w-0 flex-1">
              有 {unscheduled.length} 条清单项未排期（不在任何一天，也不属于任何项目）·{' '}
              <button
                className="text-accent underline underline-offset-2"
                onClick={() => {
                  Promise.allSettled(unscheduled.map((t) => api.updateTask(t.id, { plannedDate: d })))
                    .then(() => {
                      toast.success('已全部排进今天');
                      qc.invalidateQueries({ queryKey: qk.tasks });
                      qc.invalidateQueries({ queryKey: qk.mood });
                    });
                }}
              >
                全部排到今天
              </button>
            </span>
          </div>
        )}

        {/* 快速添加 */}
        <Input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newTitle.trim()) {
              createMut.mutate({ title: newTitle.trim(), plannedDate: target });
            }
          }}
          placeholder={viewOffset === 0
            ? '+ 添加今日清单项，回车确认'
            : `+ 添加${shortDate(target)}清单项，回车确认`}
          className="border-dashed bg-transparent focus:bg-surface-2"
        />
      </CardBody>
    </Card>
  );
}

/* ---------------- 日程（钉钉） ---------------- */
function ScheduleWidget() {
  const d = todayStr();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const { data: status } = useQuery({ queryKey: qk.eventStatus, queryFn: api.eventStatus });
  const configured = status?.dingtalk.configured || status?.ics.configured || status?.caldav.configured;
  const { data: events, isLoading } = useQuery({
    queryKey: qk.events(d),
    queryFn: () => api.events(`${d}T00:00:00`, `${d}T23:59:59`),
    enabled: configured === true,
  });
  const syncMut = useMutation({
    mutationFn: api.syncEvents,
    onSuccess: (r) => {
      if (r.ok) toast.success(`同步完成：${r.count} 条日程`);
      else toast.error(r.error ?? '同步失败');
    },
  });

  const nowStr = (() => {
    const n = new Date();
    const p = (x: number) => String(x).padStart(2, '0');
    return `${d}T${p(n.getHours())}:${p(n.getMinutes())}:00`;
  })();

  return (
    <Card className="col-span-12 md:col-span-6 lg:col-span-3">
      <CardHeader>
        <CardTitle><CalendarDays className="size-4 text-accent" /> 今日日程</CardTitle>
        <div className="flex items-center gap-2.5">
          <Button
            size="xsIcon"
            variant="ghost"
            onClick={() => setShowCreate(true)}
            aria-label="创建日程"
            title="创建日程"
          >
            <Plus className="size-3.5" />
          </Button>
          {configured && (
            <Button
              size="xsIcon"
              variant="ghost"
              onClick={() => syncMut.mutate()}
              disabled={syncMut.isPending}
              aria-label="刷新日程"
              title={syncMut.isPending ? '同步中' : '刷新日程'}
            >
              <RefreshCw className={cn('size-3.5', syncMut.isPending && 'animate-spin')} />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardBody className="min-h-[180px] p-3">
        {!configured ? (
          <EmptyState
            icon={<CalendarDays />}
            title="还没接入日历"
            desc="在设置里配置 ICS 订阅或钉钉直连后，这里会显示你的日程"
            action={<Link to="/settings"><Button size="sm" variant="secondary">去配置</Button></Link>}
          />
        ) : isLoading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9" />)}</div>
        ) : (events ?? []).length === 0 ? (
          <EmptyState icon={<CalendarDays />} title="今天没有日程" desc="享受完整的一天，或安排点新东西" />
        ) : (
          <div className="space-y-1">
            {(events ?? []).map((ev) => (
              <ScheduleEventRow key={ev.id} event={ev} nowStr={nowStr} onOpen={() => setSelectedEvent(ev)} />
            ))}
          </div>
        )}
      </CardBody>
      <CreateEventDialog open={showCreate} onClose={() => setShowCreate(false)} defaultDate={d} />
      {selectedEvent && <MeetingDetailDialog event={selectedEvent} open={Boolean(selectedEvent)} onClose={() => setSelectedEvent(null)} />}
    </Card>
  );
}

function ScheduleEventRow({ event: ev, nowStr, onOpen }: { event: CalendarEvent; nowStr: string; onOpen: () => void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const ownerRef = useRef<object>({});
  const [tip, setTip] = useState<{ left: number; top: number; width: number; above: boolean } | null>(null);
  const isAllDay = ev.is_all_day === 1;
  const ongoing = !isAllDay && ev.start_at <= nowStr && (!ev.end_at || ev.end_at >= nowStr);
  const time = isAllDay ? '全天' : `${fmtTime(ev.start_at)}${ev.end_at ? ` - ${fmtTime(ev.end_at)}` : ''}`;
  const location = (ev.location?.trim() || '未填写地点').replace(/\\n/g, '\n');
  const organizer = ev.organizer?.trim() || '未填写组织者';

  const clearTimers = () => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const showTip = () => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null;
      const row = rowRef.current;
      if (!row) return;
      const rect = row.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 24);
      const estimatedHeight = 154;
      const above = rect.bottom + estimatedHeight + 10 > window.innerHeight;
      claimHoverLayer(ownerRef.current, () => setTip(null));
      setTip({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: above ? Math.max(12, rect.top - estimatedHeight - 8) : rect.bottom + 8,
        width,
        above,
      });
    }, 350);
  };

  /**
   * 120ms grace period 关闭：给鼠标从文字跨过 gap 进入浮窗的时间窗口。
   * 进入浮窗（onMouseEnter）会清掉这个 timer。
   */
  const scheduleHide = () => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      releaseHoverLayer(ownerRef.current);
      setTip(null);
    }, 120);
  };

  const hideTipNow = () => {
    clearTimers();
    releaseHoverLayer(ownerRef.current);
    setTip(null);
  };

  useEffect(() => () => {
    clearTimers();
    releaseHoverLayer(ownerRef.current);
  }, []);

  // 浮窗显示期间，监听 document mousedown：任何点击（包括打开详情弹窗）都立即收起。
  useEffect(() => {
    if (!tip) return;
    const onDocDown = (e: MouseEvent) => {
      // 点在浮窗内（链接/选择文本）放过；其它点击（含打开 dialog）都关闭。
      if (tipRef.current && tipRef.current.contains(e.target as Node)) return;
      hideTipNow();
    };
    document.addEventListener('mousedown', onDocDown, true);
    return () => document.removeEventListener('mousedown', onDocDown, true);
  }, [tip]);

  return (
    <>
      <div
        ref={rowRef}
        tabIndex={0}
        aria-label={`${ev.title}，${time}，${location}，${organizer}`}
        role="button"
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
        onMouseEnter={showTip}
        onMouseLeave={scheduleHide}
        onFocus={showTip}
        onBlur={hideTipNow}
        className={cn(
          'flex items-center gap-3 rounded-lg border border-transparent px-2 py-2 outline-none transition-colors hover:bg-surface-2 focus-visible:border-accent/35 focus-visible:bg-surface-2',
          ongoing && 'border-accent/25 bg-accent-dim',
        )}
      >
        <span className="tnum w-[86px] shrink-0 font-mono text-[11px] text-ink-3">{time}</span>
        <span className="min-w-0 flex-1 truncate text-sm">{ev.title}</span>
        {ongoing && (
          <span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[10px] font-medium text-accent-ink">进行中</span>
        )}
      </div>

      {tip && createPortal(
        <div
          ref={tipRef}
          role="tooltip"
          onMouseEnter={() => {
            // 进入浮窗：取消所有待执行的关闭 timer
            if (showTimerRef.current !== null) {
              window.clearTimeout(showTimerRef.current);
              showTimerRef.current = null;
            }
            if (hideTimerRef.current !== null) {
              window.clearTimeout(hideTimerRef.current);
              hideTimerRef.current = null;
            }
          }}
          onMouseLeave={() => hideTipNow()}
          className={cn(
            'pop-panel pointer-events-auto fixed z-[90] rounded-lg border border-line-strong p-3 shadow-xl animate-[schedule-tip-in_.14s_ease-out]',
            tip.above ? 'origin-bottom' : 'origin-top',
          )}
          style={{ left: tip.left, top: tip.top, width: tip.width }}
        >
          <p className="min-w-0 break-words text-[13px] font-medium leading-5 text-ink [overflow-wrap:anywhere]">{ev.title}</p>
          <div className="mt-2 space-y-1.5 text-xs text-ink-3">
            <div className="flex items-center gap-2">
              <Clock3 className="size-3.5 shrink-0 text-accent" />
              <span className="tnum font-mono">{time}</span>
            </div>
            <div className="flex min-w-0 items-start gap-2">
              <MapPin className="mt-px size-3.5 shrink-0 text-accent" />
              <span className={cn('min-w-0 flex-1 break-words whitespace-pre-wrap leading-5 [overflow-wrap:anywhere]', ev.location ? 'text-ink-2' : 'text-ink-4')}>{location}</span>
            </div>
            <div className="flex min-w-0 items-start gap-2">
              <UserRound className="mt-px size-3.5 shrink-0 text-accent" />
              <span className={cn('min-w-0 flex-1 break-words leading-5 [overflow-wrap:anywhere]', ev.organizer ? 'text-ink-2' : 'text-ink-4')}>{organizer}</span>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/* ---------------- 提醒 ---------------- */
function RemindersWidget() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const [at, setAt] = useState('');

  const { data: reminders, isLoading } = useQuery({ queryKey: qk.reminders, queryFn: api.reminders });

  const createMut = useMutation({
    mutationFn: api.createReminder,
    onSuccess: () => {
      setMsg(''); setAt('');
      qc.invalidateQueries({ queryKey: qk.reminders });
      qc.invalidateQueries({ queryKey: qk.mood });
      pulseMood('remind');
    },
    onError: (e) => toast.error(e.message),
  });

  // 到点的排在前面：它才是需要当场处理的；其余按时间升序，凑满 5 条
  const upcoming = useMemo(() =>
    (reminders ?? [])
      .filter((r) => r.status === 'pending' || r.status === 'fired')
      .sort((a, b) => {
        if ((a.status === 'fired') !== (b.status === 'fired')) return a.status === 'fired' ? -1 : 1;
        return a.trigger_at.localeCompare(b.trigger_at);
      })
      .slice(0, 5), [reminders]);

  const complete = useMutation({
    mutationFn: (id: number) => api.updateReminder(id, { status: 'done' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.reminders }); pulseMood('tick'); },
    onError: (e) => toast.error(e.message),
  });
  const snooze = useMutation({
    mutationFn: ({ id, triggerAt }: { id: number; triggerAt: string }) =>
      api.updateReminder(id, { status: 'pending', triggerAt }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.reminders });
      toast.success('已延后 10 分钟');
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card className="col-span-12 md:col-span-6 lg:col-span-3">
      <CardHeader>
        <CardTitle><AlarmClock className="size-4 text-accent" /> 提醒</CardTitle>
        <Link to="/reminders" className="text-[11px] text-ink-4 transition-colors hover:text-accent">全部</Link>
      </CardHeader>
      <CardBody className="space-y-2 p-3">
        {isLoading ? (
          [0, 1].map((i) => <Skeleton key={i} className="h-9" />)
        ) : upcoming.length === 0 ? (
          <EmptyState icon={<BellRing />} title="没有待触发提醒" desc="到点会弹系统通知" className="py-6" />
        ) : (
          upcoming.map((r) => (
            <div key={r.id} className={cn(
              'flex items-center gap-2 rounded-lg px-2 py-1.5',
              r.status === 'fired' ? 'border border-danger/25 bg-danger/10' : 'hover:bg-surface-2',
            )}>
              <BellRing className={cn('size-3.5 shrink-0', r.status === 'fired' ? 'text-danger' : 'text-ink-4')} />
              <EllipsisText className="min-w-0 flex-1 text-sm">{linkify(r.message)}</EllipsisText>
              {/* 送达失败要在今日页也看得见：只显示在提醒页的话，用户根本不会去看 */}
              {r.delivery_status === 'failed' && (
                <span title={`通知没发出去：${r.delivery_error ?? '未知错误'}${r.next_retry_at ? `（${fmtTime(r.next_retry_at)} 自动重试）` : '，已停止自动重试'}。去提醒页可手动重发`}>
                  <AlertTriangle className="size-3.5 shrink-0 text-warn" />
                </span>
              )}
              <span className={cn('shrink-0 font-mono text-[11px]', r.status === 'fired' ? 'text-danger' : 'text-ink-3')}>
                {r.status === 'fired' ? '已到点' : countdown(r.trigger_at)}
              </span>
              {/* 就地处置：到点的可以完成也可以延后，没到点的允许提前完成 */}
              <Button
                size="xsIcon"
                variant="ghost"
                title="完成"
                disabled={complete.isPending}
                onClick={() => complete.mutate(r.id)}
              >
                <Check />
              </Button>
              {r.status === 'fired' && (
                <Button
                  size="xsIcon"
                  variant="ghost"
                  title="10 分钟后再提醒"
                  disabled={snooze.isPending}
                  onClick={() => snooze.mutate({ id: r.id, triggerAt: snoozeAt(SNOOZE_DEFAULT_MINUTES) })}
                >
                  <Clock />
                </Button>
              )}
            </div>
          ))
        )}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder="提醒我…"
            className="h-8 min-w-full border-dashed bg-transparent text-xs focus:bg-surface-2 lg:min-w-0 lg:flex-1"
          />
          <div className="flex flex-1 gap-1.5">
            <DateTimePicker
              value={at}
              onChange={setAt}
              className="h-8 min-w-0 flex-1 px-2 text-xs"
            />
            <Button
              size="icon"
              variant="secondary"
              disabled={!msg.trim() || !at || createMut.isPending}
              onClick={() => createMut.mutate({ message: msg.trim(), triggerAt: at })}
              title="添加提醒"
            >
              +
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/* ---------------- 项目进度 ---------------- */
function ProjectsWidget() {
  const { data: projects, isLoading } = useQuery({ queryKey: qk.projects, queryFn: api.projects });
  const active = useMemo(() =>
    (projects ?? []).filter((p) => p.status === 'active')
      .sort((a, b) => (b.open_tasks ?? 0) + (b.done_tasks ?? 0) * 0.1 - ((a.open_tasks ?? 0) + (a.done_tasks ?? 0) * 0.1))
      .slice(0, 5), [projects]);

  return (
    <Card className="col-span-12">
      <CardHeader>
        <CardTitle>项目推进</CardTitle>
        <Link to="/projects" className="text-[11px] text-ink-4 transition-colors hover:text-accent">管理</Link>
      </CardHeader>
      <CardBody className="grid grid-cols-1 gap-x-8 gap-y-3 p-4 md:grid-cols-2">
        {isLoading ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)
        ) : active.length === 0 ? (
          <EmptyState
            icon={<ArrowRight />}
            title="还没有进行中的项目"
            desc="工作或生活的大事，建一个项目来追踪"
            action={<Link to="/projects"><Button size="sm" variant="secondary">新建项目</Button></Link>}
          />
        ) : (
          active.map((p) => {
            const total = (p.open_tasks ?? 0) + (p.done_tasks ?? 0);
            const pct = total ? Math.round(((p.done_tasks ?? 0) / total) * 100) : 0;
            return (
              <Link key={p.id} to={`/projects/${p.id}`} className="block space-y-1.5 rounded-lg p-1 transition-colors hover:bg-surface-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <DomainBadge domain={p.domain} />
                    <span className="truncate">{p.name}</span>
                  </span>
                  <span className="tnum shrink-0 font-mono text-xs text-ink-3">{pct}%</span>
                </div>
                <Progress value={pct} />
              </Link>
            );
          })
        )}
      </CardBody>
    </Card>
  );
}
