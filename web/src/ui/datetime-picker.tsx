// Element Plus 风格的日期时间选择器（React 手写版，匹配 YZ 工作台主题令牌）
// 触发器：只读按钮样式（年/月/日 --:-- 占位，hover 可清空）
// 面板：左侧月历 + 右侧时/分滚动列（点选即时生效，无确认按钮），fixed 定位自适应上下翻转
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const p2 = (n: number) => String(n).padStart(2, '0');
const PANEL_W = 288;        // 仅日期模式面板宽
const DT_PANEL_W = 408;     // 日期时间模式：日历 + 右侧时/分列
const PANEL_H = 352;
const DATE_PANEL_H = 300;
const TIME_COL_H = 248;     // 时/分滚动列可视高度
const TIME_ITEM_H = 30;     // 列项高度 h-7(28) + gap(2)
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

type YMD = { y: number; mo: number; d: number };

/** 时/分滚动列：点选即时生效，打开时自动滚到当前选中值 */
function TimeColumn({ items, selected, unit, onSelect }: {
  items: number[];
  selected: number;
  unit: string;
  onSelect: (n: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, selected * TIME_ITEM_H - el.clientHeight / 2 + TIME_ITEM_H / 2);
  }, [selected]);
  return (
    <div className="flex flex-col items-center">
      <span className="mb-1 text-[10px] leading-3.5 text-ink-4">{unit}</span>
      <div ref={listRef} style={{ height: TIME_COL_H }} className="w-10 overflow-y-auto rounded-md [scrollbar-width:thin]">
        {items.map((n) => (
          <button
            key={n}
            onClick={() => onSelect(n)}
            className={cn(
              'flex h-7 w-full items-center justify-center rounded text-xs tnum transition-colors',
              n === selected ? 'bg-accent font-medium text-accent-ink' : 'text-ink-2 hover:bg-surface-2',
            )}
          >
            {p2(n)}
          </button>
        ))}
      </div>
    </div>
  );
}

function parseValue(v: string): (YMD & { hh: number; mm: number }) | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], hh: +m[4], mm: +m[5] };
}

function parseDate(v: string): YMD | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3] };
}

