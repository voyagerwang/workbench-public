import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Bell, History, MessageCircle, X } from 'lucide-react';
import { toast } from 'sonner';
import { AssistantConversation } from '@/components/AssistantConversation';
import {
  GLOBAL_TODAY_KEY, SessionHistoryList, contextFor, resolveActiveAfterDelete, useSessionRows,
} from '@/components/SessionHistory';
import { useAssistantName } from '@/lib/assistant-name';
import { cn } from '@/lib/utils';
import {
  useAssistantActions, useAssistantSessions, useAssistantHistory,
} from '@/store/assistant';

const GLOBAL_KEY = GLOBAL_TODAY_KEY;

export function AssistantDock() {
  const { pathname } = useLocation();
  const petName = useAssistantName();
  const sessions = useAssistantSessions((state) => state.sessions);
  const ensure = useAssistantSessions((state) => state.ensure);
  const removeLocal = useAssistantSessions((state) => state.remove);
  const history = useAssistantHistory((state) => state.sessions);
  const refreshHistory = useAssistantHistory((state) => state.refresh);
  const removeRemote = useAssistantHistory((state) => state.remove);
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeKey, setActiveKey] = useState(GLOBAL_KEY);
  const unreadIds = useAssistantActions((state) => state.unreadIds);
  const refreshUnread = useAssistantActions((state) => state.refreshUnread);
  const markRead = useAssistantActions((state) => state.markRead);

  // 打开抽屉时拉一次服务端索引：这是会话持久化之后唯一能翻到别处对话的入口。
  useEffect(() => {
    if (historyOpen) void refreshHistory();
  }, [historyOpen, refreshHistory]);

  // 未读数独立于会话列表：机器人在别处回了结果，不开对话也该知道。
  // 服务端每 30s 扫一次群，这里同频就够，再快也只是多打空请求。
  useEffect(() => {
    void refreshUnread();
    const timer = window.setInterval(() => void refreshUnread(), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshUnread]);

  const rows = useSessionRows();
  const rootRef = useRef<HTMLDivElement>(null);

  // 展开时点击面板/助手以外的空白区域即收起：对着对话框之外点一下就能关，不用再去找关闭键。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const hasAny = rows.length > 0;
  const openWith = () => {
    setOpen(true);
    if (unreadIds.length) void markRead();
  };

  // 首页/独立助手页已有自己的对话入口，全局 Dock 不再出现。
  if (pathname === '/' || pathname === '/assistant') return null;

  // 助手按「点开 / 再点收起」切换：展开时浮标留在面板下方继续当切换键，
  // 收起时只在有未读或已有对话时出现，避免在空白页凭空挂一个按钮。
  const toggle = () => {
    if (open) setOpen(false);
    else openWith();
  };

  const showFloating = open || unreadIds.length > 0 || hasAny;
  if (!showFloating) return null;

  const activeRemote = history.find((session) => session.id === activeKey);
  const activeSession = sessions[activeKey];
  const activeContext = contextFor(activeKey, activeRemote, activeSession);

  const floating = (
    <button
      type="button"
      onClick={toggle}
      aria-label={open ? '收起对话' : '展开对话'}
      title={open ? '收起对话' : '展开对话'}
      className={cn(
        'flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-xs shadow-xl backdrop-blur-md transition-colors',
        open || unreadIds.length
          ? 'border border-accent/45 bg-surface-1/95 text-ink hover:border-accent/70'
          : 'border border-accent/25 bg-surface-1/95 text-ink-2 hover:border-accent/50 hover:text-ink',
      )}
    >
      {open ? (
        <MessageCircle className="size-3.5 text-accent" />
      ) : unreadIds.length ? (
        <span className="relative flex items-center">
          <Bell className="size-3.5 text-accent" />
          <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-danger" />
        </span>
      ) : (
        <MessageCircle className="size-3.5 text-accent" />
      )}
      {!open && (unreadIds.length ? `${unreadIds.length} 个结果回来了` : hasAny ? `继续与${petName}对话` : null)}
      {!open && hasAny && !unreadIds.length && (
        <span className="rounded-full bg-accent-dim px-1.5 py-0.5 text-[10px] text-accent">{rows.length}</span>
      )}
    </button>
  );

  return (
    <div ref={rootRef} className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      {open && (
        <div className="w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line-strong bg-surface-1/95 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
            <MessageCircle className="size-4 text-accent" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{activeSession?.title || activeRemote?.title || `与${petName}对话`}</span>
            <button type="button" onClick={() => setHistoryOpen((value) => !value)} className={cn('rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink', historyOpen && 'bg-surface-2 text-accent')} aria-label="最近对话" title="最近对话">
              <History className="size-3.5" />
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="收起对话" title="收起对话">
              <X className="size-3.5" />
            </button>
          </div>
          {historyOpen ? (
            <SessionHistoryList
              rows={rows}
              activeKey={activeKey}
              onSelect={(key, title) => {
                ensure(key, title);
                setActiveKey(key);
                setHistoryOpen(false);
              }}
              onRemove={async (row) => {
                try {
                  // 远端优先：远端删失败时不让本地先进入「假成功」，避免删不掉的会话凭空消失。
                  if (!row.localOnly) await removeRemote(row.key);
                  removeLocal(row.key);
                  const remaining = rows.filter((r) => r.key !== row.key);
                  setActiveKey(
                    resolveActiveAfterDelete(activeKey, row.key, remaining, () => {
                      const key = `global:对话-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
                      ensure(key, '新对话');
                      return key;
                    }),
                  );
                } catch (error) {
                  toast.error('删除失败', { description: (error as Error).message });
                }
              }}
              onClose={() => setHistoryOpen(false)}
            />
          ) : (
            <div className="p-3">
              {/* 传稳定键：选中任意 global:对话-* 后读写都进各自 key，不再落回 global:今天 */}
              <AssistantConversation compact context={activeContext} sessionKey={activeKey} onClose={() => setOpen(false)} />
            </div>
          )}
        </div>
      )}
      {floating}
    </div>
  );
}
