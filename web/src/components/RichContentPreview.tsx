import { useMemo, useState, type MouseEvent } from 'react';
import { marked } from 'marked';
import { cn } from '@/lib/utils';
import { ImageLightbox } from '@/components/ImageLightbox';

function safeMarkdown(markdown: string): string {
  // 先转义原始 HTML，再解析 Markdown，防止随手记内容注入任意标签。
  const escaped = markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = marked.parse(escaped, { gfm: true, breaks: true }) as string;
  if (typeof DOMParser === 'undefined') return html;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on') || attr.name === 'style') el.removeAttribute(attr.name);
    }
    if (el instanceof HTMLAnchorElement) {
      const href = el.getAttribute('href') ?? '';
      if (!/^(https?:|mailto:|\/)/i.test(href)) el.removeAttribute('href');
      else { el.target = '_blank'; el.rel = 'noreferrer'; }
    }
    if (el instanceof HTMLImageElement) {
      const src = el.getAttribute('src') ?? '';
      if (!/^(https?:|\/api\/files\/)/i.test(src)) el.remove();
      else {
        el.loading = 'lazy';
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('title', '点击放大');
      }
    }
  }
  return doc.body.innerHTML;
}

export function RichContentPreview({ markdown, fallback, className }: {
  markdown: string;
  fallback: string;
  className?: string;
}) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const html = useMemo(() => safeMarkdown(markdown), [markdown]);

  const openImage = (target: EventTarget | null) => {
    if (target instanceof HTMLImageElement && target.src) setPreviewSrc(target.src);
  };

  if (!markdown.trim()) {
    return <p className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed', className)}>{fallback}</p>;
  }

  return (
    <>
      <div
        className={cn('md-body fragment-rich min-w-0 text-sm leading-relaxed', className)}
        onClick={(e: MouseEvent<HTMLDivElement>) => openImage(e.target)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') openImage(e.target);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <ImageLightbox src={previewSrc} onOpenChange={(open) => !open && setPreviewSrc(null)} />
    </>
  );
}
