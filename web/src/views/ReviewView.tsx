import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlarmClock, CalendarRange, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Copy, FileText, FolderKanban, NotebookPen, Pencil, Plus, RotateCcw, Settings2, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk, type WeekSel } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Card, CardBody, CardHeader, CardTitle } from '@/ui/card';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/primitives';
import { Dialog, DialogContent } from '@/ui/dialog';
import type { WeeklyReview } from '@/types';

const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const MONTH_LABELS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];
const DEFAULT_SECTIONS = ['本周完成工作', '下周重点工作', '用户心声/竞品动态/学习反思/所需支持'];

const pad2 = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 返回 d 所在周的周一（本地零点） */
function mondayOf(d: Date): Date {
  const r = new Date(d);
  const day = (r.getDay() + 6) % 7; // 周一=0
  r.setDate(r.getDate() - day);
  r.setHours(0, 0, 0, 0);
  return r;
}
/** 由某周的周一推算「YYYY年M月 第N周」标签（第1周含当月1号） */
function weekLabel(monday: Date): string {
  const y = monday.getFullYear();
  const m = monday.getMonth() + 1;
  const fm = mondayOf(new Date(y, m - 1, 1));
  const n = Math.round((monday.getTime() - fm.getTime()) / 604_800_000) + 1;
  return `${y}年${m}月 第${n}周`;
}

