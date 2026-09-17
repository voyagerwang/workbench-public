/**
 * [INPUT]: TipTap 表格扩展与当前编辑器选区
 * [OUTPUT]: documentTableExtensions 与 TableMenu，提供边缘操作柄、范围高亮及选区内容设置
 * [POS]: DocumentEditor 的文档表格边界；数据仍由 tiptap-markdown 转为 Markdown/受控 HTML
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import { Fragment } from '@tiptap/pm/model';
import { getHTMLFromFragment } from '@tiptap/core';
import { BubbleMenu, type Editor } from '@tiptap/react';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlignCenter, AlignLeft, AlignRight, Bold, Columns3, Merge, Rows3, SplitSquareHorizontal, Table2, Trash2 } from 'lucide-react';
import type { MarkdownNodeSpec } from 'tiptap-markdown';

const tableMarkdown: MarkdownNodeSpec = {
  serialize(state, node) {
    const rows = node.content.content;
    const simple = rows.length > 0 && rows.every((row, rowIndex) => row.content.content.every((cell) =>
      cell.attrs.colspan === 1 && cell.attrs.rowspan === 1 && !cell.attrs.textAlign && cell.childCount === 1 &&
      (rowIndex === 0 ? cell.type.name === 'tableHeader' : cell.type.name === 'tableCell')));
    if (simple) {
      rows.forEach((row, rowIndex) => {
        state.write('| ');
        row.forEach((cell, _offset, cellIndex) => {
          if (cellIndex) state.write(' | ');
          if (cell.firstChild?.textContent.trim()) state.renderInline(cell.firstChild);
        });
        state.write(' |'); state.ensureNewLine();
        if (rowIndex === 0) { state.write(`| ${Array.from({ length: row.childCount }, () => '---').join(' | ')} |`); state.ensureNewLine(); }
      });
      state.closeBlock(node); return;
    }
    const html = getHTMLFromFragment(Fragment.from(node), node.type.schema);
    state.write(':::document-table'); state.ensureNewLine(); state.write(html); state.ensureNewLine(); state.write(':::'); state.closeBlock(node);
  },
  parse: { setup(md) {
    const rule = (state: any, startLine: number, endLine: number, silent: boolean) => {
      const start = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim();
      if (start !== ':::document-table') return false;
      let next = startLine + 1;
      while (next < endLine && state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]).trim() !== ':::') next += 1;
      if (next >= endLine) return false;
      const html = state.src.slice(state.bMarks[startLine + 1], state.bMarks[next]).trim();
      if (!/^<table\b/i.test(html) || !/<\/table>$/i.test(html)) return false;
      if (!silent) { const token = state.push('html_block', '', 0); token.content = html; }
      state.line = next + 1; return true;
    };
    try { md.block.ruler.at('document_table', rule); }
    catch { md.block.ruler.before('fence', 'document_table', rule); }
  } },
};

const cellAttributes = {
  textAlign: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute('data-align'),
    renderHTML: (attrs: Record<string, unknown>) => attrs.textAlign ? { 'data-align': attrs.textAlign, style: `text-align:${attrs.textAlign}` } : {},
  },
};

const DocumentTable = Table.extend({ addStorage() { return { ...this.parent?.(), markdown: tableMarkdown }; } });
const DocumentTableCell = TableCell.extend({ addAttributes() { return { ...this.parent?.(), ...cellAttributes }; } });
const DocumentTableHeader = TableHeader.extend({ addAttributes() { return { ...this.parent?.(), ...cellAttributes }; } });

export const documentTableExtensions = [
  DocumentTable.configure({ resizable: true, lastColumnResizable: true, allowTableNodeSelection: true }),
  TableRow,
  DocumentTableHeader,
  DocumentTableCell,
];

const actionClass = 'flex items-center gap-2 rounded px-2 py-1.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35';

export function insertDefaultTable(editor: Editor) {
  return editor.chain().focus().insertTable({ rows: 2, cols: 3, withHeaderRow: true }).run();
}

export function TableMenu({ editor }: { editor: Editor }) {
  const [cell, setCell] = useState<HTMLTableCellElement | null>(null);
  const [menu, setMenu] = useState<'table' | 'row' | 'column' | null>(null);
  const [edge, setEdge] = useState<'table' | 'row' | 'column' | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  useEffect(() => {
    const update = () => {
      setMenu(null);
      setEdge(null);
      const { selection } = editor.state;
      const dom = editor.view.domAtPos(selection.from).node;
      setCell((dom instanceof HTMLElement ? dom : dom.parentElement)?.closest('td, th') as HTMLTableCellElement | null);
    };
    const hover = (event: MouseEvent) => {
      if (menuRef.current) return;
      if ((event.target as HTMLElement).closest('[data-table-controls]')) return;
      for (const table of editor.view.dom.querySelectorAll('table')) {
        const bounds = table.getBoundingClientRect();
        const x = event.clientX, y = event.clientY;
        if (x < bounds.left - 24 || x > bounds.right || y < bounds.top - 24 || y > bounds.bottom) continue;
        const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>('td, th'));
        const kind = x <= bounds.left + 8 && y <= bounds.top + 8 ? 'table'
          : x <= bounds.left + 8 ? 'row' : y <= bounds.top + 8 ? 'column' : null;
        const target = kind === 'table' ? cells[0] : cells.find((candidate) => {
          const r = candidate.getBoundingClientRect();
          return kind === 'row' ? y >= r.top && y < r.bottom : x >= r.left && x < r.right;
        });
        setEdge(kind); setCell(kind && target ? target : null);
        return;
      }
      setEdge(null); setCell(null);
    };
    const dismiss = () => { setMenu(null); setEdge(null); setCell(null); };
    const outside = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('[data-table-controls]')) dismiss();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { dismiss(); editor.commands.focus(); } };
    editor.on('selectionUpdate', update);
    editor.on('update', update);
    document.addEventListener('mousemove', hover);
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      editor.off('selectionUpdate', update); editor.off('update', update);
      document.removeEventListener('mousemove', hover);
      document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss);
    };
  }, [editor]);
  const open = (kind: 'table' | 'row' | 'column') => {
    if (!cell?.isConnected) return;
    const pos = editor.view.posAtDOM(cell, 0) - 1;
    const resolved = editor.state.doc.resolve(pos);
    const tableDepth = resolved.depth - 1;
    const map = TableMap.get(resolved.node(tableDepth));
    const start = resolved.start(tableDepth);
    const selection = kind === 'table'
      ? CellSelection.create(editor.state.doc, start + map.map[0], start + map.map[map.map.length - 1])
      : kind === 'row' ? CellSelection.rowSelection(resolved) : CellSelection.colSelection(resolved);
    menuRef.current = kind;
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.view.focus();
    setCell(cell); setEdge(kind); setMenu(kind);
  };
  const action = (label: string, icon: typeof Table2, run: () => boolean, disabled = false) => {
    const Icon = icon;
    return <button type="button" aria-label={label} title={label} disabled={disabled} className={actionClass}
      onMouseDown={(event) => event.preventDefault()} onClick={() => { run(); setMenu(null); }}><Icon className="size-4 shrink-0" /><span>{label}</span></button>;
  };
  const rect = cell?.isConnected ? cell.getBoundingClientRect() : null;
  const tableRect = cell?.closest('table')?.getBoundingClientRect();
  const clamp = (value: number, max: number) => Math.max(8, Math.min(value, max));
  const active = menu || edge;
  const scope = active === 'table' ? tableRect : rect && tableRect ? active === 'row'
    ? { left: tableRect.left, top: rect.top, width: tableRect.width, height: rect.height }
    : { left: rect.left, top: tableRect.top, width: rect.width, height: tableRect.height } : null;
  return <>
    {active && rect && tableRect && scope && editor.isEditable && createPortal(<div data-table-controls>
      {!menu && <div aria-hidden="true" className="pointer-events-none fixed z-[89] border border-accent bg-accent/5"
        style={{ left: scope.left, top: scope.top, width: scope.width, height: scope.height }} />}
      <button type="button" aria-label={active === 'table' ? '表格操作' : active === 'row' ? '行操作' : '列操作'}
        title={active === 'table' ? '整张表格操作' : active === 'row' ? '当前行操作' : '当前列操作'} aria-expanded={!!menu}
        className="fixed z-[92] flex items-center justify-center rounded-sm bg-surface-2 text-xs text-ink-2 hover:bg-accent hover:text-white focus-visible:outline-accent"
        style={active === 'row'
          ? { left: Math.max(2, tableRect.left - 18), top: rect.top, width: 18, height: rect.height }
          : active === 'column'
            ? { left: rect.left, top: Math.max(2, tableRect.top - 18), width: rect.width, height: 18 }
            : { left: Math.max(2, tableRect.left - 20), top: Math.max(2, tableRect.top - 20), width: 20, height: 20 }}
        onMouseDown={(event) => event.preventDefault()} onClick={() => open(active)}>
        <span aria-hidden="true">{active === 'row' ? '⋮' : '⋯'}</span>
      </button>
      {!menu && <div className="pointer-events-none fixed z-[93] rounded bg-surface-1 px-2 py-1 text-xs text-ink-2 shadow-sm border border-line"
        style={{ left: clamp(active === 'row' ? tableRect.left + 8 : scope.left, window.innerWidth - 150),
          top: Math.max(4, (active === 'row' ? rect.top : tableRect.top - 18) - 30) }}>
        {active === 'table' ? '点击操作整张表格' : active === 'row' ? '点击插入或删除行' : '点击插入或删除列'}
      </div>}
      {menu && <div role="toolbar" aria-label={menu === 'table' ? '表格设置' : menu === 'row' ? '行设置' : '列设置'}
        className="fixed z-[93] flex w-48 flex-col rounded-lg border border-line bg-surface-1 p-1 shadow-lg"
        style={{ left: clamp(menu === 'row' ? tableRect.left : rect.left, window.innerWidth - 200), top: clamp(menu === 'row' ? rect.bottom + 4 : tableRect.top + 4, window.innerHeight - 240) }}>
        <div className="px-2 py-1 text-xs text-ink-3">{menu === 'table' ? '整张表格' : menu === 'row' ? '所选行' : '所选列'}</div>
        {menu === 'table' ? <>
          {action('删除整张表格', Trash2, () => editor.chain().focus().deleteTable().run())}
          <div className="px-2 py-1 text-xs text-ink-3">包含所有单元格内容，可撤销</div>
        </> : menu === 'row' ? <>
          {action('在上方插入行', Rows3, () => editor.chain().focus().addRowBefore().run())}
          {action('在下方插入行', Rows3, () => editor.chain().focus().addRowAfter().run())}
          {action('切换表头行', Table2, () => editor.chain().focus().toggleHeaderRow().run())}
          {action('删除所选行', Trash2, () => editor.chain().focus().deleteRow().run())}
        </> : <>
          {action('在左侧插入列', Columns3, () => editor.chain().focus().addColumnBefore().run())}
          {action('在右侧插入列', Columns3, () => editor.chain().focus().addColumnAfter().run())}
          {action('切换表头列', Table2, () => editor.chain().focus().toggleHeaderColumn().run())}
          {action('删除所选列', Trash2, () => editor.chain().focus().deleteColumn().run())}
        </>}
      </div>}
    </div>, document.body)}
    <BubbleMenu editor={editor} tippyOptions={{ duration: 100, zIndex: 91, placement: 'bottom' }}
      shouldShow={({ editor: current }) => current.isEditable && !menuRef.current && current.state.selection instanceof CellSelection}>
    <div data-editor-toolbar role="toolbar" aria-label="单元格内容设置" className="flex w-80 max-w-[calc(100vw-24px)] flex-wrap items-center gap-0.5 rounded-lg border border-line bg-surface-1 p-1 shadow-lg">
      {action('粗体', Bold, () => editor.chain().focus().toggleBold().run())}
      {action('合并所选单元格', Merge, () => editor.chain().focus().mergeCells().run(), !editor.can().mergeCells())}
      {action('拆分单元格', SplitSquareHorizontal, () => editor.chain().focus().splitCell().run(), !editor.can().splitCell())}
      {action('单元格左对齐', AlignLeft, () => editor.chain().focus().setCellAttribute('textAlign', 'left').run())}
      {action('单元格居中', AlignCenter, () => editor.chain().focus().setCellAttribute('textAlign', 'center').run())}
      {action('单元格右对齐', AlignRight, () => editor.chain().focus().setCellAttribute('textAlign', 'right').run())}
    </div>
  </BubbleMenu></>;
}
