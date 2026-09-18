/**
 * [INPUT]: 服务端助手会话与运行态 API
 * [OUTPUT]: 助手会话渲染，展示真实写入凭证与动态任务卡
 * [POS]: 工作台助手界面与服务端契约的接线层
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp, BellRing, Check, Copy, CopyCheck, FileInput, FileText, Image as ImageIcon, Loader2, NotebookPen, RotateCcw, SquareCheckBig, TriangleAlert, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/ui/button';
import { Dialog, DialogContent } from '@/ui/dialog';
import { RichContentPreview } from '@/components/RichContentPreview';
import { AgentTaskCards } from '@/components/AssistantRuntimePanel';
import { DispatchPlanCards } from '@/components/DispatchPlanCard';
import { captureSummary, invalidateTriage, targetChips, targetRoute, type ChipTone } from '@/lib/triage';
import { useAssistantName } from '@/lib/assistant-name';
import { sanitizeLarkMarkup } from '@/lib/larkMarkup';
import {
  useAssistantSessions, useAssistantActions, useAssistantDispatchPlans, isActionOpen, toEntry,
} from '@/store/assistant';
import type {
  AssistantAction, AssistantActionStatus, AssistantContext, AssistantMessage, CaptureResult, CorrelationMethod,
  FragmentType,
} from '@/types';
import { cn } from '@/lib/utils';

const TYPE_ICON: Record<FragmentType, typeof NotebookPen> = {
  note: NotebookPen,
  task: SquareCheckBig,
  reminder: BellRing,
};

const CHIP_TONE: Record<ChipTone, string> = {
  accent: 'bg-accent-dim text-accent',
  ok: 'bg-ok/10 text-ok',
  warn: 'bg-warn/10 text-warn',
  muted: 'bg-surface-2 text-ink-3',
};

/**
 * 关联方式的中文名。
 *
 * 这几个词是给用户看「这条回音是靠什么认出来的」，可信度差别很大：
 * 话题直查和艾特匹配是对方明确指向我，按位置推断是「群里只有这一个待办」的猜测。
 * 用映射表而不是三元链，是为了新增方法时不会漏改——漏了就会静默显示成最弱的那档。
 */
const CORRELATION_LABEL: Record<CorrelationMethod, string> = {
  thread_reply: '话题直查',
  mention_match: '艾特匹配',
  unique_pending_actor: '按位置推断',
  manual: '人工标记',
  quiescence: '持续跟踪',
};

/** 历史消息里残留的「已挂载提示词」标记：只用于展示，不再支持手动挂载（是否用提示词/Skill 由助手自己判断）。 */
function visibleMessage(content: string) {
  const match = content.match(/^【已调用(提示词| Skill)：(.+?)】\n[\s\S]*?\n\n【用户请求】\n([\s\S]*)$/);
  return match ? { mounted: `${match[2]}`.trim(), content: match[3] } : { mounted: '', content };
}

/**
 * 落库凭证卡：内容全部来自服务端返回的 captured（真实写库结果），
 * 跟模型的自然语言回答是两条独立链路——模型说没说"记下了"都不影响这张卡。
 */
function ReceiptCard({ receipt, onOpen }: { receipt: CaptureResult; onOpen: (path: string) => void }) {
  const items = receipt.items ?? [];
  if (!items.length) return null;
  return (
    <div className="rounded-xl border border-ok/25 bg-ok/10 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Check className="size-3.5 shrink-0 text-ok" strokeWidth={3} />
        <p className="text-xs font-medium text-ink">已记 {items.length} 条</p>
        <span className="min-w-0 truncate text-[10px] text-ink-3">{captureSummary(receipt)}</span>
      </div>

      <div className="space-y-0.5">
        {items.map((item) => {
          const Icon = TYPE_ICON[item.type];
          return (
            <button
              key={item.fragmentId}
              type="button"
              onClick={() => onOpen(targetRoute(item.type, item.target))}
              title="点进去看看"
              className="flex w-full flex-wrap items-baseline gap-x-1.5 gap-y-1 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-surface-2"
            >
              <Icon className="size-3 shrink-0 translate-y-px text-ink-4" />
              <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-ink-2">{item.content}</span>
              {targetChips(item.target, item.type).map((chip) => (
                <span key={chip.text} className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none', CHIP_TONE[chip.tone])}>
                  {chip.text}
                </span>
              ))}
            </button>
          );
        })}
      </div>

      <p className="mt-1.5 border-t border-line pt-1.5 text-[10px] leading-relaxed text-ink-4">
        记错了就说一句，比如「第三条改成明天下午三点」「刚记的都删掉」
      </p>
    </div>
  );
}

