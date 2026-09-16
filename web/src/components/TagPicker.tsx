// 可搜索的标签选择器：点开就能复用已有标签，不用把名字完整敲一遍。
//
// 三条硬规则（来自随手记标签复用的验收要求）：
// 1. 输入词与已有标签完全同名时，只出现「选中它」，不出现「创建」——绝不制造重复标签。
// 2. 新标签只能由用户明确选中「创建新标签」这一项才生成。
// 3. 支持键盘：↑↓ 移动、Enter 选中、Esc 关闭；一次可以选多个，选完面板不关。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Hash, Plus, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { exactTagMatch, hasTag, normalizeTag, tagKey, tagMatches } from '@/lib/tags';

export type TagPickerProps = {
  /** 库里已有的标签（已规范化） */
  allTags: string[];
  /** 当前已选 */
  selected: string[];
  /** 每个标签的使用次数；用于「常用」排序与计数展示 */
  counts?: Record<string, number>;
  /** 最近用过的标签名，排在候选最前 */
  recent?: string[];
  placeholder?: string;
  /** 点击已有标签：选中 / 取消 */
  onToggle: (tag: string) => void;
  /** 只有明确选中「创建新标签」时才触发 */
  onCreate: (tag: string) => void;
  className?: string;
};

type Option =
  | { kind: 'tag'; tag: string; count: number }
  | { kind: 'create'; name: string };

type Section = { label: string | null; items: Option[] };

const PANEL_WIDTH = 264;
const PANEL_MAX_HEIGHT = 288;
/** 「常用」分组最多展示多少个，其余进「其他」 */
const FREQUENT_LIMIT = 8;

