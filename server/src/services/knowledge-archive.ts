/**
 * 知识存档：存储 + 公开链接导入。
 *
 * 从 `routes/knowledge.ts` 拆出来的原因：助手工具（`workbench_archive_url` 等）需要
 * 走同一套抓取与落库逻辑，而服务层反向依赖路由层会让依赖关系打结。
 * 这里只管「一条存档怎么存、一个链接怎么变成存档」，HTTP 语义留在路由里。
 *
 * 链接导入三不变量（docs/social-link-skill-capture-plan.md，Codex 五审 APPROVED）：
 * 1. 识别结果可信——JS 渲染站点的页面壳判 failed（detectPageShell），不以 indexed 假成功；
 * 2. 幂等——canonical_url 部分唯一索引，indexed 重复导入返回 duplicate、失败重试更新原行；
 * 3. fail-closed——去重索引未就绪时拒绝一切链接导入写入，不静默降级。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { db, now, knowledgeDedupeReady } from '../db.js';
import { canonicalArchiveUrl } from './url-canonical.js';
import { feishuKbStatusCached, feishuSnapshotUrls } from './feishu-kb.js';
import { readRemoteKnowledge, type KnowledgeProvider } from './knowledge-connectors.js';

type ArchiveRow = Record<string, unknown>;

export const archiveShape = z.object({
  title: z.string().max(500).default(''),
  content: z.string().max(2_000_000).default(''),
  sourceKind: z.enum(['manual', 'feishu', 'dingtalk', 'url', 'folder', 'conversation']).default('manual'),
  sourceUrl: z.string().max(4000).nullable().default(null),
  fileName: z.string().max(1000).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
  status: z.enum(['indexed', 'needs_auth', 'failed', 'remote']).default('indexed'),
  error: z.string().max(2000).nullable().default(null),
});

/**
 * 写入存档的输入类型。
 *
 * 只有 tags 可省略：多数调用点（文件导入、空间同步）没有标签概念，
 * 逐个补 `tags: []` 只是噪音。`archiveShape.parse()` 的 `.default([])` 帮不上忙——
 * 这些调用点直接传对象字面量，压根不经过 parse。
 */
export type ArchiveInput = Omit<z.infer<typeof archiveShape>, 'tags'> & {
  tags?: string[] | null;
  /** 链接幂等身份（url-canonical.ts 归一化）；只有链接导入路径会填，其余调用点为 null */
  canonicalUrl?: string | null;
};

/**
 * 标签归一：去空白、去重（忽略大小写，但保留用户输入的写法）。
 * 「K12」和「k12」应当是同一个标签，否则过滤时会出现两个看起来一样的入口。
 */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const text = raw.trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function archive(row: ArchiveRow) {
  const provider = catalogProvider(row.source_url);
  return {
    id: Number(row.id), title: String(row.title), content: String(row.content),
    source_kind: String(row.source_kind), source_url: row.source_url == null ? null : String(row.source_url),
    file_name: row.file_name == null ? null : String(row.file_name), tags: parseTags(row.tags),
    status: String(row.status),
    error: row.error == null ? null : String(row.error), created_at: String(row.created_at), updated_at: String(row.updated_at),
    // 派生字段，不可写：云端知识空间同步出来的是「一整篇 Markdown 链接目录」，
    // 不是真正落了正文的文档。以前它和普通文档一样标 `indexed`，页面显示「已索引」，
    // 用户会以为两千多篇都能搜到正文 —— 实际能检索的是 0 篇。这里把真相显式暴露出去。
    is_catalog: provider !== null,
    catalog: provider
      ? { provider, total: catalogTotal(String(row.content ?? '')), saved_bodies: 0, search_available: false }
      : null as CatalogInfo | null,
  };
}

export type ArchiveView = ReturnType<typeof archive>;

export type CatalogInfo = {
  provider: 'feishu' | 'dingtalk';
  /** 目录里列出的文档篇数 */
  total: number;
  /**
   * 这个目录列出的文档里，本地已保存正文的篇数。
   *
   * 不是「该 provider 一共存了多少篇」：同步范围可以是整个空间、单个空间、某个节点甚至单篇，
   * 而每次同步都覆盖 provider 唯一的目录存档。用 provider 级总数会算出
   * 「目录 20 篇，其中 821 篇正文可检索」这种自相矛盾的话。
   */
  saved_bodies: number;
  /**
   * 正文检索通道当前是否可用。
   *
   * 钉钉正文落在本地 kb_snapshot_fts，恒为 true；飞书正文检索走 :8792 服务，离线就是 false。
   * 与 `saved_bodies` 分开存：前者是「存了几篇」，后者是「现在能不能搜」，
   * 混成一个数字就会出现「存了 800 篇但一篇也搜不到」无法表达的情况。
   */
  search_available: boolean;
};

