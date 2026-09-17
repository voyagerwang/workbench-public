/**
 * [INPUT]: 文档页内容、容器模式与已受保存保护的关闭回调
 * [OUTPUT]: DetailHost 及展开状态标记，嵌入、侧开和全页共用同一个 React 子树
 * [POS]: 管理尺寸、实色背景、焦点和 Escape，不持有正文或保存状态
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

// 代号重命名迁移：yao.detailPanelW -> workbench.detailPanelW（仅执行一次，避免丢失详情侧栏宽度）
try {
  if (localStorage.getItem('workbench.detailPanelW') == null && localStorage.getItem('yao.detailPanelW') != null) {
    localStorage.setItem('workbench.detailPanelW', localStorage.getItem('yao.detailPanelW')!);
    localStorage.removeItem('yao.detailPanelW');
  }
} catch { /* 隐私模式等场景下 localStorage 不可用，忽略 */ }
export type DetailMode = 'embedded' | 'side' | 'page';
export function DetailHost({ mode, expanded, children, onClose }: {
  mode: DetailMode; expanded: boolean; children: ReactNode; onClose: () => void;
}) {
  const [width, setWidth] = useState(() => {
    try { return Math.max(380, Number(localStorage.getItem('workbench.detailPanelW')) || 560); } catch { return 560; }
  });
  const drag = useRef<{ x: number; width: number } | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      if (document.querySelector('[role="menu"], [role="listbox"], [data-editor-menu], [data-table-controls], [role="dialog"]')) return;
      event.preventDefault(); latestClose.current();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (focused?.isConnected) focused.focus(); };
  }, []);
  /**
   * 侧开时点面板以外的区域即关闭——这是 Notion 式侧栏详情的既有直觉，右键「关闭」不该是唯一出路。
   * 三类点击放行：
   * 1. 日期面板 / 浮层菜单 / 模态框是 portal，DOM 上挂在 body，点了不算「外部」；
   * 2. 列表行（data-detail-opener）点下去是要换一份详情，当「关闭」处理会变成要点两次；
   * 3. 全屏展开态铺满视口，本就不存在「以外」。
   */
  useEffect(() => {
    if (mode !== 'side' || expanded) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      // 有模态框开着（提醒面板、确认框）时不判「外部」：点它的遮罩是关它，不该顺带把详情也关了
      if (document.querySelector('[role="dialog"]')) return;
      if (target.closest('[data-datetime-picker-panel], .pop-panel, [data-detail-opener], [data-table-controls], [data-editor-toolbar]')) return;
      if (section.current?.contains(target)) return;
      latestClose.current();
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [mode, expanded]);
  const content = (
    <section ref={section} aria-label="文档详情" data-document-detail data-document-expanded={expanded || undefined} className={cn(
      'flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface-1 text-ink',
      mode === 'side' && !expanded && 'fixed inset-y-0 right-0 z-50 border-l border-line shadow-2xl',
      expanded && 'fixed inset-0 z-50',
      mode !== 'side' && !expanded && 'h-full rounded-xl border border-line',
    )} style={mode === 'side' && !expanded ? { width, maxWidth: '100vw' } : undefined}>
      {mode === 'side' && !expanded && <div role="separator" aria-label="调整详情宽度" aria-orientation="vertical"
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40"
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { if (drag.current) setWidth(Math.max(320, Math.min(window.innerWidth, drag.current.width + drag.current.x - event.clientX))); }}
        onPointerUp={() => { drag.current = null; try { localStorage.setItem('workbench.detailPanelW', String(width)); } catch { /* 尺寸记忆失败不影响编辑 */ } }} />}
      {children}
    </section>
  );
  // 侧栏自始至终在同一 portal 中，展开只改 CSS，不重新挂载编辑器。
  return mode === 'side' ? createPortal(content, document.body) : content;
}
