import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';

/** 匹配 http/https 链接（URL 里不会出现的空白与尖括号/引号作为边界） */
const URL_RE = /(https?:\/\/[^\s<>"'`]+)/g;

/** URL 末尾可能误粘的标点，从链接尾部剥掉、保留为普通文本 */
const TRAILING_PUNCT = /[.,;:!?)\]}'”』、。，；：！？…]+$/;

/**
 * 把纯文本里的 URL 渲染成可点击的 <a>（新标签打开），
 * 其余部分原样输出。用于提醒消息、任务标题这类「纯文本 + 可能带链接」的场景。
 */
export function linkify(text: string, keyPrefix = 'l'): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const raw = m[0];
    const punct = TRAILING_PUNCT.exec(raw);
    const tail = punct ? punct[0] : '';
    const url = raw.slice(0, raw.length - tail.length);
    nodes.push(
      <a
        key={`${keyPrefix}-${i++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all font-medium text-accent underline decoration-accent underline-offset-2 hover:decoration-accent"
        onClick={(e) => e.stopPropagation()}
      >
        {url}
        <ExternalLink className="ml-0.5 inline size-2.5 align-middle opacity-70" />
      </a>,
    );
    if (tail) nodes.push(tail);
    last = start + raw.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
