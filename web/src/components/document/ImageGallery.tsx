/**
 * [INPUT]: 2–4 个图片节点、TipTap NodeView 与 Markdown 解析扩展点
 * [OUTPUT]: ImageGallery 图片画廊节点，支持图注、跨组拖放、列宽调整、拆分和持久化
 * [POS]: DocumentEditor 的多图块；单图仍由 ResizableImage 负责，画廊只编排图片关系
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Images, Ungroup, Trash2 } from 'lucide-react';
import type { MarkdownNodeSpec } from 'tiptap-markdown';
import { useRef } from 'react';

const escapeAttribute = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decodeCaption = (value: string) => { try { return decodeURIComponent(value); } catch { return ''; } };

function GalleryView({ node, editor, getPos, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const grid = useRef<HTMLDivElement>(null);
  const widths = (() => {
    const parsed = String(node.attrs.widths || '').split(',').map(Number);
    return parsed.length === node.childCount && parsed.every((value) => Number.isFinite(value) && value > 0) ? parsed : Array(node.childCount).fill(1);
  })();
  const selectGallery = () => {
    const pos = getPos();
    if (typeof pos === 'number') editor.chain().focus().setNodeSelection(pos).run();
  };
  const ungroup = () => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, node.content));
  };
  return <NodeViewWrapper as="figure" data-image-gallery className={`document-image-gallery group relative my-4 gallery-${node.childCount}`}>
    {editor.isEditable && !selected && <button type="button" contentEditable={false} aria-label="选择图片画廊" title="选择图片画廊"
      className="absolute left-2 top-2 z-20 rounded-md border border-line bg-surface-1/90 p-1.5 text-ink-3 opacity-0 shadow-sm transition-opacity hover:text-ink group-hover:opacity-100 focus:opacity-100"
      onClick={selectGallery}><Images className="size-4" /></button>}
    <div ref={grid} className="document-image-gallery-grid-wrap">
      <NodeViewContent as="div" className="document-image-gallery-grid" style={{ gridTemplateColumns: widths.map((value) => `${value}fr`).join(' ') }} />
      {editor.isEditable && selected && widths.slice(0, -1).map((_, index) => {
        const left = widths.slice(0, index + 1).reduce((sum, value) => sum + value, 0) / widths.reduce((sum, value) => sum + value, 0) * 100;
        return <button key={index} type="button" contentEditable={false} aria-label={`调整第 ${index + 1} 列宽度`} title="拖动调整两侧图片宽度"
          className="document-image-gallery-divider" style={{ left: `${left}%` }} onPointerDown={(event) => {
            event.preventDefault(); event.stopPropagation();
            const startX = event.clientX;
            const start = [...widths];
            const total = start.reduce((sum, value) => sum + value, 0);
            const containerWidth = grid.current?.clientWidth || 1;
            event.currentTarget.setPointerCapture(event.pointerId);
            const move = (moveEvent: PointerEvent) => {
              const delta = (moveEvent.clientX - startX) / containerWidth * total;
              const pair = start[index] + start[index + 1];
              const min = Math.min(0.35, pair * 0.2);
              const next = [...start];
              next[index] = Math.max(min, Math.min(pair - min, start[index] + delta));
              next[index + 1] = pair - next[index];
              updateAttributes({ widths: next.map((value) => value.toFixed(3)).join(',') });
            };
            const done = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', done); };
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', done, { once: true });
          }} />;
      })}
    </div>
    {editor.isEditable && selected && <div contentEditable={false} role="toolbar" aria-label="图片画廊操作" className="mt-2 flex w-fit items-center gap-1 rounded-lg border border-line bg-surface-1 p-1 text-xs shadow-sm">
      <span className="flex items-center gap-1 px-2 text-ink-3"><Images className="size-4" />{node.childCount} 张</span>
      <button type="button" aria-label="拆分图片画廊" title="拆分为单张图片" className="rounded p-2 hover:bg-surface-2" onClick={ungroup}><Ungroup className="size-4" /></button>
      <button type="button" aria-label="删除图片画廊" title="删除画廊" className="rounded p-2 text-danger hover:bg-surface-2" onClick={deleteNode}><Trash2 className="size-4" /></button>
    </div>}
    {editor.isEditable && selected ? <input contentEditable={false} aria-label="画廊图注" value={node.attrs.caption || ''} placeholder="添加一条画廊图注…"
      className="mt-1 w-full border-0 bg-transparent text-center text-xs text-ink-3 outline-none placeholder:text-ink-4"
      onChange={(event) => updateAttributes({ caption: event.target.value })} />
      : node.attrs.caption ? <figcaption contentEditable={false} className="mt-1 text-center text-xs text-ink-3">{node.attrs.caption}</figcaption> : null}
  </NodeViewWrapper>;
}

const markdown: MarkdownNodeSpec = {
  serialize(state, node) {
    const caption = encodeURIComponent(node.attrs.caption || '');
    const widths = String(node.attrs.widths || '').replace(/[^0-9.,]/g, '');
    state.write(`:::image-gallery ${caption}${widths ? ` widths=${widths}` : ''}`); state.ensureNewLine();
    node.forEach((image) => {
      const attrs = image.attrs;
      state.write('<img' + ['src', 'alt', 'title', 'width', 'data-align', 'data-caption']
        .filter((key) => attrs[key] != null && attrs[key] !== '' && !(key === 'data-align' && attrs[key] === 'left'))
        .map((key) => ` ${key}="${escapeAttribute(attrs[key])}"`).join('') + '>');
      state.ensureNewLine();
    });
    state.write(':::'); state.closeBlock(node);
  },
  parse: { setup(md) {
    const rule = (state: any, startLine: number, endLine: number, silent: boolean) => {
      const start = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim();
      if (!start.startsWith(':::image-gallery')) return false;
      let next = startLine + 1;
      while (next < endLine) {
        const line = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]).trim();
        if (line === ':::') break;
        next += 1;
      }
      if (next >= endLine) return false;
      if (!silent) {
        const raw = start.slice(':::image-gallery'.length).trim();
        const widthMarker = raw.match(/(?:^|\s)widths=([0-9.,]+)$/);
        const caption = widthMarker ? raw.slice(0, widthMarker.index).trim() : raw;
        const meta = { caption: decodeCaption(caption), widths: widthMarker?.[1] || '' };
        const images = state.src.slice(state.bMarks[startLine + 1], state.bMarks[next]).match(/<img\b[^>]*>/gi) || [];
        if (images.length < 2) return false;
        const token = state.push('html_block', '', 0);
        token.content = `<figure data-image-gallery data-caption="${escapeAttribute(meta.caption)}" data-widths="${escapeAttribute(meta.widths)}">${images.slice(0, 4).join('')}</figure>`;
      }
      state.line = next + 1;
      return true;
    };
    try { md.block.ruler.at('document_image_gallery', rule); }
    catch { md.block.ruler.before('fence', 'document_image_gallery', rule); }
  } },
};

export const ImageGallery = Node.create({
  name: 'imageGallery', group: 'block', content: 'image{2,4}', isolating: true, selectable: true, draggable: true,
  addAttributes() { return {
    caption: { default: '', parseHTML: (element) => element.getAttribute('data-caption') || '' },
    widths: { default: '', parseHTML: (element) => element.getAttribute('data-widths') || '' },
  }; },
  parseHTML() { return [{ tag: 'figure[data-image-gallery]' }]; },
  renderHTML({ HTMLAttributes }) { return ['figure', mergeAttributes(HTMLAttributes, { 'data-image-gallery': '' }), 0]; },
  addStorage() { return { markdown }; },
  addNodeView() { return ReactNodeViewRenderer(GalleryView); },
});
