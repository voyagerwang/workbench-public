/**
 * [INPUT]: HTTP 请求中的资料清单、批次动作、候选决策与导出范围
 * [OUTPUT]: /api/knowledge/lifecycle 下的桥接、批次、主题归纳、成果和资产导出接口
 * [POS]: 知识库完整生命周期的薄路由；统一沿用 index.ts 的全局访问令牌与错误边界
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  bridgeLegacyArchives, createImportBatch, decideTopicCandidate, exportKnowledgeAssets,
  generateTopicBrief, generateTopicCandidates, getImportBatch, listImportBatches, listKnowledgeOutputs, retryImportBatch, setImportBatchPaused, startImportBatch,
  saveKnowledgeOutputAsDocument,
} from '../services/knowledge-lifecycle.js';
import { enumerateDingtalkWiki, enumerateDriveFolder, enumerateFeishuSpace } from '../services/knowledge-connectors.js';
import { currentDocumentVersion, listDocumentVersions, readDocumentVersion, searchDocumentChunks } from '../services/knowledge-documents.js';
import { generateTopicUnderstanding, getTopicUnderstanding, runAutoOrganization } from '../services/knowledge-topics-v2.js';
import { getKnowledgeTextDestination } from '../services/knowledge-text.js';

const manifestSchema = z.object({
  provider: z.enum(['feishu','dingtalk']), reference: z.string().min(1).max(500), title: z.string().trim().min(1).max(500),
  url: z.string().url().nullable().optional(), path: z.string().max(2000).nullable().optional(), type: z.string().max(100).nullable().optional(),
});

export default async function knowledgeLifecycleRoutes(app: FastifyInstance) {
  app.get('/api/knowledge/lifecycle/documents/search', async (req) => {
    const query = z.object({ q:z.string().trim().min(1), limit:z.coerce.number().int().min(1).max(50).default(12) }).parse(req.query ?? {});
    return { results: searchDocumentChunks(query.q, query.limit) };
  });
  app.get('/api/knowledge/lifecycle/documents/:sourceKey/versions', async (req) => {
    const { sourceKey } = z.object({ sourceKey:z.string().min(1) }).parse(req.params);
    return { current: currentDocumentVersion(sourceKey), versions: listDocumentVersions(sourceKey) };
  });
  app.get('/api/knowledge/lifecycle/documents/:sourceKey/versions/:versionId', async (req) => {
    const { sourceKey, versionId } = z.object({ sourceKey:z.string().min(1), versionId:z.coerce.number().int() }).parse(req.params);
    const query=z.object({offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(100_000).default(100_000)}).parse(req.query??{});
    return { version: readDocumentVersion(sourceKey,versionId,query.offset,query.limit) };
  });
  app.post('/api/knowledge/lifecycle/bridge-archives', async () => bridgeLegacyArchives());
  app.get('/api/knowledge/lifecycle/model-destination',async()=>getKnowledgeTextDestination());
  app.post('/api/knowledge/lifecycle/auto-organize', async (req) => {
    const body=z.object({documentKeys:z.array(z.string().min(1)).max(10_000).optional(),offset:z.number().int().min(0).default(0)}).parse(req.body ?? {});
    return runAutoOrganization(body);
  });
  app.get('/api/knowledge/lifecycle/auto-organize/runs', async () => ({ runs:(await import('../db.js')).db.prepare(`SELECT * FROM topic_analysis_runs WHERE kind='discovery' ORDER BY updated_at DESC LIMIT 50`).all() }));
  app.post('/api/knowledge/lifecycle/topics/:id/understanding', async (req) => {
    const {id}=z.object({id:z.coerce.number().int()}).parse(req.params);
    return generateTopicUnderstanding(id);
  });
  app.get('/api/knowledge/lifecycle/topics/:id/understanding', async (req) => {
    const {id}=z.object({id:z.coerce.number().int()}).parse(req.params);
    return getTopicUnderstanding(id);
  });
  app.post('/api/knowledge/lifecycle/batches', async (req) => {
    const body = z.object({ provider: z.enum(['feishu','dingtalk']), scope: z.unknown().default({}), items: z.array(manifestSchema).min(1).max(10_000), autoOrganization:z.object({authorized:z.boolean(),destinationHash:z.string().nullable().optional()}).optional() }).parse(req.body ?? {});
    return createImportBatch(body.provider, body.scope, body.items,body.autoOrganization);
  });
  app.post('/api/knowledge/lifecycle/batches/preview',async(req)=>{
    const body=z.discriminatedUnion('provider',[
      z.object({provider:z.literal('feishu'),wiki:z.array(z.object({spaceId:z.string().min(1),spaceName:z.string().min(1),parentNodeToken:z.string().optional()})).max(50).default([]),drive:z.array(z.string().min(1)).max(50).default([]),autoOrganization:z.object({authorized:z.boolean(),destinationHash:z.string().nullable().optional()}).optional()}),
      z.object({provider:z.literal('dingtalk'),spaceUrl:z.string().url(),autoOrganization:z.object({authorized:z.boolean(),destinationHash:z.string().nullable().optional()}).optional()}),
    ]).parse(req.body??{});
    const docs=[] as Array<{provider:'feishu'|'dingtalk';reference:string;title:string;url:string|null;path:string|null;type:string|null}>;
    if(body.provider==='feishu'){
      if(!body.wiki.length&&!body.drive.length)throw app.httpErrors.badRequest('至少选择一个飞书空间或文件夹');
      for(const item of body.wiki)for(const doc of await enumerateFeishuSpace(item.spaceId,item.spaceName,item.parentNodeToken))docs.push({provider:'feishu',reference:doc.reference,title:doc.title,url:doc.url,path:doc.path??null,type:doc.type});
      for(const folder of body.drive)for(const doc of await enumerateDriveFolder(folder))docs.push({provider:'feishu',reference:doc.reference,title:doc.title,url:doc.url,path:doc.path??null,type:doc.type});
    }else{const result=await enumerateDingtalkWiki(body.spaceUrl);for(const doc of result.documents)docs.push({provider:'dingtalk',reference:doc.reference,title:doc.title,url:doc.url,path:doc.path??null,type:doc.type});}
    const unique=[...new Map(docs.map(doc=>[`${doc.provider}:${doc.reference}`,doc])).values()];
    return createImportBatch(body.provider,body,unique,body.autoOrganization);
  });
  app.get('/api/knowledge/lifecycle/batches/:id', async (req) => {
    const { id } = z.object({ id:z.string().uuid() }).parse(req.params); const batch = getImportBatch(id);
    if (!batch) throw app.httpErrors.notFound('批次不存在'); return batch;
  });
  app.get('/api/knowledge/lifecycle/batches',async()=>({batches:listImportBatches()}));
  app.post('/api/knowledge/lifecycle/batches/:id/start', async (req) => {
    const { id } = z.object({ id:z.string().uuid() }).parse(req.params); return startImportBatch(id);
  });
  app.post('/api/knowledge/lifecycle/batches/:id/pause', async (req) => {
    const { id } = z.object({ id:z.string().uuid() }).parse(req.params); return setImportBatchPaused(id, true);
  });
  app.post('/api/knowledge/lifecycle/batches/:id/resume', async (req) => {
    const { id } = z.object({ id:z.string().uuid() }).parse(req.params); setImportBatchPaused(id, false); return startImportBatch(id);
  });
  app.post('/api/knowledge/lifecycle/batches/:id/retry',async(req)=>{const {id}=z.object({id:z.string().uuid()}).parse(req.params);return retryImportBatch(id);});
  app.post('/api/knowledge/lifecycle/topic-candidates/generate', async (req) => {const body=z.object({offset:z.number().int().min(0).default(0),documentKeys:z.array(z.string()).max(80).optional()}).parse(req.body??{});return generateTopicCandidates(body);});
  app.get('/api/knowledge/lifecycle/topic-candidates', async () => {const db=(await import('../db.js')).db;const rows=db.prepare(`SELECT * FROM topic_candidates ORDER BY updated_at DESC LIMIT 100`).all() as Array<Record<string,unknown>>;return {candidates:rows.map(row=>{const keys=JSON.parse(String(row.member_keys_json)) as string[];const member_documents=keys.length?db.prepare(`SELECT source_key,title,canonical_url,body_status,provider FROM source_documents WHERE source_key IN (${keys.map(()=>'?').join(',')})`).all(...keys):[];return {...row,member_documents};})};});
  app.post('/api/knowledge/lifecycle/topic-candidates/:id/decision', async (req) => {
    const { id } = z.object({ id:z.coerce.number().int() }).parse(req.params);
    const body = z.object({ action:z.enum(['accept','ignore']), excluded:z.array(z.string()).max(500).default([]), mergeTopicId:z.number().int().optional() }).parse(req.body ?? {});
    return { candidate: decideTopicCandidate(id, body.action, body.excluded, body.mergeTopicId) };
  });
  app.get('/api/knowledge/lifecycle/export', async (req, reply) => {
    const query = z.object({ topicId:z.coerce.number().int().optional(), format:z.enum(['json','markdown']).default('json') }).parse(req.query ?? {});
    const result = exportKnowledgeAssets(query.topicId);
    const name=query.topicId?`knowledge-topic-${query.topicId}`:'knowledge-library';
    reply.header('Content-Disposition',`attachment; filename="${name}.${query.format==='markdown'?'md':'json'}"`);
    if (query.format === 'markdown') return reply.type('text/markdown; charset=utf-8').send(result.markdown);
    return reply.type('application/json; charset=utf-8').send(result.json);
  });
  app.post('/api/knowledge/lifecycle/topics/:id/brief',async(req)=>{const {id}=z.object({id:z.coerce.number().int()}).parse(req.params);return {output:await generateTopicBrief(id)};});
  app.get('/api/knowledge/lifecycle/outputs',async()=>({outputs:listKnowledgeOutputs()}));
  app.get('/api/knowledge/lifecycle/outputs/:id',async(req)=>{const {id}=z.object({id:z.coerce.number().int()}).parse(req.params);const row=(await import('../db.js')).db.prepare(`SELECT * FROM knowledge_outputs WHERE id=?`).get(id);if(!row)throw app.httpErrors.notFound('成果不存在');return {output:row};});
  app.post('/api/knowledge/lifecycle/outputs/:id/save-as-document',async(req)=>{const {id}=z.object({id:z.coerce.number().int()}).parse(req.params);const {saveKey,overwriteManual}=z.object({saveKey:z.string().trim().min(8).max(200),overwriteManual:z.boolean().optional()}).parse(req.body??{});return saveKnowledgeOutputAsDocument(id,saveKey,{overwriteManual});});
}
