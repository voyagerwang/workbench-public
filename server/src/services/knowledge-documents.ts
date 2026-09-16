/**
 * [INPUT]: 依赖 source_documents 当前资料、版本表、片段表与 SQLite FTS
 * [OUTPUT]: 提供版本追加/补迁移、片段重建与检索（问句取词：长段与词窗走 trigram FTS、双字滑窗走 LIKE，双路召回后按标题/章节/正文加权的 IDF 统一打分，按文档分组），HTTP 指定版本读取，以及 Agent 搜索签发的短时读取 grant
 * [POS]: 知识库资料层的版本和引用定位边界；导入、手工编辑、Agent 回流共用，主题与 Agent 不另建索引
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { db, now, sync_id } from '../db.js';

export type DocumentVersionOrigin = 'remote' | 'manual' | 'agent';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

type Section = { heading: string; from: number; to: number; content: string };

function sectionsOf(content: string): Section[] {
  const lines = content.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const sections: Section[] = [];
  const headings: string[] = [];
  let heading = '';
  let start = 0;
  let cursor = 0;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match && cursor > start) {
      sections.push({ heading, from: start, to: cursor, content: content.slice(start, cursor) });
      start = cursor;
    }
    if (match) {
      const level = match[1].length;
      headings.splice(level - 1);
      headings[level - 1] = match[2].trim();
      heading = headings.filter(Boolean).join(' > ');
    }
    cursor += rawLine.length;
  }
  if (cursor > start) sections.push({ heading, from: start, to: content.length, content: content.slice(start) });
  return sections.filter((section) => section.content.trim());
}

function chunkSection(section: Section, maxChars = 1800): Section[] {
  if (section.content.length <= maxChars) return [section];
  const chunks: Section[] = [];
  let offset = 0;
  while (offset < section.content.length) {
    let end = Math.min(offset + maxChars, section.content.length);
    if (end < section.content.length) {
      const boundary = Math.max(section.content.lastIndexOf('\n', end), section.content.lastIndexOf('。', end));
      if (boundary > offset + 500) end = boundary + 1;
    }
    chunks.push({ heading: section.heading, from: section.from + offset, to: section.from + end, content: section.content.slice(offset, end) });
    offset = end;
  }
  return chunks;
}

export function rebuildDocumentChunks(documentKey: string, versionId: number, content: string): number {
  const chunks = sectionsOf(content).flatMap((section) => chunkSection(section));
  db.transaction(() => {
    db.prepare('DELETE FROM source_document_chunks WHERE version_id=?').run(versionId);
    const insert = db.prepare(`INSERT INTO source_document_chunks
      (id,version_id,document_key,chunk_index,heading_path,anchor_from,anchor_to,content,content_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    chunks.forEach((chunk, index) => insert.run(sync_id(), versionId, documentKey, index, chunk.heading, chunk.from, chunk.to, chunk.content, hash(chunk.content), now()));
  })();
  return chunks.length;
}

export function appendDocumentVersion(documentKey: string, content: string, origin: DocumentVersionOrigin, sourceVersion?: string | null, promote = true) {
  const contentHash = hash(content);
  const existing = db.prepare(`SELECT * FROM source_document_versions WHERE document_key=? AND content_hash=? AND origin=? AND is_current=1`)
    .get(documentKey, contentHash, origin) as { id: number; is_current: number } | undefined;
  if (existing) return { versionId: existing.id, created: false, contentHash };
  const next = (db.prepare('SELECT COALESCE(MAX(version_no),0)+1 n FROM source_document_versions WHERE document_key=?').get(documentKey) as { n: number }).n;
  const id = sync_id();
  db.transaction(() => {
    if (promote) db.prepare('UPDATE source_document_versions SET is_current=0 WHERE document_key=?').run(documentKey);
    db.prepare(`INSERT INTO source_document_versions(id,document_key,version_no,content,content_hash,origin,source_version,is_current,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, documentKey, next, content, contentHash, origin, sourceVersion ?? null, promote ? 1 : 0, now());
    rebuildDocumentChunks(documentKey, id, content);
  })();
  return { versionId: id, created: true, contentHash };
}

export function ensureDocumentVersion(row:{source_key:string;content:string;content_origin?:string;source_version?:string|null;source_nature?:string}):void{
  if(!row.content||currentDocumentVersion(row.source_key))return;
  const origin:DocumentVersionOrigin=row.source_nature==='agent_derived'?'agent':row.content_origin==='manual'?'manual':'remote';
  appendDocumentVersion(row.source_key,row.content,origin,row.source_version??null,true);
}

export function currentDocumentVersion(documentKey: string) {
  return db.prepare(`SELECT id,document_key,version_no,content_hash,origin,source_version,is_current,created_at
    FROM source_document_versions WHERE document_key=? AND is_current=1`).get(documentKey);
}

export function listDocumentVersions(documentKey: string) {
  return db.prepare(`SELECT id,document_key,version_no,content_hash,origin,source_version,is_current,created_at
    FROM source_document_versions WHERE document_key=? ORDER BY version_no DESC`).all(documentKey);
}

export function readDocumentVersion(documentKey:string,versionId:number,offset=0,maxChars=20_000){
  const row=db.prepare(`SELECT v.id version_id,v.version_no,v.content,v.content_hash,v.origin,v.source_version,d.title,d.canonical_url,d.source_nature,d.body_status,d.deleted_at,d.last_fetch_status,d.fetch_error_retryable,o.source_versions_json derived_from
    FROM source_document_versions v JOIN source_documents d ON d.source_key=v.document_key LEFT JOIN knowledge_outputs o ON o.derived_document_key=d.source_key WHERE v.document_key=? AND v.id=?`).get(documentKey,versionId) as Record<string,unknown>|undefined;
  if(!row||row.deleted_at||row.body_status!=='fetched'||(row.last_fetch_status==='failed'&&row.fetch_error_retryable===0))throw Object.assign(new Error('资料版本不存在或当前不可引用'),{statusCode:404,publicCode:'version_unavailable'});
  const content=String(row.content);const start=Math.min(Math.max(0,offset),content.length);const end=Math.min(content.length,start+Math.max(1,Math.min(maxChars,100_000)));
  return {...row,content:content.slice(start,end),range:{from:start,to:end,total:content.length,truncated:end<content.length},derived_from:row.derived_from?JSON.parse(String(row.derived_from)):[]};
}

const readGrants=new Map<string,{documentKey:string;versionId:number;expiresAt:number}>();
export function createKnowledgeReadGrant(documentKey:string,versionId:number):string{const id=randomUUID();readGrants.set(id,{documentKey,versionId,expiresAt:Date.now()+10*60_000});return id;}
export function readGrantedKnowledgeVersion(grantId:string,offset=0,maxChars=20_000){const grant=readGrants.get(grantId);if(!grant||grant.expiresAt<Date.now()){readGrants.delete(grantId);throw Object.assign(new Error('读取凭证不存在或已过期，请重新检索'),{statusCode:403,publicCode:'knowledge_grant_expired'});}return readDocumentVersion(grant.documentKey,grant.versionId,offset,maxChars);}

/** 问句功能词：出现在提问里但几乎不承载检索意义的双字词，不进 LIKE 匹配。 */
const TERM_STOP = new Set(['什么','怎么','怎样','如何','为啥','哪个','哪些','这个','那个','我们','你们','我的','你的','可以','应该','还是','然后','如果','但是','以及','没有','一下','告诉','帮忙','请问','一下','之前','以后','现在','最近','是不是','有没有','能不能','怎么办','为什么']);