export function TagPicker({
  allTags, selected, counts = {}, recent = [], placeholder = '+ 标签',
  onToggle, onCreate, className,
}: TagPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { sections, options } = useMemo(() => {
    const q = query.trim();
    const matched = allTags.filter((tag) => tagMatches(tag, q));
    const countOf = (tag: string) => counts[tag] ?? counts[tagKey(tag)] ?? 0;

    // 已选的排在每组前面并带勾，方便直接取消；未选的在前更利于快速多选。
    const rank = (tag: string) => (hasTag(selected, tag) ? 1 : 0);
    const matchedSorted = [...matched].sort(
      (a, b) => rank(a) - rank(b) || countOf(b) - countOf(a) || a.localeCompare(b, 'zh-Hans-CN'),
    );

    const recentSet = new Set(recent.map((t) => tagKey(t)));
    const recentPicks = recent
      .map((name) => matchedSorted.find((t) => tagKey(t) === tagKey(name)))
      .filter((t): t is string => Boolean(t));
    const rest = matchedSorted.filter((t) => !recentSet.has(tagKey(t)));
    const frequent = rest.slice(0, FREQUENT_LIMIT);
    const others = rest.slice(FREQUENT_LIMIT);

    const asTag = (tag: string): Option => ({ kind: 'tag' as const, tag, count: countOf(tag) });
    const built: Section[] = [];
    if (recentPicks.length) built.push({ label: '最近使用', items: recentPicks.map(asTag) });
    if (frequent.length) built.push({ label: '常用', items: frequent.map(asTag) });
    if (others.length) built.push({ label: '其他', items: others.map(asTag) });

    // 完全同名已有标签 → 不提供创建项；输入为空或只有 # 也不创建。
    const name = normalizeTag(query);
    const canCreate = Boolean(name) && !exactTagMatch(allTags, name);
    if (canCreate) built.push({ label: null, items: [{ kind: 'create' as const, name }] });

    return { sections: built, options: built.flatMap((section) => section.items) };
  }, [allTags, counts, query, recent, selected]);

  // 光标越界时收回：过滤后候选变少是常态
  useEffect(() => {
    setCursor((c) => (options.length ? Math.min(c, options.length - 1) : 0));
  }, [options.length]);

  // 面板用 portal 挂到 body：随手记编辑器卡片是 overflow-hidden，
  // 放在卡片内部会被裁掉，所以走 fixed 定位 + 跟随输入位置。
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const below = rect.bottom + 6;
      const flip = below + PANEL_MAX_HEIGHT > window.innerHeight && rect.top > PANEL_MAX_HEIGHT;
      setPos({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)),
        top: flip ? Math.max(8, rect.top - PANEL_MAX_HEIGHT - 6) : below,
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // 点面板外关闭。面板内部用 onMouseDown preventDefault 保住输入焦点，
  // 所以真正的「点外面」一定来自面板之外的 mousedown。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open, options.length]);

  const activate = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === 'create') {
      onCreate(option.name);
      setQuery('');
      inputRef.current?.focus();
      return;
    }
    onToggle(option.tag);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      if (!options.length) return;
      setCursor((c) => {
        const next = event.key === 'ArrowDown' ? c + 1 : c - 1;
        return (next + options.length) % options.length;
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      activate(options[cursor]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (open) { setOpen(false); setQuery(''); }
      return;
    }
    if (event.key === 'Backspace' && !query && selected.length) {
      // 空输入再退格 = 摘掉最后一个标签，与常见标签输入一致
      event.preventDefault();
      onToggle(selected[selected.length - 1]);
    }
  };

  let index = -1;

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setCursor(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="w-24 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-4"
        aria-haspopup="listbox"
        aria-expanded={open}
      />
      {open && pos && createPortal(
        <div
          ref={listRef}
          // 保住输入焦点：否则 mousedown 会先让 input 失焦，面板被 outside-click 逻辑关掉，点不动
          onMouseDown={(event) => event.preventDefault()}
          style={{ left: pos.left, top: pos.top, width: PANEL_WIDTH, maxHeight: PANEL_MAX_HEIGHT }}
          className="pop-panel fixed z-[95] flex flex-col overflow-hidden rounded-xl border border-line"
          role="listbox"
        >
          <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-1.5 text-ink-4">
            <Search className="size-3 shrink-0" />
            <span className="truncate text-[10px]">
              {query.trim() ? `匹配「${query.trim()}」` : '搜索或创建标签'}
            </span>
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); setCursor(0); inputRef.current?.focus(); }}
                className="ml-auto rounded p-0.5 transition-colors hover:text-ink-2"
                title="清空"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {options.length === 0 && (
              <p className="px-2 py-3 text-center text-[11px] text-ink-4">没有匹配的标签</p>
            )}
            {sections.map((section) => (
              <div key={section.label ?? 'create'}>
                {section.label && (
                  <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-4">
                    {section.label}
                  </p>
                )}
                {section.items.map((option) => {
                  index += 1;
                  const active = index === cursor;
                  const at = index;
                  if (option.kind === 'create') {
                    return (
                      <OptionRow
                        key={`create:${option.name}`}
                        active={active}
                        onHover={() => setCursor(at)}
                        onPick={() => activate(option)}
                        icon={<Plus className="size-3" />}
                        label={`创建「${option.name}」`}
                        hint="新建"
                      />
                    );
                  }
                  const isSelected = hasTag(selected, option.tag);
                  return (
                    <OptionRow
                      key={`tag:${option.tag}`}
                      active={active}
                      onHover={() => setCursor(at)}
                      onPick={() => activate(option)}
                      icon={isSelected ? <Check className="size-3 text-accent" /> : <Hash className="size-3 text-ink-4" />}
                      label={option.tag}
                      hint={isSelected ? '已选' : option.count ? `${option.count}` : undefined}
                      muted={isSelected}
                    />
                  );
                })}
              </div>
            ))}
          </div>

          {options.length > 0 && (
            <div className="flex items-center gap-2 border-t border-line px-2.5 py-1 text-[10px] text-ink-4">
              <span className="kbd">↑↓</span>
              <span>移动</span>
              <span className="kbd">↵</span>
              <span>选中</span>
              <span className="kbd">esc</span>
              <span>关闭</span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function OptionRow({ active, onHover, onPick, icon, label, hint, muted }: {
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-active={active}
      onMouseEnter={onHover}
      onClick={onPick}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors',
        active ? 'bg-surface-3 text-ink' : 'text-ink-2',
        muted && !active && 'text-ink-3',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && (
        <span className={cn('shrink-0 font-mono text-[10px]', active ? 'text-ink-3' : 'text-ink-4')}>
          {hint}
        </span>
      )}
    </button>
  );
}
