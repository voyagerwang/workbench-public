/**
 * [INPUT]: TipTap 编辑器与插入菜单位置；使用现有 StarterKit 命令
 * [OUTPUT]: 选区格式工具与空行插入菜单（含文件导入入口、模糊筛选）
 * [POS]: DocumentEditor 共用编辑工具，不扩展 Markdown 存储格式
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BubbleMenu, type Editor } from '@tiptap/react';
import { CellSelection } from '@tiptap/pm/tables';
import { Bold, Code, Italic, Strikethrough } from 'lucide-react';
import { cn } from '@/lib/utils';
import { insertDefaultTable } from './DocumentTable';
export type InsertAnchor = { left: number; top: number };

/**
 * 轻量子序列模糊打分：query 的每个字符在 target 中按顺序出现即命中（>0），
 * 否则返回 0（不匹配）。连续命中、词首/边界命中额外加分，分数越高越靠前。
 * 用于不引入额外依赖的情况下支持「模糊检索」。
 */
function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  let qi = 0, score = 0, consecutive = 0, prevMatch = -2;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      let s = 1;
      if (ti === prevMatch + 1) { consecutive++; s += consecutive * 2; } else consecutive = 0;
      if (ti === 0 || /[\s\-_/（(【]/.test(target[ti - 1])) s += 2;
      score += s;
      prevMatch = ti;
      qi++;
    }
  }
  return qi === query.length ? score : 0;
}

type Entry = { name: string; keywords: string[]; run: () => void };