/**
 * 问句取词（对话即检索的基础）：按标点/空白切段，
 * - long：≥3 字的连续段，长问句再切 4 字词窗 → 供 trigram FTS 短语召回
 *   （整段短语几乎匹配不到正文，词窗才是真正能命中的短语）
 * - short：全部双字滑窗（剔除功能词）→ 供 LIKE 召回与加权
 * "孩子掉线后怎么回课堂" → long=[孩子掉线后怎么回课堂, 孩子掉线, 子掉线后, …]，short=[孩子,掉线,课堂,…]
 */
export function extractQueryTerms(query: string): { long: string[]; short: string[] } {
  const segments = query.split(/[\s，。！？、；：,.!?;:（）()《》「」【】\[\]{}"'`~@#$%^&*+=|\\/<>·…]+/).map((s) => s.trim()).filter(Boolean);
  const long = new Set<string>();
  const short = new Set<string>();
  for (const seg of segments) {
    const chars = [...seg];
    if (chars.length >= 3 && !TERM_STOP.has(seg)) long.add(seg);
    if (chars.length > 8) {
      for (let i = 0; i + 4 <= chars.length && long.size < 12; i += 2) {
        const gram = chars.slice(i, i + 4).join('');
        if (!TERM_STOP.has(gram)) long.add(gram);
      }
    }
    for (let i = 0; i + 2 <= chars.length; i++) {
      const bigram = chars.slice(i, i + 2).join('');
      if (!TERM_STOP.has(bigram)) short.add(bigram);
    }
  }
  return { long: [...long], short: [...short] };
}

type ChunkRow = { id: number; document_key: string; version_id: number; chunk_index: number; heading_path: string; anchor_from: number; anchor_to: number; content: string; title: string; canonical_url: string | null; source_nature: string; version_no: number; content_hash: string };

const CHUNK_COLUMNS = `c.id,c.document_key,c.version_id,c.chunk_index,c.heading_path,c.anchor_from,c.anchor_to,c.content,
  d.title,d.canonical_url,d.source_nature,v.version_no,v.content_hash`;
/** 可引用的资料：未删除、正文就绪、且不是「抓取失败且不可重试」 */
const DOC_AVAILABLE = `d.deleted_at IS NULL AND d.body_status='fetched'
  AND NOT (COALESCE(d.last_fetch_status,'ok')='failed' AND d.fetch_error_retryable=0)`;

function likeOf(term: string): string {
  return `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * 资料片段检索：FTS 短语与 LIKE 双路召回 → 统一打分 → 按文档分组。
 * 两路都执行，不再「FTS 有结果就丢弃短词召回」；候选池按粗排分取（不是按更新时间截断），
 * 长尾老资料不会被新资料挤出池外。打分用简易 IDF 压低「子掉」「线后」这类滑窗噪声词。
 */
export function searchDocumentChunks(query: string, limit = 12, options: { perDocumentLimit?: number } = {}) {
  const phrase = query.trim().replace(/["']/g, ' ');
  if (!phrase) return [];
  const terms = extractQueryTerms(phrase);
  const ftsTerms = terms.long.slice(0, 12);
  // FTS 词优先入 LIKE 词表：保证 FTS 命中的片段在统一打分里也拿得到词命中分
  const likeTerms = [...new Set([...ftsTerms, ...terms.long, ...terms.short])].slice(0, 40);
  if (!likeTerms.length) return [];
  const perDocumentLimit = Math.max(1, options.perDocumentLimit ?? 3);
  const pool = new Map<number, { row: ChunkRow; ftsRank: number }>();

  // 1) trigram FTS：≥3 字短语（整段 + 长句词窗），只负责召回，不决定最终顺序
  if (ftsTerms.length) {
    const ftsQuery = ftsTerms.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
    try {
      const rows = db.prepare(`SELECT ${CHUNK_COLUMNS}
        FROM source_document_chunks_fts f JOIN source_document_chunks c ON c.id=f.rowid
        JOIN source_document_versions v ON v.id=c.version_id AND v.is_current=1
        JOIN source_documents d ON d.source_key=c.document_key
        WHERE source_document_chunks_fts MATCH ? AND ${DOC_AVAILABLE}
        ORDER BY rank LIMIT ?`).all(ftsQuery, Math.max(limit * 4, 40)) as ChunkRow[];
      rows.forEach((row, index) => pool.set(row.id, { row, ftsRank: rows.length - index }));
    } catch { /* FTS 不可用或语法不兼容：LIKE 路径独立成立 */ }
  }

  // 2) LIKE 召回：命中任一词即进池，标题/章节/正文分别计权，粗排后再截断
  const poolCap = Math.max(limit * 10, 120);
  const orClauses = likeTerms.map(() => `(c.content LIKE ? ESCAPE '\\' OR c.heading_path LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')`).join(' OR ');
  const coarseExpr = likeTerms.map(() => `(CASE WHEN c.content LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END + CASE WHEN c.heading_path LIKE ? ESCAPE '\\' THEN 2 ELSE 0 END + CASE WHEN d.title LIKE ? ESCAPE '\\' THEN 3 ELSE 0 END)`).join(' + ');
  const params: unknown[] = [];
  for (const term of likeTerms) { const like = likeOf(term); params.push(like, like, like); }
  for (const term of likeTerms) { const like = likeOf(term); params.push(like, like, like); }
  const rows = db.prepare(`SELECT * FROM (
      SELECT ${CHUNK_COLUMNS},(${coarseExpr}) coarse
      FROM source_document_chunks c
      JOIN source_document_versions v ON v.id=c.version_id AND v.is_current=1
      JOIN source_documents d ON d.source_key=c.document_key
      WHERE (${orClauses}) AND ${DOC_AVAILABLE})
    WHERE coarse>0 ORDER BY coarse DESC LIMIT ?`).all(...params, poolCap) as Array<ChunkRow & { coarse: number }>;
  for (const row of rows) if (!pool.has(row.id)) pool.set(row.id, { row, ftsRank: 0 });
  if (!pool.size) return [];

  // 3) 统一打分：标题(3) > 章节(2) > 正文(1)，每词按 IDF 加权；FTS 命中额外加 2（有连续子串证据）
  const hits = new Map<number, { terms: Set<string>; firstHit: number }>();
  const df = new Map<string, number>();
  for (const [id, candidate] of pool) {
    const { row } = candidate;
    const set = new Set<string>(); let firstHit = -1;
    for (const term of likeTerms) {
      const inBody = row.content.includes(term);
      if (!inBody && !row.heading_path.includes(term) && !row.title.includes(term)) continue;
      set.add(term);
      if (inBody) { const idx = row.content.indexOf(term); if (idx >= 0 && (firstHit < 0 || idx < firstHit)) firstHit = idx; }
    }
    hits.set(id, { terms: set, firstHit });
    for (const term of set) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const total = pool.size;
  const weightOf = (term: string) => Math.log(1 + total / (df.get(term) ?? 1));
  const scored = [...pool.values()].map(({ row, ftsRank }) => {
    const hit = hits.get(row.id)!;
    let score = ftsRank ? 2 : 0;
    for (const term of hit.terms) {
      const weight = weightOf(term);
      if (row.title.includes(term)) score += 3 * weight;
      else if (row.heading_path.includes(term)) score += 2 * weight;
      else score += 1 * weight;
    }
    return { row, score, firstHit: hit.firstHit };
  }).sort((a, b) => b.score - a.score || (a.firstHit < 0 ? 1e9 : a.firstHit) - (b.firstHit < 0 ? 1e9 : b.firstHit));

  // 4) 按文档分组输出：长文最多 perDocumentLimit 段，防止一篇占满结果
  const perDoc = new Map<string, number>();
  const out: Array<Record<string, unknown>> = [];
  for (const { row, score, firstHit } of scored) {
    if (score <= 0) continue;
    const used = perDoc.get(row.document_key) ?? 0;
    if (used >= perDocumentLimit) continue;
    perDoc.set(row.document_key, used + 1);
    const center = firstHit >= 0 ? firstHit : 0;
    const start = Math.max(0, center - 80);
    out.push({ ...row, score, snippet: (start > 0 ? '…' : '') + row.content.slice(start, start + 360).replace(/\s+/g, ' ') + '…' });
    if (out.length >= limit) break;
  }
  return out;
}
