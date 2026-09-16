import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence } from 'motion/react';
import { AlertTriangle, ArrowLeft, CalendarClock, CheckCircle2, PlayCircle, Plus, Trash2 } from 'lucide-react';
import { api, qk } from '@/lib/api';
import { notifyDeleted } from '@/lib/trash';
import type { Project } from '@/types';
import { todayStr } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Input, Select } from '@/ui/form';
import { DomainBadge, EmptyState, Progress, SectionTitle } from '@/ui/primitives';
import { TaskItem } from '@/components/TaskItem';

export function ProjectDetail() {
  const { id } = useParams();
  const pid = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [newTask, setNewTask] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: project } = useQuery({ queryKey: [...qk.projects, pid], queryFn: api.projects });
  const { data: tasks } = useQuery({ queryKey: qk.tasks, queryFn: api.tasks });

  const cur = useMemo(() => (project ?? []).find((p) => p.id === pid), [project, pid]);
  const taskList = useMemo(() => (tasks ?? []).filter((t) => t.project_id === pid), [tasks, pid]);

  const board = useMemo(() => {
    const today = todayStr();
    const columns = {
      todo: [] as typeof taskList,
      doing: [] as typeof taskList,
      done: [] as typeof taskList,
      overdue: [] as typeof taskList,
    };

    for (const task of taskList) {
      if (task.status === 'done') {
        columns.done.push(task);
        continue;
      }
      const plannedDay = task.planned_date ?? task.due_at?.slice(0, 10) ?? null;
      if (plannedDay && plannedDay < today) columns.overdue.push(task);
      else if (plannedDay === today) columns.doing.push(task);
      else columns.todo.push(task);
    }

    const byPriority = (a: typeof taskList[number], b: typeof taskList[number]) => b.priority - a.priority || b.id - a.id;
    columns.todo.sort((a, b) => (a.planned_date ?? a.due_at ?? '9999').localeCompare(b.planned_date ?? b.due_at ?? '9999') || byPriority(a, b));
    columns.doing.sort(byPriority);
    columns.overdue.sort((a, b) => (a.planned_date ?? a.due_at ?? '').localeCompare(b.planned_date ?? b.due_at ?? '') || byPriority(a, b));
    columns.done.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
    return columns;
  }, [taskList]);

  const doneTasks = board.done;
  const total = taskList.length;
  const pct = total ? Math.round((doneTasks.length / total) * 100) : 0;

  const createMut = useMutation({
    mutationFn: () => api.createTask({ title: newTask.trim(), projectId: pid }),
    onSuccess: () => { setNewTask(''); qc.invalidateQueries({ queryKey: qk.tasks }); },
  });
  const patchMut = useMutation({
    mutationFn: (b: Partial<Project>) => api.updateProject(pid, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects }),
  });
  const deleteMut = useMutation({
    mutationFn: () => api.deleteProject(pid),
    onSuccess: () => {
      notifyDeleted(qc, 'projects', pid, cur?.name);
      navigate('/projects');
    },
  });

  if (!cur && project) {
    return <EmptyState icon={<ArrowLeft />} title="项目不存在" action={<Link to="/projects"><Button size="sm" variant="secondary">返回项目</Button></Link>} />;
  }

  return (
    <div className="space-y-6">
      {/* 头部 */}
      <header className="space-y-4">
        <Link to="/projects" className="inline-flex items-center gap-1 text-xs text-ink-3 transition-colors hover:text-accent">
          <ArrowLeft className="size-3" /> 全部项目
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
              {cur?.name}
              <DomainBadge domain={cur?.domain} />
            </h1>
            {cur?.description && <p className="text-sm text-ink-3">{cur.description}</p>}
          </div>
          <div className="flex items-center gap-1.5">
            <Select
              value={cur?.status}
              onChange={(e) => patchMut.mutate({ status: e.target.value as Project['status'] })}
              className="h-8 w-auto py-0 text-xs"
            >
              <option value="active">进行中</option>
              <option value="paused">已暂停</option>
              <option value="done">已完成</option>
              <option value="archived">已归档</option>
            </Select>
            {!confirmDelete ? (
              <Button size="icon" variant="dangerGhost" title="删除项目" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
              </Button>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-danger">
                确认删除？
                <Button size="sm" variant="dangerGhost" onClick={() => deleteMut.mutate()}>确认</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>取消</Button>
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Progress value={pct} className="max-w-md flex-1" />
          <span className="tnum font-mono text-xs text-ink-3">{doneTasks.length}/{total} · {pct}%</span>
        </div>
      </header>

      {/* 添加任务 */}
      <Input
        value={newTask}
        onChange={(e) => setNewTask(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && newTask.trim() && createMut.mutate()}
        placeholder="+ 添加清单项到这个项目，回车确认"
        className="border-dashed bg-transparent focus:bg-surface-2"
      />

      {/* 项目看板：按计划日期和完成状态分列，方便快速判断下一步动作 */}
      <section className="space-y-2">
        <SectionTitle count={taskList.length}>事项看板</SectionTitle>
        {taskList.length === 0 ? (
          <EmptyState
            icon={<Plus />}
            title="还没有清单项"
            desc="把这个项目拆解成一件件小事"
            className="py-8"
          />
        ) : (
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <TaskBoardColumn title="待开始" subtitle="日期未到或未排期" icon={<CalendarClock />} tone="muted" tasks={board.todo} />
            <TaskBoardColumn title="进行中" subtitle="计划在今天" icon={<PlayCircle />} tone="accent" tasks={board.doing} />
            <TaskBoardColumn title="已完成" subtitle="已标记完成" icon={<CheckCircle2 />} tone="ok" tasks={board.done} />
            <TaskBoardColumn title="已逾期" subtitle="日期已过，尚未完成" icon={<AlertTriangle />} tone="warn" tasks={board.overdue} />
          </div>
        )}
      </section>
    </div>
  );
}

function TaskBoardColumn({ title, subtitle, icon, tone, tasks }: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  tone: 'muted' | 'accent' | 'ok' | 'warn';
  tasks: import('@/types').Task[];
}) {
  const toneClass = {
    muted: 'text-ink-3 bg-surface-2/70',
    accent: 'text-accent bg-accent-dim',
    ok: 'text-ok bg-ok/10',
    warn: 'text-warn bg-warn/10',
  }[tone];

  return (
    <section className="flex min-h-[220px] min-w-0 flex-col rounded-xl border border-line bg-surface-1">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${toneClass}`}>
            {icon}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{title}</h3>
            <p className="truncate text-[11px] text-ink-4">{subtitle}</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-3 tnum">{tasks.length}</span>
      </header>
      <div className="flex-1 p-1.5">
        {tasks.length === 0 ? (
          <div className="flex min-h-[150px] items-center justify-center px-4 text-center text-xs text-ink-4">暂无事项</div>
        ) : (
          <div className="divide-y divide-line/60">
            <AnimatePresence initial={false}>
              {tasks.map((task) => (
                <div key={task.id} className="py-0.5">
                  <TaskItem task={task} showProject={false} showPlannedDate />
                </div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </section>
  );
}
