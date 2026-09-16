/**
 * [INPUT]: HTTP 请求——主题 CRUD、主题成员与资料（含资料池列表/单篇重试/批量重试/手动补正文/手动新建）、
 *          知识条目与证据锚点；人工文档允许空白新建和清空正文；业务口径全部来自 source-documents 服务与契约文档
 * [OUTPUT]: /api/knowledge/topics 系列与 /api/knowledge/documents|pool 系列端点；
 *           409 类失败一律携带稳定 error.code（HTTP 边界的错误契约）
 * [POS]: 阶段 1 三层知识模型 + 阶段 1.5 P0 资料池/失败恢复/手动通道的接口层。
 *        契约来源：docs/knowledge-phase1-handoff.md 第八节 + docs/knowledge-phase1_5-topics-redesign.md 3.2/3.7；
 *        本文件不写业务口径，口径在 source-documents 服务里
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now, sync_id } from '../db.js';
import {
  addTopicMember,
  createManualDocument,
  getSourceDocument,
  importSourceDocument,
  refetchSourceDocument,
  retryFailedDocuments,
  saveManualBody,
} from '../services/source-documents.js';
import { bridgeLegacyArchives } from '../services/knowledge-lifecycle.js';
import { refreshLifecycleDocument } from '../services/knowledge-lifecycle.js';
import { setTopicMemberOverride, updateTopicDefinition } from '../services/knowledge-topics-v2.js';
import { documentTags } from '../services/tag-pool.js';

const kindSchema = z.enum(['conclusion', 'rule', 'decision', 'method', 'data', 'experience']);
const statusSchema = z.enum(['active', 'deprecated', 'disputed']);

const evidenceInput = z.object({
  document_key: z.string().min(1),
  quote_text: z.string().trim().min(1).max(5000),
  quote_prefix: z.string().max(200).default(''),
  quote_suffix: z.string().max(200).default(''),
  anchor_from: z.number().int().nonnegative(),
  anchor_to: z.number().int().nonnegative(),
  anchor_basis: z.string().min(1).default('tiptap-pm-v1'),
  doc_hash_at_ref: z.string().min(1),
});

function getTopic(id: number) {
  return db.prepare(`SELECT * FROM topics WHERE id = ? AND deleted_at IS NULL`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function topicCounts(topicId: number): { document_count: number; knowledge_count: number } {
  const documents = (db.prepare(`
    SELECT COUNT(*) AS n FROM topic_members m
    JOIN source_documents d ON d.source_key = m.document_key
    WHERE m.topic_id = ? AND m.state = 'confirmed' AND d.deleted_at IS NULL
  `).get(topicId) as { n: number }).n;
  const knowledge = (db.prepare(`
    SELECT COUNT(*) AS n FROM knowledge_items
    WHERE topic_id = ? AND deleted_at IS NULL AND status = 'active'
  `).get(topicId) as { n: number }).n;
  return { document_count: documents, knowledge_count: knowledge };
}

export default async function knowledgeTopicRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ 主题

  app.get('/api/knowledge/topics', async () => {
    const topics = db.prepare(`
      SELECT t.*,
        (SELECT COUNT(*) FROM topic_members m JOIN source_documents d ON d.source_key = m.document_key
          WHERE m.topic_id = t.id AND m.state = 'confirmed' AND d.deleted_at IS NULL) AS document_count,
        (SELECT COUNT(*) FROM knowledge_items k
          WHERE k.topic_id = t.id AND k.deleted_at IS NULL AND k.status = 'active') AS knowledge_count
      FROM topics t WHERE t.deleted_at IS NULL
      ORDER BY t.updated_at DESC
    `).all();
    return { topics };
  });

  app.post('/api/knowledge/topics', async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(60), summary: z.string().max(2000).default(''), scope:z.string().max(2000).default(''), focusQuestions:z.array(z.string().trim().min(1).max(300)).max(20).default([]) })
      .parse(req.body ?? {});
    const dup = db.prepare(`SELECT id FROM topics WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL`).get(body.name);
    if (dup) throw app.httpErrors.conflict(`已有同名主题「${body.name}」，直接使用它即可`);
    const id = sync_id();
    db.prepare(`INSERT INTO topics (id, name, summary, scope_text, focus_questions_json) VALUES (?, ?, ?, ?, ?)`).run(id, body.name, body.summary, body.scope, JSON.stringify(body.focusQuestions));
    return { topic: { ...getTopic(id), ...topicCounts(id) } };
  });

  app.get('/api/knowledge/topics/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const topic = getTopic(id);
    if (!topic) throw app.httpErrors.notFound('主题不存在或已删除');

    // 权威资料（manual/governance/prd 且正文就绪）在前，其余按更新时间倒序；
    // failed/suspect 原样带出状态，由页面独立展示，不混进「正文已就绪」
    const documents = db.prepare(`
      SELECT d.source_key, d.title, d.canonical_url, d.document_type, d.source_version,
             d.body_status, d.fetch_error, d.fetched_at, d.updated_at, m.created_at AS member_since,
             m.origin,COALESCE(o.decision,CASE WHEN m.state='rejected' THEN 'exclude' ELSE 'auto' END) member_decision,
             v.id version_id,v.version_no,v.content_hash version_hash
      FROM topic_members m JOIN source_documents d ON d.source_key = m.document_key
      LEFT JOIN topic_member_overrides o ON o.topic_id=m.topic_id AND o.document_key=m.document_key
      LEFT JOIN source_document_versions v ON v.document_key=d.source_key AND v.is_current=1
      WHERE m.topic_id = ? AND m.state = 'confirmed' AND COALESCE(o.decision,'include')!='exclude' AND d.deleted_at IS NULL
      ORDER BY CASE WHEN d.document_type IN ('manual','governance','prd') AND d.body_status = 'fetched' THEN 0 ELSE 1 END,
               d.updated_at DESC
    `).all(id);

    const knowledge = db.prepare(`
      SELECT k.id, k.statement, k.kind, k.status, k.created_at, k.updated_at
      FROM knowledge_items k WHERE k.topic_id = ? AND k.deleted_at IS NULL AND k.status = 'active'
      ORDER BY k.updated_at DESC
    `).all(id) as Array<{ id: number }>;
    const evidence = db.prepare(`
      SELECT e.id, e.knowledge_id, e.document_key, e.quote_text, e.drift_state, e.checked_at,
             d.title AS source_title, d.body_status AS source_body_status
      FROM knowledge_evidence e JOIN source_documents d ON d.source_key = e.document_key
      WHERE e.knowledge_id IN (SELECT id FROM knowledge_items WHERE topic_id = ? AND deleted_at IS NULL)
      ORDER BY e.id
    `).all(id);

    const deletedKnowledge = db.prepare(`SELECT id,statement,kind,status,created_at,updated_at FROM knowledge_items WHERE topic_id=? AND deleted_at IS NOT NULL ORDER BY updated_at DESC LIMIT 50`).all(id);
    const inactiveKnowledge = db.prepare(`SELECT id,statement,kind,status,created_at,updated_at FROM knowledge_items WHERE topic_id=? AND deleted_at IS NULL AND status!='active' ORDER BY updated_at DESC LIMIT 100`).all(id);
    return { topic: { ...topic, ...topicCounts(id) }, documents, knowledge, evidence, deletedKnowledge, inactiveKnowledge };
  });

  app.patch('/api/knowledge/topics/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ name: z.string().trim().min(1).max(60).optional(), summary: z.string().max(2000).optional(), scope:z.string().max(2000).optional(), focusQuestions:z.array(z.string().trim().min(1).max(300)).max(20).optional(), manualNotes:z.string().max(20_000).optional() })
      .parse(req.body ?? {});
    if (!body.name && body.summary === undefined && body.scope === undefined && body.focusQuestions === undefined && body.manualNotes === undefined) throw app.httpErrors.badRequest('至少要改一个字段');
    const topic = getTopic(id);
    if (!topic) throw app.httpErrors.notFound('主题不存在或已删除');
    if (body.name !== undefined) {
      const dup = db.prepare(`SELECT id FROM topics WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND id != ?`)
        .get(body.name, id);
      if (dup) throw app.httpErrors.conflict(`已有同名主题「${body.name}」`);
    }
    updateTopicDefinition(id,{name:body.name,scope:body.scope,focusQuestions:body.focusQuestions,manualNotes:body.manualNotes});
    if(body.summary!==undefined)db.prepare('UPDATE topics SET summary=?,updated_at=? WHERE id=?').run(body.summary,now(),id);
    return { topic: { ...getTopic(id), ...topicCounts(id) } };
  });

  // ------------------------------------------------------------------ 资料与成员

  app.get('/api/knowledge/documents/:sourceKey', async (req) => {
    const { sourceKey } = z.object({ sourceKey: z.string().min(1) }).parse(req.params);
    const doc = getSourceDocument(sourceKey);
    if (!doc || doc.deleted_at) throw app.httpErrors.notFound('资料不存在或已删除');
    const evidence = db.prepare(`
      SELECT e.id, e.knowledge_id, e.quote_text, e.quote_prefix, e.quote_suffix,
             e.anchor_from, e.anchor_to, e.anchor_basis, e.doc_hash_at_ref, e.drift_state, e.checked_at,
             k.topic_id, k.statement
      FROM knowledge_evidence e JOIN knowledge_items k ON k.id = e.knowledge_id
      WHERE e.document_key = ? AND k.deleted_at IS NULL
      ORDER BY e.id
    `).all(sourceKey);
    // tags 并进 document：与前端 SourceDocumentDetail.tags 契约一致（详情打开即见标签）；
    // topic_names 同步带出——详情页「来源与标签」合并行不依赖资料池列表是否恰好加载过这篇
    const topicNames = (db.prepare(`
      SELECT GROUP_CONCAT(t.name, '、') AS n FROM topic_members m JOIN topics t ON t.id = m.topic_id
      WHERE m.document_key = ? AND m.state = 'confirmed' AND t.deleted_at IS NULL
    `).get(sourceKey) as { n: string | null }).n;
    return { document: { ...doc, tags: documentTags(sourceKey), topic_names: topicNames }, evidence };
  });

  app.post('/api/knowledge/documents/:sourceKey/refresh', async (req) => {
    const { sourceKey } = z.object({ sourceKey: z.string().min(1) }).parse(req.params);
    const doc = getSourceDocument(sourceKey);
    if (!doc) throw app.httpErrors.notFound('资料不存在');
    const document=await refreshLifecycleDocument(sourceKey);
    return { document, outcome: (document as {body_status:string}).body_status };
  });

  // ------------------------------------------------------- 资料池与失败恢复（P0）

  /** 资料池列表：全部未删除文档 + 每篇所属主题；filter=failed|untopic|all（默认 all） */
  app.get('/api/knowledge/pool', async (req) => {
    bridgeLegacyArchives();
    const query = z.object({
      filter: z.enum(['all', 'failed', 'untopic']).default('all'),
      query: z.string().trim().max(200).default(''),
      provider: z.enum(['feishu','dingtalk','url','local','conversation']).optional(),
      topicId: z.coerce.number().int().optional(),
      tag: z.string().trim().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query ?? {});
    const filterClause = query.filter === 'failed'
      ? "AND d.last_fetch_status = 'failed'"
      : query.filter === 'untopic'
        ? 'AND NOT EXISTS (SELECT 1 FROM topic_members m WHERE m.document_key = d.source_key AND m.state = \'confirmed\')'
        : '';
    const searchClause = query.query ? `AND (d.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')` : '';
    const providerClause = query.provider ? `AND d.provider = ?` : '';
    const topicClause = query.topicId ? `AND EXISTS (SELECT 1 FROM topic_members mx WHERE mx.document_key=d.source_key AND mx.topic_id=? AND mx.state='confirmed')` : '';
    const tagClause = query.tag ? `AND EXISTS (SELECT 1 FROM source_document_tags stx JOIN tags tx ON tx.id = stx.tag_id
      WHERE stx.document_key = d.source_key AND stx.state = 'active' AND tx.deleted_at IS NULL AND tx.name = ?)` : '';
    const escaped=query.query.replace(/[\\%_]/g,(m)=>`\\${m}`);
    const params = [...(query.query ? [`%${escaped}%`, `%${escaped}%`] : []), ...(query.provider ? [query.provider] : []), ...(query.topicId ? [query.topicId] : []), ...(query.tag ? [query.tag] : [])];
    const rawDocuments = db.prepare(`
      SELECT d.source_key, d.provider, d.title, d.canonical_url, d.document_type, d.source_version,
             d.body_status, d.fetch_error, d.last_fetch_status, d.fetch_error_code, d.fetch_error_retryable,
             d.content_origin,d.source_nature,d.fetched_at,d.updated_at, SUBSTR(d.content, 1, 800) AS content_preview,
             (SELECT o.source_versions_json FROM knowledge_outputs o WHERE o.derived_document_key=d.source_key LIMIT 1) AS derived_from,
             (SELECT GROUP_CONCAT(t.name, '、') FROM topic_members m JOIN topics t ON t.id = m.topic_id
               WHERE m.document_key = d.source_key AND m.state = 'confirmed' AND t.deleted_at IS NULL) AS topic_names,
             (SELECT GROUP_CONCAT(t2.name, '、') FROM source_document_tags st2 JOIN tags t2 ON t2.id = st2.tag_id
               WHERE st2.document_key = d.source_key AND st2.state = 'active' AND t2.deleted_at IS NULL) AS tag_names
      FROM source_documents d
      WHERE d.deleted_at IS NULL ${filterClause} ${searchClause} ${providerClause} ${topicClause} ${tagClause}
      ORDER BY CASE WHEN d.last_fetch_status = 'failed' THEN 0 ELSE 1 END, d.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, query.limit, query.offset) as Array<Record<string,unknown>>;
    const documents=rawDocuments.map(row=>({...row,derived_from:row.derived_from?JSON.parse(String(row.derived_from)):[]}));
    const filteredTotal = (db.prepare(`SELECT COUNT(*) n FROM source_documents d WHERE d.deleted_at IS NULL ${filterClause} ${searchClause} ${providerClause} ${topicClause} ${tagClause}`).get(...params) as {n:number}).n;
    const summary = {
      total: (db.prepare(`SELECT COUNT(*) AS n FROM source_documents WHERE deleted_at IS NULL`).get() as { n: number }).n,
      failed: (db.prepare(`SELECT COUNT(*) AS n FROM source_documents WHERE deleted_at IS NULL AND last_fetch_status = 'failed'`).get() as { n: number }).n,
      untopic: (db.prepare(`SELECT COUNT(*) AS n FROM source_documents d WHERE d.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM topic_members m WHERE m.document_key = d.source_key AND m.state = 'confirmed')`).get() as { n: number }).n,
    };
    return { documents, summary, page: { limit: query.limit, offset: query.offset, total: filteredTotal } };
  });

  /** 单篇重试：结构化闸门在服务层（manual 来源/最近成功/不可重试 → 409 + code） */
  app.post('/api/knowledge/documents/:sourceKey/refetch', async (req) => {
    const { sourceKey } = z.object({ sourceKey: z.string().min(1) }).parse(req.params);
    const row = await refetchSourceDocument(sourceKey);
    return { document: row };
  });

  /** 批量重试：只挑可重试的最近失败项，允许部分成功，逐项返回结果 */
  app.post('/api/knowledge/documents/retry-failed', async () => {
    return { results: await retryFailedDocuments() };
  });

  /** 手动补正文 / 编辑正文（不触发抓取；content_origin 置 manual，哈希重算进归纳） */
  app.post('/api/knowledge/documents/:sourceKey/manual-body', async (req) => {
    const { sourceKey } = z.object({ sourceKey: z.string().min(1) }).parse(req.params);
    const body = z.object({ content: z.string().max(2_000_000), title: z.string().trim().max(200).optional() })
      .parse(req.body ?? {});
    return { document: saveManualBody(sourceKey, body.content, body.title) };
  });

  /** 手动新建文档：不经过 URL/抓取，直接入资料池 */
  app.post('/api/knowledge/documents/manual', async (req) => {
    const body = z.object({
      title: z.string().trim().min(1).max(200),
      content: z.string().max(2_000_000),
      documentType: z.enum(['prd', 'version', 'manual', 'governance', 'research', 'data', 'plan', 'ops', 'other']).default('other'),
    }).parse(req.body ?? {});
    return { document: createManualDocument(body) };
  });

  app.post('/api/knowledge/topics/:id/members', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ documentKeys: z.array(z.string().min(1)).min(1).max(100) }).parse(req.body ?? {});
    if (!getTopic(id)) throw app.httpErrors.notFound('主题不存在或已删除');
    // 先整体校验再写入：任一资料不存在就整体拒绝，避免半批加入
    for (const key of body.documentKeys) {
      const doc = getSourceDocument(key);
      if (!doc || doc.deleted_at) throw app.httpErrors.notFound(`资料不存在：${key}`);
    }
    for (const key of body.documentKeys) addTopicMember(id, key);
    return { added: body.documentKeys.length, ...topicCounts(id) };
  });

  app.put('/api/knowledge/topics/:id/member-overrides/:sourceKey', async (req) => {
    const { id, sourceKey } = z.object({ id:z.coerce.number().int(), sourceKey:z.string().min(1) }).parse(req.params);
    const { decision } = z.object({ decision:z.enum(['include','exclude']) }).parse(req.body ?? {});
    if (!getTopic(id) || !getSourceDocument(sourceKey)) throw app.httpErrors.notFound('主题或资料不存在');
    return { override:setTopicMemberOverride(id,sourceKey,decision) };
  });

  app.delete('/api/knowledge/topics/:id/members/:sourceKey', async (req) => {
    const params = z.object({ id: z.coerce.number().int(), sourceKey: z.string().min(1) }).parse(req.params);
    if (!getTopic(params.id)) throw app.httpErrors.notFound('主题不存在或已删除');
    // 只移除主题关系，不删资料与知识
    const info = db.prepare(`DELETE FROM topic_members WHERE topic_id = ? AND document_key = ?`)
      .run(params.id, params.sourceKey);
    if (info.changes === 0) throw app.httpErrors.notFound('该资料不在这个主题里');
    return { ok: true, ...topicCounts(params.id) };
  });

  // ------------------------------------------------------------------ 知识与证据

  app.post('/api/knowledge/topics/:id/items', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ statement: z.string().trim().min(1).max(2000), kind: kindSchema.default('conclusion'), evidence: evidenceInput })
      .parse(req.body ?? {});
    if (!getTopic(id)) throw app.httpErrors.notFound('主题不存在或已删除');

    const doc = getSourceDocument(body.evidence.document_key);
    if (!doc || doc.deleted_at) throw app.httpErrors.notFound('证据指向的资料不存在');
    const member = db.prepare(`SELECT 1 FROM topic_members WHERE topic_id = ? AND document_key = ? AND state = 'confirmed'`)
      .get(id, body.evidence.document_key);
    if (!member) throw app.httpErrors.conflict('证据指向的资料不属于当前主题');
    if (doc.body_status !== 'fetched') throw app.httpErrors.conflict(`资料正文状态为 ${doc.body_status}，不能从它生成知识`);
    if (body.evidence.anchor_from >= body.evidence.anchor_to) throw app.httpErrors.badRequest('选区为空或无效');
    // 前端直接回传资料接口给它的 content_hash；哈希对不上说明正文已刷新，要求重新选择
    if (body.evidence.doc_hash_at_ref !== doc.content_hash) {
      throw app.httpErrors.conflict('原文已更新，请在最新正文里重新选择证据');
    }

    const knowledgeId = sync_id();
    const evidenceId = sync_id();
    const ts = now();
    // 知识与证据必须同一事务：证据校验通过后一起落库，失败一起回滚
    db.transaction(() => {
      db.prepare(`INSERT INTO knowledge_items (id, topic_id, statement, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(knowledgeId, id, body.statement, body.kind, ts, ts);
      db.prepare(`
        INSERT INTO knowledge_evidence
          (id, knowledge_id, document_key, quote_text, quote_prefix, quote_suffix,
           anchor_from, anchor_to, anchor_basis, source_version, doc_hash_at_ref, drift_state, checked_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)
      `).run(
        evidenceId, knowledgeId, body.evidence.document_key, body.evidence.quote_text,
        body.evidence.quote_prefix, body.evidence.quote_suffix,
        body.evidence.anchor_from, body.evidence.anchor_to, body.evidence.anchor_basis,
        doc.source_version, body.evidence.doc_hash_at_ref, ts, ts,
      );
    })();
    return { knowledge: db.prepare(`SELECT * FROM knowledge_items WHERE id = ?`).get(knowledgeId), evidence_id: evidenceId };
  });

  app.patch('/api/knowledge/items/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({
      statement: z.string().trim().min(1).max(2000).optional(),
      kind: kindSchema.optional(),
      status: statusSchema.optional(),
    }).parse(req.body ?? {});
    if (!Object.keys(body).length) throw app.httpErrors.badRequest('至少要改一个字段');
    const item = db.prepare(`SELECT id FROM knowledge_items WHERE id = ? AND deleted_at IS NULL`).get(id);
    if (!item) throw app.httpErrors.notFound('知识不存在或已删除');
    db.prepare(`UPDATE knowledge_items SET statement = COALESCE(?, statement), kind = COALESCE(?, kind), status = COALESCE(?, status), updated_at = ? WHERE id = ?`)
      .run(body.statement ?? null, body.kind ?? null, body.status ?? null, now(), id);
    return { knowledge: db.prepare(`SELECT * FROM knowledge_items WHERE id = ?`).get(id) };
  });

  app.delete('/api/knowledge/items/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const item = db.prepare(`SELECT id FROM knowledge_items WHERE id = ? AND deleted_at IS NULL`).get(id);
    if (!item) throw app.httpErrors.notFound('知识不存在或已删除');
    // 软删除；证据保留供恢复
    db.prepare(`UPDATE knowledge_items SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), id);
    return { ok: true };
  });

  app.post('/api/knowledge/items/:id/restore', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const item = db.prepare(`SELECT id FROM knowledge_items WHERE id = ? AND deleted_at IS NOT NULL`).get(id);
    if (!item) throw app.httpErrors.notFound('知识不存在或不在回收站里');
    db.prepare(`UPDATE knowledge_items SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
    return { knowledge: db.prepare(`SELECT * FROM knowledge_items WHERE id = ?`).get(id) };
  });

  // 阅读器重定位成功后回写锚点（正文哈希变化 → 前端按引文重新定位 → 回写新 anchor_from/to）
  app.patch('/api/knowledge/evidence/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({
      anchor_from: z.number().int().nonnegative(),
      anchor_to: z.number().int().nonnegative(),
      doc_hash_at_ref: z.string().min(1),
    }).parse(req.body ?? {});
    if (body.anchor_from >= body.anchor_to) throw app.httpErrors.badRequest('锚点区间为空');
    const evidence = db.prepare(`
      SELECT e.id, d.content_hash, d.body_status
      FROM knowledge_evidence e JOIN source_documents d ON d.source_key = e.document_key
      WHERE e.id = ?
    `).get(id) as { content_hash: string | null; body_status: string } | undefined;
    if (!evidence) throw app.httpErrors.notFound('证据不存在');
    if (body.doc_hash_at_ref !== evidence.content_hash) {
      throw app.httpErrors.conflict('原文与当前版本不一致，回写已取消');
    }
    db.prepare(`UPDATE knowledge_evidence SET anchor_from = ?, anchor_to = ?, checked_at = ? WHERE id = ?`)
      .run(body.anchor_from, body.anchor_to, now(), id);
    return { ok: true };
  });
}
