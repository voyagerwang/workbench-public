/**
 * [INPUT]: 依赖 node:crypto；输入是外部连接器返回的 { title, content }，内容不可信
 * [OUTPUT]: 对外提供不以固定字数误判短文的 validateRemoteDocument、normalizeDocumentContent 与 contentHashOf
 * [POS]: server 的正文质量闸门。CLI、直连 MCP、代理 MCP 三条读取路径与阶段 1 导入服务共用本模块，
 *        防止上游错误 JSON、登录页、权限页被当作正文入库；清洗规则带版本号，规则升级必须换版本
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { createHash } from 'node:crypto';

/** 清洗规则版本：写入 source_documents.normalizer_version，规则变更时必须换新值 */
export const CONTENT_NORMALIZER_VERSION = 'content-normalizer-v1';

/** 仅用于加强短内容的壳页检查；长度本身不再决定正文是否可用。 */
export const MIN_FETCHED_CHARS = 500;

export type RemoteDocumentVerdict =
  | { verdict: 'ok' }
  | { verdict: 'suspect'; reason: string }
  | { verdict: 'error'; reason: string };

/**
 * 上游错误信封：连接器偶尔会把 {"success":false,"errorCode":...} 原样塞进正文字段。
 * 只有「整个正文就是一段 JSON」才按信封处理 —— 正文里讨论 JSON 是正常文档内容。
 */
function errorEnvelopeReason(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null; // 不是整体 JSON，按普通正文走
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.success === false) {
    return `上游返回错误信封：${String(parsed.errorMsg ?? parsed.error ?? parsed.errorCode ?? 'success=false')}`;
  }
  if (typeof parsed.errorCode === 'string' && parsed.errorCode
    && parsed.content == null && parsed.markdown == null && parsed.data == null) {
    return `上游返回错误信封：errorCode=${parsed.errorCode}`;
  }
  return null;
}

/** 登录 / 权限 / 失效过渡页特征。只对短正文生效：长文里出现这些词是正常内容 */
const GATE_PAGE_PATTERNS: Array<[RegExp, string]> = [
  [/扫码登录|请先登录|登录后查看|登录以继续|立即登录/, '登录页'],
  [/没有权限|无权访问|权限不足|申请查看权限|需要申请权限/, '权限提示页'],
  [/内容不存在|文档不存在|已被删除|链接已失效|页面不存在/, '内容失效页'],
  [/sign\s*in\s*to\s*(continue|view)/i, '登录页'],
  [/permission\s*denied|access\s*denied/i, '权限提示页'],
];
const TRUNCATION_PATTERNS = [/内容已截断|正文截断|仅显示前\s*\d+|truncated\s*[:：]?\s*true/i, /\.\.\.\s*查看更多$/];

/**
 * 清洗：只保留一份规范 Markdown，导入时算一次哈希，阅读器与检索共用同一份。
 * 纯函数、确定性：同一输入永远得到同一输出，这是 content_hash 稳定的前提。
 * 允许清除无语义样式标签、<br> 转换行；不得动链接文字、表格内容和标题层级。
 * 钉钉导出的 Markdown 常把列表 / 段落写成内联 HTML，这里转成等价 Markdown 结构，
 * 否则前端 html:false 渲染会把 <ul><li> 原样当文字显示。
 */
export function normalizeDocumentContent(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<\/?(span|font|o:p)\b[^>]*>/gi, '');
  // 结构性块级标签 → Markdown 等价物（只动标签，不动标签里的内容）
  text = text.replace(/<li[^>]*>/gi, '- ');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<\/?(ul|ol|p|div|dl|dd|dt)[^>]*>/gi, '\n');
  text = text.replace(/<h[1-6][^>]*>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n');
  // 常见实体；其余实体保持原样，不猜
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** sha256（hex）。调用方传入的是 normalizeDocumentContent 的输出 */
export function contentHashOf(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * 校验远程文档正文，判定 ok / suspect / error。无副作用，可对同输入反复调用。
 *
 * 1. 正文整体是上游错误信封（success=false 或 errorCode）→ error，绝不当正文；
 * 2. 空正文 → error；
 * 3. 短正文且命中登录/权限/失效页特征 → error；
 * 4. 明确带截断标记 → suspect；
 * 5. 其余非空正文（包括合法短文）→ ok。
 */
export function validateRemoteDocument(input: { title?: string | null; content: string }): RemoteDocumentVerdict {
  const envelope = errorEnvelopeReason(input.content);
  if (envelope) return { verdict: 'error', reason: envelope };

  const normalized = normalizeDocumentContent(input.content);
  if (!normalized) return { verdict: 'error', reason: '文档内容为空或尚未就绪' };

  const charCount = [...normalized].length;
  if (charCount < MIN_FETCHED_CHARS) {
    for (const [pattern, label] of GATE_PAGE_PATTERNS) {
      if (pattern.test(normalized)) return { verdict: 'error', reason: `疑似${label}，不是文档正文` };
    }
  }
  if (TRUNCATION_PATTERNS.some((pattern) => pattern.test(normalized))) return { verdict: 'suspect', reason: '上游正文带有明确截断标记，需补全后使用' };
  return { verdict: 'ok' };
}