export function EditorMenus({ editor, anchor, onClose, onImportFile, onInsertReminder }: {
  editor: Editor; anchor: InsertAnchor | null; onClose: () => void; onImportFile: () => void;
  /** 「提醒事项」：交给外层弹输入面板，菜单自己不管落库 */
  onInsertReminder: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const entries: Entry[] = [
    { name: '正文', keywords: ['text', 'zhengwen', 'zw', 'paragraph', 'p'], run: () => editor.chain().focus().setParagraph().run() },
    { name: '一级标题', keywords: ['h1', 'title', 'biaoti', 'bt', 'yijibiaoti', 'heading'], run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { name: '二级标题', keywords: ['h2', 'title', 'biaoti', 'bt', 'ertibiaoti', 'heading'], run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { name: '三级标题', keywords: ['h3', 'title', 'biaoti', 'bt', 'sanjibiaoti', 'heading'], run: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { name: '无序列表', keywords: ['ul', 'list', 'wuxu', 'wxlb', 'bullet', 'liebiao'], run: () => editor.chain().focus().toggleBulletList().run() },
    { name: '有序列表', keywords: ['ol', 'list', 'youxu', 'youlb', 'number', 'liebiao'], run: () => editor.chain().focus().toggleOrderedList().run() },
    { name: '待办清单', keywords: ['todo', 'task', 'daiban', 'db', 'checklist', 'qingdan'], run: () => editor.chain().focus().toggleTaskList().run() },
    { name: '引用', keywords: ['quote', 'yinyong', 'yy', 'blockquote'], run: () => editor.chain().focus().toggleBlockquote().run() },
    { name: '代码块', keywords: ['code', 'daima', 'dm', 'codeblock'], run: () => editor.chain().focus().toggleCodeBlock().run() },
    { name: '分割线', keywords: ['hr', 'fengexian', 'fgx', 'divider', 'line'], run: () => editor.chain().focus().setHorizontalRule().run() },
    { name: '表格（2 × 3）', keywords: ['table', 'biaoge', 'bg'], run: () => insertDefaultTable(editor) },
    { name: '提醒事项', keywords: ['reminder', 'tixing', 'tx', 'alert'], run: onInsertReminder },
    { name: '导入文件（PDF / PPT 等）', keywords: ['import', 'daoru', 'dr', 'file', 'upload'], run: onImportFile },
  ];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.map((entry, index) => ({ entry, index }));
    return entries
      .map((entry, index) => {
        const candidates = [entry.name.toLowerCase(), ...entry.keywords];
        const score = Math.max(...candidates.map((text) => fuzzyScore(q, text)));
        return { entry, index, score };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
  }, [query]);
  useEffect(() => { setQuery(''); setSelected(0); }, [anchor]);
  useEffect(() => { if (anchor) inputRef.current?.focus(); }, [anchor]);
  useEffect(() => { setSelected((current) => Math.min(current, Math.max(0, filtered.length - 1))); }, [filtered.length]);
  useEffect(() => { listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selected, filtered.length]);
  useEffect(() => {
    if (!anchor) return;
    const pointer = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('[data-editor-menu]')) onClose(); };
    document.addEventListener('mousedown', pointer);
    return () => document.removeEventListener('mousedown', pointer);
  }, [anchor, onClose]);
  const runAt = (index: number) => { const result = filtered[index]; if (result) { result.entry.run(); onClose(); } };
  const menuStyle: CSSProperties | undefined = anchor
    ? { left: Math.max(8, Math.min(anchor.left, window.innerWidth - 232)), top: Math.max(8, Math.min(anchor.top, window.innerHeight - 460)) }
    : undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((index) => (index + 1) % Math.max(1, filtered.length)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((index) => (index - 1 + filtered.length) % Math.max(1, filtered.length)); }
    else if (event.key === 'Enter') { event.preventDefault(); if (filtered.length) runAt(selected); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  };
  const formats = [
    { name: '粗体', mark: 'bold', icon: Bold, run: () => editor.chain().focus().toggleBold().run() },
    { name: '斜体', mark: 'italic', icon: Italic, run: () => editor.chain().focus().toggleItalic().run() },
    { name: '删除线', mark: 'strike', icon: Strikethrough, run: () => editor.chain().focus().toggleStrike().run() },
    { name: '行内代码', mark: 'code', icon: Code, run: () => editor.chain().focus().toggleCode().run() },
  ];
  return <>
    <BubbleMenu editor={editor} tippyOptions={{ duration: 100, zIndex: 90, placement: 'bottom' }} shouldShow={({ editor: current, from, to }) => current.isEditable && from !== to && !(current.state.selection instanceof CellSelection) && !current.isActive('image') && !current.isActive('attachment')}>
      <div data-editor-toolbar role="toolbar" aria-label="文字格式" className="flex max-w-[calc(100vw-24px)] flex-wrap rounded-lg border border-line bg-surface-1 p-1 shadow-lg">
        {formats.map(({ name, mark, icon: Icon, run }) => <button key={mark} title={name} aria-label={name} aria-pressed={editor.isActive(mark)}
          onMouseDown={(event) => event.preventDefault()} onClick={run}
          className={cn('flex items-center gap-1 rounded px-2 py-1.5 text-sm hover:bg-surface-2', editor.isActive(mark) && 'text-accent')}><Icon className="size-4" /><span>{name}</span></button>)}
      </div>
    </BubbleMenu>
    {anchor && createPortal(<div data-editor-menu role="menu" aria-label="插入内容" className="pop-panel fixed z-[90] w-56 rounded-lg border border-line bg-chrome p-1 shadow-xl"
      style={menuStyle}>
      <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="筛选功能（支持模糊检索）"
        aria-label="筛选功能" autoComplete="off" spellCheck={false}
        className="mb-1 w-full rounded border border-line bg-surface-1 px-2 py-1.5 text-xs outline-none placeholder:text-ink-4 focus:border-accent" />
      {filtered.length === 0
        ? <p className="px-2 py-3 text-center text-xs text-ink-4">无匹配项</p>
        : <div ref={listRef} role="menu" aria-label="插入内容" className="max-h-[60vh] overflow-y-auto">
          {filtered.map((item, index) => <button role="menuitem" key={item.entry.name} data-selected={index === selected} onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setSelected(index)} onClick={() => runAt(index)}
            className={cn('block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-surface-2', index === selected && 'bg-surface-2 text-accent')}>{item.entry.name}</button>)}
        </div>}
    </div>, document.body)}
  </>;
}
