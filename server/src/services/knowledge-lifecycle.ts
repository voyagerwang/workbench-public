/**
 * [INPUT]: 依赖 SQLite、云文档连接器、正文规范化器与知识专属 WorkBuddy 文本边界
 * [OUTPUT]: 提供旧存档桥接、持久批次执行、主题候选归纳/采纳、带来源/缺失/漂移说明的简报与资产导出
 * [POS]: 知识库信息生命周期编排层；路由只做校验，资料抓取与用户资产保护在本层统一决策
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, now, sync_id } from '../db.js';
import { readRemoteKnowledge, type KnowledgeProvider } from './knowledge-connectors.js';
import { generateKnowledgeText, getKnowledgeTextDestination } from './knowledge-text.js';
import { contentHashOf, normalizeDocumentContent, validateRemoteDocument } from './remote-document.js';
import { classifyFetchError, updateEvidenceDrift } from './source-documents.js';
import { catalogProvider } from './knowledge-archive.js';
import { appendDocumentVersion, currentDocumentVersion, ensureDocumentVersion } from './knowledge-documents.js';
import { autoAssociateDocument, autoOrganizeByPath, runAutoOrganization } from './knowledge-topics-v2.js';
import { scheduleDocumentAutoTag } from './tag-auto.js';

export type ImportManifestItem = {
  provider: 'feishu' | 'dingtalk'; reference: string; title: string; url?: string | null;
  path?: string | null; type?: string | null;
};
type ImportReader = typeof readRemoteKnowledge;
let importReader: ImportReader = readRemoteKnowledge;
export function setImportReaderForTest(reader: ImportReader | null): void { importReader = reader ?? readRemoteKnowledge; }

function stableKey(provider: string, reference: string): string {
  return `${provider}:${reference}`;
}
function mergeLegacyDuplicate(remoteKey:string,url:unknown):void{
  if(!url)return;const legacy=db.prepare(`SELECT source_key,title,content,content_hash,body_status,content_origin FROM source_documents WHERE canonical_url=? AND provider='local' AND source_key LIKE 'archive:%' AND deleted_at IS NULL LIMIT 1`).get(String(url)) as {source_key:string;title:string;content:string;content_hash:string|null;body_status:string;content_origin:string}|undefined;
  if(!legacy||legacy.source_key===remoteKey)return;
  db.transaction(()=>{
    if(legacy.content_origin==='manual')db.prepare(`UPDATE source_documents SET title=?,content=?,content_hash=?,body_status=?,content_origin='manual',updated_at=? WHERE source_key=?`).run(legacy.title,legacy.content,legacy.content_hash,legacy.body_status,now(),remoteKey);
    db.prepare(`INSERT OR IGNORE INTO topic_members(id,topic_id,document_key,origin,state,confirmed_at,created_at,updated_at) SELECT sync_id(),topic_id,?,origin,state,confirmed_at,created_at,updated_at FROM topic_members WHERE document_key=?`).run(remoteKey,legacy.source_key);
    db.prepare(`DELETE FROM topic_members WHERE document_key=?`).run(legacy.source_key);
    db.prepare(`UPDATE knowledge_evidence SET document_key=? WHERE document_key=?`).run(remoteKey,legacy.source_key);
    db.prepare(`UPDATE source_documents SET deleted_at=?,updated_at=? WHERE source_key=?`).run(now(),now(),legacy.source_key);
  })();
}

/** 旧存档是一个可编辑来源；仅其正文仍由桥接维护时才跟随更新。 */
export function bridgeLegacyArchives(): { created: number; updated: number; deleted: number; restored: number } {
  const rows = db.prepare(`SELECT id,title,content,source_kind,source_url,canonical_url,status,error,updated_at,deleted_at FROM knowledge_archives`)
    .all() as Array<Record<string, string | number | null>>;
  const result = { created: 0, updated: 0, deleted: 0, restored: 0 };
  const upsert = db.prepare(`INSERT INTO source_documents
    (source_key,provider,external_id,title,canonical_url,document_type,content,content_hash,body_status,
     content_origin,source_version,path,updated_at,deleted_at)
    VALUES (?, 'local', ?, ?, ?, 'other', ?, ?, ?, 'fetch', ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      title=CASE WHEN source_documents.content_origin='fetch' THEN excluded.title ELSE source_documents.title END, canonical_url=COALESCE(excluded.canonical_url,source_documents.canonical_url),
      content=CASE WHEN source_documents.content_origin='fetch' THEN excluded.content ELSE source_documents.content END,
      content_hash=CASE WHEN source_documents.content_origin='fetch' THEN excluded.content_hash ELSE source_documents.content_hash END,
      body_status=CASE WHEN source_documents.content_origin='fetch' THEN excluded.body_status ELSE source_documents.body_status END,
      source_version=excluded.source_version, path=excluded.path, updated_at=excluded.updated_at,
      deleted_at=excluded.deleted_at`);
  for (const row of rows) {
    const url = String(row.canonical_url ?? row.source_url ?? '');
    if (catalogProvider(url)) continue;
    const sameRemote = url ? db.prepare(`SELECT source_key FROM source_documents WHERE canonical_url=? AND provider IN ('feishu','dingtalk') LIMIT 1`).get(url) as { source_key: string } | undefined : undefined;
    if (sameRemote) continue;
    const key = `archive:${row.id}`;
    const before = db.prepare(`SELECT deleted_at,content_origin,content_hash,title,source_version,last_fetch_status FROM source_documents WHERE source_key=?`).get(key) as { deleted_at: string | null; content_origin: string; content_hash:string|null; title:string; source_version:string|null; last_fetch_status:string|null } | undefined;
    const content = normalizeDocumentContent(String(row.content ?? ''));
    const deletedAt = row.deleted_at ? String(row.deleted_at) : null;
    const hash=content?contentHashOf(content):null; const failed=row.status==='failed';
    const version=String(row.updated_at ?? now());
    if(before&&before.source_version===version&&before.deleted_at===deletedAt) continue;
    if(before){const previous=db.prepare('SELECT source_key,content,content_origin,source_version,source_nature FROM source_documents WHERE source_key=?').get(key) as Parameters<typeof ensureDocumentVersion>[0];ensureDocumentVersion(previous);}
    upsert.run(key, String(row.id), String(row.title ?? ''), url || null, content, hash,
      failed?'failed':content ? 'fetched' : 'pending', version,
      `archive:${row.id}`, String(row.updated_at ?? now()), deletedAt);
    if (content) appendDocumentVersion(key, content, 'remote', version, before?.content_origin !== 'manual');
    if(failed) db.prepare(`UPDATE source_documents SET last_fetch_status='failed',fetch_error=?,fetch_error_code='legacy_failed',fetch_error_retryable=1 WHERE source_key=?`).run(String(row.error??'旧存档抓取失败'),key);
    if(before?.content_hash&&before.content_hash!==hash&&before.content_origin==='fetch') updateEvidenceDrift(key,hash);
    if (!before) result.created += 1;
    else if (!before.deleted_at && deletedAt) result.deleted += 1;
    else if (before.deleted_at && !deletedAt) result.restored += 1;
    else result.updated += 1;
  }
  return result;
}