export function ReviewView() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [range, setRange] = useState<WeekSel>({ offset: 0, label: '本周' });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // 切换周（本周/上周/选周/步进）时清空已展开的当日明细
  useEffect(() => { setSelectedDate(null); }, [range]);
  const [configOpen, setConfigOpen] = useState(false);
  // 显式编辑入口按钮的开关（点击内容进入编辑与该状态独立）
  const [editing, setEditing] = useState(false);

  const [sectionTitles, setSectionTitles] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('weekly-report-sections') || 'null') || DEFAULT_SECTIONS; } catch { return DEFAULT_SECTIONS; }
  });
  const [draftSections, setDraftSections] = useState<string[]>(sectionTitles);

  const { data: review, isLoading } = useQuery({
    queryKey: qk.review(range),
    queryFn: () => api.weeklyReview(range),
  });

  // 当前选中的周一（本周时回退到今天所在周）
  const curMonday = useMemo(() => keyOf(mondayOf(new Date())), []);
  const selMonday = range.weekStart ?? curMonday;
  const isThisWeek = selMonday === curMonday;
  const isLastWeek = selMonday === keyOf(new Date(new Date(curMonday).getTime() - 7 * 86_400_000));
  const canGoNext = selMonday < curMonday; // 不能翻到未来周

  const bars = useMemo(() => {
    if (!review) return [];
    const m = new Map(review.perDay.map((r) => [r.d, r.n]));
    const start = new Date(review.weekStart.slice(0, 10));
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const key = keyOf(d);
      return {
        label: DAY_LABELS[i],
        date: `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`,
        key,
        n: m.get(key) ?? 0,
      };
    });
  }, [review]);

  const maxN = Math.max(1, ...bars.map((d) => d.n));

  // 按天分组本周完成的清单项，供点击柱状图后原地展开明细
  const tasksByDay = useMemo(() => {
    const map = new Map<string, import('@/types').Task[]>();
    for (const t of review?.recentCompleted ?? []) {
      const d = (t.completed_at ?? '').slice(0, 10);
      if (!d) continue;
      const list = map.get(d) ?? [];
      list.push(t);
      map.set(d, list);
    }
    return map;
  }, [review]);

  const completedHighlights = useMemo(() => pickHighlights(review?.recentCompleted ?? [], 6), [review]);
  const nextHighlights = useMemo(() => pickHighlights(review?.nextWeekTasks ?? [], 5), [review]);
  // 自动生成的三个段落：纯文本（不带 dash / 序号前缀），渲染时再统一加 `1. ` `2. ` 等
  const generatedReport = useMemo(() => [
    completedHighlights.length ? completedHighlights.map((t) => taskLine(t)).join('\n') : '本期暂无已完成的待办事项',
    nextHighlights.length ? nextHighlights.map((t) => taskLine(t)).join('\n') : '暂无已安排的重点待办',
    '用户心声：暂无记录\n竞品动态：暂无记录\n学习反思：暂无记录\n所需支持：暂无记录',
  ], [completedHighlights, nextHighlights]);
  // 用户编辑过的段落（已去序号）；缺 key 表示回退到 generatedReport
  const overrides = review?.overrides ?? {};
  const hasOverride = (i: number) => typeof overrides[i] === 'string';

  // 「下周重点工作」段落当前内容：用户编辑过的优先，否则用自动生成
  const nextSectionText = overrides[1] ?? generatedReport[1];
  // 「已同步下周清单」= 没被用户编辑过 且 自动生成的 nextHighlights 非空
  const autoSyncedNext = !hasOverride(1) && nextHighlights.length > 0;

  const createNextTasks = useMutation({
    mutationFn: async () => {
      const monday = nextMonday();
      const titles = bulletLines(nextSectionText).filter((title) => !title.includes('暂无已安排'));
      if (!titles.length) throw new Error('请先填写下周重点工作');
      return Promise.all(titles.map((title) => api.createTask({ title, plannedDate: monday })));
    },
    onSuccess: (items) => {
      queryClient.invalidateQueries({ queryKey: qk.tasks });
      toast.success(`已创建 ${items.length} 条下周清单任务`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '创建失败'),
  });

  const resetReport = useMutation({
    mutationFn: async () => {
      if (!review) return;
      await api.resetWeeklyReport(review.weekStart.slice(0, 10));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.review(range) });
      toast.success('已恢复自动生成内容');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '重置失败'),
  });
  const anyOverride = hasOverride(0) || hasOverride(1) || hasOverride(2);

  if (isLoading || !review) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const s = review.stats;
  const label = range.label ?? '本周';
  // 周一~周日区间文本
  const ws = new Date(review.weekStart.slice(0, 10));
  const we = new Date(ws);
  we.setDate(we.getDate() + 6);
  const rangeText = `${pad2(ws.getMonth() + 1)}/${pad2(ws.getDate())}–${pad2(we.getMonth() + 1)}/${pad2(we.getDate())}`;

  function shiftWeek(delta: number) {
    const base = new Date(selMonday.slice(0, 10));
    const d = new Date(base);
    d.setDate(d.getDate() + delta * 7);
    setRange({ weekStart: keyOf(d), label: weekLabel(d) });
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">工作周报</h1>
          <p className="mt-0.5 text-sm text-ink-3">{label} · {rangeText}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {/* 上一周 / 下一周：贴合日历的 ‹ › 裸图标按钮 */}
          <div className="flex items-center gap-0.5">
            <Button
              size="xsIcon"
              variant="ghost"
              onClick={() => shiftWeek(-1)}
              aria-label="上一周"
              className="hover:bg-surface-3"
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button
              size="xsIcon"
              variant="ghost"
              onClick={() => shiftWeek(1)}
              disabled={!canGoNext}
              aria-label="下一周"
              className="hover:bg-surface-3"
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
          <button
            onClick={() => setRange({ offset: 0, label: '本周' })}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs transition-colors',
              isThisWeek ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink',
            )}
          >
            本周
          </button>
          <button
            onClick={() => setRange({ offset: 1, label: '上周' })}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs transition-colors',
              isLastWeek ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink',
            )}
          >
            上周
          </button>
          <WeekPicker
            weekStart={range.weekStart ?? null}
            onPick={(ws2) => setRange({ weekStart: ws2, label: weekLabel(new Date(ws2.slice(0, 10))) })}
          />
        </div>
      </header>

      {/* 总结句 */}
      <Card>
        <CardBody className="flex items-start gap-3 p-5">
          <TrendingUp className="mt-0.5 size-5 shrink-0 text-accent" />
          <p className="text-[15px] leading-relaxed">
            {label}完成了{' '}
            <b className="tnum neon-text">{s.completedTasks}</b>
            {' 个清单项（工作 '}
            <b className="tnum">{s.workDone}</b>
            {' · 生活 '}
            <b className="tnum">{s.lifeDone}</b>
            {s.noneDone > 0 && (
              <b className="tnum">{` · 未分组 ${s.noneDone}`}</b>
            )}
            {'），记下 '}
            <b className="tnum">{s.newNotes}</b>
            {' 条随手记、'}
            <b className="tnum">{s.newFragments}</b>
            {' 条捕获记录。'}
            {review.stagnant.length > 0 && (
              <>{'有 '}<b className="text-warn">{review.stagnant.length}</b>{' 个项目在停滞，值得看看。'}</>
            )}
            {s.completedTasks === 0 && s.newFragments === 0 && (
              <span className="text-ink-3"> 一切安静，也许该向顶部助手说点什么了。</span>
            )}
          </p>
        </CardBody>
      </Card>

      {/* 统计瓦片 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile icon={<CheckCircle2 />} value={s.completedTasks} label="完成清单" accent />
        <StatTile icon={<NotebookPen />} value={s.newNotes} label="新增随手记" />
        <StatTile icon={<AlarmClock />} value={s.newFragments} label="捕获记录" />
        <StatTile icon={<FolderKanban />} value={s.activeProjects} label="活跃项目" />
      </div>

      {/* 每日柱状图（周一~周日） */}
      <Card>
        <CardHeader><CardTitle>完成节奏</CardTitle></CardHeader>
        <CardBody className="p-5">
          <div className="flex h-40 items-end justify-between gap-2">
            {bars.map((d) => {
              const isSel = selectedDate === d.key;
              return (
                <div
                  key={d.key}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSel}
                  onClick={() => setSelectedDate((prev) => (prev === d.key ? null : d.key))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedDate((prev) => (prev === d.key ? null : d.key)); }
                  }}
                  title={`${d.date} ${d.label} · 完成 ${d.n} 项，点击查看当天明细`}
                  className={cn(
                    'group flex h-full flex-1 cursor-pointer flex-col items-center justify-end gap-1 rounded-t-md outline-none transition-colors',
                    isSel ? 'bg-accent/5 ring-1 ring-inset ring-accent/40' : 'hover:bg-surface-2',
                  )}
                >
                  <span className={cn('font-mono text-xs tnum transition-opacity', d.n ? 'text-accent opacity-90' : 'opacity-0')}>{d.n}</span>
                  <div
                    className={cn(
                      'w-full max-w-9 rounded-t-md transition-all duration-300 group-hover:brightness-125',
                      d.n ? 'bg-accent/70 shadow-[0_0_16px_-4px_var(--color-accent)]' : 'bg-surface-3',
                    )}
                    style={{ height: `${Math.max(3, (d.n / maxN) * 100)}%` }}
                  />
                  <div className="flex flex-col items-center gap-0.5 leading-none">
                    <span className={cn('font-mono text-[10px] tnum', isSel ? 'text-accent' : 'text-ink-3')}>{d.date}</span>
                    <span className={cn('text-[10px]', isSel ? 'text-accent' : 'text-ink-4')}>{d.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>

      {/* 点击柱状图某天后，原地展开当天完成事项（不打断周报阅读） */}
      {selectedDate && (() => {
        const items = tasksByDay.get(selectedDate) ?? [];
        const [yy, mm, dd] = selectedDate.split('-').map(Number);
        return (
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <CalendarRange className="size-4 text-accent" />
                  {yy}年{mm}月{dd}日 完成事项
                </CardTitle>
                <p className="mt-1 text-xs text-ink-3">共 {items.length} 项 · 点上方其他日期可切换</p>
              </div>
              <button
                type="button"
                onClick={() => navigate(`/calendar?date=${selectedDate}`)}
                className="shrink-0 text-xs text-accent transition-opacity hover:opacity-80"
              >
                在日历查看 →
              </button>
            </CardHeader>
            <CardBody className="p-0">
              {items.length === 0 ? (
                <p className="px-5 py-6 text-sm text-ink-4">这天没有完成记录。</p>
              ) : (
                <ul className="divide-y divide-line">
                  {items.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                      <CheckCircle2 className="size-4 shrink-0 text-accent" />
                      <span className="flex-1">
                        {t.title}
                        {t.project_name && <span className="ml-1.5 text-ink-4">· {t.project_name}</span>}
                      </span>
                      {t.completed_at && (
                        <span className="font-mono text-[11px] tnum text-ink-4">{t.completed_at.slice(11, 16)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        );
      })()}

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div><CardTitle className="flex items-center gap-2"><FileText className="size-4 text-accent" />工作周报</CardTitle><p className="mt-1 text-xs text-ink-3">已根据每日待办清单自动提炼重点事项</p></div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setConfigOpen(true)}><Settings2 />配置格式</Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}><Pencil />{editing ? '完成编辑' : '编辑周报'}</Button>
            <Button size="sm" variant="ghost" disabled={!anyOverride || resetReport.isPending} onClick={() => resetReport.mutate()} title="恢复为自动生成的内容"><RotateCcw />重置</Button>
            <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard.writeText(sectionTitles.map((title, i) => `${title}\n${formatSectionForCopy(overrides[i] ?? generatedReport[i])}`).join('\n\n')); toast.success('周报已复制'); }}><Copy />复制</Button>
          </div>
        </CardHeader>
        <CardBody className="divide-y divide-line p-0">
          {sectionTitles.map((title, index) => (
            <WeeklyReportSection
              key={`${title}-${index}`}
              weekStart={review.weekStart.slice(0, 10)}
              sectionIndex={index}
              title={title}
              content={overrides[index] ?? generatedReport[index]}
              hasOverride={hasOverride(index)}
              externalEditing={editing}
              queryKey={qk.review(range)}
              showNextTaskButton={index === 1 && review.isCurrentWeek}
              autoSyncedNext={index === 1 ? autoSyncedNext : false}
              nextTaskButtonDisabled={createNextTasks.isPending}
              nextTaskButtonLabel={
                index === 1 && autoSyncedNext ? '已同步下周清单' :
                index === 1 && createNextTasks.isPending ? '创建中…' : '一键创建下周清单'
              }
              nextTaskButtonVariant={index === 1 && autoSyncedNext ? 'secondary' : 'primary'}
              nextTaskButtonIcon={index === 1 && autoSyncedNext ? <Check /> : <Plus />}
              onClickNextTask={index === 1 ? () => createNextTasks.mutate() : undefined}
            />
          ))}
        </CardBody>
      </Card>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}><DialogContent title="配置周报格式" className="p-6"><h2 className="text-base font-semibold">配置周报格式</h2><p className="mt-1 text-xs text-ink-3">设置三个固定模块的标题，内容仍会按清单自动生成并分点展示。</p><div className="mt-5 space-y-3">{draftSections.map((title, i) => <label key={i} className="block"><span className="mb-1 block text-xs text-ink-3">第 {i + 1} 部分</span><input className="input-base" value={title} onChange={(e) => setDraftSections((old) => old.map((v, n) => n === i ? e.target.value : v))} /></label>)}</div><div className="mt-5 flex justify-end gap-2"><Button onClick={() => { setDraftSections(DEFAULT_SECTIONS); }}>恢复默认</Button><Button variant="primary" onClick={() => { const clean = draftSections.map((v, i) => v.trim() || DEFAULT_SECTIONS[i]); setSectionTitles(clean); localStorage.setItem('weekly-report-sections', JSON.stringify(clean)); setConfigOpen(false); toast.success('周报格式已保存'); }}><Check />保存格式</Button></div></DialogContent></Dialog>
    </div>
  );
}

/* ---------------- 周选择器（照 MonthPicker 视觉） ---------------- */
function WeekPicker({ weekStart, onPick }: { weekStart: string | null; onPick: (ws: string) => void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'months' | 'weeks'>('months');
  const [py, setPy] = useState(() => (weekStart ? new Date(weekStart.slice(0, 10)) : new Date()).getFullYear());
  const [pm, setPm] = useState(() => (weekStart ? new Date(weekStart.slice(0, 10)) : new Date()).getMonth() + 1);
  const ref = useRef<HTMLDivElement>(null);
  const today = new Date();
  const selectedMonday = weekStart ? new Date(weekStart.slice(0, 10)) : null;

  useEffect(() => {
    if (!open) {
      const d = weekStart ? new Date(weekStart.slice(0, 10)) : new Date();
      setPy(d.getFullYear());
      setPm(d.getMonth() + 1);
      setView('months');
    }
  }, [open, weekStart]);

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

  const { data: weeks } = useQuery({
    queryKey: ['review-weeks', py, pm],
    queryFn: () => api.reviewWeeks(py, pm),
    enabled: open && view === 'weeks',
  });
  const curMonday = keyOf(mondayOf(new Date()));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="选择某一周"
        className={cn(
          'flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors',
          weekStart ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink',
        )}
      >
        <CalendarRange className="size-3.5" />选周
        <ChevronDown className={cn('size-3.5 transition-transform duration-150', open && 'rotate-180 text-accent')} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="选择某一周"
          className="pop-panel absolute right-0 top-full z-30 mt-2 w-[280px] rounded-xl border border-line bg-pop p-3 shadow-[var(--pop-shadow)]"
        >
          {view === 'months' ? (
            <>
              <div className="mb-3 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setPy((y) => y - 1)}
                  aria-label="上一年"
                  className="flex size-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <ChevronsLeft className="size-4" />
                </button>
                <span className="tnum text-sm font-medium text-ink">{py} 年</span>
                <button
                  type="button"
                  onClick={() => setPy((y) => y + 1)}
                  aria-label="下一年"
                  className="flex size-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <ChevronsRight className="size-4" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {MONTH_LABELS.map((label, idx) => {
                  const m = idx + 1;
                  const isNow = py === today.getFullYear() && m === today.getMonth() + 1;
                  const isSel = selectedMonday && selectedMonday.getFullYear() === py && selectedMonday.getMonth() + 1 === m;
                  return (
                    <button
                      type="button"
                      key={label}
                      onClick={() => { setPm(m); setView('weeks'); }}
                      className={cn(
                        'relative flex h-9 items-center justify-center rounded-md text-xs font-medium transition-colors',
                        isSel
                          ? 'bg-accent text-accent-ink'
                          : isNow
                            ? 'border border-accent/40 text-accent hover:bg-accent-dim'
                            : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      {label}
                      {isNow && !isSel && <span className="absolute right-1.5 top-1.5 size-1 rounded-full bg-accent" />}
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 border-t border-line pt-2 text-[11px] text-ink-4">点月份看该月的各周 · ESC 关闭</p>
            </>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setView('months')}
                  aria-label="返回选月份"
                  className="flex size-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <span className="text-sm font-medium text-ink">{py}年{pm}月</span>
              </div>
              <div className="space-y-1">
                {(weeks ?? []).map((w) => {
                  const isSel = weekStart === w.weekStart;
                  const future = w.weekStart.slice(0, 10) > curMonday; // 未来的周还没发生，禁选
                  // 后端 fmt() 带 "T00:00:00"，剥掉时间部分再构造本地日期，避免再拼一次造成 Invalid Date
                  const wsd = new Date(w.weekStart.slice(0, 10));
                  const wed = new Date(w.weekEnd.slice(0, 10));
                  return (
                    <button
                      type="button"
                      key={w.weekN}
                      disabled={future}
                      onClick={() => { onPick(w.weekStart); setOpen(false); }}
                      className={cn(
                        'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs transition-colors',
                        future ? 'cursor-not-allowed text-ink-4/50'
                          : isSel ? 'bg-surface-3 text-ink'
                          : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      <span>第{w.weekN}周</span>
                      <span className="flex items-center gap-2">
                        {w.hasData && <span className="size-1.5 rounded-full bg-accent" aria-label="该周有完成记录" />}
                        <span className="tnum font-mono text-[10px] text-ink-4">
                          {pad2(wsd.getMonth() + 1)}/{pad2(wsd.getDate())}–{pad2(wed.getMonth() + 1)}/{pad2(wed.getDate())}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 border-t border-line pt-2 text-[11px] text-ink-4">圆点 = 该周有完成记录 · 点周即跳转</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function pickHighlights(tasks: import('@/types').Task[], limit: number) {
  return [...tasks].sort((a, b) => b.priority - a.priority || Number(Boolean(b.project_id)) - Number(Boolean(a.project_id))).slice(0, limit);
}

function taskLine(task: import('@/types').Task) { return `${task.title}${task.project_name ? `（${task.project_name}）` : ''}`; }

// 与服务端 LEADING_NUM_RE 对齐的剥序号正则：剥 `1.` `2、` `3)` `4 ` `(1)` `*` `-` `•` `（1）` 这些前缀
const LEADING_NUM_RE = /^\s*(?:\d+[.、)\s]\s*|[(*\-+•]\s*|（\s*\d+\s*）\s*)/;
function stripLeadingNumber(line: string) { return line.replace(LEADING_NUM_RE, '').trim(); }

// 把内容渲染成「1. xxx」形式（每行一个）；保留空行（如「用户心声：暂无记录」下方留白）
function formatSectionForRender(value: string) {
  const lines = value.split('\n');
  return lines.map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return line; // 保留空行
    return `${i + 1}. ${trimmed}`;
  }).join('\n');
}
// 复制时也用带序号的格式
function formatSectionForCopy(value: string) { return formatSectionForRender(value); }

function bulletLines(value: string) {
  return value.split('\n').map(stripLeadingNumber).filter(Boolean);
}

function nextMonday() { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; d.setDate(d.getDate() + add); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

/**
 * 周报单个段落：管理展示/编辑两种状态、自动保存、点击空白退出。
 * - 展示态：每行加 `1. ` 序号前缀，点击内容区进入编辑
 * - 编辑态：textarea 直接显示带序号的文本，方便用户续写；输入触发 setDraft，
 *   debounce 1.8s 自动 POST 保存到服务端（服务端会剥掉序号后入库）
 * - 编辑态：失焦 / 点击段落外部 → 退出编辑；退出前 flush 未提交的 patch
 * - 「外部 editing」（顶部"编辑周报"按钮）开启时，所有段落强制进入编辑态
 */
function WeeklyReportSection({
  weekStart, sectionIndex, title, content, hasOverride,
  externalEditing,
  queryKey,
  showNextTaskButton, autoSyncedNext,
  nextTaskButtonDisabled, nextTaskButtonLabel, nextTaskButtonVariant, nextTaskButtonIcon, onClickNextTask,
}: {
  weekStart: string;
  sectionIndex: number;
  title: string;
  content: string;
  hasOverride: boolean;
  externalEditing: boolean;
  queryKey: readonly unknown[];
  showNextTaskButton: boolean;
  autoSyncedNext: boolean;
  nextTaskButtonDisabled: boolean;
  nextTaskButtonLabel: string;
  nextTaskButtonVariant: 'primary' | 'secondary';
  nextTaskButtonIcon: React.ReactNode;
  onClickNextTask: (() => void) | undefined;
}) {
  const queryClient = useQueryClient();
  // 进入编辑时把"展示态的内容（不带序号）"转成"编辑态的初始值（带序号）"
  const renderContent = useMemo(() => formatSectionForRender(content), [content]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(renderContent);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // 外部 props 变化（切周 / 重置 / 服务端 override 变化）→ 重置本地 draft 与 editing
  useEffect(() => {
    setDraft(renderContent);
    setEditing(false);
    setSaveState('idle');
    setSavedAt(null);
  }, [renderContent, weekStart]);

  const editingActive = editing || externalEditing;

  // 自动保存：debounce 1.8s
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 跟踪"内容相对服务端的状态"：dirty 表示有未保存的改动
  const dirtyRef = useRef(false);
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;
  const weekStartRef = useRef(weekStart);
  weekStartRef.current = weekStart;

  const persistNow = useCallback(async (value: string) => {
    setSaveState('saving');
    try {
      const res = await api.saveWeeklyReport(weekStartRef.current, ['', '', value].map((v, i) => i === sectionIndex ? v : ''));
      // 局部更新缓存，避免整个 qk.review 重新请求
      queryClientRef.current.setQueryData<WeeklyReview>(queryKeyRef.current, (old) => {
        if (!old) return old;
        return { ...old, overrides: { ...old.overrides, [sectionIndex]: value } };
      });
      setSaveState('saved');
      setSavedAt(Date.now());
      dirtyRef.current = false;
      return res;
    } catch (e) {
      setSaveState('error');
      throw e;
    }
  }, [sectionIndex]);

  const scheduleSave = useCallback((value: string) => {
    dirtyRef.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('idle');
    saveTimer.current = setTimeout(() => { void persistNow(value); }, 1800);
  }, [persistNow]);

  const onChange = useCallback((next: string) => {
    setDraft(next);
    scheduleSave(next);
  }, [scheduleSave]);

  // 段落容器 ref：用于判断点击是否在内部
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // 外部 editing 开启时禁用「点空白退出」（用户在批量编辑）
  useEffect(() => {
    if (!editing || externalEditing) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        // 点外面：flush 后退出
        if (saveTimer.current) clearTimeout(saveTimer.current);
        if (dirtyRef.current) {
          void persistNow(draft).catch(() => {});
        }
        setEditing(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editing, externalEditing, draft, persistNow]);

  // 卸载 / 切周前 flush 未提交的 patch
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (dirtyRef.current) {
      // 卸载时 fire-and-forget（queryClient 可能已经卸载，乐观缓存先打上）
      queryClientRef.current.setQueryData<WeeklyReview>(queryKeyRef.current, (old) => {
        if (!old) return old;
        return { ...old, overrides: { ...old.overrides, [sectionIndex]: draft } };
      });
      void api.saveWeeklyReport(weekStartRef.current, ['', '', draft].map((v, i) => i === sectionIndex ? v : '')).catch(() => {});
    }
  }, [draft, sectionIndex]);

  // 外部 editing 由 true → false：flush
  useEffect(() => {
    if (!externalEditing && editing) {
      // 退出外部 editing：保留当前段落的局部 editing（用户主动进的）
      // 这里只 flush 一次（不退出局部）
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (dirtyRef.current) { void persistNow(draft).catch(() => {}); }
    }
  }, [externalEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  // 「已保存 N 秒前」chip 自动消失
  useEffect(() => {
    if (saveState !== 'saved') return;
    const t = setTimeout(() => setSaveState('idle'), 2500);
    return () => clearTimeout(t);
  }, [saveState, savedAt]);

  return (
    <section className="grid gap-3 p-5 md:grid-cols-[180px_1fr]">
      <div className="flex items-start gap-2">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          {sectionIndex < 2 && <p className="mt-1 text-[11px] text-ink-4">来源：待办清单</p>}
          {hasOverride && !editingActive && (
            <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-accent" title="此段落已编辑过">
              <Pencil className="size-2.5" />已编辑
            </span>
          )}
        </div>
      </div>
      <div ref={wrapRef} className="space-y-2">
        {editingActive ? (
          <div>
            <textarea
              autoFocus={editing && !externalEditing}
              className="input-base min-h-28 resize-y leading-7"
              value={draft}
              onChange={(e) => onChange(e.target.value)}
              placeholder="每行一项，输入序号会自动去掉（例如：1. xxx）"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-ink-4">
              <span>支持 1. 2、3） 等多种序号格式，保存时自动去除</span>
              <SaveStateChip state={saveState} savedAt={savedAt} />
            </div>
          </div>
        ) : (
          <div
            role="button"
            tabIndex={0}
            onClick={() => setEditing(true)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true); } }}
            title="点击进入编辑"
            className="group min-h-12 cursor-text whitespace-pre-line rounded-md px-2 py-1.5 text-sm leading-7 text-ink-2 transition-colors hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
          >
            {renderContent}
            <Pencil className="ml-1 inline size-3 align-middle text-ink-4 opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        )}
        {showNextTaskButton && (
          <div>
            <Button
              size="sm"
              variant={nextTaskButtonVariant}
              disabled={nextTaskButtonDisabled || autoSyncedNext}
              onClick={onClickNextTask}
            >
              {nextTaskButtonIcon}{nextTaskButtonLabel}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function SaveStateChip({ state, savedAt }: { state: 'idle' | 'saving' | 'saved' | 'error'; savedAt: number | null }) {
  if (state === 'idle') return null;
  if (state === 'saving') return <span className="inline-flex items-center gap-1 text-ink-3"><span className="size-1.5 animate-pulse rounded-full bg-ink-3" />自动保存中…</span>;
  if (state === 'saved') {
    const sec = savedAt ? Math.max(1, Math.round((Date.now() - savedAt) / 1000)) : 0;
    return <span className="inline-flex items-center gap-1 text-ok"><Check className="size-3" />已自动保存 {sec}s 前</span>;
  }
  return <span className="inline-flex items-center gap-1 text-warn">保存失败，重试中…</span>;
}

function StatTile({ icon, value, label, accent }: {
  icon: React.ReactNode; value: number; label: string; accent?: boolean;
}) {
  return (
    <Card className={cn('card-hover', accent && 'border-accent/20')}>
      <CardBody className="p-4">
        <div className={cn('[&_svg]:size-4', accent ? 'text-accent' : 'text-ink-4')}>{icon}</div>
        <p className={cn('mt-2 font-mono text-2xl font-semibold tnum', accent && 'neon-text')}>{value}</p>
        <p className="text-xs text-ink-3">{label}</p>
      </CardBody>
    </Card>
  );
}
