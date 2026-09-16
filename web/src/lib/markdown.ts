// Markdown 文本的轻量处理：只做「提取可读摘要 / 统计图片」这类不需要完整解析的事情。
// 正文渲染统一交给 DocumentEditor（TipTap 所见即所得），这里不产出 HTML。

/**
 * 导入类文档（飞书 / 钉钉 / 网页）常残留 HTML 元信息，渲染后会变成正文里的脏文本。
 * 只清理几乎不可能属于正文的标签，保留其他内容原样。
 */
export function stripHtmlNoise(markdown: string): string {
  return markdown
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(html|body|head|title|meta|link|base)\b[^>]*>/gi, '')
    .trim();
}

/** 统计正文里的图片数量（含 HTML <img> 与 Markdown ![](...) 两种写法） */
export function countImages(markdown: string): number {
  if (!markdown) return 0;
  const md = (markdown.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length;
  const html = (markdown.match(/<img\b/gi) ?? []).length;
  return md + html;
}

/** 把 Markdown 压成一行纯文本摘要：剥掉标记符号，图片折叠成「[图片]」占位 */
export function markdownSummary(markdown: string, limit = 140): string {
  if (!markdown.trim()) return '';
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块整块去掉
    .replace(/`([^`]+)`/g, '$1')              // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]') // 图片
    .replace(/<img\b[^>]*>/gi, '[图片]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // 链接只留文字
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')       // 标题井号
    .replace(/^\s{0,3}>\s?/gm, '')            // 引用
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')// 列表符号
    .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, ' ')// 分割线
    .replace(/<[^>]+>/g, ' ')                 // 兜底：残余 HTML 标签
    .replace(/[*_~]/g, '')                    // 强调符号
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