const activeBatchRuns=new Map<string,Promise<ReturnType<typeof getImportBatch>>>();
const unsupportedTypes=new Set(['atable','bitable','sheet','spreadsheet','whiteboard','board','mindnote','file','shortcut','folder']);

export function createImportBatch(provider: 'feishu' | 'dingtalk', scope: unknown, items: ImportManifestItem[], autoOrganization?:{authorized:boolean;destinationHash?:string|null}) {
  const id = randomUUID(); const ts = now();
  const destination=getKnowledgeTextDestination();
  if(autoOrganization?.authorized&&(!destination.available||autoOrganization.destinationHash!==destination.signature))throw Object.assign(new Error('自动整理目的地已变化，请重新确认'),{statusCode:409,publicCode:'model_destination_changed'});
  const unique = [...new Map(items.filter((x) => x.provider === provider && x.reference).map((x) => [stableKey(provider, x.reference), x])).values()];
  db.transaction(() => {
    db.prepare(`INSERT INTO knowledge_import_batches(id,provider,scope_json,status,discovered_count,auto_organization_authorized,auto_organization_destination_hash,created_at,updated_at) VALUES(?,?,?,'draft',?,?,?,?,?)`)
      .run(id, provider, JSON.stringify(scope ?? {}), unique.length, autoOrganization?.authorized?1:0,autoOrganization?.authorized?destination.signature:null,ts,ts);
    const insert = db.prepare(`INSERT INTO knowledge_import_items(id,batch_id,source_key,source_reference,title,canonical_url,source_path,document_type,source_type,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?)`);
    for (const item of unique) insert.run(sync_id(), id, stableKey(provider, item.reference), item.reference, item.title, item.url ?? null, item.path ?? null, mapType(item.type), item.type ?? null, ts, ts);
  })();
  return getImportBatch(id);
}

function mapType(type?: string | null): string {
  return ['prd','version','manual','governance','research','data','plan','ops'].includes(type ?? '') ? type! : 'other';
}

export function getImportBatch(id: string) {
  const batch = db.prepare(`SELECT * FROM knowledge_import_batches WHERE id=?`).get(id);
  if (!batch) return null;
  const items = db.prepare(`SELECT i.*,d.body_status,d.content_origin,d.source_nature FROM knowledge_import_items i LEFT JOIN source_documents d ON d.source_key=i.source_key WHERE i.batch_id=? ORDER BY i.created_at,i.id`).all(id);
  return { batch, items };
}
export function listImportBatches(){return db.prepare(`SELECT * FROM knowledge_import_batches ORDER BY created_at DESC LIMIT 50`).all();}
export function startImportBatch(id:string){if(!getImportBatch(id))throw Object.assign(new Error('批次不存在'),{statusCode:404});void runImportBatch(id).catch((error)=>{db.prepare(`UPDATE knowledge_import_batches SET status='failed',updated_at=?,finished_at=? WHERE id=?`).run(now(),now(),id);console.error('[knowledge-batch]',(error as Error).message);});return getImportBatch(id);}
export function retryImportBatch(id:string){const batch=getImportBatch(id);if(!batch)throw Object.assign(new Error('批次不存在'),{statusCode:404});db.prepare(`UPDATE knowledge_import_items SET status='queued',round_attempts=0,retry_round=retry_round+1,finished_at=NULL,updated_at=? WHERE batch_id=? AND status='failed' AND retryable=1`).run(now(),id);db.prepare(`UPDATE knowledge_import_batches SET status='partial',finished_at=NULL,updated_at=? WHERE id=?`).run(now(),id);return startImportBatch(id);}

export function setImportBatchPaused(id: string, paused: boolean) {
  const status = paused ? 'paused' : 'running';
  const info = db.prepare(`UPDATE knowledge_import_batches SET status=?,updated_at=? WHERE id=? AND status IN ('draft','running','paused','partial')`).run(status, now(), id);
  if (!info.changes) throw Object.assign(new Error('批次不存在或已结束'), { statusCode: 409 });
  return getImportBatch(id);
}