const CATALOG_URL = /^(feishu|dingtalk):\/\/wiki-catalog$/;

/**
 * 目录存档的判定：同步云端知识空间时，整份目录被拼成一条 `source_url = <provider>://wiki-catalog` 的存档。
 *
 * 刻意不改 `status` 枚举（`schema.sql` 的 CHECK 只有 indexed/needs_auth/failed/remote），
 * 加一个 `catalog_only` 会触发整表重建，代价远超收益。先派生，等数据模型稳定后再正式扩枚举。
 */
export function catalogProvider(sourceUrl: unknown): 'feishu' | 'dingtalk' | null {
  const match = CATALOG_URL.exec(String(sourceUrl ?? ''));
  return match ? (match[1] as 'feishu' | 'dingtalk') : null;
}

/**
 * 目录里的文档篇数。
 *
 * 列表接口只返回正文前 800 字符，所以不能靠数 `- [` 行（会被截断低估）。
 * 目录正文头部的「共 N 个分组 / M 篇文档」在前 200 字符内，是唯一在列表和详情下都可靠的来源。
 * 历史存档里飞书写的是「个空间」、钉钉写的是「个分组」，两种都得认。
 */
function catalogTotal(content: string): number {
  const header = /共\s*\d+\s*个(?:分组|空间)\s*\/\s*(\d+)\s*篇文档/.exec(content.slice(0, 400));
  if (header) return Number(header[1]);
  return (content.match(/^- \[/gm) ?? []).length;
}

/**
 * 链接归一化：去掉 hash / query / 末尾斜杠并统一小写。
 *
 * 目录里的钉钉链接带 `?utm_scene=team_space`，快照里存的是裸链接，
 * 不做归一化，交集永远是 0。
 */
function normalizeDocRef(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const cut = text.search(/[?#]/);
  return (cut < 0 ? text : text.slice(0, cut)).replace(/\/+$/, '').toLowerCase();
}

/**
 * 目录正文里列出的文档链接（归一化、去重）。
 *
 * 目录是一份 `- [标题](链接)` 的 Markdown 列表；同一篇文档可能被多个分组收录，所以要去重。
 * 必须用完整正文调用 —— 列表接口只给前 800 字符，在截断内容上解析会严重低估。
 */
export function catalogRefs(content: string): string[] {
  const refs = new Set<string>();
  for (const match of content.matchAll(/^- \[[^\]]*\]\(([^)\s]+)\)/gm)) {
    const ref = normalizeDocRef(match[1] ?? '');
    if (ref) refs.add(ref);
  }
  return [...refs];
}

/** 本地已保存正文的文档链接集合（同样归一化），用于和目录链接求交集 */
function localBodyRefs(provider: 'feishu' | 'dingtalk'): Set<string> {
  const refs = new Set<string>();
  if (provider === 'dingtalk') {
    const rows = db.prepare(`SELECT url FROM kb_snapshot_fts WHERE provider = 'dingtalk'`)
      .all() as Array<{ url: string | null }>;
    for (const row of rows) {
      const ref = normalizeDocRef(row.url ?? '');
      if (ref) refs.add(ref);
    }
    return refs;
  }
  for (const url of feishuSnapshotUrls()) {
    const ref = normalizeDocRef(url);
    if (ref) refs.add(ref);
  }
  return refs;
}

/** 正文检索通道是否可用；读的是缓存的健康状态，不向 :8792 发同步请求 */
function searchChannelAvailable(provider: 'feishu' | 'dingtalk'): boolean {
  // 钉钉正文落在本地 kb_snapshot_fts，没有外部依赖
  if (provider === 'dingtalk') return true;
  // 飞书正文检索走 :8792，服务离线时 searchFeishuKb 直接返回空 —— 那就是搜不到
  return feishuKbStatusCached()?.available === true;
}

/**
 * 补齐目录存档的统计字段（篇数 / 已存正文篇数 / 检索通道可用性）。
 *
 * 和 `archive()` 分开的原因：这两项需要读完整正文，而列表接口为了省带宽只返回前 800 字符，
 * 这里是回库取全文的地方。同步执行 —— 状态读缓存，主列表不能等 :8792。
 */
export function attachCatalogStats(views: ArchiveView[]): ArchiveView[] {
  const catalogs = views.filter((view): view is ArchiveView & { catalog: CatalogInfo } => view.catalog !== null);
  if (!catalogs.length) return views;

  const ids = catalogs.map((view) => view.id);
  const full = new Map<number, string>();
  const rows = db
    .prepare(`SELECT id, content FROM knowledge_archives WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as Array<{ id: number; content: string }>;
  for (const row of rows) full.set(row.id, row.content);

  const bodies = new Map<string, Set<string>>();
  const channels = new Map<string, boolean>();
  for (const provider of new Set(catalogs.map((view) => view.catalog.provider))) {
    bodies.set(provider, localBodyRefs(provider));
    channels.set(provider, searchChannelAvailable(provider));
  }

  for (const view of catalogs) {
    const content = full.get(view.id) ?? view.content;
    const refs = catalogRefs(content);
    const saved = bodies.get(view.catalog.provider) ?? new Set<string>();
    // 篇数也在这里重算：完整正文下才能给出准确值，列表视图里的只是 800 字符上的估算
    view.catalog.total = catalogTotal(content) || refs.length;
    view.catalog.saved_bodies = refs.reduce((count, ref) => (saved.has(ref) ? count + 1 : count), 0);
    view.catalog.search_available = channels.get(view.catalog.provider) ?? false;
  }
  return views;
}

export function getArchive(id: number) {
  const row = db.prepare('SELECT * FROM knowledge_archives WHERE id = ? AND deleted_at IS NULL').get(id) as ArchiveRow | undefined;
  if (!row) throw Object.assign(new Error('知识存档不存在'), { statusCode: 404 });
  return archive(row);
}

export function insertArchive(input: ArchiveInput) {
  const result = db.prepare(`
    INSERT INTO knowledge_archives (id, title, content, source_kind, source_url, canonical_url, file_name, tags, status, error)
    VALUES (sync_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.title || '未命名文档', input.content, input.sourceKind, input.sourceUrl, input.canonicalUrl ?? null, input.fileName,
    JSON.stringify(normalizeTags(input.tags ?? [])), input.status, input.error);
  return getArchive(Number(result.lastInsertRowid));
}

// ---------------------------------------------------------------------------
// 公开链接导入
// ---------------------------------------------------------------------------

function providerFor(url: URL): 'feishu' | 'dingtalk' | 'url' {
  const host = url.hostname.toLowerCase();
  if (host.includes('feishu.cn') || host.includes('larksuite.com')) return 'feishu';
  if (host.includes('dingtalk.com') || host.includes('alidocs.com')) return 'dingtalk';
  return 'url';
}

export function providerLabel(provider: KnowledgeProvider): string {
  return provider === 'feishu' ? '飞书' : '钉钉';
}

function privateAddress(address: string): boolean {
  if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  if (!isIP(address)) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('知识库地址格式不正确'), { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('仅支持 http(s) 地址'), { statusCode: 400 });
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw Object.assign(new Error('无法解析该域名，请检查链接是否正确'), { statusCode: 400 });
  }
  if (!addresses.length || addresses.some((item) => privateAddress(item.address))) {
    throw Object.assign(new Error('该地址指向内网，出于安全考虑不予访问'), { statusCode: 400 });
  }
  return url;
}

/**
 * 公开网页抓取默认 UA。
 *
 * 不能用自报家门的 UA：微信公众号等站点对非浏览器 UA 直接返回「环境异常/未知错误」的
 * 验证页（正文为空、长度极短），会被下游误判成「需要登录」，报错信息完全指错方向。
 * 这里统一伪装成常规浏览器，只有调用方显式指定时才覆盖。
 */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchPublicDocument(start: URL, userAgent = BROWSER_UA): Promise<Response> {
  let url = start;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(url.toString());
    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'manual', signal: AbortSignal.timeout(20_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('远端重定向缺少目标地址');
      url = new URL(location, url);
      continue;
    }
    return response;
  }
  throw new Error('远端重定向次数过多');
}

