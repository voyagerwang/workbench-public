/**
 * [INPUT]: TipTap 表格扩展与当前编辑器选区
 * [OUTPUT]: documentTableExtensions 与 TableMenu，提供 2×3 默认表格和块内行列操作
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
import { AlignCenter, AlignLeft, AlignRight, Columns3, Merge, Rows3, SplitSquareHorizontal, Table2, Trash2 } from 'lucide-react';
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

const actionClass = 'rounded p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35';

export function insertDefaultTable(editor: Editor) {
  return editor.chain().focus().insertTable({ rows: 2, cols: 3, withHeaderRow: true }).run();
}

export function TableMenu({ editor }: { editor: Editor }) {
  const action = (label: string, icon: typeof Table2, run: () => boolean, disabled = false) => {
    const Icon = icon;
    return <button type="button" aria-label={label} title={label} disabled={disabled} className={actionClass}
      onMouseDown={(event) => event.preventDefault()} onClick={run}><Icon className="size-4" /></button>;
  };
  return <BubbleMenu editor={editor} tippyOptions={{ duration: 100, zIndex: 91 }}
    shouldShow={({ editor: current }) => current.isEditable && current.isActive('table')}>
    <div role="toolbar" aria-label="表格操作" className="flex max-w-[calc(100vw-24px)] flex-wrap items-center gap-0.5 rounded-lg border border-line bg-chrome p-1 shadow-lg">
      {action('在上方插入行', Rows3, () => editor.chain().focus().addRowBefore().run())}
      {action('在下方插入行', Rows3, () => editor.chain().focus().addRowAfter().run())}
      {action('在左侧插入列', Columns3, () => editor.chain().focus().addColumnBefore().run())}
      {action('在右侧插入列', Columns3, () => editor.chain().focus().addColumnAfter().run())}
      <span className="mx-0.5 h-5 w-px bg-line" />
      {action('合并所选单元格', Merge, () => editor.chain().focus().mergeCells().run(), !editor.can().mergeCells())}
      {action('拆分单元格', SplitSquareHorizontal, () => editor.chain().focus().splitCell().run(), !editor.can().splitCell())}
      {action('切换表头行', Table2, () => editor.chain().focus().toggleHeaderRow().run())}
      {action('单元格左对齐', AlignLeft, () => editor.chain().focus().setCellAttribute('textAlign', 'left').run())}
      {action('单元格居中', AlignCenter, () => editor.chain().focus().setCellAttribute('textAlign', 'center').run())}
      {action('单元格右对齐', AlignRight, () => editor.chain().focus().setCellAttribute('textAlign', 'right').run())}
      <span className="mx-0.5 h-5 w-px bg-line" />
      {action('删除当前行', Trash2, () => editor.chain().focus().deleteRow().run())}
      {action('删除当前列', Trash2, () => editor.chain().focus().deleteColumn().run())}
      {action('删除表格', Trash2, () => editor.chain().focus().deleteTable().run())}
    </div>
  </BubbleMenu>;
}
