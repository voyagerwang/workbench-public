import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Trash2 } from 'lucide-react';
import { useAssistantSessions, useAssistantHistory, type AssistantSession } from '@/store/assistant';
import { api } from '@/lib/api';
import type { SessionTaskActivity } from '@/lib/assistant-runtime';
import { cn, relTime } from '@/lib/utils';

// 纯函数，抽去 @/ 别名与 React 依赖以便 node 端单测；这里再导出，调用方仍从本模块 import。
export { resolveActiveAfterDelete } from '@/lib/session-key';

/** 首页每日陪伴用的固定会话键；独立页默认也会落到它，但它只是众多会话之一。 */
export const GLOBAL_TODAY_KEY = 'global:今天';

export type SessionRow = {
  key: string;
  title: string;
  preview: string;
  updatedAt: string;
  messageCount: number;
  actionCount: number;
  kind: 'global' | 'task' | 'document';
  refId: string | null;
  localOnly: boolean;
  /** 会话内 AI 任务活跃状态（三态圆点）；无活跃任务时为空。 */
  activity?: SessionTaskActivity;
};

export const ACTIVITY_DOT_TEXT: Record<SessionTaskActivity['state'], string> = {
  running: '任务执行中',
  attention: '有任务需要处理',
  queued: '任务排队中',
};

/** 会话圆点轮询：与任务台账解耦的轻量聚合，失败时圆点整体隐藏，不影响列表。 */
export function useSessionActivity() {
  return useQuery({
    queryKey: ['assistant-session-activity'],
    queryFn: api.sessionActivity,
    refetchInterval: 10_000,
    retry: false,
    staleTime: 5_000,
  });
}

export function contextKindFor(key: string): 'global' | 'task' | 'document' {
  if (key.startsWith('task:')) return 'task';
  if (key.startsWith('document:')) return 'document';
  return 'global';
}

/** 把会话键还原成 AssistantConversation 需要的 context。任务/文档会话带 refId，普通会话只看标题。 */
export function contextFor(
  key: string,
  remote: { kind: 'global' | 'task' | 'document'; refId: string | null; title: string } | undefined,
  local: AssistantSession | undefined,
): { kind: 'global' | 'task' | 'document'; taskId?: number; title: string } {
  const kind = remote?.kind ?? contextKindFor(key);
  const title = local?.title || remote?.title || '今天';
  if (kind === 'task') {
    const taskId = Number(remote?.refId ?? key.slice(5));
    return Number.isFinite(taskId) && taskId > 0 ? { kind: 'task', taskId, title } : { kind: 'global', title: '今天' };
  }
  if (kind === 'document') return { kind: 'document', title };
  // 普通全局会话：标题透传真实 session 标题。曾是写死 '今天'，会让所有 global 会话
  // 在对话里同名；现在稳定键（sessionKey）已与标题解耦，可安全显示真实标题。
  return { kind: 'global', title: local?.title || remote?.title || '今天' };
}

/**
 * 合并服务端索引（useAssistantHistory）与本地缓存（useAssistantSessions）的会话，
 * 按更新时间倒序。服务端为准，但本地有、服务端还没同步上去的会话也一并列出，免得用户刚打的字"消失"。
 * Dock 与独立助手页共用同一份列表，避免两边逻辑漂移。
 */
export function useSessionRows() {
  const history = useAssistantHistory((state) => state.sessions);
  const sessions = useAssistantSessions((state) => state.sessions);
  const activity = useSessionActivity();
  return useMemo<SessionRow[]>(() => {
    const remote = new Map(history.map((session) => [session.id, session]));
    const merged = new Map<string, SessionRow>();
    for (const session of history) {
      merged.set(session.id, {
        key: session.id,
        title: session.title,
        preview: `${session.messageCount} 条消息${session.actionCount ? ` · ${session.actionCount} 个动作` : ''}`,
        updatedAt: session.updatedAt,
        messageCount: session.messageCount,
        actionCount: session.actionCount,
        kind: session.kind,
        refId: session.refId,
        localOnly: false,
        activity: activity.data?.activity[session.id],
      });
    }
    for (const session of Object.values(sessions)) {
      if (remote.has(session.key)) continue;
      const last = [...session.messages].reverse().find((message) => message.role === 'user')?.content;
      if (!last && !session.input.trim()) continue; // 空会话不占位
      merged.set(session.key, {
        key: session.key,
        title: session.title,
        preview: last ?? '未发送内容',
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        actionCount: 0,
        kind: contextKindFor(session.key),
        refId: session.key.startsWith('task:') ? session.key.slice(5) : null,
        localOnly: true,
        activity: activity.data?.activity[session.key],
      });
    }
    return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [history, sessions, activity.data]);
}

export function SessionHistoryList({ rows, activeKey, onSelect, onRemove, onClose }: {
  rows: SessionRow[];
  activeKey: string;
  onSelect: (key: string, title: string) => void;
  onRemove: (row: SessionRow) => void;
  /** 移动端浮层用它收起列表；桌面常驻侧栏可不传。 */
  onClose?: () => void;
}) {
  const loading = useAssistantHistory((state) => state.loading);
  return (
    <div className="no-scrollbar flex-1 overflow-y-auto p-2">
      <div className="flex items-center justify-between px-2 py-2">
        <p className="text-xs font-medium text-ink-2">最近对话</p>
        {onClose && (
          <button type="button" onClick={onClose} className="text-[11px] text-ink-4 hover:text-ink-2">收起</button>
        )}
      </div>
      {loading && rows.length === 0 && (
        <p className="flex items-center justify-center gap-1.5 px-2 py-6 text-sm text-ink-4">
          <Loader2 className="size-3.5 animate-spin" /> 正在读取
        </p>
      )}
      {!loading && rows.length === 0 && <p className="px-2 py-6 text-center text-sm text-ink-4">还没有可继续的对话</p>}
      {rows.map((row) => (
        <div key={row.key} className={cn('group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-surface-2', row.key === activeKey && 'bg-surface-2')}>
          {row.activity && (
            <span
              aria-label={ACTIVITY_DOT_TEXT[row.activity.state]}
              title={`${ACTIVITY_DOT_TEXT[row.activity.state]}：执行中 ${row.activity.running} · 排队 ${row.activity.queued} · 待处理 ${row.activity.attention}`}
              className={cn(
                'size-2 shrink-0 rounded-full',
                row.activity.state === 'attention' && 'bg-danger',
                row.activity.state === 'running' && 'animate-pulse bg-accent',
                row.activity.state === 'queued' && 'bg-ink-4',
              )}
            />
          )}
          <button type="button" onClick={() => onSelect(row.key, row.title)} className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm text-ink">{row.title}</p>
            <p className="mt-0.5 truncate text-xs text-ink-4">
              {row.preview} · {relTime(row.updatedAt.slice(0, 19))}{row.localOnly ? ' · 仅本机' : ''}
            </p>
          </button>
          <button
            type="button"
            onClick={() => onRemove(row)}
            className="shrink-0 rounded p-1 text-ink-4 opacity-0 hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
            aria-label={`删除${row.title}`}
            title="删除历史"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
