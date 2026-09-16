/**
 * [INPUT]: 服务端助手会话与运行态 API
 * [OUTPUT]: 助手页面编排，对话历史与任务记忆面板
 * [POS]: 工作台助手界面与服务端契约的接线层
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { History, MessageCirclePlus } from 'lucide-react';
import { toast } from 'sonner';
import { AssistantRuntimePanel } from '@/components/AssistantRuntimePanel';
import { AssistantConversation } from '@/components/AssistantConversation';
import {
  GLOBAL_TODAY_KEY, SessionHistoryList, contextFor, resolveActiveAfterDelete, useSessionRows,
} from '@/components/SessionHistory';
import { useAssistantSessions, useAssistantHistory } from '@/store/assistant';
import { cn } from '@/lib/utils';

/**
 * 独立助手页（方向 A：真·聊天产品）。
 * 不再硬编码 global:今天，而是持有「稳定会话键」在多个会话间切换 / 新开；
 * 默认落到最近一次对话，global:今天 只是列表里的一个普通条目。
 * 从提示词「在助手运行」跳过来时，草稿进入独立的新会话，保留之前的讨论。
 */
export function AssistantView() {
  const [pageParams] = useSearchParams();
  const linkedSession = pageParams.get('session');
  const rows = useSessionRows();
  const historySessions = useAssistantHistory((state) => state.sessions);
  const refreshHistory = useAssistantHistory((state) => state.refresh);
  const removeRemote = useAssistantHistory((state) => state.remove);
  const localSessions = useAssistantSessions((state) => state.sessions);
  const ensure = useAssistantSessions((state) => state.ensure);
  const removeLocal = useAssistantSessions((state) => state.remove);

  const [activeKey, setActiveKey] = useState(GLOBAL_TODAY_KEY);
  const [showRuntime, setShowRuntime] = useState(false);
  const [showList, setShowList] = useState(false);
  const [mountedSkills, setMountedSkills] = useState<Array<{id:string;name:string}>>([]);
  const didInit = useRef(false);

  // 进入页面拉一次服务端索引：这是能翻到过往对话的唯一来源。
  useEffect(() => {
    const raw = sessionStorage.getItem('assistant-skill'); if (raw) { try { const skill=JSON.parse(raw); if(typeof skill.id==='string'&&typeof skill.name==='string'){setMountedSkills([skill]); const key=`global:${crypto.randomUUID()}`; useAssistantSessions.getState().ensure(key,'新对话'); didInit.current=true; setActiveKey(key);} } catch {} sessionStorage.removeItem('assistant-skill'); }
  }, []);
  const removeSkill = (id: string) => setMountedSkills((items) => items.filter((s) => s.id !== id));
  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  // 成果链接定位到已有会话；服务端确认存在后才切换，不能由 URL 冒造会话。
  useEffect(() => {
    if (!linkedSession) return;
    let live = true;
    didInit.current = true;
    void api.assistantSession(linkedSession).then(({session}) => {
      if (!live) return;
      ensure(session.id, session.title);
      setMountedSkills([]);
      setActiveKey(session.id);
    }).catch(() => { if (live) toast.error('链接中的会话不存在或暂时无法读取，请从最近对话选择。'); });
    return () => { live = false; };
  }, [linkedSession, ensure]);

  // 首屏默认打开最近一段对话（聊天产品的常规预期），之后不再覆盖用户的主动切换。
  useEffect(() => {
    if (didInit.current || rows.length === 0) return;
    setActiveKey(rows[0].key);
    didInit.current = true;
  }, [rows]);

  // 提示词启动是独立目标，建立新对话；不污染之前的讨论。
  useEffect(() => {
    const draft = sessionStorage.getItem('assistant-draft');
    if (draft) {
      sessionStorage.removeItem('assistant-draft');
      const key = `global:${crypto.randomUUID()}`;
      useAssistantSessions.getState().ensure(key, '新对话');
      useAssistantSessions.getState().update(key, { input: draft });
      didInit.current = true;
      setActiveKey(key);
    }
  }, []);

  const activeRemote = historySessions.find((session) => session.id === activeKey);
  const activeLocal = localSessions[activeKey];
  const context = useMemo(
    () => contextFor(activeKey, activeRemote, activeLocal),
    [activeKey, activeRemote, activeLocal],
  );

  const mintKey = () => `global:${crypto.randomUUID()}`;

  const startNew = () => {
    setMountedSkills([]);
    const key = mintKey();
    ensure(key, '新对话');
    didInit.current = true;
    setActiveKey(key);
    setShowList(false);
  };

  const selectSession = (key: string, title: string) => {
    setMountedSkills([]);
    ensure(key, title);
    setActiveKey(key);
    setShowList(false);
  };

  const removeSession = async (row: { key: string; localOnly: boolean }) => {
    try {
      // 远端优先：远端删失败时不让本地先进入「假成功」，避免删不掉的会话凭空消失。
      if (!row.localOnly) await removeRemote(row.key);
      removeLocal(row.key);
      // 原子切换：删当前→落到最近剩余；删成最后一个→建新会话；删非当前→当前不变。
      const remaining = rows.filter((r) => r.key !== row.key);
      if(row.key===activeKey)setMountedSkills([]);
      const next = resolveActiveAfterDelete(activeKey, row.key, remaining, () => {
        const key = mintKey();
        ensure(key, '新对话');
        return key;
      });
      setActiveKey(next);
    } catch (error) {
      toast.error('删除失败', { description: (error as Error).message });
    }
  };

  return (
    // 助手页要全屏贴边：AppShell 给所有页面套了 md:px-8 md:py-8 (32px) padding，
    // 流式页面看着自然，但助手页 height 撑满视口后会显得"卡片嵌在卡片里"。
    // 用 -mx-8 -my-8 + 同步 100vh 抵消这个 padding：
    //   子 top (相对视口) = wrapper top edge + (-my-8) - py-8 = 0（贴顶）
    //   子 height = 100vh（贴底）
    //   侧栏 pl-56 (224px) 不动，-mx-8 只让子元素横向扩到 main content area 边缘（与侧栏右缘齐平）
    // mobile 多扣 3.5rem (56px) 给 sticky header。
    <div className="-mx-4 -my-6 flex h-[calc(100dvh-3.5rem)] min-h-0 md:-mx-8 md:-my-8 md:h-[100vh]">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface-1/40 md:flex">
        <div className="flex items-center gap-2 border-b border-line px-3 py-3">
          <span className="text-sm font-medium text-ink">助手</span>
          <button
            type="button"
            onClick={startNew}
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2 text-[11px] font-medium text-accent-ink transition-opacity hover:opacity-90"
          >
            <MessageCirclePlus className="size-3.5" /> 新开对话
          </button>
        </div>
        <SessionHistoryList
          rows={rows}
          activeKey={activeKey}
          onSelect={selectSession}
          onRemove={removeSession}
        />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 md:px-4">
          <button
            type="button"
            onClick={() => setShowList((value) => !value)}
            className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink md:hidden"
            aria-label="对话列表"
            title="对话列表"
          >
            <History className="size-4" />
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
            {activeLocal?.title || activeRemote?.title || '助手'}
          </span>
          <button type="button" aria-expanded={showRuntime} onClick={() => setShowRuntime((v) => !v)} className="rounded-md border border-line px-2 py-1 text-xs text-ink-2">{showRuntime ? '收起任务与记忆' : '任务与记忆'}</button>
          {/* 移动端顶栏常驻「新开对话」：桌面侧栏已有按钮，移动端浮层列表里没有，必须这里补 */}
          <button
            type="button"
            onClick={startNew}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[11px] font-medium text-ink-2 transition-colors hover:border-accent/40 hover:text-accent md:hidden"
            aria-label="新开对话"
            title="新开对话"
          >
            <MessageCirclePlus className="size-3.5" /> 新开对话
          </button>
        </div>

        {showRuntime && <AssistantRuntimePanel key={activeKey} sessionKey={activeKey} />}

        {showList && (
          <div className="border-b border-line md:hidden">
            <SessionHistoryList
              rows={rows}
              activeKey={activeKey}
              onSelect={selectSession}
              onRemove={removeSession}
              onClose={() => setShowList(false)}
            />
          </div>
        )}

        <div className={cn('flex min-h-0 flex-1 flex-col')}>
        <AssistantConversation context={context} sessionKey={activeKey} autoFocus fullPage mountedSkills={mountedSkills} onRemoveSkill={removeSkill} />
        </div>
      </main>
    </div>
  );
}
