// 日历视图：Notion 风格月历，按天展示所有清单（planned_date，未规划则回退 due_at 当天）
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CalendarRange, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, GripVertical, Plus, RefreshCw, UserRound } from 'lucide-react';
import { DndContext, closestCenter, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import { useTaskReorder } from '@/lib/reorder';
import { cn, compareTasks, fmtTime, shortDate, todayStr } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Input } from '@/ui/form';
import { EllipsisText, EmptyState } from '@/ui/primitives';
import { Dialog, DialogContent } from '@/ui/dialog';
import { TaskDetailDialog } from '@/components/TaskDetailDialog';
import { CreateEventDialog } from '@/components/CreateEventDialog';
import { MeetingDetailDialog } from '@/components/MeetingDetailDialog';
import { pulseMood } from '@/store/mood';
import type { CalendarEvent, Task } from '@/types';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 任务归属日期：进了今日清单用 planned_date；否则有截止时间就算在截止那天 */
const dayOf = (t: Task) => t.planned_date || t.due_at?.slice(0, 10) || '';

export function CalendarView() {
  const today = todayStr();
  const qc = useQueryClient();
  // 支持从周报等页面带 ?date=YYYY-MM-DD 跳过来，自动定位到那个月并打开那天
  const [params] = useSearchParams();
  const jumpDate = (() => {
    const v = params.get('date');
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  })();
  const [cursor, setCursor] = useState(() => {
    const base = jumpDate ? new Date(jumpDate + 'T00:00:00') : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [selected, setSelected] = useState<string | null>(jumpDate); // 打开的某天（YYYY-MM-DD）
  const [editing, setEditing] = useState<Task | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [showCreate, setShowCreate] = useState(false); // 创建钉钉日程弹窗
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const { data: tasks, isLoading } = useQuery({ queryKey: qk.tasks, queryFn: api.tasks });

  // 视角切换：清单（按天分组任务） / 日程（按天分组同步来的日历事件）
  const [mode, setMode] = useState<'tasks' | 'events'>('tasks');
  const { data: status } = useQuery({ queryKey: qk.eventStatus, queryFn: api.eventStatus });
  const configured = Boolean(status?.dingtalk.configured || status?.ics.configured || status?.caldav.configured);
  const ym = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}`;
  // 月网格首尾（含前后月补位日期），事件查询按网格范围拉取，
  // 否则尾部/头部的相邻月格子看不到日程、点开也误报「没有日程」
  const gridMeta = useMemo(() => {
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7; // 周一为 0
    const rows = Math.ceil((lead + new Date(y, m + 1, 0).getDate()) / 7);
    const startDate = new Date(y, m, 1 - lead);
    const endDate = new Date(y, m, 1 - lead + rows * 7 - 1);
    return { lead, rows, start: keyOf(startDate), end: keyOf(endDate) };
  }, [cursor]);
  const { data: monthEvents, isLoading: eventsLoading } = useQuery({
    queryKey: qk.events(`grid-${ym}`),
    queryFn: () => api.events(`${gridMeta.start}T00:00:00`, `${gridMeta.end}T23:59:59`),
    enabled: mode === 'events' && configured,
  });
  const gridLoading = mode === 'tasks' ? isLoading : eventsLoading;

  // 按天分组，组内未完成在前、优先级高的在前
  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks ?? []) {
      const k = dayOf(t);
      if (!k) continue;
      const list = map.get(k) ?? [];
      list.push(t);
      map.set(k, list);
    }
    for (const list of map.values()) {
      list.sort(compareTasks);
    }
    return map;
  }, [tasks]);

  // 日程按天分组：全天在前，其余按开始时间
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of monthEvents ?? []) {
      const k = ev.start_at.slice(0, 10);
      const list = map.get(k) ?? [];
      list.push(ev);
      map.set(k, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (b.is_all_day - a.is_all_day) || a.start_at.localeCompare(b.start_at) || a.title.localeCompare(b.title));
    }
    return map;
  }, [monthEvents]);

  const toggleMut = useMutation({
    mutationFn: (t: Task) => api.updateTask(t.id, { status: t.status === 'done' ? 'todo' : 'done' }),
    onSuccess: (_r, t) => {
      qc.invalidateQueries({ queryKey: qk.tasks });
      qc.invalidateQueries({ queryKey: qk.mood });
      pulseMood(t.status === 'done' ? 'snooze' : 'tick');
    },
    onError: (e) => toast.error(e.message),
  });

  const moveMut = useMutation({
    mutationFn: ({ id, date }: { id: number; date: string }) => api.updateTask(id, { plannedDate: date }),
    onSuccess: (_task, vars) => {
      qc.invalidateQueries({ queryKey: qk.tasks });
      toast.success(`清单已移到 ${shortDate(vars.date)}`);
      pulseMood('snooze');
    },
    onError: (e) => toast.error(e.message),
  });

  // 同天拖拽排序：直接复用「今日」那边那套 useTaskReorder（落库 sort_order + 乐观更新共享缓存），
  // 因此日历格子里的顺序天然同步到今日清单。
  const reorderMut = useTaskReorder();

  const onCalendarDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);
    if (!activeId.startsWith('calendar-task-')) return;
    const taskId = Number(activeId.slice('calendar-task-'.length));
    const overId = String(over.id);
    const sourceDate = String(active.data.current?.sourceDate ?? '');
    if (!sourceDate) return;

    const overIsChip = overId.startsWith('chip-');
    // 落点是格子 droppable 时 id 即日期；落点是任务芯片时从 droppable data 读它的日期
    const overDate = overIsChip ? String(over.data.current?.dateKey ?? '') : overId;

    // 跨天：落到别的日期（格子或别天的任务芯片）→ 改期
    if (overDate !== sourceDate && /^\d{4}-\d{2}-\d{2}$/.test(overDate)) {
      moveMut.mutate({ id: taskId, date: overDate });
      return;
    }
    // 同天：重排（拖到某条任务上=插到它前面；拖到格子空白处=挪到末尾）
    if (overDate === sourceDate) {
      const dayTasks = byDay.get(sourceDate) ?? [];
      const ids = dayTasks.map((t) => t.id);
      const from = ids.indexOf(taskId);
      if (from < 0) return;
      let to = ids.length - 1;
      if (overIsChip) {
        const overTaskId = Number(overId.slice('chip-'.length));
        if (overTaskId === taskId) return;
        const idx = ids.indexOf(overTaskId);
        if (idx < 0) return;
        to = idx;
      }
      if (to === from) return;
      reorderMut.mutate(arrayMove(ids, from, to));
    }
  };

  // 月网格（周一起始），补齐整周
  const cells = useMemo(() => {
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const { lead, rows } = gridMeta;
    const out: Array<{ key: string; day: number; inMonth: boolean }> = [];
    for (let i = 0; i < rows * 7; i++) {
      const d = new Date(y, m, 1 - lead + i);
      out.push({ key: keyOf(d), day: d.getDate(), inMonth: d.getMonth() === m });
    }
    return out;
  }, [cursor, gridMeta]);

  const shift = (n: number) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + n, 1));
  // 点相邻月的补位格子：切到对应月份再打开当天面板
  const handleSelect = (key: string) => {
    const d = new Date(`${key}T00:00:00`);
    if (d.getFullYear() !== cursor.getFullYear() || d.getMonth() !== cursor.getMonth()) {
      setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
    }
    setSelected(key);
  };
  // 「今天」= 切回当前月，不弹当天面板（避免与"切换月份"语义混淆）
  const goToday = () => {
    const n = new Date();
    setCursor(new Date(n.getFullYear(), n.getMonth(), 1));
  };

  // 手动触发一次日历同步，完成后刷新日程数据
  const syncMut = useMutation({
    mutationFn: api.syncEvents,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['events'] });
      qc.invalidateQueries({ queryKey: qk.eventStatus });
      if (r.ok) toast.success(`日程已同步${r.count != null ? ` · ${r.count} 条` : ''}`);
      else toast.error(r.error ?? '同步失败');
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      {/* 头部：月份标题 + 月份切换；右侧 Today / 视角切换 */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
        <h1 className="flex items-baseline gap-2 text-[22px] font-medium leading-tight tracking-tight">
          <MonthPicker
            year={cursor.getFullYear()}
            month={cursor.getMonth()}
            onPick={(y, m) => setCursor(new Date(y, m, 1))}
          />
        </h1>

        {/* 月份切换：‹ 今天 › 一体式，直接平铺不包外框 */}
        <div className="flex items-center gap-1">
          <Button
            size="xsIcon"
            variant="ghost"
            onClick={() => shift(-1)}
            aria-label="上个月"
            className="hover:bg-surface-3"
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <button
            type="button"
            onClick={goToday}
            aria-label="回到今天"
            className="flex h-6 items-center rounded-md px-2 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            今天
          </button>
          <Button
            size="xsIcon"
            variant="ghost"
            onClick={() => shift(1)}
            aria-label="下个月"
            className="hover:bg-surface-3"
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </div>

        {/* 右侧：辅助说明 + 视角切换 + 日程专属操作 */}
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="hidden text-[11px] text-ink-4 sm:block">
            {mode === 'tasks' ? '拖 ⋮ 可改期或同天排序 · 点格子看当天' : '点格子看当天日程 · 数据来自日历同步'}
          </p>

          {mode === 'events' && (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={syncMut.isPending}
                onClick={() => syncMut.mutate()}
                aria-label="同步日程"
              >
                <RefreshCw className={cn('size-4', syncMut.isPending && 'animate-spin')} />
                同步
              </Button>
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus className="size-4" />
                创建日程
              </Button>
            </>
          )}

          {/* 双视角切换：清单 / 日程 */}
          <div className="flex items-center gap-0.5 rounded-lg border border-line bg-surface-1/60 p-0.5">
            {([['tasks', '清单'], ['events', '日程']] as const).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  mode === m
                    ? 'bg-surface-3 text-ink shadow-sm'
                    : 'text-ink-3 hover:bg-surface-2 hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* 日程视角未接入日历时给引导空态 */}
      {mode === 'events' && !configured ? (
        <div className="overflow-hidden rounded-xl border border-line bg-chrome">
          <EmptyState
            icon={<CalendarDays />}
            title="还没接入日历"
            desc="在设置里配置 ICS 订阅、钉钉或 CalDAV 后，这里会显示整月日程"
            action={<Link to="/settings"><Button size="sm" variant="secondary">去配置</Button></Link>}
            className="py-16"
          />
        </div>
      ) : (
      <div className="overflow-hidden rounded-xl border border-line bg-chrome">
        <div className="grid grid-cols-7 border-b border-line bg-surface-1/60">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-1.5 text-center text-[11px] font-medium tracking-wide text-ink-3">{w}</div>
          ))}
        </div>
        {gridLoading ? (
          <div className="grid grid-cols-7">
            {Array.from({ length: 35 }, (_, i) => (
              <div key={i} className="min-h-[76px] animate-pulse border-b border-r border-line last:border-r-0 [&:nth-child(7n)]:border-r-0" />
            ))}
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onCalendarDragEnd}>
            <div className="grid grid-cols-7">
              {cells.map(({ key, day, inMonth }, idx) => (
                <CalendarCell
                  key={key}
                  dateKey={key}
                  day={day}
                  inMonth={inMonth}
                  edge={idx % 7 === 6}
                  isToday={key === today}
                  mode={mode}
                  tasks={byDay.get(key) ?? []}
                  events={eventsByDay.get(key) ?? []}
                  onSelect={handleSelect}
                  onEdit={setEditing}
                  onToggle={(t) => toggleMut.mutate(t)}
                  onOpenEvent={setSelectedEvent}
                />
              ))}
            </div>
          </DndContext>
        )}
      </div>
      )}

      {/* 当天面板 */}
      <Dialog open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        {selected && (
          <DayPanel
            dateKey={selected}
            mode={mode}
            tasks={byDay.get(selected) ?? []}
            events={eventsByDay.get(selected) ?? []}
            onEdit={setEditing}
            onToggle={(t) => toggleMut.mutate(t)}
            onOpenEvent={setSelectedEvent}
          />
        )}
      </Dialog>

      {/* 条目详情 */}
      {editing && (
        <TaskDetailDialog
          task={editing}
          open={Boolean(editing)}
          onClose={() => setEditing(null)}
        />
      )}

      {/* 创建钉钉日程（MCP） */}
      <CreateEventDialog open={showCreate} onClose={() => setShowCreate(false)} defaultDate={selected ?? undefined} />
      {selectedEvent && <MeetingDetailDialog event={selectedEvent} open={Boolean(selectedEvent)} onClose={() => setSelectedEvent(null)} />}
    </div>
  );
}

function CalendarCell({ dateKey, day, inMonth, edge, isToday, mode, tasks, events, onSelect, onEdit, onToggle, onOpenEvent }: {
  dateKey: string;
  day: number;
  inMonth: boolean;
  edge: boolean;
  isToday: boolean;
  mode: 'tasks' | 'events';
  tasks: Task[];
  events: CalendarEvent[];
  onSelect: (dateKey: string) => void;
  onEdit: (task: Task) => void;
  onToggle: (task: Task) => void;
  onOpenEvent: (event: CalendarEvent) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dateKey });

  return (
    <div
      ref={setNodeRef}
      onClick={() => onSelect(dateKey)}
      className={cn(
        'group relative min-h-[76px] cursor-pointer border-b border-r border-line p-1.5 transition-colors hover:bg-surface-1 md:min-h-[104px]',
        edge && 'border-r-0',
        !inMonth && 'text-ink-4',
        isToday && 'bg-accent-dim',
        isOver && 'bg-accent-dim ring-1 ring-inset ring-accent/70',
      )}
    >
      <div className="mb-1 flex items-center justify-end">
        {isToday ? (
          <span className="tnum flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-ink">{day}</span>
        ) : (
          <span className={cn('tnum text-[11px]', inMonth ? 'text-ink-3' : 'opacity-40')}>{day}</span>
        )}
      </div>

      <div className="space-y-0.5">
        {mode === 'tasks' && tasks.map((task) => (
          <CalendarTaskChip key={task.id} task={task} dateKey={dateKey} onEdit={onEdit} onToggle={onToggle} />
        ))}
        {mode === 'events' && events.map((ev) => (
          <button key={ev.id} type="button" onClick={(e) => { e.stopPropagation(); onOpenEvent(ev); }} className="flex w-full items-center gap-1 rounded px-1 py-px text-left transition-colors hover:bg-surface-2">
            <span className={cn('tnum w-[30px] shrink-0 text-right font-mono text-[9px] leading-4', ev.is_all_day === 1 ? 'text-accent' : 'text-ink-4')}>
              {ev.is_all_day === 1 ? '全天' : ev.start_at.slice(11, 16)}
            </span>
            <EllipsisText className="block min-w-0 flex-1 text-[11px] leading-4 text-ink">{ev.title}</EllipsisText>
          </button>
        ))}
      </div>
    </div>
  );
}

function CalendarTaskChip({ task, dateKey, onEdit, onToggle }: {
  task: Task;
  dateKey: string;
  onEdit: (task: Task) => void;
  onToggle: (task: Task) => void;
}) {
  const { attributes, listeners, setNodeRef: dragRef, transform, isDragging } = useDraggable({
    id: `calendar-task-${task.id}`,
    data: { taskId: task.id, sourceDate: dateKey },
  });
  // 同天排序：每个芯片同时是拖放目标，落上去就把拖动的条插到它前面
  const { setNodeRef: dropRef, isOver } = useDroppable({
    id: `chip-${task.id}`,
    data: { dateKey },
  });
  const done = task.status === 'done';
  const isDueOnly = !task.planned_date && Boolean(task.due_at?.startsWith(dateKey));

  return (
    <div
      ref={(el) => { dragRef(el); dropRef(el); }}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'flex items-center gap-1 rounded px-1 py-px text-left transition-colors hover:bg-surface-2',
        isDragging && 'relative z-20 bg-surface-3 shadow-lg ring-1 ring-accent/50',
        isOver && !isDragging && 'bg-accent-dim ring-1 ring-inset ring-accent/60',
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="拖动改期或同天排序"
        title="拖动改期或同天排序"
        className="shrink-0 cursor-grab touch-none rounded p-px text-ink-4 opacity-0 transition-[opacity,color] hover:text-accent group-hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical className="size-3" />
      </button>
      <button
        type="button"
        aria-label={done ? '标记未完成' : '完成'}
        onClick={() => onToggle(task)}
        className={cn(
          'flex size-[13px] shrink-0 items-center justify-center rounded-[4px] border transition-all',
          done ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong hover:border-accent/70',
        )}
      >
        {done && <svg viewBox="0 0 10 10" className="size-2 fill-none stroke-current stroke-[2.5]" strokeWidth={2.5}><path d="M1.5 5.5 4 8l4.5-6" /></svg>}
      </button>
      <button type="button" onClick={() => onEdit(task)} data-detail-opener="" className="min-w-0 flex-1 text-left">
        <EllipsisText className={cn('block w-full text-[11px] leading-4 transition-colors', done ? 'text-ink-4 line-through' : 'text-ink hover:text-accent')}>
          {!done && task.priority > 0 && <span className={cn('mr-1 inline-block size-1.5 rounded-full align-middle', task.priority >= 2 ? 'bg-danger' : 'bg-warn')} />}
          {task.title}
        </EllipsisText>
      </button>
      {isDueOnly && <span className="shrink-0 rounded-sm bg-surface-2 px-1 text-[9px] text-ink-4">截止</span>}
    </div>
  );
}

/* ---------------- 某天的清单面板（支持拖拽排序） ---------------- */
function DayPanel({ dateKey, mode, tasks, events, onEdit, onToggle, onOpenEvent }: {
  dateKey: string;
  mode: 'tasks' | 'events';
  tasks: Task[];
  events: CalendarEvent[];
  onEdit: (t: Task) => void;
  onToggle: (t: Task) => void;
  onOpenEvent: (event: CalendarEvent) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const reorderMut = useTaskReorder();

  // 按下 6px 才算拖拽，避免和点击打开详情打架
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const d = new Date(`${dateKey}T00:00:00`);
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  const isPast = dateKey < todayStr();

  const createMut = useMutation({
    mutationFn: () => api.createTask({ title: title.trim(), plannedDate: dateKey }),
    onSuccess: () => {
      setTitle('');
      qc.invalidateQueries({ queryKey: qk.tasks });
    },
    onError: (e) => toast.error(e.message),
  });

  const open = tasks.filter((t) => t.status !== 'done').length;

  // 拖拽落点：本地换序 + 整组落库（乐观更新在 useTaskReorder 里）
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = tasks.map((t) => t.id);
    const from = ids.indexOf(Number(active.id));
    const to = ids.indexOf(Number(over.id));
    if (from < 0 || to < 0) return;
    reorderMut.mutate(arrayMove(ids, from, to));
  };

  return (
    <DialogContent title={`${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${week}`} className="flex max-h-[80vh] max-w-lg flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-6 pb-2 pt-1 text-xs text-ink-3">
        <CalendarRange className="size-3.5 text-accent" />
        {mode === 'tasks' ? (
          <>
            <span>共 {tasks.length} 项 · 待完成 {open}</span>
            {isPast && open > 0 && <span className="rounded-full bg-danger/10 px-2 py-px text-danger">已过期</span>}
          </>
        ) : (
          <span>共 {events.length} 个日程</span>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-4 pb-2">
        {mode === 'events' ? (
          events.length === 0 ? (
            <EmptyState icon={<CalendarRange />} title="这天没有日程" desc="日程来自日历同步，同步后这里会显示" />
          ) : (
            events.map((ev) => <EventRow key={ev.id} event={ev} onOpen={() => onOpenEvent(ev)} />)
          )
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={<CalendarRange />}
            title="这天还没有记录"
            desc={isPast ? '过去的一天空空荡荡' : '在下方输入，回车加进这天的清单'}
          />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {tasks.map((t) => (
                <SortableDayRow key={t.id} task={t} onEdit={onEdit} onToggle={onToggle} />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      <div className="border-t border-line p-4">
        {mode === 'events' ? (
          <p className="text-[11px] text-ink-4">
            日程来自日历同步（ICS / 钉钉 / CalDAV）· 想拉取最新数据可点右上角「同步」按钮
          </p>
        ) : (
          <>
            <div className="flex gap-2">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && title.trim() && createMut.mutate()}
                placeholder="+ 加进这天的清单，回车确认"
                className="border-dashed bg-transparent"
              />
              <Button
                size="icon"
                variant="secondary"
                disabled={!title.trim() || createMut.isPending}
                onClick={() => createMut.mutate()}
                aria-label="添加"
              >
                <Plus className="size-4" />
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-ink-4">
              记录会保存在这一天的日历里 · 点条目看详情，拖 ⋮ 排序 · 想翻历史就往前翻月份，
              <Link to="/" className="underline underline-offset-2 hover:text-accent">回今日</Link>
            </p>
          </>
        )}
      </div>
    </DialogContent>
  );
}

/** 可拖拽的当天条目：外层 div 承接 dnd-kit transform */
function SortableDayRow({ task, onEdit, onToggle }: {
  task: Task;
  onEdit: (t: Task) => void;
  onToggle: (t: Task) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const done = task.status === 'done';
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group flex items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2',
        done && 'opacity-55',
        isDragging && 'relative z-10',
      )}
    >
      <button
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        aria-label="拖动排序"
        title="拖动排序"
        className="-ml-1 mt-0.5 shrink-0 cursor-grab touch-none rounded p-0.5 text-ink-4 opacity-0 transition-[opacity,color] hover:text-accent group-hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </button>
      <button
        onClick={() => onToggle(task)}
        aria-label={done ? '标记未完成' : '完成'}
        className={cn(
          'mt-0.5 flex size-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-all',
          done ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong hover:border-accent/70',
        )}
      >
        {done && <svg viewBox="0 0 10 10" className="size-2.5 fill-none stroke-current stroke-[2.5]"><path d="M1.5 5.5 4 8l4.5-6" /></svg>}
      </button>
      <button onClick={() => onEdit(task)} data-detail-opener="" className="min-w-0 flex-1 text-left">
        <EllipsisText className={cn('block w-full text-sm', done && 'line-through')}>
          {task.title}
        </EllipsisText>
        {task.project_name && (
          <span className="mt-0.5 block truncate text-[11px] text-ink-4">{task.project_name}</span>
        )}
      </button>
    </div>
  );
}

/** 日程视角的当天事件行（只读，数据来自同步） */
function EventRow({ event: ev, onOpen }: { event: CalendarEvent; onOpen?: () => void }) {
  const allDay = ev.is_all_day === 1;
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2">
      <span className="tnum mt-0.5 w-[92px] shrink-0 font-mono text-[11px] text-ink-3">
        {allDay ? '全天' : `${fmtTime(ev.start_at)}${ev.end_at ? ` - ${fmtTime(ev.end_at)}` : ''}`}
      </span>
      <div className="min-w-0 flex-1">
        <EllipsisText className="block w-full text-sm">{ev.title}</EllipsisText>
        {ev.location && <span className="mt-0.5 block truncate text-[11px] text-ink-4">{ev.location}</span>}
        {ev.organizer && <span className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-ink-4"><UserRound className="size-3 shrink-0" />{ev.organizer}</span>}
      </div>
    </button>
  );
}

/* ---------------- 月份快速选择 ---------------- */
const MONTH_LABELS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];

/**
 * 月份标题点击展开的月份选择器：年份步进 + 12 月网格。
 * 跟全局设计系统保持一致：发丝线 + 玻璃面板；选中月用 accent 高亮。
 */
function MonthPicker({ year, month, onPick }: { year: number; month: number; onPick: (y: number, m: number) => void }) {
  const [open, setOpen] = useState(false);
  const [pickedYear, setPickedYear] = useState(year);
  const ref = useRef<HTMLDivElement>(null);
  const today = new Date();

  // 打开时回到当前展示的年份；外部年份变化时同步
  useEffect(() => { if (!open) setPickedYear(year); }, [open, year]);

  // 点外面 / ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (m: number) => {
    onPick(pickedYear, m);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="切换月份"
        className={cn(
          'group inline-flex items-baseline gap-1 rounded-md px-1 -mx-1 transition-colors',
          'hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent/60',
        )}
      >
        <span className="text-ink-2">{year}</span>
        <span className="text-ink-2">年</span>
        <span className="neon-text">{month + 1}</span>
        <span className="text-ink-2">月</span>
        <ChevronDown className={cn(
          'size-3.5 text-ink-3 transition-transform duration-150',
          open && 'rotate-180 text-accent',
        )} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="选择月份"
          className="pop-panel absolute left-0 top-full z-30 mt-2 w-[280px] rounded-xl border border-line bg-pop p-3 shadow-[var(--pop-shadow)]"
        >
          {/* 年份步进 */}
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setPickedYear((y) => y - 1)}
              aria-label="上一年"
              className="flex size-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <ChevronsLeft className="size-4" />
            </button>
            <span className="tnum text-sm font-medium text-ink">{pickedYear} 年</span>
            <button
              type="button"
              onClick={() => setPickedYear((y) => y + 1)}
              aria-label="下一年"
              className="flex size-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <ChevronsRight className="size-4" />
            </button>
          </div>

          {/* 12 月网格 */}
          <div className="grid grid-cols-3 gap-1.5">
            {MONTH_LABELS.map((label, idx) => {
              const isCurrent = year === pickedYear && idx === month;
              const isNow = pickedYear === today.getFullYear() && idx === today.getMonth();
              return (
                <button
                  type="button"
                  key={label}
                  onClick={() => choose(idx)}
                  className={cn(
                    'relative flex h-9 items-center justify-center rounded-md text-xs font-medium transition-colors',
                    isCurrent
                      ? 'bg-accent text-accent-ink'
                      : isNow
                        ? 'border border-accent/40 text-accent hover:bg-accent-dim'
                        : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                  )}
                >
                  {label}
                  {isNow && !isCurrent && (
                    <span className="absolute right-1.5 top-1.5 size-1 rounded-full bg-accent" />
                  )}
                </button>
              );
            })}
          </div>

          <p className="mt-3 border-t border-line pt-2 text-[11px] text-ink-4">
            选月份跳转 · 今天有圆点标记 · ESC 关闭
          </p>
        </div>
      )}
    </div>
  );
}
