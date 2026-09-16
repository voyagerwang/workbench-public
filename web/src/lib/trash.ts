// 删除的统一出口：toast 带撤销动作，撤销走回收站 restore
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { MODULE_LABEL } from '@/lib/triage';
import type { FragmentDeleteResult, FragmentType, TrashType } from '@/types';

const MODULE_TRASH: Record<FragmentType, TrashType> = { task: 'tasks', note: 'notes', reminder: 'reminders' };

/** 删除成功后调用：弹「已删除 + 撤销」提示（保留 30 天，可在回收站找回） */
export function notifyDeleted(qc: QueryClient, type: TrashType, id: number, name?: string): void {
  toast.success('已删除', {
    description: name
      ? `${name} · 已进回收站，30 天内可找回`
      : '已进回收站，30 天内可找回',
    duration: 8000,
    action: {
      label: '撤销',
      onClick: () => {
        api.restoreTrash(type, id)
          .then(() => {
            toast.success('已撤销');
            qc.invalidateQueries();
          })
          .catch((e: Error) => toast.error(e.message));
      },
    },
  });
  qc.invalidateQueries();
}

/**
 * 删除分发记录专用：默认连它分发出去的条目一起进回收站，撤销时一并还原；
 * 目标条目被改过时服务端会保留它，这里给一个「一起删掉」的补刀入口。
 */
export function notifyFragmentDeleted(
  qc: QueryClient,
  fragId: number,
  result: FragmentDeleteResult,
  deleteAnyway: () => void,
): void {
  if (result.kept.length > 0) {
    const kept = result.kept[0];
    toast.info(`分发记录已删 · ${MODULE_LABEL[kept.module]}里那条留着`, {
      description: `${kept.title} · ${kept.reason}`,
      duration: 9000,
      action: { label: '一起删掉', onClick: deleteAnyway },
    });
    qc.invalidateQueries();
    return;
  }

  const gone = result.removed;
  toast.success(gone.length ? `已删除 · ${gone.map((g) => MODULE_LABEL[g.module]).join('、')}里的那条也收进了回收站` : '已删除', {
    description: gone.length ? '点撤销会连分发记录一起放回原处，30 天内也能在回收站找回' : '已进回收站，30 天内可找回',
    duration: 8000,
    action: {
      label: '撤销',
      onClick: () => {
        const jobs = [api.restoreTrash('fragments', fragId), ...gone.map((g) => api.restoreTrash(MODULE_TRASH[g.module], g.id))];
        Promise.allSettled(jobs)
          .then(() => {
            toast.success('已放回原处');
            qc.invalidateQueries();
          })
          .catch((e: Error) => toast.error(e.message));
      },
    },
  });
  qc.invalidateQueries();
}
