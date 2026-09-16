/**
 * [INPUT]: 清单项、列表打开状态与全局详情互斥协调器
 * [OUTPUT]: TaskDetailDialog 兼容既有入口，同屏只挂载一个清单详情
 * [POS]: 切换前排空旧文档保存和上传；失败保留旧详情
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { Task } from '@/types';
import { taskDetailOwner } from '@/lib/task-detail-owner';
import { TaskDocument } from '@/components/document/TaskDocument';
export function TaskDetailDialog({ task, open, onClose }: { task: Task; open: boolean; onClose: () => void }) {
  return open ? <OpenTaskDetail key={task.id} task={task} onClose={onClose} /> : null;
}
function OpenTaskDetail({ task, onClose }: { task: Task; onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const [owner] = useState(() => ({ flush: async () => { await flushRef.current?.(); }, close: () => closeRef.current() }));
  const active = useSyncExternalStore(taskDetailOwner.subscribe, taskDetailOwner.getSnapshot);
  const registerFlush = useCallback((flush: (() => Promise<void>) | null) => { flushRef.current = flush; }, []);
  useEffect(() => {
    void taskDetailOwner.open(owner).catch((error) => toast.error(`未切换详情：${error instanceof Error ? error.message : '保存失败'}`));
    return () => taskDetailOwner.release(owner);
  }, [owner]);
  return active === owner ? <TaskDocument task={task} onClose={onClose} onRegisterFlush={registerFlush} /> : null;
}
