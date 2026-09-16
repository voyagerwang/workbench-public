import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { motion } from 'motion/react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DraggableAttributes } from '@dnd-kit/core';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import { BellPlus, BellRing, Check, FileText, Flag, GripVertical, Repeat2, Trash2 } from 'lucide-react';
import { api, qk, type TaskWrite } from '@/lib/api';
import { notifyDeleted } from '@/lib/trash';
import type { Task } from '@/types';
import { cn, countdown, dayLabel } from '@/lib/utils';
import { pulseMood } from '@/store/mood';
import { DomainBadge, EllipsisText } from '@/ui/primitives';
import { Dialog, DialogContent } from '@/ui/dialog';
import { Button } from '@/ui/button';
import { DateTimePicker } from '@/ui/datetime-picker';
import { TaskDetailDialog } from '@/components/TaskDetailDialog';
import { repeatLabel } from '@/lib/utils';

export function TaskItem({ task, showProject = true, showPlannedDate = false, dragHandle }: {
  task: Task;
  showProject?: boolean;
  showPlannedDate?: boolean;
  dragHandle?: { attributes: DraggableAttributes; listeners?: SyntheticListenerMap };
}) {
  const qc = useQueryClient();
  const [remindOpen, setRemindOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const updateMut = useMutation({
    mutationFn: (b: TaskWrite) => api.updateTask(task.id, b),
    onSuccess: (_r, b) => {
      if (b.remindAt) toast.success('提醒已设');
      if (b.remindAt === null) toast.success('已清除提醒');
      if (b.plannedDate) toast.success(`已安排到${dayLabel(b.plannedDate)}`);
      if (b.plannedDate === null) toast.success('已取消计划日期');
      // 情绪球回应动作：完成=一句耳语，挪走/取消=换个神色，删除=沉一下不说话
      if (b.status === 'done') pulseMood('tick');
      else if (b.status === 'todo') pulseMood('snooze', '先放着');
      else if (b.plannedDate !== undefined) pulseMood('snooze');
      else if (b.remindAt) pulseMood('remind');
      qc.invalidateQueries({ queryKey: qk.tasks });
      qc.invalidateQueries({ queryKey: qk.mood });
      qc.invalidateQueries({ queryKey: qk.reminders });
      qc.invalidateQueries({ queryKey: qk.review({}) });
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteMut = useMutation({
    mutationFn: () => api.deleteTask(task.id),
    onSuccess: () => { notifyDeleted(qc, 'tasks', task.id, task.title); pulseMood('delete'); },
  });

  const done = task.status === 'done';
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 8 }}
      transition={{ duration: 0.18 }}
      onClick={() => setDetailOpen(true)}
      // 详情面板靠它认出「这一下是来换详情的，不是点空白关面板」，否则切换要按两次
      data-detail-opener=""
      className={cn(
        'group relative flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2',
        done && 'opacity-45',
      )}
    >
      {/* 拖拽手柄（可排序列表才渲染） */}
      {dragHandle && (
        <button
          {...dragHandle.attributes}
          {...dragHandle.listeners}
          onClick={(e) => e.stopPropagation()}
          aria-label="拖动排序"
          title="拖动排序"
          className="-ml-1 shrink-0 cursor-grab touch-none rounded p-0.5 text-ink-4 opacity-0 transition-[opacity,color] hover:text-accent group-hover:opacity-100 active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </button>
      )}

      {/* 勾选框 */}
      <button
        onClick={(e) => { e.stopPropagation(); updateMut.mutate({ status: done ? 'todo' : 'done' }); }}
        aria-label={done ? '标记未完成' : '完成'}
        className={cn(
          'flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-all',
          done ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong hover:border-accent/70',
        )}
      >
        {done && <Check className="size-3" strokeWidth={3} />}
      </button>

      {/* 标题：点击行打开右侧详情，改名在详情面板里 */}
      <EllipsisText
        className={cn(
          'min-w-0 flex-1 text-sm',
          done && 'text-ink-3 line-through decoration-ink-4',
        )}
      >
        {task.priority > 0 && !done && (
          <Flag
            className={cn('mr-1.5 inline size-3 -translate-y-px', task.priority === 2 ? 'text-danger' : 'text-warn')}
            fill="currentColor"
            strokeWidth={0}
          />
        )}
        {task.title}
      </EllipsisText>

      {/* 元信息：hover 时淡出（位置仍被占位，行高不跳动）；操作栏盖在其上方 */}
      <div className="flex shrink-0 items-center gap-2 transition-opacity duration-100 group-hover:pointer-events-none group-hover:opacity-0">
          {task.remind_at && !done && (
            <span
              className="flex items-center gap-1 font-mono text-[11px] text-accent tnum"
              title={`提醒时间 ${task.remind_at}`}
            >
              <BellRing className="size-3" />{countdown(task.remind_at)}
            </span>
          )}
          {task.due_at && !done && (
            <span className="tnum font-mono text-[11px] text-warn">{countdown(task.due_at)}</span>
          )}
          {showPlannedDate && task.planned_date && !done && (
            <span className="tnum font-mono text-[11px] text-accent">{dayLabel(task.planned_date)}</span>
          )}
          {task.repeat_rule !== 'none' && (
            <span className="flex items-center gap-1 text-[11px] text-ink-3" title={`完成后按${repeatLabel(task.repeat_rule)}生成下一期`}>
              <Repeat2 className="size-3" />{repeatLabel(task.repeat_rule)}
            </span>
          )}
          {showProject && task.project_name && (
            <span className="flex items-center gap-1 text-[11px] text-ink-3">
              <DomainBadge domain={task.project_domain} />
              <span className="max-w-[100px] truncate">{task.project_name}</span>
            </span>
          )}
      </div>

      {/* hover 操作：固定锚在行尾、延迟浮现，鼠标移入途中不会突然出现被误点；
          删除单独隔开在最右，和详情/提醒保持距离。误删可在提示里撤销或去回收站找回 */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="pointer-events-none absolute right-2 top-1/2 z-10 flex -translate-y-1/2 translate-x-1 items-center gap-0.5 rounded-lg border border-line bg-chrome/95 p-0.5 opacity-0 shadow-lg backdrop-blur transition-all duration-150 group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 group-hover:delay-[150ms]"
      >
          <button
            onClick={() => setDetailOpen(true)}
            title={task.detail ? '查看详情' : '添加详情'}
            className={cn(
              'rounded-md p-1 transition-colors hover:bg-surface-3',
              task.detail ? 'text-accent' : 'text-ink-3 hover:text-ink',
            )}
          >
            <FileText className="size-3.5" />
          </button>
          <button
            onClick={() => setRemindOpen(true)}
            title={task.remind_at ? '修改提醒' : '设提醒'}
            className={cn(
              'rounded-md p-1 transition-colors hover:bg-surface-3',
              task.remind_at ? 'text-accent' : 'text-ink-3 hover:text-ink',
            )}
          >
            {task.remind_at ? <BellRing className="size-3.5" /> : <BellPlus className="size-3.5" />}
          </button>
          {!done && (
            <DateTimePicker
              value={task.planned_date ?? ''}
              dateOnly
              iconOnly
              ariaLabel="修改计划日期"
              title="修改计划日期"
              onChange={(v) => updateMut.mutate({ plannedDate: v || null })}
              className={task.planned_date ? 'text-accent' : undefined}
              disabled={updateMut.isPending}
            />
          )}
          <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
          <button
            onClick={() => deleteMut.mutate()}
            title="删除（可在回收站找回）"
            className="ml-0.5 rounded-md p-1 text-ink-3 transition-colors hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </button>
      </div>

      {/* 弹层统一包一层阻断点击冒泡：React portal 事件会沿组件树冒回任务行，
          不阻断的话点关闭/取消会被行的 onClick 又拉起来（关了又开） */}
      <div onClick={(e) => e.stopPropagation()}>
        {/* 详情文档（Notion 式右侧面板） */}
        <TaskDetailDialog task={task} open={detailOpen} onClose={() => setDetailOpen(false)} />

        {/* 提醒设置对话框 */}
        <TaskRemindDialog
          task={task}
          open={remindOpen}
          onClose={() => setRemindOpen(false)}
          onSave={(v) => { updateMut.mutate({ remindAt: v }); setRemindOpen(false); }}
          onClear={() => { updateMut.mutate({ remindAt: null }); setRemindOpen(false); }}
        />
      </div>
    </motion.div>
  );
}

/** 可拖拽排序的 TaskItem：外层 div 承接 dnd-kit transform，避免和入场动画打架 */
export function SortableTaskItem({ task, showProject }: { task: Task; showProject?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'relative z-10')}
    >
      <TaskItem task={task} showProject={showProject} dragHandle={{ attributes, listeners }} />
    </div>
  );
}

function TaskRemindDialog({ task, open, onClose, onSave, onClear }: {
  task: Task;
  open: boolean;
  onClose: () => void;
  onSave: (v: string) => void;
  onClear: () => void;
}) {
  const defaultAt = (() => {
    if (task.remind_at) return task.remind_at.slice(0, 16);
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  })();
  const [value, setValue] = useState(defaultAt);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="清单提醒"
        className="max-w-sm"
        onPointerDownOutside={(e) => {
          // 日期时间面板通过 Portal 渲染到 body，但仍属于提醒弹窗内的交互。
          if ((e.target as HTMLElement).closest('[data-datetime-picker-panel]')) e.preventDefault();
        }}
      >
        <div className="space-y-4 p-5">
          <p className="truncate text-sm font-medium">{task.title}</p>
          <DateTimePicker
            value={open ? value : defaultAt}
            onChange={setValue}
          />
          <p className="text-xs leading-relaxed text-ink-4">
            到点弹系统通知；完成清单项后提醒自动失效
          </p>
          <div className="flex justify-end gap-2 pt-1">
            {task.remind_at && (
              <Button variant="dangerGhost" onClick={onClear}>清除提醒</Button>
            )}
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="primary" disabled={!value} onClick={() => onSave(value)}>保存</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