const ACTION_TONE: Record<AssistantActionStatus, { chip: string; icon: typeof Check; label: string; spin?: boolean }> = {
  dispatched: { chip: 'bg-surface-2 text-ink-3', icon: Loader2, label: '已派发·等回应', spin: true },
  acked: { chip: 'bg-warn/10 text-warn', icon: Loader2, label: '对方已收到·进行中', spin: true },
  progress: { chip: 'bg-accent-dim text-accent', icon: Loader2, label: '有进展·继续等', spin: true },
  succeeded: { chip: 'bg-ok/10 text-ok', icon: Check, label: '有结果了' },
  failed: { chip: 'bg-danger/10 text-danger', icon: TriangleAlert, label: '失败了' },
  expired: { chip: 'bg-surface-2 text-ink-3', icon: TriangleAlert, label: '没等到结果' },
};

/**
 * 派单回音卡。
 *
 * 两条硬规矩体现在 UI 上：
 * 1. 状态只由服务端抓到的真实回复推进，没抓到就是「没等到结果」，绝不显示"已完成"。
 * 2. **原始回复永远展示**——分类器认没认出终态只影响上面那个标签，
 *    机器人到底说了什么用户自己能看见，不会被分类器挡住。
 */
function ActionCard({ action, onResolve, onRetry }: {
  action: AssistantAction;
  onResolve?: (status: 'succeeded' | 'failed') => void;
  onRetry?: (id: string) => Promise<{ resent: boolean }>;
}) {
  const tone = ACTION_TONE[action.status] ?? ACTION_TONE.dispatched;
  const Icon = tone.icon;
  const open = isActionOpen(action);
  const [retrying, setRetrying] = useState(false);
  // 只有「确认没发出去」的动作才给重发：outboundMessageId 为空 = 飞书没回消息 id。
  // 已发出的绝不二发——后端会拦 409，这里只是把提示语抛给用户。
  const canRetry = !action.outboundMessageId && !!onRetry;
  const handleRetry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      const { resent } = await onRetry(action.id);
      if (!resent) toast('这条已经发出去了，不需要重发');
    } catch (error) {
      toast.error('重发失败', { description: (error as Error).message });
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon className={cn('size-3.5 shrink-0', tone.chip.split(' ')[1], tone.spin && 'animate-spin')} />
        <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none', tone.chip)}>{tone.label}</span>
        <span className="min-w-0 truncate text-[10px] text-ink-3">
          {action.chatName ? `#${action.chatName}` : '飞书'}
          {action.targetActorName ? ` · @${action.targetActorName}` : ''}
        </span>
      </div>

      <p className="mb-1.5 break-words text-xs leading-relaxed text-ink-2">{sanitizeLarkMarkup(action.summary)}</p>

      {action.resultText && (
        <pre className="mb-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-surface px-2 py-1.5 text-[11px] leading-relaxed text-ink-2">
          {sanitizeLarkMarkup(action.resultText)}
        </pre>
      )}

      <div className="flex items-center gap-2 border-t border-line pt-1.5 text-[10px] text-ink-4">
        <span>
          {action.status === 'expired'
            ? '盯了 30 分钟没等到结果'
            : action.status === 'dispatched'
              ? '后台每 30 秒查一次群里的回复'
              : `关联方式：${CORRELATION_LABEL[action.correlation ?? 'quiescence']}`}
        </span>
        {onResolve && (
          <button
            type="button"
            onClick={() => onResolve('succeeded')}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-ink-3 transition-colors hover:bg-surface hover:text-ink"
          >
            {open ? '标记已完成' : '改判'}
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            disabled={retrying}
            onClick={() => void handleRetry()}
            className="shrink-0 rounded px-1.5 py-0.5 text-ink-3 transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
          >
            {retrying ? '重发中…' : '重发'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 一条消息派出去的所有动作。
 * 单独成组件是因为要用到 hook——在消息循环里直接调 hook 会违反 Hook 规则。
 */
function ActionCards({ ids }: { ids: string[] }) {
  const resolve = useAssistantActions((state) => state.resolve);
  const retry = useAssistantActions((state) => state.retry);
  // 新链路的 child action 由 Plan 卡按 target 展示；这里仅保留历史 action，避免同一派单出现两张卡。
  const tracked = useActionWatcher(ids).filter((action) => !action.dispatchItemId);
  if (!tracked.length) return null;
  return (
    <div className="mt-1 w-full space-y-1.5">
      {tracked.map((action) => (
        <ActionCard
          key={action.id}
          action={action}
          onResolve={(status) => { void resolve(action.id, status); }}
          onRetry={(id) => retry(id)}
        />
      ))}
    </div>
  );
}

/** 有待跟踪的派单时才起轮询；没有待办就完全不打网络。 */
function useActionWatcher(actionIds: string[]) {
  const actions = useAssistantActions((state) => state.actions);
  const refresh = useAssistantActions((state) => state.refresh);
  const tracked = actionIds.map((id) => actions[id]).filter(Boolean);
  const hasOpen = tracked.some(isActionOpen);
  const key = actionIds.join(',');

  useEffect(() => {
    if (!key) return;
    void refresh(key.split(','));
  }, [key, refresh]);

  useEffect(() => {
    if (!hasOpen) return;
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [hasOpen, refresh]);

  return tracked;
}

export function AssistantConversation({
  context,
  autoFocus = false,
  compact = false,
  fullPage = false,
  className,
  onClose,
  onInsert,
  /** 稳定会话键（= 服务端 id）。传入后本地存储与服务端落库都以此为准，标题改名也不会让 key 漂移。不传则回退按标题推导（首页/Dock 旧行为）。 */
  sessionKey,
  mountedSkills = [], onRemoveSkill,
}: {
  context: AssistantContext;
  autoFocus?: boolean;
  compact?: boolean;
  fullPage?: boolean;
  className?: string;
  onClose?: () => void;
  onInsert?: (content: string) => void;
  sessionKey?: string;
  mountedSkills?: Array<{id:string;name:string}>; onRemoveSkill?: (id:string)=>void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const petName = useAssistantName();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  // stickRef：用户是否还贴在底部。往上翻看历史时置 false，新消息就不再强行拽回去。
  const stickRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  // 优先用显式稳定键：新开对话时标题会被服务端自动改写，若按标题推导 key 会漂移、查到空会话。
  const contextKey = sessionKey
    ?? (context.taskId
      ? `${context.kind}:${context.taskId}`
      : `${context.kind}:${context.title ?? ''}`);
  const session = useAssistantSessions((state) => state.sessions[contextKey]);
  const ensureSession = useAssistantSessions((state) => state.ensure);
  const updateSession = useAssistantSessions((state) => state.update);
  const hydrateSession = useAssistantSessions((state) => state.hydrate);
  const input = session?.input ?? '';
  const messages = session?.messages ?? [];
  const [pending, setPending] = useState(false);
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const [resendConfirm, setResendConfirm] = useState(false);
  // 待发送的图片：选完/粘贴后先本地预览，真正发送时再上传到服务端取回 /api/files 地址。
  const [pendingImages, setPendingImages] = useState<Array<{ id: string; file: File; preview: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 把文件/剪贴板里的图片加入待发送列表（本地预览，发送时才上传）。 */
  const addImages = (files: File[]) => {
    const next = files
      .filter((file) => file.type.startsWith('image/'))
      .map((file) => ({
        id: `img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        file,
        preview: URL.createObjectURL(file),
      }));
    if (next.length) setPendingImages((prev) => [...prev, ...next]);
  };

  const removeImage = (id: string) => {
    setPendingImages((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((item) => item.id !== id);
    });
  };

  // 卸载时回收没发出去的预览对象 URL，避免内存泄漏。
  useEffect(() => () => { pendingImages.forEach((item) => URL.revokeObjectURL(item.preview)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** 上传待发送图片，返回服务端 /api/files 地址。任一上传失败都抛错（由调用方 toast）。 */
  const uploadPendingImages = async (): Promise<string[]> => {
    if (!pendingImages.length) return [];
    return Promise.all(pendingImages.map(async (item) => {
      const res = await api.uploadFile(item.file);
      return res.url;
    }));
  };

  useEffect(() => {
    ensureSession(contextKey, context.title || '未命名对话');
  }, [contextKey, context.title, ensureSession]);

  // 会话存在服务端：进入时以服务端记录覆盖本地缓存，刷新/换浏览器都是同一份对话。
  // 依赖里只放 needsHydration 这个布尔值——放 session 对象会导致每敲一个字都重新拉一次。
  const needsHydration = session ? !session.seeded : false;
  useEffect(() => {
    if (!session || !needsHydration) return;
    void hydrateSession(contextKey);
  }, [contextKey, needsHydration, hydrateSession]);

  useEffect(() => {
    if (autoFocus) window.setTimeout(() => inputRef.current?.focus(), 40);
  }, [autoFocus]);

  // 输入框随内容长高，空着时占满整块面板，点哪儿都能打字。
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const filled = messages.length > 0 || pending;
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, filled ? 44 : 132), 200)}px`;
  }, [input, messages.length, pending]);

  // 判断当前是否贴底（离底 < 80px 算贴底）
  const stickToBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  // 贴底滚动：双 rAF 等浏览器把这一轮内容/图片的布局算完再量 scrollHeight，
  // 否则会在 Markdown 渲染、图片异步加载还没结束时量到偏小的高度，smooth 滚到「旧底部」就停，永远差一截。
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    rafRef.current = window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node && stickRef.current) node.scrollTo({ top: node.scrollHeight, behavior: 'auto' });
    }));
  };

  // 新消息 / 等待态变化：重新贴底
  useEffect(() => {
    scrollToBottom();
  }, [messages.length, pending]);

  // 内容高度变化（Markdown 渲染、图片异步加载、输入框长高挤出空间）都要重新贴底。
  // 同时 observe 滚动容器自身：输入框长高会改它的可视高度，也需要重新对齐。
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => scrollToBottom());
    ro.observe(el);
    if (content) ro.observe(content);
    return () => ro.disconnect();
  }, [messages.length]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
  }, []);

  /**
   * 真正走网络发一条用户消息。
   * 成功时以服务端返回的权威记录替换掉本地 temp 消息，并清掉 loadError；
   * 失败时 toast 并触发 hydrate 重新对齐。
   */
  const sendRequest = async (request: string, tempId: string, seed?: AssistantMessage[], images?: string[]) => {
    setPending(true);
    try {
      const result = await api.assistantChat(request, context, contextKey, seed, mountedSkills.map((s) => s.id), images);
      // 服务端已经写库，本地缓存必须跟着刷新，否则清单/随手记里看不到刚记的东西。
      if (result.captured) invalidateTriage(qc);
      // 以服务端返回的权威记录为准：丢掉刚才那条乐观气泡，换成带 id 的真记录。
      const current = useAssistantSessions.getState().sessions[contextKey]?.messages ?? [];
      updateSession(contextKey, {
        messages: [...current.filter((entry) => entry.tempId !== tempId), ...result.appended.map(toEntry)],
        ...(result.session ? { title: result.session.title } : {}),
        seeded: true,
        serverBacked: true,
        loadError: undefined,
      });
      void qc.invalidateQueries({ queryKey: ['assistant-agent-tasks'] });
      void qc.invalidateQueries({ queryKey: ['assistant-memory'] });
      void qc.invalidateQueries({ queryKey: ['assistant-usage'] });
      if (result.plans.length) useAssistantDispatchPlans.getState().put(result.plans);
      // 本轮有新派单时立刻把状态拉下来，别让用户等第一个 15 秒
      if (result.actions?.length) void useAssistantActions.getState().refresh();
      return result;
    } catch (error) {
      toast.error((error as Error).message);
      // 用户在输入框里的话服务端可能已经记下了（先落库再调模型），重新对齐一次，
      // 免得界面上留下一条「未同步」但其实已经入库的消息。
      void hydrateSession(contextKey);
      throw error;
    } finally {
      setPending(false);
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  };

  const submit = async (preset?: string) => {
    const request = (preset ?? input).trim();
    // 纯文字或纯图片都能发：没有文字但有待发图片时也放行。
    if ((!request && pendingImages.length === 0) || pending) return;
    const tempId = `tmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let imageUrls: string[] = [];
    if (pendingImages.length) {
      try {
        imageUrls = await uploadPendingImages();
      } catch (error) {
        toast.error('图片上传失败', { description: (error as Error).message });
        return;
      }
    }
    // 历史由服务端持有，这里只发这一轮的新消息。首次发送时把本地缓存带上去补种一次，
    // 让升级前存在浏览器里的老会话不至于在服务端失忆。补种只认有正文的消息——纯图片消息
    // 没有正文，会被 seed 的 zod schema 拒掉，而且它本来就会走正常 appendMessage 落库，无需补种。
    const seed = session && !session.seeded
      ? messages
        .filter((entry) => entry.content.trim())
        .map(({ role, content, images }): AssistantMessage => ({ role, content, ...(images?.length ? { images } : {}) }))
        .slice(-40)
      : undefined;
    updateSession(contextKey, {
      messages: [...messages, { role: 'user', content: request, ...(imageUrls.length ? { images: imageUrls } : {}), tempId }],
      input: '',
    });
    setPendingImages([]);
    try {
      await sendRequest(request, tempId, seed, imageUrls);
    } catch { /* toast 与 hydrate 已在 sendRequest 里处理 */ }
  };

  /** 重试一条没同步成功的用户消息（只有最后一条才给入口，避免中间消息乱序）。 */
  const retryMessage = async (index: number) => {
    const target = messages[index];
    if (!target || target.role !== 'user' || !target.tempId || pending) return;
    const request = target.content;
    const images = target.images;
    const tempId = `tmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    // 把旧 temp 消息换成新的 tempId，发送成功后服务端记录会自然覆盖它
    updateSession(contextKey, {
      messages: [...messages.slice(0, index), { role: 'user', content: request, ...(images?.length ? { images } : {}), tempId }],
    });
    try {
      await sendRequest(request, tempId, undefined, images);
    } catch { /* toast 与 hydrate 已在 sendRequest 里处理 */ }
  };

  /**
   * 最后一轮是否已经落了库 / 派了活。
   * 重跑会重新走一遍完整链路，上一轮记下的条目不会跟着撤销——先跟用户确认，别让他事后才发现重复。
   */
  const lastTurnHasSideEffects = () => {
    const current = useAssistantSessions.getState().sessions[contextKey]?.messages ?? [];
    const lastUser = current.map((entry) => entry.role).lastIndexOf('user');
    if (lastUser < 0) return false;
    return current.slice(lastUser).some((entry) => Boolean(
      entry.planIds?.length || entry.actionIds?.length || entry.agentTaskIds?.length || entry.receipt?.items?.length,
    ));
  };

  /** 重新发送 / 重新生成最后一轮：服务端原地重跑，不新开会话。 */
  const resendLast = async () => {
    if (pending) return;
    setPending(true);
    try {
      const result = await api.assistantResend(contextKey);
      if (result.captured) invalidateTriage(qc);
      // 服务端已经把这轮退回去重写了，本地把旧那一轮摘掉换成新两条（id 都是新的）
      const current = useAssistantSessions.getState().sessions[contextKey]?.messages ?? [];
      const lastUser = current.map((entry) => entry.role).lastIndexOf('user');
      updateSession(contextKey, {
        messages: [...(lastUser >= 0 ? current.slice(0, lastUser) : current), ...result.appended.map(toEntry)],
        ...(result.session ? { title: result.session.title } : {}),
        seeded: true,
        serverBacked: true,
        loadError: undefined,
      });
      void qc.invalidateQueries({ queryKey: ['assistant-agent-tasks'] });
      void qc.invalidateQueries({ queryKey: ['assistant-memory'] });
      void qc.invalidateQueries({ queryKey: ['assistant-usage'] });
      if (result.plans.length) useAssistantDispatchPlans.getState().put(result.plans);
      if (result.actions?.length) void useAssistantActions.getState().refresh();
    } catch (error) {
      toast.error('重发失败', { description: (error as Error).message });
      // 服务端可能已经把旧那一轮截掉了，跟服务端重新对齐，别让界面上留着一轮并不存在的回答
      void hydrateSession(contextKey);
    } finally {
      setPending(false);
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  };

  const copyMessage = async (key: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessage(key);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedMessage(null), 1600);
    } catch {
      toast.error('复制失败，请检查剪贴板权限');
    }
  };

  const focusInput = (event: React.MouseEvent<HTMLElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest('button, select, input, textarea, a, [data-keep-focus]')) return;
    inputRef.current?.focus();
  };

  // 用户手动滚动时实时更新贴底状态：往上翻看历史就不强拽，滚回底部再恢复自动贴底
  const handleScroll = () => { stickRef.current = stickToBottom(); };

  const hasConversationContent = messages.length > 0 || pending;
  // 只有最后一轮给重发入口：中间那条重发会把其后的对话一起丢掉，服务端也只接受最后一轮。
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');

  return (
    <section
      onClick={focusInput}
      className={cn(
        // 不再自带卡片框：整块就是聊天流，嵌入头部/弹窗时不会「框套框」
        'assistant-conversation flex min-h-0 cursor-text flex-col overflow-hidden',
        // 整页模式撑满父容器高度；否则沿用嵌入态的 max-h 上限（compact 更矮）
        fullPage ? 'h-full' : compact ? 'max-h-[min(440px,70vh)]' : 'max-h-[min(560px,72vh)]',
        className,
      )}
      aria-label={`与${petName}对话`}
    >
      {/* 拉历史失败以前是静默的，界面只剩空白，用户分不清「本来就没消息」和「没读上来」。
          现在用警告色（非危险）轻量提示，并提供重试。 */}
      {session?.loadError && (
        <div role="alert" className="mb-1 flex items-center gap-1.5 rounded-lg border border-warn/20 bg-warn/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warn">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">历史没读上来：{session.loadError}</span>
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-warn/20"
            onClick={() => void hydrateSession(contextKey)}
          >重试</button>
        </div>
      )}
      {hasConversationContent && <div ref={scrollRef} onScroll={handleScroll} className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-1">
        <div ref={contentRef} className="space-y-3">
        {messages.map((message, index) => {
          const visible = visibleMessage(message.content);
          const messageKey = `${message.role}-${index}`;
          return (
          <div key={messageKey} className={cn('group flex flex-col', message.role === 'user' ? 'items-end' : 'items-start')}>
            <div className={cn(
              'min-w-0 text-sm leading-relaxed',
              message.role === 'user'
                ? 'max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3 py-2 text-accent-ink'
                // 助手段无气泡会糊成长段：黑曜石霓虹的层级靠「发丝线边框 + 表面阶梯」不靠透明度——
                // 单纯 surface-1/40 在日间主题下与 canvas 色差 < 4 阶看不出，
                // 必须配合 bg-surface-1（纯白）+ border-line 才有「块」的边界感。
                // 圆角与下方 ReceiptCard / ActionCard 的 rounded-xl 内容块语言保持一致。
                : 'max-w-full rounded-xl border border-line bg-surface-1 px-3.5 py-2.5 text-ink',
            )}>
                {visible.mounted && <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-ink-4"><FileText className="size-3" />已调用 {visible.mounted}</div>}
                {/* 用户随消息发的图片：随文字一起展示，点击新标签打开原图 */}
                {message.images?.length ? (
                  <div className="mb-1.5 flex flex-wrap gap-1.5">
                    {message.images.map((src, i) => (
                      <a
                        key={i}
                        href={src}
                        target="_blank"
                        rel="noreferrer"
                        className={cn('block overflow-hidden rounded-lg', message.role === 'user' ? 'border border-white/25' : 'border border-line')}
                      >
                        <img src={src} alt="" className="h-28 w-28 object-cover" />
                      </a>
                    ))}
                  </div>
                ) : null}
                {/* 助手会回 Markdown（标题/列表/表格）：走安全渲染；用户消息保持纯文本 */}
                {message.role === 'assistant'
                  ? <RichContentPreview markdown={visible.content} fallback={visible.content} className="text-ink" />
                  : visible.content}
            </div>

            <div className={cn(
              'mt-1 flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100',
              message.role === 'user' && 'justify-end',
            )}>
              <button
                type="button"
                onClick={() => void copyMessage(messageKey, visible.content)}
                aria-label={copiedMessage === messageKey ? '已复制' : '复制消息'}
                title={copiedMessage === messageKey ? '已复制' : '复制'}
                className="flex size-6 items-center justify-center rounded-md text-ink-4 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                {copiedMessage === messageKey ? <CopyCheck className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
              </button>
              {message.role === 'assistant' && onInsert && (
                <button
                  type="button"
                  onClick={() => onInsert(message.content)}
                  aria-label="插入当前文档"
                  title="插入当前文档"
                  className="flex size-6 items-center justify-center rounded-md text-ink-4 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <FileInput className="size-3.5" />
                </button>
              )}
              {/* 临时消息给重试入口：只有最后一条才点得到，避免中间消息乱序重发 */}
              {message.tempId && message.role === 'user' && index === messages.length - 1 && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void retryMessage(index)}
                  aria-label="重新发送"
                  title="这条没发出去，点击重试"
                  className="flex size-6 items-center justify-center rounded-md text-warn transition-colors hover:bg-warn/10 hover:text-warn disabled:opacity-40"
                >
                  <RotateCcw className={cn('size-3.5', pending && 'animate-spin')} />
                </button>
              )}
              {/* 重发只给最后一轮：这是聊天产品的通行做法——最后一条原地重跑，中间那条属于「分叉新会话」 */}
              {!message.tempId && (index === lastUserIndex || (index === messages.length - 1 && message.role === 'assistant')) && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => { if (lastTurnHasSideEffects()) setResendConfirm(true); else void resendLast(); }}
                  aria-label={message.role === 'user' ? '重新发送' : '重新生成'}
                  title={message.role === 'user' ? '重新发送这条（不新开会话）' : '重新生成这条回答'}
                  className="flex size-6 items-center justify-center rounded-md text-ink-4 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
                >
                  <RotateCcw className="size-3.5" />
                </button>
              )}
            </div>

            {/* 凭证卡独立于回答渲染：模型的话术不能代表落库结果 */}
            {message.receipt && (
              <div className="mt-1 w-full">
                <ReceiptCard receipt={message.receipt} onOpen={(path) => { navigate(path); onClose?.(); }} />
              </div>
            )}

            {message.receiptError && (
              <div className="mt-1 flex w-full items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-2.5 py-2 text-[11px] leading-relaxed text-danger">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                <span>{message.receiptError}</span>
              </div>
            )}

            {message.agentTaskIds?.length ? <div className="w-full"><AgentTaskCards ids={message.agentTaskIds} /></div> : null}

            {/* 原子派发计划：消息只保存 id，动态状态进入页面后从服务端恢复。 */}
            {message.planIds?.length ? <div className="w-full"><DispatchPlanCards ids={message.planIds} /></div> : null}

            {/* 历史派单回音：新 Plan 的 child action 由上面的目标行展示，不重复渲染。 */}
            {message.actionIds?.length ? <div className="w-full"><ActionCards ids={message.actionIds} /></div> : null}
          </div>
          );
        })}

        {pending && (
          <div className="flex items-center gap-2 text-xs text-ink-3">
            <Loader2 className="size-3.5 animate-spin text-accent" /> {petName}正在处理…
          </div>
        )}
        </div>
      </div>}

      {/* 重发会重跑整条链路，上一轮已落库的条目不会跟着撤回：有副作用就先问一声 */}
      <Dialog open={resendConfirm} onOpenChange={(open) => !open && setResendConfirm(false)}>
        <DialogContent title="重新发送" className="max-w-sm">
          <div className="space-y-3 p-5">
            <p className="text-sm text-ink">最后一轮已经记过东西或派过任务。</p>
            <p className="text-xs leading-relaxed text-ink-4">
              重新发送只重跑这一轮对话，已经写进工作台的清单 / 随手记 / 提醒不会自动撤销。
              若重跑后又记了一遍，重复项需要你自己去对应页面删掉。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setResendConfirm(false)}>取消</Button>
              <Button variant="primary" onClick={() => { setResendConfirm(false); void resendLast(); }}>仍然重发</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="relative flex shrink-0 flex-col border-t border-line/50 px-3.5 pb-2 pt-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) addImages(Array.from(event.target.files));
            event.target.value = '';
          }}
        />
        {mountedSkills.length > 0 && <div className="mb-2 flex gap-2">{mountedSkills.map((s) => <span key={s.id} className="rounded-full bg-accent-dim px-2 py-1 text-xs">{s.name} <button onClick={() => onRemoveSkill?.(s.id)} aria-label={`移除${s.name}`}>×</button></span>)}</div>}
        {/* 待发送图片预览：发送前可逐张删除；真正发送时才上传到服务端 */}
        {pendingImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingImages.map((img) => (
              <div key={img.id} className="group/img relative size-16 overflow-hidden rounded-lg border border-line">
                <img src={img.preview} alt="" className="size-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  aria-label="移除图片"
                  className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover/img:opacity-100"
                >
                  <X className="size-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) => updateSession(contextKey, { input: event.target.value })}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
            if (files.length) { event.preventDefault(); addImages(files); }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && onClose) { event.preventDefault(); onClose(); return; }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={1}
          placeholder="想聊什么？可发送图片"
          className="w-full resize-none bg-transparent pt-1 text-sm leading-6 text-ink outline-none placeholder:text-ink-4"
        />

        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[10px] text-ink-4">Enter 发送 · Shift+Enter 换行 · 可发送图片</p>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="发送图片"
              title="发送图片"
              className="flex size-7 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <ImageIcon className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={(!input.trim() && pendingImages.length === 0) || pending}
              aria-label="发送"
              className="flex size-7 items-center justify-center rounded-full bg-accent text-accent-ink transition-all hover:brightness-110 disabled:opacity-30"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
