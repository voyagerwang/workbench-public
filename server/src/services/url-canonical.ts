/**
 * [INPUT]: 原始链接字符串（可为 null/undefined/非法输入）
 * [OUTPUT]: 归一化 canonical URL 字符串或 null
 * [POS]: 知识存档「同链接幂等」身份的唯一实现：db.ts 的存量回填迁移与
 *        knowledge-archive.ts 的导入落库共用本函数，规则改这里一处即可，防止两边漂移。
 *        只用于身份判定（去重），不用于重新抓取——source_url 仍存原始链接。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/**
 * 跟踪参数：命中即从 canonical 身份里剥掉。
 * 只收确定是跟踪用途的键，宁漏勿误——误剥内容参数会让两条不同页面被合并成同一身份。
 */
const TRACKING_KEY = /^(utm_[a-z0-9_]*|spm[a-z_]*|share_[a-z0-9_]*|vd_[a-z0-9_]*|bb_id|from_scene|xg_source|app_platform|ch_from|refer|ref_source)$/i;

/**
 * 归一化规则：
 * - 仅接受 http(s)（feishu:// 等目录协议返回 null，不参与唯一索引）
 * - 去掉 fragment（#后面的锚点）
 * - host 小写、路径去尾部斜杠（路径本身大小写敏感，保留原样）
 * - query 剥跟踪参数后按名排序（同一页面不同参数顺序视为同一身份）
 */
export function canonicalArchiveUrl(raw: string | null | undefined): string | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const params = new URLSearchParams(url.search);
  for (const key of [...params.keys()]) {
    if (TRACKING_KEY.test(key)) params.delete(key);
  }
  params.sort();
  const query = params.toString();
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.protocol}//${host}${path}${query ? `?${query}` : ''}`;
}
