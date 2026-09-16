// 极简下拉菜单：触发器 + portal 浮层，点外部或 Esc 关闭。
// 为什么用 portal：提醒卡片在列表里层层嵌套，就地 absolute 容易被祖先裁掉。
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export type MenuItem = {
  key: string;
  label: string;
  hint?: string;
  onSelect: () => void;
  tone?: 'default' | 'danger';
};

export function MenuButton({ children, items, title, width = 176, className, disabled }: {
  children: React.ReactNode;
  items: MenuItem[];
  title?: string;
  width?: number;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const rect = open ? anchor.current?.getBoundingClientRect() : undefined;
  const style = rect
    ? {
        width,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        // 下方放不下就翻到上方，估算一个菜单高度即可，不追求像素级
        top: rect.bottom + 6 + 200 > window.innerHeight ? Math.max(8, rect.top - 6 - 160) : rect.bottom + 6,
      }
    : undefined;

  return (
    <>
      <button
        ref={anchor}
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={className}
      >
        {children}
      </button>
      {open && style && createPortal(
        <div ref={box} role="menu" style={style} className="pop-panel fixed z-[70] rounded-lg border border-line p-1 shadow-lg">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); item.onSelect(); }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors',
                item.tone === 'danger' ? 'text-danger hover:bg-danger/10' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
              )}
            >
              <span className="flex-1 truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-[10px] text-ink-4">{item.hint}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
