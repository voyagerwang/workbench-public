import { useEffect, useState } from 'react';
import {
  Ban, Check, CheckCircle2, Clock3, Loader2, MessageSquareText, RefreshCw, ShieldAlert, TriangleAlert, Undo2, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeLarkMarkup } from '@/lib/larkMarkup';
import { isActionOpen, useAssistantDispatchPlans } from '@/store/assistant';
import type {
  AssistantActionStatus, AssistantDispatchItem, AssistantDispatchPlan, AssistantDispatchPlanStatus,
} from '@/types';
import { cn } from '@/lib/utils';
import { isWithinRecallWindow } from '@/lib/recall';

const PLAN_TONE: Record<AssistantDispatchPlanStatus, {
  icon: typeof ShieldAlert;
  label: string;
  className: string;
  description: string;
  spin?: boolean;
}> = {
  pending_confirmation: {
    icon: ShieldAlert,
    label: '发送前确认',
    className: 'border-warn/30 bg-warn/5 text-warn',
    description: '这是批量派发，请核对群、对象和内容。确认后将按下面的清单发送。',
  },
  dispatching: {
    icon: Loader2,
    label: '正在派发',
    className: 'border-accent/25 bg-accent-dim text-accent',
    description: '正在按已确认的清单发送，请稍候。',
    spin: true,
  },
  dispatched: {
    icon: CheckCircle2,
    label: '派发完成',
    className: 'border-ok/25 bg-ok/5 text-ok',
    description: '清单中的消息均已发送。需要回复的对象会继续跟踪。',
  },
  partial_failed: {
    icon: TriangleAlert,
    label: '部分未发出',
    className: 'border-warn/30 bg-warn/5 text-warn',
    description: '已发出的消息不会重复发送；可以单独重试失败项。',
  },
  failed: {
    icon: TriangleAlert,
    label: '派发失败',
    className: 'border-danger/25 bg-danger/5 text-danger',
    description: '消息没有成功发出，可以单独重试失败项。',
  },
  cancelled: {
    icon: Ban,
    label: '已取消',
    className: 'border-line bg-surface-2/60 text-ink-3',
    description: '这份派发计划已取消，没有发送。',
  },
  expired: {
    icon: Clock3,
    label: '确认已过期',
    className: 'border-line bg-surface-2/60 text-ink-3',
    description: '确认窗口已结束，这份计划没有发送。',
  },
};

const ITEM_STATUS: Record<AssistantDispatchItem['status'], { label: string; className: string }> = {
  pending: { label: '待发送', className: 'text-ink-4' },
  sending: { label: '发送中', className: 'text-accent' },
  sent: { label: '已发送', className: 'text-ok' },
  failed: { label: '发送失败', className: 'text-danger' },
  recalling: { label: '撤回中', className: 'text-warn' },
  recalled: { label: '已撤回', className: 'text-ink-4' },
};

const ACTION_STATUS: Record<AssistantActionStatus, string> = {
  dispatched: '等待回复',
  acked: '已收到',
  progress: '进行中',
  succeeded: '已有结果',
  failed: '执行失败',
  expired: '未等到结果',
};

function targetState(item: AssistantDispatchItem, target: AssistantDispatchItem['targets'][number]) {
  if (!target.expectsReply) return '仅通知';
  if (target.action) return ACTION_STATUS[target.action.status];
  return item.status === 'sent' ? '等待跟踪' : '将跟踪回复';
}

const RECALL_REFRESH_MS = 30_000;