export function DateTimePicker({ value, onChange, placeholder, className, disabled, dateOnly = false, iconOnly = false, ariaLabel, title }: {
  value: string;            // datetime: YYYY-MM-DDTHH:MM；dateOnly: YYYY-MM-DD
  onChange: (v: string) => void;
  placeholder?: string;     // 默认「年/月/日 --:--」
  className?: string;       // 触发器尺寸/布局微调
  disabled?: boolean;
  dateOnly?: boolean;       // 仅选择计划日期，不显示时间下拉
  iconOnly?: boolean;       // 紧凑场景只显示日历图标，点击直接展开浮层
  ariaLabel?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });
  const [view, setView] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), mo: n.getMonth() + 1 };
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const cur = dateOnly ? parseDate(value) : parseValue(value);
  const now = new Date();

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const panelW = dateOnly ? PANEL_W : DT_PANEL_W;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - panelW - 8);
    const panelH = dateOnly ? DATE_PANEL_H : PANEL_H;
    const fitsBelow = r.bottom + 6 + panelH < window.innerHeight - 8;
    const top = fitsBelow ? r.bottom + 6 : Math.max(8, r.top - panelH - 6);
    setPos({ top, left });
  };

  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const openPanel = () => {
    const base = dateOnly ? parseDate(value) : parseValue(value);
    const n = new Date();
    setView(base ? { y: base.y, mo: base.mo } : { y: n.getFullYear(), mo: n.getMonth() + 1 });
    place();
    setOpen(true);
  };

  const commit = (y: number, mo: number, d: number, hh: number, mm: number) =>
    onChange(dateOnly ? `${y}-${p2(mo)}-${p2(d)}` : `${y}-${p2(mo)}-${p2(d)}T${p2(hh)}:${p2(mm)}`);

  const pickDay = (c: YMD) => {
    if (dateOnly) {
      commit(c.y, c.mo, c.d, 0, 0);
      return;
    }
    const t = parseValue(value);
    commit(c.y, c.mo, c.d, t?.hh ?? 9, t?.mm ?? 0);
  };

  const pickTime = (hh: number, mm: number) => {
    const t = parseValue(value);
    const base = t ?? { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate() };
    commit(base.y, base.mo, base.d, hh, mm);
  };

  const pickNow = () => {
    if (dateOnly) {
      commit(now.getFullYear(), now.getMonth() + 1, now.getDate(), 0, 0);
      setOpen(false);
      return;
    }
    commit(now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes());
    setOpen(false);
  };

  const shiftMonth = (delta: number) => {
    setView((v) => {
      const d = new Date(v.y, v.mo - 1 + delta, 1);
      return { y: d.getFullYear(), mo: d.getMonth() + 1 };
    });
  };

  // 42 格月历（周一开头，前后月补齐）
  const cells = useMemo(() => {
    const first = new Date(view.y, view.mo - 1, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(view.y, view.mo - 1, 1 - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate() };
    });
  }, [view]);

  const today: YMD = { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate() };
  const sameDay = (a: YMD | null, b: YMD) => a && a.y === b.y && a.mo === b.mo && a.d === b.d;

  const timeValue = dateOnly ? null : parseValue(value);
  const hhSel = timeValue?.hh ?? 9;
  const mmSel = timeValue?.mm ?? 0;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-label={ariaLabel ?? (dateOnly ? '选择日期' : '选择日期和时间')}
        title={title}
        className={cn(
          iconOnly
            ? 'flex size-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink'
            : 'input-base flex items-center justify-between gap-2 text-left',
          !iconOnly && (value ? 'text-ink' : 'text-ink-4'),
          className,
        )}
      >
        {iconOnly ? <CalendarDays className="size-3.5" /> : <>
          <span className={cn('truncate', value ? 'tnum font-mono' : 'font-sans')}>
            {value ? (dateOnly ? value : value.replace('T', ' ')) : (placeholder ?? (dateOnly ? '未安排日期' : '年/月/日 --:--'))}
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            {value && (
              <span
                role="button"
                aria-label="清空日期"
                onClick={(e) => { e.stopPropagation(); onChange(''); if (dateOnly) setOpen(false); }}
                className="rounded p-0.5 text-ink-4 transition-colors hover:bg-surface-3 hover:text-ink"
              >
                <X className="size-3.5" />
              </span>
            )}
            <CalendarDays className="size-3.5 text-ink-4" />
          </span>
        </>}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          data-datetime-picker-panel
          style={{ top: pos.top, left: pos.left, width: dateOnly ? PANEL_W : DT_PANEL_W }}
          className="pop-panel pointer-events-auto fixed z-[60] rounded-xl border border-line p-3"
        >
          <div className="flex items-start gap-2">
            {/* 左侧：月历 */}
            <div className="shrink-0">
              {/* 月切换 */}
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-0.5">
                  <button onClick={() => shiftMonth(-1)} aria-label="上个月" className="rounded p-1 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink">
                    <ChevronLeft className="size-4" />
                  </button>
                  <span className="tnum min-w-[88px] text-center text-xs font-medium">{view.y} 年 {view.mo} 月</span>
                  <button onClick={() => shiftMonth(1)} aria-label="下个月" className="rounded p-1 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink">
                    <ChevronRight className="size-4" />
                  </button>
                </div>
                <button
                  onClick={() => setView({ y: today.y, mo: today.mo })}
                  className="text-[11px] text-ink-4 transition-colors hover:text-accent"
                >
                  今天
                </button>
              </div>

              {/* 日历格 */}
              <div className="grid grid-cols-7 gap-y-0.5">
                {WEEKDAYS.map((w) => (
                  <span key={w} className="flex h-6 items-center justify-center text-[10px] text-ink-4">{w}</span>
                ))}
                {cells.map((c, i) => {
                  const sel = sameDay(cur, c);
                  const isToday = sameDay(today, c);
                  return (
                    <button
                      key={i}
                      onClick={() => pickDay(c)}
                      className={cn(
                        'mx-auto flex size-8 items-center justify-center rounded-md text-xs tnum transition-colors',
                        c.mo !== view.mo && 'text-ink-4/50',
                        c.mo === view.mo && !sel && 'text-ink-2 hover:bg-surface-2',
                        isToday && !sel && 'border border-accent/40 text-accent',
                        sel && 'bg-accent font-medium text-accent-ink',
                      )}
                    >
                      {c.d}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 右侧：时/分滚动列，点选即时生效 */}
            {!dateOnly && (
              <div className="ml-auto flex gap-1.5 border-l border-line pl-2.5">
                <TimeColumn
                  unit="时"
                  items={Array.from({ length: 24 }, (_, h) => h)}
                  selected={hhSel}
                  onSelect={(h) => pickTime(h, mmSel)}
                />
                <TimeColumn
                  unit="分"
                  items={Array.from({ length: 60 }, (_, m) => m)}
                  selected={mmSel}
                  onSelect={(m) => pickTime(hhSel, m)}
                />
              </div>
            )}
          </div>

          {/* 快捷操作；日期时间模式的时间选择已移到右侧滚动列 */}
          <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
            <span className="flex-1" />
            <button
              disabled={!value}
              onClick={() => onChange('')}
              className="rounded px-2 py-1 text-xs text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
            >
              清空
            </button>
            <button
              onClick={pickNow}
              className="rounded px-2 py-1 text-xs text-accent transition-colors hover:bg-accent/10"
            >
              {dateOnly ? '今天' : '此刻'}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
