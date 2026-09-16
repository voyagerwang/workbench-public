/**
 * [INPUT]: TipTap 图片节点视图、imageMarkdown 与统一图片编排命令
 * [OUTPUT]: ResizableImage 扩展，支持缩放、预览、替换及四向拖放编排
 * [POS]: DocumentEditor 的共用图片节点；视觉层判定投放方向，事务变换由 image-gallery-commands 负责
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useRef, useState } from 'react';
import TipTapImage, { type ImageOptions } from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { AlignCenter, AlignLeft, Eye, Loader2, Maximize2, Minus, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { imageMarkdown, imageWidth } from './image-markdown';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { IMAGE_DRAG_MIME, moveDocumentImage, type ImageDragPayload, type ImageDropPlacement } from './image-gallery-commands';

const MIN_WIDTH = 64;
const SCALE_STEP = 1.2;
let imageDrag: ImageDragPayload | null = null;
let pointerMoveConsumed = false;
function ImageView({ node, selected, editor, updateAttributes, getPos, extension, deleteNode }: NodeViewProps) {
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; width: number; next: number } | null>(null);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [replacing, setReplacing] = useState(false);
  const width = previewWidth ?? imageWidth(node.attrs.width);
  const editable = editor.isEditable;
  const clamp = (value: number) => {
    const max = frame.current?.clientWidth || MIN_WIDTH;
    return Math.round(Math.min(max, Math.max(Math.min(MIN_WIDTH, max), value)));
  };
  const resize = (factor: number) => {
    const current = image.current?.getBoundingClientRect().width;
    if (current) updateAttributes({ width: clamp(current * factor) });
  };
  const align = ['center', 'full'].includes(node.attrs.align) ? node.attrs.align : 'left';
  const dragIdentity = () => typeof getPos === 'function' && typeof getPos() === 'number' ? { pos: getPos() as number } : null;
  const startImageDrag = (event: React.DragEvent) => {
    const identity = dragIdentity();
    if (!identity || !editable) return;
    imageDrag = identity;
    pointerMoveConsumed = false;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(IMAGE_DRAG_MIME, JSON.stringify(identity));
  };
  const placementAt = (clientX: number, clientY: number): ImageDropPlacement | null => {
    const rect = image.current?.getBoundingClientRect();
    if (!rect) return null;
    const dx = (clientX - rect.left) / rect.width - 0.5;
    const dy = (clientY - rect.top) / rect.height - 0.5;
    return Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'before' : 'after') : (dx < 0 ? 'left' : 'right');
  };
  const dropImage = (event: React.DragEvent) => {
    if (pointerMoveConsumed) { event.preventDefault(); event.stopPropagation(); pointerMoveConsumed = false; return; }
    try {
      const source = imageDrag || JSON.parse(event.dataTransfer.getData(IMAGE_DRAG_MIME)) as ImageDragPayload;
      const target = dragIdentity();
      const placement = placementAt(event.clientX, event.clientY);
      if (!target || !placement) return;
      if (moveDocumentImage(editor, source.pos, target.pos, placement)) { event.preventDefault(); event.stopPropagation(); }
    } catch { /* 普通文件拖放继续交给编辑器上传 */ }
    imageDrag = null;
  };
  return <NodeViewWrapper ref={frame} className={`document-image my-3 max-w-full ${align === 'center' ? 'document-image-center' : align === 'full' ? 'document-image-full' : ''}`}
    data-document-image contentEditable={false} draggable={editable}
    onPointerDown={(event: React.PointerEvent) => { if (event.button === 0 && editable) imageDrag = dragIdentity(); }}
    onPointerOver={(event: React.PointerEvent) => {
      if (event.buttons !== 1 || !imageDrag) return;
      const target = dragIdentity();
      const placement = placementAt(event.clientX, event.clientY);
      if (target && placement && moveDocumentImage(editor, imageDrag.pos, target.pos, placement)) { imageDrag = null; pointerMoveConsumed = true; }
    }}
    onPointerUp={() => { imageDrag = null; }}
    onDragStart={startImageDrag}
    onDragEnd={() => { imageDrag = null; pointerMoveConsumed = false; }}
    onDragOver={(event: React.DragEvent) => { if (imageDrag || event.dataTransfer.types.includes(IMAGE_DRAG_MIME)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
    onDrop={dropImage}>
    <div className="relative max-w-full" style={{ width: align === 'full' ? '100%' : width ?? 'fit-content' }}>
      <img ref={image} src={node.attrs.src} alt={node.attrs.alt || ''} title={node.attrs.title || '拖动图片进行编排'} draggable={editable}
        onDragStart={startImageDrag} onDragEnd={() => { imageDrag = null; pointerMoveConsumed = false; }}
        onDragOver={(event) => { if (imageDrag || event.dataTransfer.types.includes(IMAGE_DRAG_MIME)) event.preventDefault(); }} onDrop={dropImage}
        style={{ width: width ? '100%' : undefined, margin: 0, outline: selected && editable ? '2px solid var(--color-accent)' : undefined }}
        onDoubleClick={(event) => { event.preventDefault(); extension.options.onPreview?.(node.attrs.src); }}
        onClick={() => { const pos = getPos(); if (editable && typeof pos === 'number') editor.chain().focus().setNodeSelection(pos).run(); }} />
      {selected && editable && <button type="button" aria-label="拖动调整图片大小" title="拖动调整图片大小"
        className="absolute -bottom-1 -right-1 size-5 touch-none cursor-nwse-resize rounded border-2 border-white bg-accent shadow"
        onPointerDown={(event) => {
          event.preventDefault(); event.stopPropagation();
          const current = image.current?.getBoundingClientRect().width;
          if (!current) return;
          drag.current = { x: event.clientX, width: current, next: current };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          drag.current.next = clamp(drag.current.width + event.clientX - drag.current.x);
          setPreviewWidth(drag.current.next);
        }}
        onPointerUp={() => {
          if (drag.current && drag.current.next !== drag.current.width) updateAttributes({ width: drag.current.next });
          drag.current = null; setPreviewWidth(null);
        }}
        onPointerCancel={() => { drag.current = null; setPreviewWidth(null); }} />}
    </div>
    {selected && editable && <div role="toolbar" aria-label="图片操作" className="mt-2 flex w-fit max-w-full flex-wrap items-center gap-1 rounded-lg border border-line bg-surface-1 p-1 text-xs shadow-sm"
      onMouseDown={(event) => event.preventDefault()}>
      <button type="button" aria-label="图片左对齐" title="左对齐" className="rounded p-2 hover:bg-surface-2" onClick={() => updateAttributes({ align: 'left' })}><AlignLeft className="size-4" /></button>
      <button type="button" aria-label="图片居中" title="居中" className="rounded p-2 hover:bg-surface-2" onClick={() => updateAttributes({ align: 'center' })}><AlignCenter className="size-4" /></button>
      <button type="button" aria-label="图片通栏" title="通栏" className="rounded p-2 hover:bg-surface-2" onClick={() => updateAttributes({ align: 'full', width: null })}><Maximize2 className="size-4" /></button>
      <button type="button" aria-label="缩小图片" title="缩小图片" className="rounded p-2 hover:bg-surface-2" onClick={() => resize(1 / SCALE_STEP)}><Minus className="size-4" /></button>
      <span className="min-w-12 text-center text-ink-3">{width ? `${width}px` : '原始尺寸'}</span>
      <button type="button" aria-label="放大图片" title="放大图片" className="rounded p-2 hover:bg-surface-2" onClick={() => resize(SCALE_STEP)}><Plus className="size-4" /></button>
      <button type="button" aria-label="恢复图片原始尺寸" title="恢复原始尺寸" className="rounded p-2 hover:bg-surface-2" onClick={() => updateAttributes({ width: null })}><RotateCcw className="size-4" /></button>
      <button type="button" aria-label="预览图片" title="预览" className="rounded p-2 hover:bg-surface-2" onClick={() => extension.options.onPreview?.(node.attrs.src)}><Eye className="size-4" /></button>
      <label title="替换图片" className="cursor-pointer rounded p-2 hover:bg-surface-2">{replacing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}<input aria-label="替换图片" type="file" accept="image/*" className="hidden" disabled={replacing} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file) return;
        setReplacing(true); api.uploadFile(file).then(({ url }) => updateAttributes({ src: url }))
          .catch((error) => toast.error(`替换图片失败：${error instanceof Error ? error.message : '请稍后重试'}`)).finally(() => setReplacing(false));
      }} /></label>
      <button type="button" aria-label="删除图片" title="删除" className="rounded p-2 text-danger hover:bg-surface-2" onClick={deleteNode}><Trash2 className="size-4" /></button>
    </div>}
    {editable && selected ? <input aria-label="图片图注" value={node.attrs.caption || ''} placeholder="添加图注…" className="mt-1 w-full border-0 bg-transparent text-center text-xs text-ink-3 outline-none placeholder:text-ink-4"
      onMouseDown={(event) => event.stopPropagation()} onChange={(event) => updateAttributes({ caption: event.target.value })} />
      : node.attrs.caption ? <figcaption className="mt-1 text-center text-xs text-ink-3">{node.attrs.caption}</figcaption> : null}
  </NodeViewWrapper>;
}
export const ResizableImage = TipTapImage.extend<ImageOptions & { onPreview?: (src: string) => void }>({
  addAttributes() {
    return { ...this.parent?.(), width: {
      default: null,
      parseHTML: (element) => imageWidth(element.getAttribute('width')),
      renderHTML: (attrs) => imageWidth(attrs.width) ? { width: imageWidth(attrs.width) } : {},
    }, align: {
      default: 'left', parseHTML: (element) => element.getAttribute('data-align') || 'left',
      renderHTML: (attrs) => attrs.align && attrs.align !== 'left' ? { 'data-align': attrs.align } : {},
    }, caption: {
      default: '', parseHTML: (element) => element.getAttribute('data-caption') || '',
      renderHTML: (attrs) => attrs.caption ? { 'data-caption': attrs.caption } : {},
    } };
  },
  addStorage() { return { ...this.parent?.(), markdown: imageMarkdown }; },
  addNodeView() { return ReactNodeViewRenderer(ImageView); },
});