function PlanItem({ item, planId, disabled }: { item: AssistantDispatchItem; planId: string; disabled: boolean }) {
  const retryItem = useAssistantDispatchPlans((state) => state.retryItem);
  const recallItem = useAssistantDispatchPlans((state) => state.recallItem);
  const busy = useAssistantDispatchPlans((state) => state.mutatingIds.includes(item.id));
  const itemTone = ITEM_STATUS[item.status];
  const [armed, setArmed] = useState(false);
  // 窗口只在前端做提示：渲染时读一次，再用轻量定时刷新——到期自动禁用按钮，
  // 不必逐秒倒计时。组件卸载清理 timer。服务端才是最终裁决。
  const [withinWindow, setWithinWindow] = useState(() => isWithinRecallWindow(item.sentAt, Date.now()));
  useEffect(() => {
    if (item.status !== 'sent' || !item.sentAt) return;
    const tick = () => setWithinWindow(isWithinRecallWindow(item.sentAt, Date.now()));
    tick();
    const timer = window.setInterval(tick, RECALL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [item.status, item.sentAt]);

  const retry = async () => {
    try {
      await retryItem(planId, item.id);
    } catch (error) {
      toast.error('重试失败', { description: (error as Error).message });
    }
  };

  const recall = async () => {
    setArmed(false);
    try {
      await recallItem(planId, item.id);
    } catch (error) {
      toast.error('撤回失败', { description: (error as Error).message });
    }
  };

  return (
    <div className="border-t border-line py-2.5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-2 text-[11px]">
        <MessageSquareText className="size-3.5 shrink-0 text-ink-4" />
        <span className="min-w-0 flex-1 truncate font-medium text-ink-2">
          {item.chatName ? `#${item.chatName}` : item.chatId}
        </span>
        <span className={cn('shrink-0', itemTone.className)}>{itemTone.label}</span>
      </div>

      <p className="my-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words pl-5 text-xs leading-relaxed text-ink-2">
        {sanitizeLarkMarkup(item.body)}
      </p>

      <div className="space-y-1 pl-5 text-[10px] text-ink-4">
        <p>
          {item.senderIdentity === 'user' ? '以本人身份' : '以机器人身份'}
          <span aria-hidden="true"> · </span>
          {item.format === 'markdown' ? 'Markdown' : '文本'}
        </p>
        {item.targets.length ? item.targets.map((target) => (
          <div key={target.id} className="min-w-0">
            <p className="break-words">
              <span className="text-ink-2">@{target.actorName}</span>
              <span aria-hidden="true"> · </span>
              {targetState(item, target)}
            </p>
            {target.action?.resultText && (
              <p className="mt-0.5 max-h-20 overflow-y-auto whitespace-pre-wrap break-words border-l border-line pl-2 leading-relaxed text-ink-3">
                {sanitizeLarkMarkup(target.action.resultText)}
              </p>
            )}
          </div>
        )) : <p>无 @ 对象</p>}
      </div>

      {item.lastError && (
        <p className="mt-2 break-words pl-5 text-[10px] leading-relaxed text-danger">{item.lastError}</p>
      )}

      {item.status === 'failed' && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void retry()}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-[11px] font-medium text-ink-2 transition-colors hover:border-line-strong hover:bg-surface disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {busy ? '重试中' : '重试这条'}
          </button>
        </div>
      )}

      {item.status === 'sent' && (
        <div className="mt-2 flex flex-col items-end gap-1.5">
          {armed ? (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-ink-3">确认撤回这条消息？（飞书仅允许 5 分钟内撤回）</span>
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => void recall()}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-danger px-2.5 text-[11px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
                {busy ? '撤回中' : '确认撤回'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setArmed(false)}
                className="inline-flex h-7 items-center rounded-md border border-line px-2.5 text-[11px] font-medium text-ink-3 transition-colors hover:bg-surface disabled:opacity-45"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={disabled || busy || !withinWindow}
              title={withinWindow ? '撤回这条消息' : '已超过 5 分钟撤回时限'}
              onClick={() => setArmed(true)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-[11px] font-medium text-ink-3 transition-colors hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Undo2 className="size-3" />
              撤回
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function DispatchPlanCard({ plan }: { plan: AssistantDispatchPlan }) {
  const confirm = useAssistantDispatchPlans((state) => state.confirm);
  const cancel = useAssistantDispatchPlans((state) => state.cancel);
  const mutating = useAssistantDispatchPlans((state) => state.mutatingIds.includes(plan.id));
  const error = useAssistantDispatchPlans((state) => state.errorById[plan.id]);
  const tone = PLAN_TONE[plan.status];
  const Icon = tone.icon;
  const pendingConfirmation = plan.status === 'pending_confirmation';
  const expiry = plan.expiresAt ? new Date(plan.expiresAt) : null;
  const locallyExpired = expiry ? expiry.getTime() <= Date.now() : false;

  const run = async (operation: 'confirm' | 'cancel') => {
    try {
      await (operation === 'confirm' ? confirm(plan.id) : cancel(plan.id));
    } catch (caught) {
      toast.error(operation === 'confirm' ? '确认发送失败' : '取消失败', {
        description: (caught as Error).message,
      });
    }
  };

  return (
    <section className={cn('w-full overflow-hidden rounded-lg border', tone.className)} aria-live="polite">
      <div className="px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn('size-4 shrink-0', tone.spin && 'animate-spin')} />
          <span className="min-w-0 flex-1 text-xs font-semibold text-ink">{tone.label}</span>
          <span className="shrink-0 text-[10px] text-ink-4">
            {plan.itemCount} 条 · {plan.chatCount} 个群
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
          {pendingConfirmation
            ? `将发送 ${plan.itemCount} 条消息到 ${plan.chatCount} 个群，涉及 ${plan.targetCount} 个对象。${tone.description}`
            : tone.description}
        </p>
        {pendingConfirmation && expiry && (
          <p className="mt-1 flex items-center gap-1 text-[10px] text-ink-4">
            <Clock3 className="size-3 shrink-0" />
            {locallyExpired ? '正在更新确认状态' : `${expiry.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 前有效`}
          </p>
        )}
      </div>

      <div className="border-y border-line bg-surface/45 px-3 py-2.5">
        {plan.items.map((item) => (
          <PlanItem key={item.id} item={item} planId={plan.id} disabled={mutating} />
        ))}
      </div>

      {(plan.lastError || error) && (
        <div className="flex items-start gap-1.5 border-b border-line px-3 py-2 text-[10px] leading-relaxed text-danger">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          <span className="min-w-0 break-words">{error || plan.lastError}</span>
        </div>
      )}

      {pendingConfirmation && (
        <div className="flex flex-wrap items-center justify-end gap-2 bg-surface/30 px-3 py-2.5">
          <button
            type="button"
            disabled={mutating}
            onClick={() => void run('cancel')}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs font-medium text-ink-3 transition-colors hover:border-line-strong hover:bg-surface hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
          >
            <X className="size-3.5" />取消
          </button>
          <button
            type="button"
            disabled={mutating || locallyExpired}
            onClick={() => void run('confirm')}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-ink transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {mutating ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {mutating ? '处理中' : '确认发送'}
          </button>
        </div>
      )}
    </section>
  );
}

/** 按消息上的 plan id 恢复动态状态；只有等待确认/正在派发时才持续轮询。 */
export function DispatchPlanCards({ ids }: { ids: string[] }) {
  const plans = useAssistantDispatchPlans((state) => state.plans);
  const loadingIds = useAssistantDispatchPlans((state) => state.loadingIds);
  const errors = useAssistantDispatchPlans((state) => state.errorById);
  const refresh = useAssistantDispatchPlans((state) => state.refresh);
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  const key = uniqueIds.join(',');
  const tracked = uniqueIds.map((id) => plans[id]).filter(Boolean);
  const hasChangingPlan = tracked.some((plan) =>
    plan.status === 'pending_confirmation'
    || plan.status === 'dispatching'
    || plan.items.some((item) => item.targets.some((target) => isActionOpen(target.action ?? undefined))));

  useEffect(() => {
    if (key) void refresh(key.split(','));
  }, [key, refresh]);

  useEffect(() => {
    if (!hasChangingPlan) return;
    const timer = window.setInterval(() => void refresh(uniqueIds), 15_000);
    return () => window.clearInterval(timer);
  }, [hasChangingPlan, key, refresh]);

  if (!uniqueIds.length) return null;
  return (
    <div className="mt-1 w-full space-y-1.5">
      {uniqueIds.map((id) => {
        const plan = plans[id];
        if (plan) return <DispatchPlanCard key={id} plan={plan} />;
        if (loadingIds.includes(id)) {
          return (
            <div key={id} className="flex min-h-16 items-center gap-2 rounded-lg border border-line bg-surface-2/50 px-3 text-xs text-ink-3">
              <Loader2 className="size-3.5 animate-spin text-accent" />正在读取派发计划
            </div>
          );
        }
        return (
          <div key={id} className="flex min-h-16 items-center gap-2 rounded-lg border border-danger/25 bg-danger/5 px-3 text-xs text-danger">
            <TriangleAlert className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{errors[id] || '派发计划暂时无法读取'}</span>
            <button
              type="button"
              onClick={() => void refresh([id])}
              aria-label="重新读取派发计划"
              title="重新读取"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-surface hover:text-ink"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
