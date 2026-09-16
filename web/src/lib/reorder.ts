// 拖拽重排的乐观更新：先改本地缓存再落库，失败回滚
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qk } from '@/lib/api';
import type { Task } from '@/types';

/** 把 ids 的新顺序套到全量任务缓存上（不在 ids 里的保持相对位置不变） */
function applyOrder(list: Task[], ids: number[]): Task[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  return list
    .map((t) => (rank.has(t.id) ? { ...t, sort_order: rank.get(t.id)! } : t))
    .sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return 0;
    });
}

export function useTaskReorder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => api.reorderTasks(ids),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: qk.tasks });
      const prev = qc.getQueryData<Task[]>(qk.tasks);
      qc.setQueryData<Task[]>(qk.tasks, (old) => applyOrder(old ?? [], ids));
      return { prev };
    },
    onError: (_e, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.tasks, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.tasks }),
  });
}
