/**
 * [INPUT]: Task 与既有任务更新 API、提醒/回顾查询键
 * [OUTPUT]: TaskDocument，提供任务属性与完成反馈的文档适配
 * [POS]: 清单入口到共享详情的边界，向互斥入口注册完整保存回调；不复制编辑器、自动保存或助手浮层
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useLayoutEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, CalendarDays, Check, Clock3, FolderKanban, SquareCheckBig } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk, type TaskWrite } from '@/lib/api';
import type { Task } from '@/types';
import { cn, countdown, dayLabel, fmtDateTime } from '@/lib/utils';
import { pulseMood } from '@/store/mood';
import { DomainBadge } from '@/ui/primitives';
import { DateTimePicker } from '@/ui/datetime-picker';
import { DocumentDetail, DocumentProperty } from './DocumentDetail';
import { useDocumentSession } from './use-document-session';
import type { DetailMode } from './DetailHost';

export function TaskDocument({ task, onClose, mode = 'side', onRegisterFlush }: { task: Task; onClose: () => void; mode?: DetailMode; onRegisterFlush?: (flush: (() => Promise<void>) | null) => void }) {
  const qc = useQueryClient();
  const session = useDocumentSession({
    initial: { title: task.title, body: task.detail ?? '', status: task.status, plannedDate: task.planned_date ?? null },
    storageKey: () => `task:${task.id}`,
    persist: async (patch) => {
      const { body, ...fields } = patch;
      const write: TaskWrite = { ...fields, ...(body !== undefined ? { detail: body } : {}) };
      if (write.title !== undefined) {
        write.title = write.title.trim();
        if (!write.title) throw new Error('清单标题不能为空');
      }
      const result = await api.updateTask(task.id, write);
      void qc.invalidateQueries({ queryKey: qk.tasks });
      void qc.invalidateQueries({ queryKey: qk.mood });
      void qc.invalidateQueries({ queryKey: qk.reminders });
      void qc.invalidateQueries({ queryKey: qk.review({}) });
      qc.setQueryData(['document', 'task', task.id], result);
      if (write.status === 'done') pulseMood('tick');
      else if (write.status === 'todo') pulseMood('snooze', '先放着');
      if (write.plannedDate) toast.success(`已安排到${dayLabel(write.plannedDate)}`);
      if (write.plannedDate === null) toast.success('已取消计划日期');
    },
  });
  const flushRef = useRef(session.flush);
  flushRef.current = session.flush;
  useLayoutEffect(() => {
    onRegisterFlush?.(() => flushRef.current());
    return () => onRegisterFlush?.(null);
  }, [onRegisterFlush]);
  const done = session.value.status === 'done';
  return <DocumentDetail session={session} mode={mode} label="清单项详情" titleRequired onClose={onClose}
    context={{ kind: 'task', taskId: task.id }}
    getAssistantIdentity={async () => ({ sessionKey: `task:${task.id}`, context: { kind: 'task', taskId: task.id } })}
    getLink={() => `/documents/task/${task.id}`}
    properties={<>
      <DocumentProperty icon={SquareCheckBig} label="状态"><button className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-2"
        onClick={() => session.change({ status: done ? 'todo' : 'done' })}>
        <span className={cn('flex size-[17px] items-center justify-center rounded-[5px] border', done ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong')}>{done && <Check className="size-3" />}</span>
        {done ? '已完成' : session.value.status === 'doing' ? '进行中' : '待处理'}
      </button></DocumentProperty>
      <DocumentProperty icon={CalendarDays} label="计划日期"><DateTimePicker value={session.value.plannedDate ?? ''} dateOnly
        onChange={(value) => session.change({ plannedDate: value || null })} placeholder="未安排日期"
        className="h-8 w-[154px] border-transparent bg-transparent px-2 text-xs shadow-none hover:border-line hover:bg-surface-2" /></DocumentProperty>
    </>}
    secondaryProperties={<>
      {task.project_name && <DocumentProperty icon={FolderKanban} label="项目"><span className="flex items-center gap-1.5"><DomainBadge domain={task.project_domain} />{task.project_name}</span></DocumentProperty>}
      {task.remind_at && !done && <DocumentProperty icon={BellRing} label="提醒">{countdown(task.remind_at)}</DocumentProperty>}
      {task.due_at && !done && <DocumentProperty icon={Clock3} label="截止时间">{countdown(task.due_at)}</DocumentProperty>}
      <DocumentProperty icon={Clock3} label="创建时间">{fmtDateTime(task.created_at)}</DocumentProperty>
    </>} />;
}
