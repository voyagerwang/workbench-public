/**
 * [INPUT]: 本地 PDF 地址、PDF.js 与宿主宽度（PPT 也使用转换后的 PDF）
 * [OUTPUT]: 按页渲染、跳页、缩放和全屏查看器
 * [POS]: 附件共用阅读组件；仅渲染当前页，翻页不写回文档，取消过时渲染任务
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, RotateCw } from 'lucide-react';
import { Dialog, DialogContent } from '@/ui/dialog';
GlobalWorkerOptions.workerSrc = workerUrl;

function PageCanvas({ pdf, page, zoom }: { pdf: PDFDocumentProxy; page: number; zoom: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(true);
  useEffect(() => {
    const element = host.current!;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!width) return;
    let cancelled = false;
    let render: RenderTask | undefined;
    setRendering(true); setError('');
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `第 ${page} 页`);
    const container = host.current!.querySelector('[data-pdf-canvas]')!;
    // 保留当前画布及高度；新页在离屏画布中完成后再替换，避免外层滚动位置因高度塌缩被截断。
    void pdf.getPage(page).then(async (value) => {
      if (cancelled) return;
      const natural = value.getViewport({ scale: 1 });
      const fit = Math.max(1, width - 16) / natural.width * zoom;
      const ratio = Math.min(window.devicePixelRatio || 1, 2, 8192 / (Math.max(natural.width, natural.height) * fit), Math.sqrt(16_000_000 / (natural.width * natural.height * fit * fit)));
      const viewport = value.getViewport({ scale: fit * ratio });
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      canvas.style.width = `${viewport.width / ratio}px`; canvas.style.height = `${viewport.height / ratio}px`;
      render = value.render({ canvas, viewport });
      await render.promise;
      if (!cancelled) { container.replaceChildren(canvas); setRendering(false); }
    }).catch((reason: Error) => { if (!cancelled && reason.name !== 'RenderingCancelledException') { setError('这一页未能显示，请切换页面或重新打开预览'); setRendering(false); } });
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, page, width, zoom]);
  return <div ref={host} className="relative min-h-32 min-w-0 overflow-auto bg-surface-2 p-2" style={{ maxHeight: '70dvh' }}>
    {rendering && <p role="status" className="absolute left-3 top-3 rounded bg-surface-1 px-2 text-xs">正在渲染第 {page} 页…</p>}
    {error && <p role="alert" className="p-3 text-xs text-danger">{error}</p>}
    <div data-pdf-canvas className="w-max min-w-full [&>canvas]:mx-auto [&>canvas]:bg-white" />
  </div>;
}
export default function PdfPreview({ url, name }: { url: string; name: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [full, setFull] = useState(false);
  useEffect(() => {
    let active = true; setPdf(null); setPage(1); setError('');
    const task = getDocument({ url, isEvalSupported: false, cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/' });
    void task.promise.then((value) => { if (active) setPdf(value); }).catch((reason: Error) => {
      if (active) setError(reason.name === 'PasswordException' ? '文件受密码保护，请下载后打开或导入无密码版本' : '无法读取预览，请重试或下载原文件');
    });
    return () => { active = false; void task.destroy(); };
  }, [url, retry]);
  if (error) return <div role="alert" className="p-3 text-xs text-danger">{error}<button className="ml-2 underline" onClick={() => setRetry((value) => value + 1)}>重试预览</button></div>;
  if (!pdf) return <p role="status" className="p-3 text-xs text-ink-3">正在加载文件预览…</p>;
  const go = (next: number) => { if (Number.isFinite(next)) setPage(Math.max(1, Math.min(pdf.numPages, Math.trunc(next)))); };
  const content = <div data-file-reader className="min-w-0 bg-surface-1 text-ink" tabIndex={0} onKeyDown={(event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(page - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); go(page + 1); }
  }}>
    <div role="toolbar" aria-label="文件翻页" className="flex flex-wrap items-center justify-center gap-1 border-y border-line p-2 text-xs [&_button]:rounded [&_button]:p-2 [&_button:hover]:bg-surface-2 [&_button:disabled]:opacity-30">
      <button type="button" aria-label="上一页" disabled={page === 1} onClick={() => go(page - 1)}><ChevronLeft className="size-4" /></button>
      <label className="flex items-center gap-1">第<input aria-label="跳转页码" type="number" min={1} max={pdf.numPages} value={page}
        onChange={(event) => { if (event.target.value) go(Number(event.target.value)); }} className="w-12 rounded border border-line bg-surface-2 px-1 py-1 text-center" />页 / {pdf.numPages} 页</label>
      <button type="button" aria-label="下一页" disabled={page === pdf.numPages} onClick={() => go(page + 1)}><ChevronRight className="size-4" /></button>
      <button type="button" aria-label="缩小页面" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}><Minus className="size-4" /></button>
      <span className="w-9 text-center">{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="放大页面" disabled={zoom >= 2} onClick={() => setZoom((value) => Math.min(2, value + 0.25))}><Plus className="size-4" /></button>
      <button type="button" aria-label="页面适应宽度" onClick={() => setZoom(1)}><RotateCw className="size-4" /></button>
      {!full && <button type="button" aria-label="全屏查看文件" onClick={() => setFull(true)}><Maximize2 className="size-4" /></button>}
    </div>
    <PageCanvas pdf={pdf} page={page} zoom={zoom} />
  </div>;
  return <>{!full && content}<Dialog open={full} onOpenChange={setFull}><DialogContent title={name} aria-describedby={undefined}
    className="max-h-[100dvh] w-screen max-w-none overflow-auto rounded-none bg-surface-1 px-2 pb-2 pt-10 sm:px-6">{full && content}</DialogContent></Dialog></>;
}