async function fetchImportItem(row: Record<string, unknown>): Promise<void> {
  const sourceKey = String(row.source_key); const provider = sourceKey.slice(0, sourceKey.indexOf(':')); const reference = String(row.source_reference);
  const existing = db.prepare(`SELECT content_origin,content_hash,body_status FROM source_documents WHERE source_key=?`).get(sourceKey) as
    { content_origin: string; content_hash: string | null; body_status: string } | undefined;
  const remote = await importReader(provider as KnowledgeProvider, reference);
  const verdict = validateRemoteDocument(remote);
  if (verdict.verdict === 'error') throw new Error(verdict.reason);
  const content = normalizeDocumentContent(remote.content); const hash = contentHashOf(content); const ts = now();
  if(existing){const previous=db.prepare('SELECT source_key,content,content_origin,source_version,source_nature FROM source_documents WHERE source_key=?').get(sourceKey) as Parameters<typeof ensureDocumentVersion>[0];ensureDocumentVersion(previous);}
  db.prepare(`INSERT INTO source_documents(source_key,provider,external_id,title,canonical_url,path,document_type,content,content_hash,body_status,last_fetch_status,content_origin,fetched_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'ok','fetch',?,?) ON CONFLICT(source_key) DO UPDATE SET
      title=CASE WHEN source_documents.content_origin='manual' THEN source_documents.title ELSE excluded.title END,canonical_url=COALESCE(excluded.canonical_url,source_documents.canonical_url),path=COALESCE(excluded.path,source_documents.path),
      document_type=excluded.document_type,content=CASE WHEN source_documents.content_origin='manual' THEN source_documents.content ELSE excluded.content END,
      content_hash=CASE WHEN source_documents.content_origin='manual' THEN source_documents.content_hash ELSE excluded.content_hash END,
      body_status=CASE WHEN source_documents.content_origin='manual' THEN source_documents.body_status ELSE excluded.body_status END,
      last_fetch_status='ok',fetch_error=NULL,fetch_error_code=NULL,fetch_error_retryable=NULL,fetched_at=excluded.fetched_at,updated_at=excluded.updated_at`)
    .run(sourceKey, provider, reference, remote.title?.trim() || String(row.title), row.canonical_url, row.source_path, row.document_type,
      content, hash, verdict.verdict === 'ok' ? 'fetched' : 'suspect', verdict.verdict === 'ok' ? ts : null, ts);
  appendDocumentVersion(sourceKey, content, 'remote', null, existing?.content_origin !== 'manual');
  autoAssociateDocument(sourceKey);
  // 自动打标（docs/knowledge-tags-unified-pool.md）：非阻塞排队，失败只留日志，绝不影响导入结果
  scheduleDocumentAutoTag(sourceKey);
  mergeLegacyDuplicate(sourceKey,row.canonical_url);
  if (existing?.content_hash && existing.content_hash !== hash && existing.content_origin !== 'manual') updateEvidenceDrift(sourceKey, hash);
}

export async function refreshLifecycleDocument(sourceKey:string){
  const row=db.prepare(`SELECT * FROM source_documents WHERE source_key=? AND deleted_at IS NULL`).get(sourceKey) as Record<string,unknown>|undefined;
  if(!row)throw Object.assign(new Error('资料不存在'),{statusCode:404});
  if(row.content_origin==='manual'||!['feishu','dingtalk'].includes(String(row.provider)))throw Object.assign(new Error('这份资料由人工维护，没有可用的远程刷新通道'),{statusCode:409,publicCode:'manual_no_pipeline'});
  try{await fetchImportItem({...row,source_reference:row.external_id,source_path:row.path});}
  catch(error){const kind=classifyFetchError((error as Error).message);db.prepare(`UPDATE source_documents SET last_fetch_status='failed',fetch_error=?,fetch_error_code=?,fetch_error_retryable=?,updated_at=? WHERE source_key=? AND content_origin!='manual'`).run((error as Error).message.slice(0,500),kind.code,kind.retryable?1:0,now(),sourceKey);}
  return db.prepare(`SELECT * FROM source_documents WHERE source_key=?`).get(sourceKey);
}

