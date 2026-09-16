/**
 * [INPUT]: 依赖 React、Portal、样式工具与全局 hover 浮层生命周期协调器
 * [OUTPUT]: 对外提供 EllipsisText、DomainBadge、Kbd、Progress、EmptyState、Skeleton、SectionTitle 等基础展示原语
 * [POS]: ui 的轻量展示组件集合；EllipsisText 负责可交互截断预览，并与其他 hover 预览保持同屏唯一
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { cn } from '@/lib/utils';
import { claimHoverLayer, releaseHoverLayer } from '@/lib/hover-layer';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 截断文本：悬停 350ms 后在元素下方浮出完整内容气泡（仅真被截断时）。
 *
 * 行为契约（用户 2026-09-04 多次明确要求）：
 * 1. 鼠标在文字上 → 350ms 后开浮窗
 * 2. 鼠标离开文字但进入浮窗 → 浮窗保持（120ms grace period）
 * 3. 鼠标离开文字且没进入浮窗 → 120ms 内关闭
 * 4. 鼠标离开浮窗 → 立即关闭
 * 5. 浮窗本身可 hover、pointer-events: auto → 内部链接（linkify 渲染的 <a>）可点击
 * 6. modal dialog fixed 覆盖时：浏览器认为鼠标坐标仍在元素 bbox 内 → onMouseLeave 不触发，
 *    所以再挂 document mousedown（capture）兜底，任何点击都能立即清掉浮窗
 */
export function EllipsisText({ children, className, title }: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const ownerRef = useRef<object>({});
  const [tip, setTip] = useState<{ content: React.ReactNode; left: number; top: number } | null>(null);

  const clearTimers = () => {
    if (showTimer.current) window.clearTimeout(showTimer.current);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  };

  useEffect(() => () => {
    clearTimers();
    releaseHoverLayer(ownerRef.current);
  }, []);

  useEffect(() => {
    if (!tip) return;
    const onDocDown = (e: MouseEvent) => {
      // 点在浮窗内（链接/选择文本）放过；其它点击（含打开 dialog）都关闭。
      if (tipRef.current && tipRef.current.contains(e.target as Node)) return;
      clearTimers();
      releaseHoverLayer(ownerRef.current);
      setTip(null);
    };
    document.addEventListener('mousedown', onDocDown, true);
    return () => document.removeEventListener('mousedown', onDocDown, true);
  }, [tip]);

  const showTip = () => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const { left, top, bottom } = el.getBoundingClientRect();
    const content = title ?? children;
    if (showTimer.current) window.clearTimeout(showTimer.current);
    showTimer.current = window.setTimeout(() => {
      const maxW = 420;
      claimHoverLayer(ownerRef.current, () => setTip(null));
      setTip({
        content,
        left: Math.max(8, Math.min(left, window.innerWidth - maxW - 12)),
        top: bottom + 6 + 40 > window.innerHeight ? Math.max(8, top - 38) : bottom + 6,
      });
    }, 350);
  };

  /** 短延时关闭，给鼠标从文字跨过 gap 进入浮窗的时间窗口 */
  const scheduleHide = () => {
    if (showTimer.current) {
      window.clearTimeout(showTimer.current);
      showTimer.current = undefined;
    }
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = undefined;
      releaseHoverLayer(ownerRef.current);
      setTip(null);
    }, 120);
  };

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={showTip}
        onMouseLeave={scheduleHide}
        className={cn('truncate', className)}
      >
        {children}
      </span>
      {tip && createPortal(
        <div
          ref={tipRef}
          onMouseEnter={() => {
            // 鼠标进入浮窗：取消任何待执行的关闭
            if (hideTimer.current) window.clearTimeout(hideTimer.current);
            if (showTimer.current) window.clearTimeout(showTimer.current);
          }}
          onMouseLeave={() => {
            releaseHoverLayer(ownerRef.current);
            setTip(null);
          }}
          className="pop-panel pointer-events-auto fixed z-[80] max-w-[420px] select-text rounded-lg border border-line px-3 py-1.5 text-xs leading-relaxed break-words shadow-lg"
          style={{ left: tip.left, top: tip.top }}
        >
          {tip.content}
        </div>,
        document.body,
      )}
    </>
  );
}

export function DomainBadge({ domain }: { domain: 'work' | 'life' | null | undefined }) {
  if (!domain) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] leading-4',
        domain === 'work'
          ? 'border-accent/25 bg-accent-dim text-accent'
          : 'border-ok/20 bg-ok/10 text-ok',
      )}
    >
      <span className="size-1 rounded-full bg-current" />
      {domain === 'work' ? '工作' : '生活'}
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-1 w-full overflow-hidden rounded-full bg-surface-3', className)}>
      <div
        className="h-full rounded-full bg-accent transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function EmptyState({ icon, title, desc, action, className }: {
  icon?: React.ReactNode;
  title: string;
  desc?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {icon && <div className="mb-1 text-ink-4 [&_svg]:size-7">{icon}</div>}
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {desc && <p className="max-w-[280px] text-xs leading-relaxed text-ink-4">{desc}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />;
}

export function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-ink-3">
      {children}
      {count !== undefined && (
        <span className="rounded-full bg-surface-2 px-1.5 py-px font-mono text-[10px] tracking-normal tnum">
          {count}
        </span>
      )}
    </h2>
  );
}