/**
 * 读取响应正文，超过上限就中断。
 *
 * 上限按「解压后的字节」计：content-length 报的是压缩后的大小（公众号文章常见 700KB → 解压 3MB+），
 * 拿 content-length 做闸门会漏。12 MB 对富文本页面足够，再大基本都是脚本/内联资源堆出来的噪声。
 */
async function readLimitedText(response: Response, maxBytes = 12_000_000): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  // 只在「肯定超限」时提前拒绝；没有该头（chunked）或值偏小时仍以实际读数为准
  if (declared > maxBytes * 4) throw new Error(`远端文档超过 ${Math.round(maxBytes / 1_000_000)} MB 限制`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error(`远端文档超过 ${Math.round(maxBytes / 1_000_000)} MB 限制`); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function decodeEntities(text: string): string {
  return text.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)));
}

/**
 * 取标题，按可靠度依次回退。
 *
 * `<title>` 放最后不是随便排的：微信公众号的 `<title>` 是空的，真标题在 `var msg_title`
 * 和 og:title 里；反过来很多站点的 `<title>` 又带「 - 站点名」之类的后缀。
 * 顺序：og:title → <h1> → var msg_title → <title>。
 */
function extractTitle(html: string): string {
  const pick = (raw: string | undefined | null): string =>
    decodeEntities(raw ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const og = pick(html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i)?.[1]);
  if (og) return og;
  const h1 = pick(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  if (h1 && h1.length <= 200) return h1;
  // 公众号：标题只存在于页面脚本里
  const msgTitle = pick(html.match(/var\s+msg_title\s*=\s*['"]([^'"]+)['"]/i)?.[1]
    ?? html.match(/var\s+msg_title\s*=\s*'([^']*)'\s*\.html\(\)/i)?.[1]);
  if (msgTitle) return msgTitle;
  return pick(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
}

/**
 * 从整页 HTML 里切出正文容器。
 *
 * 不做这一步的话，导进知识库的是「整页文本」：公众号文章会带上一大段「微信扫一扫 /
 * 赞 在看 分享 收藏 听过」的外壳，以及被剥掉标签后留下的一串孤立标点。这些噪声会进 FTS，
 * 让检索命中一堆无关内容。
 *
 * 用标签配平而不是简单正则截取：容器内部必然有嵌套 div，粗暴地截到下一个 `</div>`
 * 会丢掉大半篇文章。
 */
function extractMainHtml(html: string): string {
  // 按优先级排列，命中靠前的就用；公众号的 js_content 放在最前面
  const patterns = [
    /<div[^>]+id=["']js_content["'][^>]*>/i,
    /<div[^>]+class=["'][^"']*rich_media_content[^"']*["'][^>]*>/i,
    /<article\b[^>]*>/i,
    /<main\b[^>]*>/i,
    /<div[^>]+role=["']main["'][^>]*>/i,
    /<div[^>]+id=["'](content|article|main)["'][^>]*>/i,
    /<div[^>]+class=["'][^"']*(post-content|article-content|entry-content|markdown-body)[^"']*["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match) continue;
    const start = match.index;
    const openTag = match[0];
    // 自闭合或空容器没有意义
    if (/\/>\s*$/.test(openTag)) continue;
    const tagName = (openTag.match(/^<(\w+)/i)?.[1] ?? 'div').toLowerCase();
    const openRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
    let depth = 0;
    let cursor = start;
    let end = -1;
    // 从容器起点往后扫，配平同名标签。depth 回到 0 即找到闭合位置。
    while (cursor < html.length) {
      openRe.lastIndex = cursor;
      closeRe.lastIndex = cursor;
      const openAt = openRe.exec(html);
      const closeAt = closeRe.exec(html);
      const hasOpen = openAt && openAt.index !== undefined;
      const hasClose = closeAt && closeAt.index !== undefined;
      if (!hasOpen && !hasClose) break;
      const openIdx = hasOpen ? openAt.index : Number.POSITIVE_INFINITY;
      const closeIdx = hasClose ? closeAt.index : Number.POSITIVE_INFINITY;
      // 容器自身的开标签要算进 depth，否则第一次遇到闭标签就会误判为结束
      if (openIdx === start) { depth += 1; cursor = start + openTag.length; continue; }
      if (openIdx < closeIdx) { depth += 1; cursor = openIdx + openAt![0].length; continue; }
      depth -= 1;
      cursor = closeIdx + closeAt![0].length;
      if (depth <= 0) { end = cursor; break; }
    }
    if (end > start) {
      const slice = html.slice(start, end);
      // 切出来的得真有内容，别为了「更干净」把文章切没了
      if (slice.replace(/<[^>]+>/g, '').trim().length >= 120) return slice;
    }
  }
  return html;
}

function htmlText(html: string): { title: string; content: string } {
  const title = extractTitle(html);
  const cleaned = extractMainHtml(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return { title, content: decodeEntities(cleaned).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim() };
}

/** 单条存档正文的入库上限：再长对检索也没意义，只会拖慢 FTS 和卡片预览 */
const MAX_ARCHIVE_CONTENT = 300_000;

// 权限页特征要足够强：普通文档里出现「登录」「permission」等词很常见，弱匹配会把公开内容误判成需要授权。
const AUTH_WALL = /请登录|立即登录|登录后(查看|可见)|扫码登录|短信登录|验证码登录|微信登录|钉钉登录|飞书登录|需要授权|无权访问|没有(访问)?权限|访问受限|sign\s*in\s*to|log\s*in\s*to|permission\s*denied|access\s*denied/i;
// 反爬验证页：不是权限问题，换账号登录也没用，别让用户去「设置 → 文档读取权限」白折腾一趟
const BOT_WALL = /环境异常|完成验证后|请稍后再试|未知错误|访问过于频繁|请完成安全验证|人机验证|滑动验证|请开启 ?JavaScript|浏览器版本过低|enable javascript|are you a human|unusual traffic/i;

/**
 * 判定抓回来的页面到底能不能用。
 *
 * 关键是**分开两种「拿不到」**：需要登录（用户能解决）与被反爬拦截（用户解决不了，得我们换策略）。
 * 早期版本把「正文太短」一律当成需要登录，结果公众号文章被反爬返回 18 个字的「未知错误」时，
 * 界面提示用户去开放访问权限——完全指错方向，还让人以为是自己没配好。
 */
export function classifyFetch(content: string): 'ok' | 'auth' | 'blocked' {
  const head = content.slice(0, 1000);
  if (AUTH_WALL.test(head)) return 'auth';
  if (BOT_WALL.test(head)) return 'blocked';
  // 短文本身不是失败证据：公告、FAQ、定义和操作提示经常只有几十字。
  // 空白或几乎没有正文的响应才交给 blocked，页面壳仍由 detectPageShell 独立判定。
  const meaningful = content.replace(/\s+/g, '').trim();
  if (meaningful.length === 0) return 'blocked';
  return 'ok';
}

// ---------------------------------------------------------------------------
// 页面壳判定（P0：社交媒体假成功修复，docs/social-link-skill-capture-plan.md）
// ---------------------------------------------------------------------------

/**
 * 已知「JS 渲染、裸 fetch 只能拿到页面框架」的站点表。
 * 壳特征词只对这些 hostname 生效：普通文章里出现「bilibili」不能成为拒绝理由，
 * 必须是「站点自身 + 只有导航页脚 + 无实质正文段」三者同时成立。
 */
const SPA_SHELL_SITES: Array<{ hosts: RegExp; marks: RegExp }> = [
  { hosts: /(^|\.)(xiaohongshu\.com|xhslink\.cn)$/, marks: /创作中心|业务合作|行吟信息科技|小红书/ },
  { hosts: /(^|\.)(bilibili\.com|b23\.tv)$/, marks: /bilibili|哔哩哔哩|下载客户端/i },
  { hosts: /(^|\.)douyin\.com$/, marks: /抖音|douyin|douyin\.com/i },
];

/** 通用壳判定的组合信号阈值：单独一个信号都不足以判 blocked（防误伤短文/FAQ/目录页） */
const SHELL_MIN_MAIN_PARAGRAPH = 200;   // 最长连续正文段低于此值
const SHELL_SHORT_LINE_RATIO = 0.6;     // 且短行（≤12字）占比高于此值
const SHELL_MAX_TOTAL = 1200;           // 且全文总量低于此值（真文章几乎不可能这么短还这么碎）

export type ShellMeta = { finalUrl?: string | null; contentType?: string | null };

/** 可诊断 reason：工具层把它带给模型/用户，说清到底哪个信号命中了 */
export type ShellVerdict = { shell: boolean; reason: string };

function shellSignals(content: string): { longest: number; shortRatio: number; total: number } {
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  // 「导航壳短行」= 又短又没有句末标点。FAQ 问答、公告正文虽然也短，但带句末标点，
  // 不算导航特征——否则短行 FAQ 会被通用规则误判成壳。
  // 句末标点集合：这些字符结尾的短行是「说话的内容」，不是导航
  const navPunctRe = /[。．！？?；;…：:）)」』》"']$/;
  const shortNavLines = lines.filter((line) => line.length <= 12 && !navPunctRe.test(line)).length;
  let longest = 0;
  for (const line of lines) longest = Math.max(longest, line.length);
  return {
    longest,
    shortRatio: lines.length ? shortNavLines / lines.length : 0,
    total: content.replace(/\s+/g, '').length,
  };
}

/**
 * 判定抓到的文本是不是「页面壳」。
 *
 * 站点规则：hostname 命中已知 JS 渲染站点 + 正文命中该站装饰词 + 无实质正文段 → shell。
 * 通用规则：三个低置信信号（长段过短、短行占比过高、总量过小）必须同时满足才判 shell，
 * reason 里带实测值，误判时可诊断。两路都要求「无实质正文段」，正常短文/FAQ/公告不受影响。
 */
export function detectPageShell(content: string, meta: ShellMeta): ShellVerdict {
  const { longest, shortRatio, total } = shellSignals(content);
  const noSubstance = longest < SHELL_MIN_MAIN_PARAGRAPH;
  const generic = noSubstance && shortRatio > SHELL_SHORT_LINE_RATIO && total < SHELL_MAX_TOTAL;
  const signals = `最长段=${longest}字 短行占比=${(shortRatio * 100).toFixed(0)}% 有效总长=${total}字`;

  let host = '';
  try { host = meta.finalUrl ? new URL(meta.finalUrl).hostname.toLowerCase() : ''; } catch { /* 解析失败按无站点处理 */ }
  const site = SPA_SHELL_SITES.find((entry) => entry.hosts.test(host));
  if (site && noSubstance && site.marks.test(content)) {
    return { shell: true, reason: `${host} 是 JS 渲染页面，只抓到页面框架（命中站点特征词；${signals}）` };
  }
  if (generic) {
    return { shell: true, reason: `正文呈导航壳特征且无实质段落（${signals}）` };
  }
  return { shell: false, reason: signals };
}

export type ImportUrlOutcome = ArchiveView & { duplicate?: boolean; retried?: boolean };

/**
 * 链接导入的幂等落库（canonical_url 唯一索引兜底，见 P0b）。
 * - 已有 indexed 记录 → 不新建，返回 duplicate:true
 * - 已有 failed/needs_auth/remote 记录 → 更新原行（重试语义），返回 retried:true
 * - 无记录 → 插入；撞唯一索引（理论竞态）时按 duplicate 处理
 */
function landUrlArchive(
  input: Omit<ArchiveInput, 'tags'>,
  tags: string[],
  canonical: string | null,
): ImportUrlOutcome {
  if (canonical) {
    const existing = db.prepare(`
      SELECT * FROM knowledge_archives WHERE canonical_url = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1
    `).get(canonical) as ArchiveRow | undefined;
    if (existing) {
      if (String(existing.status) === 'indexed') return { ...archive(existing), duplicate: true };
      const mergedTags = normalizeTags([...parseTags(existing.tags), ...tags]);
      db.prepare(`
        UPDATE knowledge_archives SET title = ?, content = ?, status = ?, error = ?, tags = ?, canonical_url = ?, updated_at = ?
        WHERE id = ?
      `).run(input.title || '未命名文档', input.content, input.status, input.error, JSON.stringify(mergedTags),
        canonical, now(), Number(existing.id));
      return { ...getArchive(Number(existing.id)), retried: true };
    }
  }
  try {
    return insertArchive({ ...input, tags, canonicalUrl: canonical });
  } catch (error) {
    if (canonical && /UNIQUE constraint failed/.test((error as Error).message)) {
      const existing = db.prepare(`
        SELECT * FROM knowledge_archives WHERE canonical_url = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1
      `).get(canonical) as ArchiveRow | undefined;
      if (existing) return { ...archive(existing), duplicate: true };
    }
    throw error;
  }
}

/**
 * 导入一个公开链接并落库。
 *
 * 失败也落库（status=failed / needs_auth），这样用户在知识库里能看到「有一条没成功」并重试，
 * 而不是静悄悄什么都不发生。
 *
 * P0 修复（docs/social-link-skill-capture-plan.md）：
 * - fail-closed：canonical 唯一索引未就绪时直接拒绝写入（503），绝不静默降级制造重复；
 * - 页面壳判定：JS 渲染站点（小红书/B站/抖音等）裸 fetch 只能拿到导航页脚壳，
 *   过去会以「indexed + 1156 字符导航文本」假成功，现在判 failed 并给可诊断 reason；
 * - 幂等：同一 canonical_url 重复导入不再产生重复行。
 */
export async function importUrlToArchive(rawUrl: string, tags: string[] = []): Promise<ImportUrlOutcome> {
  if (!knowledgeDedupeReady()) {
    throw Object.assign(
      new Error('存档去重索引未就绪，链接导入写入已暂停。请检查服务启动日志中 idx_knowledge_archives_canonical 的迁移错误，修复后重启。'),
      { statusCode: 503 },
    );
  }
  const url = await assertPublicUrl(rawUrl);
  const sourceKind = providerFor(url);
  const sourceUrl = url.toString();
  // 抓取前的快速通道：同链接已 indexed 就不再发请求（短链被反复转发时的典型场景）
  const inputCanonical = canonicalArchiveUrl(sourceUrl);
  if (inputCanonical) {
    const existing = db.prepare(`
      SELECT * FROM knowledge_archives WHERE canonical_url = ? AND deleted_at IS NULL AND status = 'indexed' ORDER BY id DESC LIMIT 1
    `).get(inputCanonical) as ArchiveRow | undefined;
    if (existing) return { ...archive(existing), duplicate: true };
  }
  try {
    const response = await fetchPublicDocument(url);
    if (!response.ok) throw new Error(`远端返回 HTTP ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    if (!/(text\/|application\/(json|xml|xhtml\+xml))/.test(type)) throw new Error(`暂不支持该文档类型：${type || '未知类型'}`);
    const rawContent = await readLimitedText(response);
    // 幂等身份以最终 URL 为准：短链（xhslink/b23.tv）重定向后的地址才指向真实内容
    const finalUrl = response.url || sourceUrl;
    const canonical = canonicalArchiveUrl(finalUrl) ?? inputCanonical;
    const parsed = type.includes('html') ? htmlText(rawContent) : { title: '', content: rawContent.trim() };
    const verdict = classifyFetch(parsed.content);
    if (verdict === 'ok') {
      const shell = detectPageShell(parsed.content, { finalUrl, contentType: type });
      if (shell.shell) {
        return landUrlArchive({
          title: parsed.title || url.hostname, content: '', sourceKind, sourceUrl, fileName: null,
          status: 'failed',
          error: `没有抓到正文：${shell.reason}。这类站点（社交/视频平台）需要浏览器或人工取出内容；可以让用户直接贴正文，或登记转写任务给执行 Agent。`,
        }, tags, canonical);
      }
    }
    // 需要授权且是飞书/钉钉：走已授权连接重读，用户不必去改文档权限
    if (verdict === 'auth' && sourceKind !== 'url') {
      try {
        const connected = await readRemoteKnowledge(sourceKind, sourceUrl);
        return landUrlArchive({
          title: connected.title, content: connected.content, sourceKind, sourceUrl, fileName: null,
          status: 'indexed', error: null,
        }, tags, canonical);
      } catch (error) {
        return landUrlArchive({
          title: parsed.title || url.hostname, content: '', sourceKind, sourceUrl, fileName: null,
          status: 'needs_auth',
          error: `${(error as Error).message}。请在“设置 → 文档读取权限”完成连接后重试。`,
        }, tags, canonical);
      }
    }
    return landUrlArchive({
      title: parsed.title || url.hostname,
      // 正文可能很长（整站导出的页面常见），截断后再入库，避免撑爆 FTS 与卡片预览
      content: verdict === 'ok' ? parsed.content.slice(0, MAX_ARCHIVE_CONTENT) : '',
      sourceKind, sourceUrl, fileName: null,
      status: verdict === 'ok' ? 'indexed' : verdict === 'auth' ? 'needs_auth' : 'failed',
      error: verdict === 'ok'
        ? null
        : verdict === 'auth'
          ? '这个网页需要登录。请在来源网站开放访问权限后重试。'
          : '这个站点拒绝了自动抓取（多半是反爬验证页）。公开链接也不一定能抓到，可以试试把正文复制给我，我直接存档。',
    }, tags, canonical);
  } catch (error) {
    const message = (error as Error).message;
    if (sourceKind !== 'url' && /HTTP (401|403)|unauthori[sz]ed|forbidden|登录|授权|权限/i.test(message)) {
      try {
        const connected = await readRemoteKnowledge(sourceKind, sourceUrl);
        return landUrlArchive({
          title: connected.title, content: connected.content, sourceKind, sourceUrl, fileName: null,
          status: 'indexed', error: null,
        }, tags, inputCanonical);
      } catch (connectorError) {
        return landUrlArchive({
          title: url.hostname, content: '', sourceKind, sourceUrl, fileName: null,
          status: 'needs_auth', error: `${(connectorError as Error).message}。不需要公开文档，请在“设置 → 文档读取权限”完成连接。`,
        }, tags, inputCanonical);
      }
    }
    return landUrlArchive({
      title: url.hostname, content: '', sourceKind, sourceUrl, fileName: null,
      status: 'failed', error: message,
    }, tags, inputCanonical);
  }
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

export type KnowledgeHit = {
  id: number;
  title: string;
  content: string;
  status: string;
  source_kind: string | null;
  source_url: string | null;
};

/**
 * 标签精确匹配的 SQL 片段与参数构造。
 *
 * tags 存的是 JSON 数组文本（`["k12","教培"]`）。裸 `LIKE '%ai%'` 会把 `trainai` 也捞出来，
 * 所以先把 JSON 外壳剥成 `,k12,教培,` 再两头加逗号匹配——只有完整标签才会命中。
 */
export const TAG_MATCH_SQL = `lower(',' || replace(replace(replace(tags, '[', ''), ']', ''), '"', '') || ',')`;

export function tagNeedle(tag: string): string {
  return `%,${tag.trim().toLowerCase()},%`;
}

function terms(query: string): string[] {
  const compact = query.trim().toLowerCase();
  const latin = compact.match(/[a-z0-9_-]{2,}/g) ?? [];
  const chinese = compact.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const hanTerms = chinese.flatMap((part) => part.length < 4 ? [part] : Array.from({ length: part.length - 2 }, (_, index) => part.slice(index, index + 3)));
  return [...new Set([...latin, ...hanTerms])].filter(Boolean).slice(0, 16);
}

/**
 * 按标签检索。标签是用户自己贴的语义，命中它比命中正文里的一个词可信得多；
 * 而且标签常常很短（k12、AI），FTS 索引里根本没有，只能单独查。
 */
function matchedByTags(tokens: string[], selectedSql: string, selected: number[], limit: number): KnowledgeHit[] {
  if (!tokens.length) return [];
  const clauses = tokens.map(() => `${TAG_MATCH_SQL} LIKE ?`);
  const params = tokens.map(tagNeedle);
  return db.prepare(`
    SELECT id, title, substr(content, 1, 5000) AS content, status, source_kind, source_url
    FROM knowledge_archives
    WHERE status IN ('indexed','remote') AND deleted_at IS NULL AND length(tags) > 2 ${selectedSql}
      AND (${clauses.join(' OR ')})
    ORDER BY updated_at DESC LIMIT ?
  `).all(...selected, ...params, limit) as Array<KnowledgeHit>;
}

export function relevantKnowledge(query: string, ids: number[] | 'all', limit = 4): KnowledgeHit[] {
  if (Array.isArray(ids) && ids.length === 0) return [];
  const selected = ids === 'all' ? [] : ids;
  const selectedSql = selected.length ? `AND id IN (${selected.map(() => '?').join(',')})` : '';
  const tokens = terms(query);
  if (!tokens.length) return [];
  // 标签优先：标签是用户自己贴的语义，命中它比命中正文里的一个词可信得多。
  // 而且标签常常很短（k12、AI），FTS 索引里根本没有，只能单独查。
  const tagHits = matchedByTags(tokens, selectedSql, selected, limit);
  if (tagHits.length) return tagHits;
  // 本地知识基线：全文（indexed）与云端目录索引（remote）都参与检索，remote 命中后按 reference 读原文
  const ftsQuery = tokens.filter((token) => token.length >= 3).map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
  if (ftsQuery) {
    const rows = db.prepare(`
      SELECT a.id, a.title, snippet(knowledge_archives_fts, 1, '', '', '…', 80) AS content,
             a.status, a.source_kind, a.source_url
      FROM knowledge_archives_fts JOIN knowledge_archives a ON a.id = knowledge_archives_fts.rowid
      WHERE knowledge_archives_fts MATCH ? AND a.status IN ('indexed','remote') AND a.deleted_at IS NULL ${selected.length ? `AND a.id IN (${selected.map(() => '?').join(',')})` : ''}
      ORDER BY bm25(knowledge_archives_fts) LIMIT ?
    `).all(ftsQuery, ...selected, limit) as Array<KnowledgeHit>;
    if (rows.length) return rows;
  }
  const short = tokens.filter((token) => token.length < 3);
  if (!short.length) return [];
  const clauses = short.flatMap(() => ['lower(title) LIKE ?', 'lower(content) LIKE ?']);
  return db.prepare(`SELECT id, title, substr(content, 1, 5000) AS content, status, source_kind, source_url FROM knowledge_archives WHERE status IN ('indexed','remote') AND deleted_at IS NULL ${selectedSql} AND (${clauses.join(' OR ')}) ORDER BY updated_at DESC LIMIT ?`)
    .all(...selected, ...short.flatMap((token) => [`%${token}%`, `%${token}%`]), limit) as Array<KnowledgeHit>;
}

/** 追加标签到已有存档（合并而非替换，避免助手只补一个标签时把已有的抹掉） */
export function addArchiveTags(id: number, tags: string[]) {
  const current = getArchive(id);
  const merged = normalizeTags([...current.tags, ...tags]);
  db.prepare('UPDATE knowledge_archives SET tags = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(merged), now(), id);
  return getArchive(id);
}

export type { ArchiveRow };
