/**
 * [INPUT]: TipTap 图片节点、Markdown 序列化器及 markdown-it 解析扩展点
 * [OUTPUT]: imageMarkdown，保留图片宽度、对齐与图注的 Markdown 读写契约
 * [POS]: 原图沿用 Markdown 图片，扩展属性使用受控 img 标签；仅放行图片白名单属性，保持其他 HTML 禁用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { defaultMarkdownSerializer } from 'prosemirror-markdown';
import type { MarkdownNodeSpec } from 'tiptap-markdown';

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function imageWidth(value: unknown): number | null {
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? Math.round(Math.min(width, 10000)) : null;
}
function imageTag(attrs: Record<string, unknown>) {
  return '<img' + ['src', 'alt', 'title', 'width', 'data-align', 'data-caption']
    .filter((key) => attrs[key] != null)
    .map((key) => ` ${key}="${escapeAttribute(String(attrs[key]))}"`).join('') + '>';
}
export const imageMarkdown: MarkdownNodeSpec = {
  serialize(state, node, parent, index) {
    const width = imageWidth(node.attrs.width);
    const align = ['center', 'full'].includes(node.attrs.align) ? node.attrs.align : null;
    const caption = String(node.attrs.caption || '').trim() || null;
    if (!width && !align && !caption) defaultMarkdownSerializer.nodes.image(state, node, parent, index);
    else state.write(imageTag({ ...node.attrs, width, 'data-align': align, 'data-caption': caption }));
    state.closeBlock(node);
  },
  parse: {
    setup(md) {
      // setup 会在每次 setContent 时调用；ruler 同名规则必须替换而非叠加。
      const rule: Parameters<typeof md.inline.ruler.before>[2] = (state, silent) => {
        const match = /^<img\b[^>]*>/i.exec(state.src.slice(state.pos));
        if (!match) return false;
        const image = new DOMParser().parseFromString(match[0], 'text/html').querySelector('img');
        const src = image?.getAttribute('src');
        if (!image || !src || !md.validateLink(src)) return false;
        if (!silent) {
          const token = state.push('html_inline', '', 0);
          token.content = imageTag({ src, alt: image.getAttribute('alt'), title: image.getAttribute('title'), width: imageWidth(image.getAttribute('width')),
            'data-align': image.getAttribute('data-align'), 'data-caption': image.getAttribute('data-caption') });
        }
        state.pos += match[0].length;
        return true;
      };
      try { md.inline.ruler.at('document_image', rule); }
      catch { md.inline.ruler.before('html_inline', 'document_image', rule); }
    },
  },
};