/** 固定两 worker；每次 claim 先落 SQLite，暂停后不领取新项。 */
export async function runImportBatch(id: string) {
  const existingRun=activeBatchRuns.get(id); if(existingRun)return existingRun;
  if(!getImportBatch(id))throw Object.assign(new Error('批次不存在'),{statusCode:404});
  const run=(async()=>{
  db.prepare(`UPDATE knowledge_import_batches SET status='running',updated_at=? WHERE id=? AND status IN ('draft','partial','running')`).run(now(), id);
  const worker = async () => {
    for (;;) {
      const batch = db.prepare(`SELECT status FROM knowledge_import_batches WHERE id=?`).get(id) as { status: string } | undefined;
      if (!batch || batch.status !== 'running') return;
      const row = db.prepare(`SELECT * FROM knowledge_import_items WHERE batch_id=? AND status='queued' ORDER BY updated_at,id LIMIT 1`).get(id) as Record<string, unknown> | undefined;
      if (!row) return;
      const claim = db.prepare(`UPDATE knowledge_import_items SET status='running',attempts=attempts+1,round_attempts=round_attempts+1,claimed_at=?,updated_at=? WHERE id=? AND status='queued'`).run(now(), now(), row.id);
      if (!claim.changes) continue;
      try {
        if(unsupportedTypes.has(String(row.source_type??'').toLowerCase())){
          db.prepare(`UPDATE knowledge_import_items SET status='skipped',error_code='unsupported_type',error_message='当前类型仅保留来源，正文未就绪',retryable=0,finished_at=?,updated_at=? WHERE id=?`).run(now(),now(),row.id);
          finalizeBatch(id); continue;
        }
        await fetchImportItem(row);
        db.prepare(`UPDATE knowledge_import_items SET status='succeeded',error_code=NULL,error_message=NULL,retryable=NULL,finished_at=?,updated_at=? WHERE id=?`).run(now(), now(), row.id); finalizeBatch(id);
      } catch (error) {
        const message = (error as Error).message; const kind = classifyFetchError(message);
        const attempts = Number(row.round_attempts ?? 0) + 1;
        const retry = kind.retryable && attempts < 3;
        db.prepare(`UPDATE source_documents SET last_fetch_status='failed',fetch_error=?,fetch_error_code=?,fetch_error_retryable=?,updated_at=? WHERE source_key=? AND content_origin!='manual'`).run(message.slice(0,500),kind.code,kind.retryable?1:0,now(),row.source_key);
        if(retry)await new Promise(resolve=>setTimeout(resolve,attempts===1?200:800));
        db.prepare(`UPDATE knowledge_import_items SET status=?,error_code=?,error_message=?,retryable=?,finished_at=?,updated_at=? WHERE id=?`)
          .run(retry ? 'queued' : kind.code === 'invalid_request' ? 'skipped' : 'failed', kind.code, message.slice(0,500), kind.retryable ? 1 : 0, retry ? null : now(), now(), row.id); finalizeBatch(id);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  finalizeBatch(id); return getImportBatch(id);
  })(); activeBatchRuns.set(id,run); try{return await run;}finally{activeBatchRuns.delete(id);}
}

function finalizeBatch(id: string): void {
  const counts = db.prepare(`SELECT COUNT(*) total,SUM(i.status IN ('succeeded','failed','skipped')) processed,
    SUM(i.status='succeeded' AND d.body_status='fetched') usable,
    SUM(i.status='succeeded' AND d.body_status='suspect') incomplete,
    SUM(i.status='failed') failed,SUM(i.status='skipped') skipped,SUM(i.status IN ('queued','running')) pending
    FROM knowledge_import_items i LEFT JOIN source_documents d ON d.source_key=i.source_key WHERE i.batch_id=?`).get(id) as Record<string, number>;
  const current = db.prepare(`SELECT status FROM knowledge_import_batches WHERE id=?`).get(id) as { status: string };
  const status = current.status === 'paused' ? 'paused' : counts.pending ? 'running' : counts.failed || counts.skipped || counts.incomplete ? counts.usable ? 'partial' : 'failed' : 'completed';
  db.prepare(`UPDATE knowledge_import_batches SET status=?,completed_count=?,usable_count=?,incomplete_count=?,failed_count=?,skipped_count=?,updated_at=?,finished_at=? WHERE id=?`)
    .run(status, counts.processed || 0, counts.usable || 0, counts.incomplete || 0, counts.failed || 0, counts.skipped || 0, now(), ['completed','partial','failed'].includes(status) ? now() : null, id);
  if (['completed','partial'].includes(status) && counts.usable) {
    const keys=(db.prepare(`SELECT source_key FROM knowledge_import_items WHERE batch_id=? AND status='succeeded'`).all(id) as Array<{source_key:string}>).map(row=>row.source_key);
    autoOrganizeByPath(keys);
    const authorization=db.prepare(`SELECT auto_organization_authorized authorized,auto_organization_destination_hash destination_hash FROM knowledge_import_batches WHERE id=?`).get(id) as {authorized:number;destination_hash:string|null};
    if(!authorization.authorized){db.prepare(`UPDATE knowledge_import_batches SET auto_organization_status='completed',updated_at=? WHERE id=?`).run(now(),id);return;}
    const destination=getKnowledgeTextDestination();
    if(!destination.available||destination.signature!==authorization.destination_hash){db.prepare(`UPDATE knowledge_import_batches SET auto_organization_status='failed',auto_organization_error='模型目的地已变化，请重新确认',updated_at=? WHERE id=?`).run(now(),id);return;}
    const claimed=db.prepare(`UPDATE knowledge_import_batches SET auto_organization_status='running',updated_at=? WHERE id=? AND auto_organization_status='pending'`).run(now(),id);if(!claimed.changes)return;
    void runAutoOrganization({documentKeys:keys}).then(result=>db.prepare(`UPDATE knowledge_import_batches SET auto_organization_status=?,auto_organization_error=?,updated_at=? WHERE id=?`).run(result.status==='published'?(result.coverage?.partial?'running':'completed'):'failed',result.coverage?.partial?'仍有资料待继续自动整理':result.status==='failed'?String(result.error):null,now(),id)).catch(error=>db.prepare(`UPDATE knowledge_import_batches SET auto_organization_status='failed',auto_organization_error=?,updated_at=? WHERE id=?`).run((error as Error).message.slice(0,1000),now(),id));
  }
}

const candidatePayloadSchema=z.object({candidates:z.array(z.object({name:z.string().trim().min(1).max(60),reason:z.string().max(2000),summary:z.string().max(6000),member_keys:z.array(z.string().min(1)).max(80)})).max(8)});
type CandidateGenerator = (prompt: string) => Promise<string>;
let candidateGenerator: CandidateGenerator = generateKnowledgeText;
export function setCandidateGeneratorForTest(generator: CandidateGenerator | null): void {
  candidateGenerator = generator ?? generateKnowledgeText;
}

const candidateRuns=new Map<string,Promise<unknown>>(); const CANDIDATE_RULE='topics-v2';
export async function generateTopicCandidates(options:{offset?:number;documentKeys?:string[]}={}):Promise<Record<string,unknown>> {
  const offset=Math.max(0,options.offset??0); const keys=options.documentKeys?.slice(0,80)??[];
  // 归纳输入只认一手资料：agent_derived（主题简报等派生成果）不再进入候选归纳，避免"总结套总结"
  const where=(keys.length?`AND source_key IN (${keys.map(()=>'?').join(',')})`:'')+" AND source_nature='source'";
  const allCount=(db.prepare(`SELECT COUNT(*) n FROM source_documents WHERE deleted_at IS NULL AND body_status='fetched' ${where}`).get(...keys) as {n:number}).n;
  const docs = db.prepare(`SELECT source_key,title,content,content_hash FROM source_documents WHERE deleted_at IS NULL AND body_status='fetched' ${where} ORDER BY updated_at DESC,source_key LIMIT 40 OFFSET ?`).all(...keys,offset) as Array<Record<string,string>>;
  if (!docs.length) throw Object.assign(new Error('没有可用于归纳的正文'), { statusCode: 409 });
  const inputHash = createHash('sha256').update(`${CANDIDATE_RULE}|${docs.map((d) => `${d.source_key}:${d.content_hash}`).sort().join('|')}`).digest('hex');
  const cached = db.prepare(`SELECT * FROM topic_candidates WHERE input_hash=? ORDER BY id`).all(inputHash);
  const completed=db.prepare(`SELECT 1 FROM topic_candidate_runs WHERE input_hash=?`).get(inputHash);
  if (completed) return { input_hash: inputHash, candidates: cached, reused: true,coverage:{offset,count:docs.length,total:allCount,next_offset:offset+docs.length<allCount?offset+docs.length:null} };
  const active=candidateRuns.get(inputHash); if(active)return active as Promise<Record<string,unknown>>;
  const run=(async()=>{
  // 分批归纳：一次 8 篇（约 2.2 万字）——40 篇全量提示词曾超文本通道承受力（502），分批后单次负载可控；
  // 任一批失败整轮 502（不落半截候选，重试按同一 input_hash 幂等重跑）
  const BATCH=8; const collected:Array<{name:string;reason:string;summary:string;keys:string[]}>=[]; let totalParsed=0;
  for(let start=0;start<docs.length;start+=BATCH){
    const group=docs.slice(start,start+BATCH);
    const prompt = `请仅返回 JSON：{"candidates":[{"name":"主题名","reason":"理由","summary":"带出处概览","member_keys":["资料key"]}]}。最多8组。资料 key 必须来自输入。\n${group.map((d) => `[${d.source_key}] ${d.title}\n${d.content.slice(0,2800)}`).join('\n\n')}`;
    let parsed:z.infer<typeof candidatePayloadSchema>;
    try { const raw = await candidateGenerator(prompt); parsed = candidatePayloadSchema.parse(JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ''))); }
    catch { throw Object.assign(new Error('模型没有返回符合结构的主题候选 JSON'), { statusCode: 502 }); }
    const allowed = new Set(group.map((d) => d.source_key)); totalParsed+=(parsed.candidates?.length??0);
    for (const item of parsed.candidates ?? []) {
      const keys = [...new Set((item.member_keys ?? []).filter((key) => allowed.has(key)))];
      collected.push({name:String(item.name ?? ''),reason:String(item.reason ?? ''),summary:String(item.summary ?? ''),keys});
    }
  }
  const names = new Set<string>(); const ts = now();
  const snapshot = Object.fromEntries(docs.map((d) => [d.source_key, d.content_hash]));
  const insert = db.prepare(`INSERT INTO topic_candidates(id,input_hash,input_snapshot_json,name,reason,summary_draft,member_keys_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)`);
  let inserted=0;
  for (const item of collected) {
    const name = item.name.trim().slice(0,60); const lower = name.toLowerCase();
    if (!name || names.has(lower)) continue; names.add(lower);
    if (!item.keys.length) continue;
    insert.run(sync_id(), inputHash, JSON.stringify(snapshot), name, item.reason.slice(0,2000), item.summary.slice(0,6000), JSON.stringify(item.keys), ts, ts); inserted++;
    if(inserted>=24)break;
  }
  const count=(db.prepare(`SELECT COUNT(*) n FROM topic_candidates WHERE input_hash=?`).get(inputHash) as {n:number}).n;
  db.prepare(`INSERT INTO topic_candidate_runs(input_hash,rule_version,input_snapshot_json,candidate_count,created_at) VALUES(?,?,?,?,?)`).run(inputHash,CANDIDATE_RULE,JSON.stringify(snapshot),count,ts);
  return { input_hash: inputHash, candidates: db.prepare(`SELECT * FROM topic_candidates WHERE input_hash=? ORDER BY id`).all(inputHash), reused: false,coverage:{offset,count:docs.length,total:allCount,next_offset:offset+docs.length<allCount?offset+docs.length:null} };
  })();candidateRuns.set(inputHash,run);try{return await run;}finally{candidateRuns.delete(inputHash);}
}

export function decideTopicCandidate(id: number, action: 'accept'|'ignore', excluded: string[] = [], mergeTopicId?: number) {
  const candidate = db.prepare(`SELECT * FROM topic_candidates WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!candidate) throw Object.assign(new Error('候选不存在'), { statusCode: 404 });
  if (candidate.status !== 'pending') return candidate;
  if (action === 'ignore') { db.prepare(`UPDATE topic_candidates SET status='ignored',updated_at=? WHERE id=?`).run(now(), id); return db.prepare(`SELECT * FROM topic_candidates WHERE id=?`).get(id); }
  const originalKeys = JSON.parse(String(candidate.member_keys_json)) as string[];
  const keys = originalKeys.filter((key) => !excluded.includes(key));
  if(!keys.length)throw Object.assign(new Error('至少保留一份有效资料'),{statusCode:409});
  const snapshot = JSON.parse(String(candidate.input_snapshot_json)) as Record<string,string>;
  const stale = keys.some((key) => {
    const current = db.prepare(`SELECT content_hash FROM source_documents WHERE source_key=? AND deleted_at IS NULL AND body_status='fetched'`).get(key) as { content_hash: string | null } | undefined;
    return !current || current.content_hash !== snapshot[key];
  });
  if (stale) throw Object.assign(new Error('候选资料内容已变化，请重新归纳'), { statusCode: 409 });
  const topicId = mergeTopicId ?? sync_id(); const ts = now();
  db.transaction(() => {
    if (!mergeTopicId) db.prepare(`INSERT INTO topics(id,name,summary,created_at,updated_at) VALUES(?,?,?,?,?)`).run(topicId, candidate.name, candidate.summary_draft, ts, ts);
    else if (!db.prepare(`SELECT 1 FROM topics WHERE id=? AND deleted_at IS NULL`).get(topicId)) throw new Error('目标主题不存在');
    const add = db.prepare(`INSERT INTO topic_members(id,topic_id,document_key,origin,state,confirmed_at,created_at,updated_at) VALUES(?,?,?,'ai','confirmed',?,?,?) ON CONFLICT(topic_id,document_key) DO UPDATE SET state='confirmed',updated_at=excluded.updated_at`);
    for (const key of keys) add.run(sync_id(), topicId, key, ts, ts, ts);
    db.prepare(`UPDATE topic_candidates SET status='accepted',accepted_topic_id=?,updated_at=? WHERE id=? AND status='pending'`).run(topicId, ts, id);
  })();
  return db.prepare(`SELECT * FROM topic_candidates WHERE id=?`).get(id);
}

export function exportKnowledgeAssets(topicId?: number) {
  const topicFilter = topicId ? `WHERE t.id=? AND t.deleted_at IS NULL` : `WHERE t.deleted_at IS NULL`;
  const topics = db.prepare(`SELECT t.* FROM topics t ${topicFilter}`).all(...(topicId ? [topicId] : []));
  const knowledge = topicId ? db.prepare(`SELECT id,topic_id,statement,kind,status,created_at,updated_at FROM knowledge_items WHERE topic_id=? AND deleted_at IS NULL`).all(topicId) : db.prepare(`SELECT id,topic_id,statement,kind,status,created_at,updated_at FROM knowledge_items WHERE deleted_at IS NULL`).all();
  const ids = (knowledge as Array<{id:number}>).map((x)=>x.id);
  const evidence = ids.length ? db.prepare(`SELECT id,knowledge_id,document_key,quote_text,quote_prefix,quote_suffix,anchor_from,anchor_to,anchor_basis,source_version,doc_hash_at_ref,drift_state,checked_at,created_at FROM knowledge_evidence WHERE knowledge_id IN (${ids.map(()=>'?').join(',')})`).all(...ids) : [];
  const topicIds=(topics as Array<{id:number}>).map(x=>x.id);
  const members=topicIds.length?db.prepare(`SELECT * FROM topic_members WHERE state='confirmed' AND topic_id IN (${topicIds.map(()=>'?').join(',')})`).all(...topicIds):[];
  const overrides=topicIds.length?db.prepare(`SELECT * FROM topic_member_overrides WHERE topic_id IN (${topicIds.map(()=>'?').join(',')})`).all(...topicIds):[];
  const evidenceKeys=(evidence as Array<{document_key:string}>).map(e=>e.document_key);
  const memberKeys=(members as Array<{document_key:string}>).map(m=>m.document_key);
  const neededKeys=[...new Set(topicId?[...memberKeys,...evidenceKeys]:[])];
  const documents=topicId
    ? neededKeys.length?db.prepare(`SELECT source_key,provider,external_id,space,path,title,canonical_url,document_type,source_version,content,content_hash,normalizer_version,body_status,content_origin,source_nature,fetched_at,created_at,updated_at FROM source_documents WHERE deleted_at IS NULL AND source_key IN (${neededKeys.map(()=>'?').join(',')})`).all(...neededKeys):[]
    : db.prepare(`SELECT source_key,provider,external_id,space,path,title,canonical_url,document_type,source_version,content,content_hash,normalizer_version,body_status,content_origin,source_nature,fetched_at,created_at,updated_at FROM source_documents WHERE deleted_at IS NULL`).all();
  const documentKeys=(documents as Array<{source_key:string}>).map(d=>d.source_key);const versions=documentKeys.length?db.prepare(`SELECT id,document_key,version_no,content,content_hash,origin,source_version,is_current,created_at FROM source_document_versions WHERE document_key IN (${documentKeys.map(()=>'?').join(',')}) ORDER BY document_key,version_no`).all(...documentKeys):[];
  const outputs=topicId?db.prepare(`SELECT * FROM knowledge_outputs WHERE scope_kind='topic' AND scope_id=? OR derived_document_key IN (${documentKeys.length?documentKeys.map(()=>'?').join(','):`''`})`).all(String(topicId),...documentKeys):db.prepare('SELECT * FROM knowledge_outputs').all();
  const payload = { exported_at: now(), scope: topicId ? { kind:'topic', id:topicId } : { kind:'all' }, topics, documents, versions, members, overrides, knowledge, evidence, outputs };
  const markdown = [`# 知识资产导出`, `导出时间：${payload.exported_at}`, ...(topics as Array<Record<string,unknown>>).flatMap((t)=>[`\n## ${t.name}`, String(t.summary || ''), `### 知识`, ...(knowledge as Array<Record<string,unknown>>).filter((k)=>k.topic_id===t.id).map((k)=>`- [${k.status}] ${k.statement}`)]), `\n## 资料`, ...(documents as Array<Record<string,unknown>>).flatMap(d=>[`\n### ${d.title}`,`来源：${d.canonical_url||`/knowledge/documents/${encodeURIComponent(String(d.source_key))}`}  `,`版本：${d.content_hash||'无'}  `,String(d.content||'（正文未就绪）')]), `\n## 证据`, ...(evidence as Array<Record<string,unknown>>).map(e=>`- 知识 ${e.knowledge_id} ← ${e.document_key} (${e.drift_state})：${e.quote_text}`)].join('\n');
  return { json: payload, markdown };
}

type BriefGenerator = (prompt:string)=>Promise<string>;
let briefGenerator: BriefGenerator = generateKnowledgeText;
export function setBriefGeneratorForTest(generator:BriefGenerator|null):void { briefGenerator=generator ?? generateKnowledgeText; }

/** 只消费已确认主题成员与有效知识；结果保存为草稿，不反向升级为知识。
 *  S11 口径：明确实际覆盖的资料版本、未纳入资料及原因、证据已漂移的知识；失败不产出"成功总结"。 */
export async function generateTopicBrief(topicId:number) {
  const topic=db.prepare(`SELECT id,name,summary FROM topics WHERE id=? AND deleted_at IS NULL`).get(topicId) as Record<string,unknown>|undefined;
  if(!topic)throw Object.assign(new Error('主题不存在'),{statusCode:404});
  // 与候选归纳同口径：只消费一手资料，agent_derived（派生成果）不作为简报的一手来源，避免"总结套总结"
  const allMembers=db.prepare(`SELECT d.source_key,d.title,d.canonical_url,d.body_status,d.last_fetch_status,d.fetch_error,d.fetch_error_retryable,d.source_nature FROM topic_members m JOIN source_documents d ON d.source_key=m.document_key LEFT JOIN topic_member_overrides o ON o.topic_id=m.topic_id AND o.document_key=m.document_key WHERE m.topic_id=? AND m.state='confirmed' AND COALESCE(o.decision,'include')!='exclude' AND d.deleted_at IS NULL ORDER BY d.updated_at DESC`).all(topicId) as Array<Record<string,string|number|null>>;
  const usable=(row:Record<string,string|number|null>)=>String(row.body_status)==='fetched'&&!(String(row.last_fetch_status??'ok')==='failed'&&Number(row.fetch_error_retryable)===0)&&String(row.source_nature??'source')==='source';
  const sources=db.prepare(`SELECT d.source_key,d.title,d.canonical_url,v.id version_id,v.version_no,v.content_hash,v.content FROM topic_members m JOIN source_documents d ON d.source_key=m.document_key JOIN source_document_versions v ON v.document_key=d.source_key AND v.is_current=1 LEFT JOIN topic_member_overrides o ON o.topic_id=m.topic_id AND o.document_key=m.document_key WHERE m.topic_id=? AND m.state='confirmed' AND COALESCE(o.decision,'include')!='exclude' AND d.deleted_at IS NULL AND d.body_status='fetched' AND d.source_nature='source' AND NOT(COALESCE(d.last_fetch_status,'ok')='failed' AND d.fetch_error_retryable=0) ORDER BY d.updated_at DESC LIMIT 10000`).all(topicId) as Array<Record<string,string|number>>;
  if(!sources.length)throw Object.assign(new Error('主题没有可用正文'),{statusCode:409});
  const missing=allMembers.filter((row)=>!usable(row)).map((row)=>{
    const status=String(row.body_status);
    const reason=String(row.source_nature??'source')==='agent_derived'
      ?'派生成果（简报/分析），不作为一手资料重复归纳'
      :status==='failed'
      ?`抓取失败${Number(row.fetch_error_retryable)===0?'且不可重试':'（可重试）'}${row.fetch_error?`：${String(row.fetch_error).slice(0,120)}`:''}`
      :status==='suspect'?'正文可能不完整，未纳入分析':status==='pending'?'正文尚未就绪':`正文状态异常（${status}）`;
    return {document_key:String(row.source_key),title:String(row.title),reason};
  });
  const selected:Array<Record<string,string|number>&{used_content:string}>=[];let budget=100_000;
  for(const source of sources){if(budget<=0)break;const raw=String(source.content);const used=raw.slice(0,budget);if(!used)continue;selected.push({...source,used_content:used});budget-=used.length;}
  const selectedKeys=selected.map(s=>String(s.source_key));const knowledge=selectedKeys.length?db.prepare(`SELECT DISTINCT k.statement,k.kind FROM knowledge_items k JOIN knowledge_evidence e ON e.knowledge_id=k.id JOIN source_documents d ON d.source_key=e.document_key JOIN source_document_versions v ON v.document_key=e.document_key AND v.content_hash=e.doc_hash_at_ref WHERE k.topic_id=? AND k.status='active' AND k.deleted_at IS NULL AND e.drift_state='ok' AND d.source_nature='source' AND d.deleted_at IS NULL AND d.body_status='fetched' AND e.document_key IN (${selectedKeys.map(()=>'?').join(',')}) ORDER BY k.updated_at DESC LIMIT 50`).all(topicId,...selectedKeys) as Array<Record<string,string>>:[];
  const driftedKnowledge=db.prepare(`SELECT DISTINCT k.statement,e.drift_state FROM knowledge_items k JOIN knowledge_evidence e ON e.knowledge_id=k.id WHERE k.topic_id=? AND k.status='active' AND k.deleted_at IS NULL AND e.drift_state!='ok' ORDER BY k.updated_at DESC LIMIT 50`).all(topicId) as Array<{statement:string;drift_state:string}>;
  const prompt=`请写一份 Markdown 主题简报。事实后用 [资料key@版本id] 标注来源；明确区分资料事实和建议，不虚构覆盖范围。\n主题：${topic.name}\n已确认知识：${knowledge.map(k=>`- ${k.statement}`).join('\n')}\n资料：\n${selected.map(s=>`[${s.source_key}@${s.version_id}] ${s.title}\n${s.used_content}`).join('\n\n')}`;
  let generated='';try{generated=(await briefGenerator(prompt)).trim();}catch(error){throw Object.assign(new Error(`模型未生成简报：${(error as Error).message.slice(0,200)}`),{statusCode:502});}if(!generated)throw Object.assign(new Error('模型未生成简报'),{statusCode:502});
  const docLink=(key:string)=>`/knowledge/documents/${encodeURIComponent(key)}`;
  const missingSection=missing.length?`\n\n## 未纳入本简报的资料（${missing.length} 份）\n${missing.map(m=>`- [${m.title}](${docLink(m.document_key)}) · ${m.reason}`).join('\n')}`:'';
  const driftSection=driftedKnowledge.length?`\n\n## 证据需人工复核的知识（${driftedKnowledge.length} 条，未作为事实纳入）\n${driftedKnowledge.map(k=>`- ${k.statement}（证据${k.drift_state==='changed'?'位置已变化':'原文当前不可用'}）`).join('\n')}`:'';
  const content=`${generated}\n\n## 已用来源\n${selected.map(source=>`- [${source.title}](/knowledge/documents/${encodeURIComponent(String(source.source_key))}?version=${source.version_id}) · ${source.source_key}@${source.version_id}${source.canonical_url?` · 原始来源：${source.canonical_url}`:''}`).join('\n')}${missingSection}${driftSection}`;
  const id=sync_id(),ts=now(),keys=selected.map(s=>String(s.source_key));const versions=selected.map(s=>({document_key:s.source_key,version_id:s.version_id,version_no:s.version_no,content_hash:s.content_hash,chars:s.used_content.length}));
  db.prepare(`INSERT INTO knowledge_outputs(id,title,content,scope_kind,scope_id,source_keys_json,status,source_versions_json,coverage_json,created_at,updated_at) VALUES(?,?,?,'topic',?,?,'draft',?,?,?,?)`).run(id,`${topic.name}简报`,content,String(topicId),JSON.stringify(keys),JSON.stringify(versions),JSON.stringify({candidate_count:sources.length,covered_count:selected.length,partial:selected.length<sources.length||selected.some(s=>s.used_content.length<String(s.content).length),missing,drifted_knowledge:driftedKnowledge}),ts,ts);
  return db.prepare(`SELECT * FROM knowledge_outputs WHERE id=?`).get(id);
}

/** S11 回存口径：同 save_key 首次保存创建衍生资料；同一主题重新生成后再次保存，以新版本更新同一衍生资料；
 *  跨主题/跨类型/已删除一律 409 且不做任何修改（文档可同属多主题，故要求原输出与新输出 scope 一致，
 *  成员关系仅作合法性辅助校验）；衍生资料当前版本为人工整理时默认 409 不覆盖，
 *  仅在调用方显式 overwriteManual 后才以新版本更新（人工版本保留在历史中）。 */
export function saveKnowledgeOutputAsDocument(outputId:number,saveKey:string,options:{overwriteManual?:boolean}={}){
  const output=db.prepare(`SELECT * FROM knowledge_outputs WHERE id=?`).get(outputId) as Record<string,unknown>&{derived_document_key:string|null;save_key:string|null}|undefined;if(!output)throw Object.assign(new Error('分析不存在'),{statusCode:404});
  // 已保存分析的重复保存（评审边界补充）：删除检查与成员关系校验先于 reused 返回——
  // 源资料已删除或 scope 被篡改（衍生资料已不是其声称主题的成员）都不得返回成功；
  // 同键重存幂等返回自身绑定，换键重存显式 409，绝不静默换绑或产生"未绑定键"。
  if(output.derived_document_key){
    const docKey0=output.derived_document_key;
    const deleted=db.prepare(`SELECT 1 FROM source_documents WHERE source_key=? AND deleted_at IS NOT NULL`).get(docKey0);
    if(deleted)throw Object.assign(new Error('原衍生资料已删除，请使用新的保存键'),{statusCode:409,publicCode:'save_key_conflict'});
    if(String(output.scope_kind)!=='topic'||output.scope_id==null
      ||!db.prepare(`SELECT 1 FROM topics WHERE id=? AND deleted_at IS NULL`).get(Number(output.scope_id))
      ||!db.prepare(`SELECT 1 FROM topic_members WHERE topic_id=? AND document_key=?`).get(Number(output.scope_id),docKey0))
      throw Object.assign(new Error('该保存键已用于另一主题或另一类型的分析，不能跨主题覆盖'),{statusCode:409,publicCode:'save_key_conflict'});
    if(output.save_key===saveKey)return {document_key:docKey0,reused:true};
    throw Object.assign(new Error('该分析已用其他保存键保存，请沿用原保存键'),{statusCode:409,publicCode:'save_key_conflict'});
  }
  const existing=db.prepare(`SELECT id,derived_document_key,scope_kind,scope_id FROM knowledge_outputs WHERE save_key=?`).get(saveKey) as {id:number;derived_document_key:string;scope_kind:string;scope_id:string|null}|undefined;
  if(existing?.derived_document_key){
    const docKey=existing.derived_document_key;
    // 源资料存在性检查先于 reused 早退：已删除的衍生资料不得返回成功
    const doc=db.prepare(`SELECT content_hash FROM source_documents WHERE source_key=? AND deleted_at IS NULL`).get(docKey) as {content_hash:string|null}|undefined;
    if(!doc)throw Object.assign(new Error('原衍生资料已删除，请使用新的保存键'),{statusCode:409,publicCode:'save_key_conflict'});
    // scope 一致性校验（评审复验 P1）：文档可同属多个主题，成员关系不是唯一所属；
    // 必须同时核验原输出与新输出的 scope_kind/scope_id 一致，否则另一主题可借同键覆盖原主题资料。
    if(String(output.scope_kind)!=='topic'||output.scope_id==null
      ||existing.scope_kind!=='topic'||String(existing.scope_id??'')!==String(output.scope_id))
      throw Object.assign(new Error('该保存键已用于另一主题或另一类型的分析，不能跨主题覆盖'),{statusCode:409,publicCode:'save_key_conflict'});
    // 合法性校验（含重复保存）：目标主题须存在且衍生资料确为其成员，防 scope 被篡改后绕过。
    const validateScope=(scopeKind:unknown,scopeId:unknown)=>{
      if(String(scopeKind)!=='topic'||scopeId==null
        ||!db.prepare(`SELECT 1 FROM topics WHERE id=? AND deleted_at IS NULL`).get(Number(scopeId))
        ||!db.prepare(`SELECT 1 FROM topic_members WHERE topic_id=? AND document_key=?`).get(Number(scopeId),docKey))
        throw Object.assign(new Error('该保存键已用于另一主题或另一类型的分析，不能跨主题覆盖'),{statusCode:409,publicCode:'save_key_conflict'});
    };
    validateScope(output.scope_kind,output.scope_id);
    if(existing.id===outputId)return {document_key:docKey,reused:true};
    const ts=now();const content=String(output.content);
    // 人工编辑保护：当前版本是人工整理时不自动切走 current，需显式确认
    const current=currentDocumentVersion(docKey) as {origin:string}|undefined;
    if(current?.origin==='manual'&&!options.overwriteManual)
      throw Object.assign(new Error('已保存资料的当前版本是人工整理，自动更新未覆盖；确认覆盖后旧版本仍保留在历史中'),{statusCode:409,publicCode:'manual_current_version'});
    db.transaction(()=>{
      appendDocumentVersion(docKey,content,'agent',String(outputId));
      db.prepare(`UPDATE source_documents SET title=?,content=?,content_hash=?,updated_at=? WHERE source_key=?`).run(String(output.title),content,contentHashOf(content),ts,docKey);
      db.prepare(`UPDATE knowledge_outputs SET save_key=NULL,updated_at=? WHERE save_key=?`).run(ts,saveKey);
      db.prepare(`UPDATE knowledge_outputs SET save_key=?,derived_document_key=?,status='saved',updated_at=? WHERE id=?`).run(saveKey,docKey,ts,outputId);
    })();
    return {document_key:docKey,reused:false,updated:true,derived_from:JSON.parse(String(output.source_versions_json??'[]'))};
  }
  const sourceKey=`agent:${outputId}`;const ts=now();const content=String(output.content);const contentHash=contentHashOf(content);
  db.transaction(()=>{db.prepare(`INSERT INTO source_documents(source_key,provider,external_id,title,document_type,content,content_hash,body_status,content_origin,source_nature,fetched_at,updated_at) VALUES(?,'conversation',?,?,'research',?,?,'fetched','manual','agent_derived',?,?) ON CONFLICT(source_key) DO NOTHING`).run(sourceKey,String(outputId),String(output.title),content,contentHash,ts,ts);appendDocumentVersion(sourceKey,content,'agent',String(outputId));if(output.scope_kind==='topic'&&output.scope_id)db.prepare(`INSERT INTO topic_members(id,topic_id,document_key,origin,state,confirmed_at,created_at,updated_at) VALUES(?,?,?,'user','confirmed',?,?,?) ON CONFLICT(topic_id,document_key) DO UPDATE SET state='confirmed',origin='user',updated_at=excluded.updated_at`).run(sync_id(),Number(output.scope_id),sourceKey,ts,ts,ts);db.prepare(`UPDATE knowledge_outputs SET save_key=?,derived_document_key=?,status='saved',updated_at=? WHERE id=? AND derived_document_key IS NULL`).run(saveKey,sourceKey,ts,outputId);})();
  return {document_key:sourceKey,reused:false,derived_from:JSON.parse(String(output.source_versions_json??'[]'))};
}

export function listKnowledgeOutputs(){ return db.prepare(`SELECT * FROM knowledge_outputs ORDER BY updated_at DESC LIMIT 100`).all(); }
