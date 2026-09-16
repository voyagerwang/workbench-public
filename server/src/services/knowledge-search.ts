/**
 * [INPUT]: 依赖当前资料版本片段、有效知识证据与人工主题成员覆盖
 * [OUTPUT]: 对外提供 searchKnowledgeLayers：带版本和位置的公共检索结果
 * [POS]: 知识库 V2 唯一检索契约；HTTP、主题页与 Agent 共用，旧快照不得旁路失效过滤
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { db } from '../db.js';
import { searchDocumentChunks, extractQueryTerms } from './knowledge-documents.js';

export type KnowledgeSearchHit = {
  kind: 'knowledge' | 'source_document';
  id: string | number;
  title: string;
  snippet: string;
  topic_id: number | null;
  evidence_url: string | null;
  source_title: string | null;
  updated_at: string;
  /** source_document 层带出抓取状态：suspect 只在资料搜索中显示状态，不进小精灵答案 */
  body_status?: string;
  version_id?: number;
  version_no?: number;
  content_hash?: string;
  heading_path?: string;
  anchor_from?: number;
  anchor_to?: number;
  source_nature?: string;
  derived_from?: unknown[];
};

/** 内部证据深链（交接文档 7.3） */
export function evidenceUrl(topicId: number, sourceKey: string, evidenceId: number, versionId?:number): string {
  return `/knowledge/topics/${topicId}/documents/${encodeURIComponent(sourceKey)}?evidence=${evidenceId}${versionId?`&version=${versionId}`:''}`;
}

/** LIKE 通配符转义 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** FTS 短语转义：trigram 需要不少于 3 个字符才能命中 */
function ftsPhrase(q: string): string | null {
  const phrase = q.trim().replace(/"/g, '""');
  return [...phrase].length >= 3 ? `"${phrase}"` : null;
}

function excerptOf(text: string, tokens: string[]): string {
  let idx = -1;
  for (const token of tokens) {
    const at = text.toLowerCase().indexOf(token.toLowerCase());
    if (at >= 0 && (idx < 0 || at < idx)) idx = at;
  }
  if (idx < 0) return text.slice(0, 80).replace(/\s+/g, ' ');
  const start = Math.max(0, idx - 20);
  return (start > 0 ? '…' : '') + text.slice(start, idx + 60).replace(/\s+/g, ' ') + '…';
}

export function searchKnowledgeLayers(query: string, limit = 8): KnowledgeSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: KnowledgeSearchHit[] = [];

  // 分词后逐词匹配：用户查询常是「直播课堂 适用对象」这类多词组合，或未分词的中文问句；
  // 统一用中文问句取词（长字段 + 双字短词），整串 LIKE / 整串 FTS 短语都匹配不到正文子串
  const terms = extractQueryTerms(q);
  const tokens = [...new Set([...terms.long, ...terms.short])];
  if (!tokens.length) return hits;

  // 第一层：用户确认的知识（active、未删除），必须带证据信息才算命中。
  // 证据用标量子查询取第一条；相关子查询放 ON 里在这版 SQLite 上不返回行。
  // 名额封顶一半：知识条目不再按更新时间占满最终结果，剩余位置留给资料原文
  const knowledgeLimit = Math.max(1, Math.ceil(limit / 2));
  const statementScore = tokens.map(() => `(CASE WHEN k.statement LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`).join(' + ');
  const knowledge = db.prepare(`
    SELECT k.id,k.statement,k.topic_id,k.updated_at,e.id evidence_id,e.document_key,e.quote_text,v.id version_id,d.title source_title,
      (${statementScore}) score
    FROM knowledge_items k
    JOIN knowledge_evidence e ON e.id=(SELECT e2.id FROM knowledge_evidence e2 JOIN source_documents d2 ON d2.source_key=e2.document_key
      WHERE e2.knowledge_id=k.id AND e2.drift_state='ok' AND d2.source_nature='source' AND d2.deleted_at IS NULL AND d2.body_status='fetched'
      AND NOT(COALESCE(d2.last_fetch_status,'ok')='failed' AND d2.fetch_error_retryable=0) ORDER BY e2.id LIMIT 1)
    JOIN source_documents d ON d.source_key=e.document_key
    JOIN source_document_versions v ON v.document_key=e.document_key AND v.content_hash=e.doc_hash_at_ref
    WHERE k.deleted_at IS NULL AND k.status = 'active' AND (${statementScore}) > 0
    ORDER BY score DESC,k.updated_at DESC LIMIT ?
  `).all(...tokens.map(likePattern), ...tokens.map(likePattern), knowledgeLimit) as Array<{
    id: number; statement: string; topic_id: number | null; updated_at: string;
    evidence_id: number | null; document_key: string | null; quote_text: string | null; source_title: string | null; version_id:number|null;
  }>;
  for (const row of knowledge) {
    if(!row.evidence_id||!row.document_key)continue;
    hits.push({
      kind: 'knowledge',
      id: row.id,
      title: row.statement,
      snippet: row.quote_text ? excerptOf(row.quote_text, tokens) : row.statement,
      topic_id: row.topic_id,
      evidence_url: row.topic_id && row.evidence_id && row.document_key
        ? evidenceUrl(row.topic_id, row.document_key, row.evidence_id,row.version_id??undefined)
        : null,
      source_title: row.source_title,
      updated_at: row.updated_at,
    });
  }

  // 第二层：资料原文片段。取词与打分都在 searchDocumentChunks 内完成（FTS 短语 + 双字 LIKE 双路召回，
  // 标题/章节/正文加权并按文档分组）；结果不足时补满知识条目没用掉的名额。
  const docs = searchDocumentChunks(q,limit) as Array<{document_key:string;title:string;snippet:string;version_id:number;version_no:number;content_hash:string;heading_path:string;anchor_from:number;anchor_to:number;canonical_url:string|null;source_nature:string}>;
  for (const row of docs) {
    const membership=db.prepare(`SELECT m.topic_id FROM topic_members m LEFT JOIN topic_member_overrides o ON o.topic_id=m.topic_id AND o.document_key=m.document_key WHERE m.document_key=? AND m.state='confirmed' AND COALESCE(o.decision,'include')!='exclude' ORDER BY m.topic_id LIMIT 1`).get(row.document_key) as {topic_id:number}|undefined;
    const derived=row.source_nature==='agent_derived'?db.prepare('SELECT source_versions_json FROM knowledge_outputs WHERE derived_document_key=?').get(row.document_key) as {source_versions_json:string}|undefined:undefined;
    hits.push({
      kind: 'source_document',
      id: row.document_key,
      title: row.title,
      snippet: row.snippet,
      topic_id: membership?.topic_id??null,
      evidence_url: membership ? `/knowledge/topics/${membership.topic_id}/documents/${encodeURIComponent(row.document_key)}?version=${row.version_id}&from=${row.anchor_from}&to=${row.anchor_to}` : `/knowledge/documents/${encodeURIComponent(row.document_key)}?version=${row.version_id}&from=${row.anchor_from}&to=${row.anchor_to}`,
      source_title: null,
      updated_at: '', body_status:'fetched',version_id:row.version_id,version_no:row.version_no,content_hash:row.content_hash,heading_path:row.heading_path,anchor_from:row.anchor_from,anchor_to:row.anchor_to,source_nature:row.source_nature,
      derived_from:derived?JSON.parse(derived.source_versions_json):[],
    });
  }

  return [...new Map(hits.map(hit=>[`${hit.kind}:${hit.id}`,hit])).values()].slice(0,limit);
}
