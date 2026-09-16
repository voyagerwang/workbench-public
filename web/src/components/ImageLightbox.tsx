/**
 * [INPUT]: 图片地址与 Radix Dialog，预览状态独立于文档保存
 * [OUTPUT]: ImageLightbox，按钮/滚轮缩放、拖动平移与适应窗口
 * [POS]: 文档共用大图查看器；切换图片时重置视图，查看缩放不修改正文图片尺寸
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useRef, useState } from 'react';
import { Minus, Plus, Scan } from 'lucide-react';
import { Dialog, DialogContent } from '@/ui/dialog';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.25;
function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const bounded = (x: number, y: number, zoom: number) => {
    const maxX = Math.max(0, ((image.current?.clientWidth || 0) * zoom - (viewport.current?.clientWidth || 0)) / 2);
    const maxY = Math.max(0, ((image.current?.clientHeight || 0) * zoom - (viewport.current?.clientHeight || 0)) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  };
  const zoom = (next: number) => {
    const value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    setScale(value); setOffset((current) => bounded(current.x, current.y, value));
  };
  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }); };
  return <div className="flex h-full min-h-0 w-full flex-col text-white" onKeyDown={(event) => {
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(scale * ZOOM_STEP); }
    if (event.key === '-') { event.preventDefault(); zoom(scale / ZOOM_STEP); }
    if (event.key === '0') { event.preventDefault(); reset(); }
  }}>
    <div ref={viewport} data-image-viewport className="flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden"
      style={{ cursor: scale > 1 ? 'grab' : 'zoom-in' }}
      onWheel={(event) => { event.stopPropagation(); zoom(scale * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)); }}
      onDoubleClick={() => scale === 1 ? zoom(2) : reset()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); drag.current = { x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start) setOffset(bounded(start.startX + event.clientX - start.x, start.startY + event.clientY - start.y, scale));
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <img ref={image} src={src} alt={alt} draggable={false} className="block max-h-full max-w-full shrink-0 object-contain"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} />
    </div>
    <div role="toolbar" aria-label="图片预览缩放" className="z-10 mt-3 flex shrink-0 items-center justify-center gap-2">
      <button aria-label="缩小预览" className="rounded-lg bg-white/10 p-3 hover:bg-white/20 disabled:opacity-40" disabled={scale <= MIN_ZOOM} onClick={() => zoom(scale / ZOOM_STEP)}><Minus className="size-4" /></button>
      <output aria-label="预览比例" className="w-14 text-center text-sm tabular-nums">{Math.round(scale * 100)}%</output>
      <button aria-label="放大预览" className="rounded-lg bg-white/10 p-3 hover:bg-white/20 disabled:opacity-40" disabled={scale >= MAX_ZOOM} onClick={() => zoom(scale * ZOOM_STEP)}><Plus className="size-4" /></button>
      <button aria-label="适应窗口" title="适应窗口（0）" className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2.5 text-sm hover:bg-white/20" onClick={reset}><Scan className="size-4" />适应窗口</button>
    </div>
    <p className="mt-2 text-center text-xs text-white/60">滚轮缩放 · 放大后拖动查看 · 双击切换缩放</p>
  </div>;
}
export function ImageLightbox({ src, alt = '随手记图片', onOpenChange }: {
  src: string | null; alt?: string; onOpenChange: (open: boolean) => void;
}) {
  return <Dialog open={Boolean(src)} onOpenChange={onOpenChange}>
    <DialogContent title="图片预览" aria-describedby={undefined}
      className="flex h-[100dvh] w-screen max-h-none max-w-none items-center justify-center overflow-hidden rounded-none border-0 bg-black p-4 pt-12 [&>button]:bg-white/10 [&>button]:text-white [&>button]:hover:bg-white/20 sm:p-8 sm:pt-12">
      {src && <ImagePreview key={src} src={src} alt={alt} />}
    </DialogContent>
  </Dialog>;
}
