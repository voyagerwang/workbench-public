import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now, getSetting, setSetting } from '../db.js';
import { pushNotify, sendSystemNotification } from '../services/notify.js';
import { feishuKbStatus, refreshFeishuKb, warmFeishuKbStatus } from '../services/feishu-kb.js';
import { getDingtalkKb } from '../services/kb-snapshot.js';
import {
  type ArchiveRow,
  addArchiveTags,
  archive,
  archiveShape,
  attachCatalogStats,
  catalogProvider,
  getArchive,
  importUrlToArchive,
  insertArchive,
  normalizeTags,
  providerLabel,
  relevantKnowledge,
  TAG_MATCH_SQL,
  tagNeedle,
  type KnowledgeHit,
} from '../services/knowledge-archive.js';

// 存档的存储与链接导入已迁到 services/knowledge-archive.ts（助手工具要复用同一套逻辑）。
// 这里保留转发，避免既有 import 全部改动。
export { relevantKnowledge };
export type { KnowledgeHit };
import {
  authorizationJob,
  configureCodexMcp,
  configureKnowledgeCli,
  browseFeishu,
  enumerateDingtalkWiki,
  enumerateDriveFolder,
  enumerateFeishuSpace,
  enumerateFeishuWiki,
  importThroughCodexMcp,
  knowledgeConnectorStatus,
  listRemoteDocuments,
  readRemoteKnowledge,
  renameMcpNote,
  removeCodexMcp,
  searchRemoteKnowledge,
  selectKnowledgeConnector,
  startCodexMcpLogin,
  startCliOneClick,
  startKnowledgeCliLogin,
  unlinkKnowledgeConnector,
  type BrowseBranch,
  type KnowledgeProvider,
  type SyncDoc,
} from '../services/knowledge-connectors.js';
import { createImportBatch, runImportBatch } from '../services/knowledge-lifecycle.js';

// 知识空间同步：枚举云端全部文档，建索引（也可选读全文），进度轮询
type KnowledgeSyncJob = {
  id: string;
  provider: KnowledgeProvider;
  mode: 'index' | 'full';
  status: 'running' | 'done' | 'failed';
  total: number;
  indexed: number;
  failed: number;
  current: string | null;
  error: string | null;
  batchId?: string;
  spaceHint: string | null;
  /** 枚举后解析出的人类可读标题（钉钉空间名等），历史列表优先展示 */
  title: string | null;
  startedAt: number;
  finishedAt?: string | null;
};

const syncJobs = new Map<string, KnowledgeSyncJob>();

function syncJob(id: string): KnowledgeSyncJob | null {
  return syncJobs.get(id) ?? null;
}

type SyncScope = {
  wiki?: Array<{ spaceId: string; spaceName?: string; parentNodeToken?: string }>;
  drive?: string[];
  docs?: Array<{ reference: string; title?: string; url?: string | null; space?: string }>;
};

async function collectSyncDocs(job: KnowledgeSyncJob, spaceUrl: string | undefined, scope: SyncScope | undefined): Promise<SyncDoc[]> {
  if (job.provider === 'dingtalk') {
    const result = await enumerateDingtalkWiki(spaceUrl ?? '');
    // 枚举成功后把空间名写进任务，历史列表展示人类可读标题而不是裸链接
    if (result.title) job.title = result.title;
    return result.documents;
  }
  if (!scope || (!scope.wiki?.length && !scope.drive?.length && !scope.docs?.length)) {
    return enumerateFeishuWiki();
  }
  const docs: SyncDoc[] = [];
  const seen = new Set<string>();
  const push = (list: SyncDoc[]) => {
    for (const doc of list) if (doc.reference && !seen.has(doc.reference)) { seen.add(doc.reference); docs.push(doc); }
  };
  for (const item of scope.wiki ?? []) {
    push(await enumerateFeishuSpace(item.spaceId, item.spaceName ?? item.spaceId, item.parentNodeToken));
  }
  for (const folder of scope.drive ?? []) {
    push(await enumerateDriveFolder(folder || undefined));
  }
  for (const item of scope.docs ?? []) {
    if (item.reference && !seen.has(item.reference)) {
      seen.add(item.reference);
      docs.push({ title: item.title || item.reference, reference: item.reference, url: item.url ?? null, type: null, space: item.space, path: item.space ? `${item.space}/${item.title || item.reference}` : item.title || item.reference });
    }
  }
  // 飞书历史同样展示空间名 / 文档名，而不是「已选 N 项」这类模糊描述
  if (scope.wiki?.length === 1) job.title = scope.wiki[0].spaceName ?? null;
  else if (scope.wiki?.length) job.title = `${scope.wiki.length} 个知识空间`;
  else if (scope.docs?.length === 1) job.title = scope.docs[0].title ?? null;
  else if (scope.docs?.length) job.title = `${scope.docs.length} 份文档`;
  return docs;
}

function recordSyncStart(job: KnowledgeSyncJob, scope: SyncScope | undefined): void {
  db.prepare('INSERT OR REPLACE INTO knowledge_sync_history (id, provider, mode, status, total, indexed, failed, error, scope_json, space_hint, title, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(job.id, job.provider, job.mode, job.status, job.total, job.indexed, job.failed, job.error,
      scope ? JSON.stringify(scope) : null, job.spaceHint, job.title, new Date(job.startedAt).toISOString());
}

function recordSyncFinish(job: KnowledgeSyncJob): void {
  db.prepare('UPDATE knowledge_sync_history SET status=?, total=?, indexed=?, failed=?, error=?, title=?, finished_at=? WHERE id=?')
    .run(job.status, job.total, job.indexed, job.failed, job.error, job.title, new Date().toISOString(), job.id);
}

/** 后台同步结束（页面可能已经关了）：系统通知兜底 + 已启用的推送通道 */
async function notifySyncFinished(job: KnowledgeSyncJob): Promise<void> {
  const label = job.provider === 'feishu' ? '飞书' : '钉钉';
  const text = job.status === 'done'
    ? `知识库同步完成：${label} · ${job.spaceHint ?? ''}，新增 ${job.indexed} 条索引${job.failed ? `，失败 ${job.failed} 条` : ''}`
    : `知识库同步失败：${label} · ${job.spaceHint ?? ''}。${job.error ?? ''}`.slice(0, 300);
  await sendSystemNotification('YZ 工作台', text);
  await pushNotify(text);
}

/**
 * 目录存档里「正文能不能检索到」的说明。
 *
 * 只建索引（mode='index'）的同步不落任何正文，能命中的只有目录标题本身。
 * 以前不管什么模式都写「全文已建本地快照」，快照不存在时这句话就是假的。
 */
function retrievableNote(isFeishu: boolean, mode: KnowledgeSyncJob['mode']): string {
  if (isFeishu) return '正文检索依赖本地快照服务（:8792），离线时只能命中目录标题；';
  if (mode === 'full') return '本次已抓取正文并写入本地快照（data/kb/dingtalk）；';
  return '本次只建索引，正文尚未抓取，检索只能命中目录标题；';
}

/** 目录索引存档：每个 provider 只有一条记录（source_url=<provider>://wiki-catalog），重复同步时原地更新 */
async function writeCatalogArchive(job: KnowledgeSyncJob, docs: SyncDoc[]): Promise<void> {
  const isFeishu = job.provider === 'feishu';
  const label = isFeishu ? '飞书知识库目录索引' : '钉钉知识库目录索引';
  const bySpace = new Map<string, string[]>();
  for (const doc of docs) {
    const key = doc.space ?? '未分组';
    const list = bySpace.get(key) ?? [];
    list.push(`- [${doc.title}](${doc.url ?? doc.reference})`);
    bySpace.set(key, list);
  }
  const sections = [...bySpace.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN'))
    .map(([space, items]) => `## ${space}（${items.length} 篇）\n${items.join('\n')}`);
  const catalog = [
    `# ${label}`,
    ``,
    `> ${new Date().toLocaleString('zh-CN')} 同步，共 ${bySpace.size} 个分组 / ${docs.length} 篇文档。`,
    // 以前这里写死「全文已建本地快照（data/kb/dingtalk）」，而快照目录压根不存在 —— 一句假话。
    // 只建索引的同步不会落任何正文，必须说清楚「正文还没进来」。
    `> ${retrievableNote(isFeishu, job.mode)}打开单篇走云端实时读取。`,
    ``,
    ...sections,
  ].join('\n');
  const catalogUrl = `${job.provider}://wiki-catalog`;
  const catalogRow = db.prepare(
    'SELECT id FROM knowledge_archives WHERE source_kind = ? AND source_url = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
  ).get(job.provider, catalogUrl) as { id: number } | undefined;
  if (catalogRow) {
    db.prepare('UPDATE knowledge_archives SET title = ?, content = ?, updated_at = ? WHERE id = ?')
      .run(label, catalog, now(), catalogRow.id);
  } else {
    insertArchive({
      title: label,
      content: catalog,
      sourceKind: job.provider,
      sourceUrl: catalogUrl,
      fileName: job.spaceHint ?? label,
      status: 'indexed',
      error: null,
    });
  }
}

/** 每日自动更新钉钉本地快照：复用上次同步的分享链接；有任务在跑或没同步过时跳过 */
export function refreshDingtalkKbSnapshot(): KnowledgeSyncJob | null {
  if ([...syncJobs.values()].some((j) => j.provider === 'dingtalk' && j.status === 'running')) return null;
  const spaceUrl = getSetting<string>('dingtalk_kb_space_url');
  if (!spaceUrl) return null;
  const job: KnowledgeSyncJob = {
    id: Math.random().toString(36).slice(2, 12), provider: 'dingtalk', mode: 'full',
    status: 'running', total: 0, indexed: 0, failed: 0, current: null, error: null,
    spaceHint: '每日自动更新', title: null, startedAt: Date.now(),
  };
  syncJobs.set(job.id, job);
  runKnowledgeSync(job, { spaceUrl });
  return job;
}

function runKnowledgeSync(job: KnowledgeSyncJob, options: { spaceUrl?: string; scope?: SyncScope } = {}): void {
  void (async () => {
    try {
      recordSyncStart(job, options.scope);
      const docs: SyncDoc[] = await collectSyncDocs(job, options.spaceUrl, options.scope);
      job.total = docs.length;

      // 既有范围选择器直接接入持久队列：full 由队列逐篇处理；index 只保存清单，绝不把标题数冒充正文数。
      const persistent = createImportBatch(job.provider as 'feishu'|'dingtalk', options.scope ?? { spaceUrl: options.spaceUrl }, docs.map((doc)=>({
        provider: job.provider as 'feishu'|'dingtalk', reference: doc.reference, title: doc.title,
        url: doc.url, path: doc.path ?? (doc.space ? `${doc.space}/${doc.title}` : doc.title), type: doc.type,
      })));
      job.batchId = (persistent!.batch as {id:string}).id;

      if (job.mode === 'full') {
        const completed = await runImportBatch(job.batchId);
        const facts = completed!.batch as {completed_count:number;failed_count:number;skipped_count:number;status:string};
        job.indexed = facts.completed_count; job.failed = facts.failed_count + facts.skipped_count;
        await writeCatalogArchive(job, docs);
        job.status = facts.status === 'failed' ? 'failed' : 'done'; job.current = null; job.finishedAt = new Date().toISOString();
        recordSyncFinish(job); await notifySyncFinished(job); return;
      }

      // 增量去重：已存在同 source_url 的跳过
      const existingRows = db.prepare(
        'SELECT source_url FROM knowledge_archives WHERE source_kind = ? AND source_url IS NOT NULL',
      ).all(job.provider) as Array<{ source_url: string }>;
      const existing = new Set(existingRows.map((row) => String(row.source_url)));

      if (job.mode === 'index') {
        // 索引模式只落一份「目录索引」存档（单条记录），不再逐篇插行污染存档列表；
        // 飞书全文检索走 feishu-kb 本地快照，钉钉靠 MCP 搜索/云端实时读取补齐正文。
        await writeCatalogArchive(job, docs);
        job.total = docs.length;
        job.indexed = docs.length;
        job.status = 'done';
        job.current = null;
        job.finishedAt = new Date().toISOString();
        recordSyncFinish(job);
        await notifySyncFinished(job);
        return;
      }

      if (job.provider === 'dingtalk') {
        // 钉钉「同时读全文」= 建本地快照：与 feishu-kb 同一套布局（MD 文件 + kb_manifest + FTS 检索），
        // 不逐篇建行；内容没变的文档自动跳过，再次同步就是增量更新。
        const snapshot = getDingtalkKb();
        for (const doc of docs) {
          job.current = doc.title;
          try {
            const read = await readRemoteKnowledge('dingtalk', doc.reference);
            const title = read.title && read.title !== doc.reference ? read.title : doc.title;
            await snapshot.upsertDoc({ reference: doc.reference, url: doc.url, title, space: doc.space, content: read.content });
            job.indexed++;
          } catch {
            job.failed++;
          }
        }
        await snapshot.rebuildFts('dingtalk');
        await snapshot.saveManifest();
        if (options.spaceUrl) setSetting('dingtalk_kb_space_url', options.spaceUrl);
        await writeCatalogArchive(job, docs);
        job.status = 'done';
        job.current = null;
        job.finishedAt = new Date().toISOString();
        recordSyncFinish(job);
        await notifySyncFinished(job);
        return;
      }

      for (const doc of docs) {
        if (existing.has(doc.reference)) continue;
        job.current = doc.title;
        try {
          if (job.mode === 'full') {
            const read = await readRemoteKnowledge(job.provider, doc.reference);
            insertArchive({
              title: doc.title || read.title,
              content: read.content,
              sourceKind: job.provider,
              sourceUrl: doc.reference,
              fileName: doc.space ?? null,
              status: 'indexed',
              error: null,
            });
          } else {
            insertArchive({
              title: doc.title,
              content: '',
              sourceKind: job.provider,
              sourceUrl: doc.reference,
              fileName: doc.space ?? null,
              status: 'remote',
              error: null,
            });
          }
          job.indexed++;
        } catch {
          job.failed++;
        }
      }
      job.status = 'done';
      job.current = null;
      job.finishedAt = new Date().toISOString();
      recordSyncFinish(job);
      await notifySyncFinished(job);
    } catch (error) {
      job.status = 'failed';
      job.error = (error as Error).message;
      job.current = null;
      job.finishedAt = new Date().toISOString();
      // 收尾动作自身也可能抛（通知通道挂了等），不能让它逃出去变成 unhandled rejection 崩掉服务
      try { recordSyncFinish(job); } catch (cleanupError) { console.error('[knowledge-sync] 记录失败状态出错:', cleanupError); }
      try { await notifySyncFinished(job); } catch (notifyError) { console.error('[knowledge-sync] 发送完成通知出错:', notifyError); }
    }
  })().catch((fatal) => {
    // 最后的保险丝：任何漏网异常只记日志，绝不崩进程
    console.error('[knowledge-sync] 同步任务致命错误:', fatal);
    job.status = 'failed';
    job.error = (fatal as Error).message;
    job.finishedAt = new Date().toISOString();
    try { recordSyncFinish(job); } catch { /* ignore */ }
  });
}


/**
 * 标签精确匹配的 SQL 片段与参数构造。
 *
 * tags 存的是 JSON 数组文本（`["k12","教培"]`）。裸 `LIKE '%ai%'` 会把 `trainai` 也捞出来，
 * 所以先把 JSON 外壳剥成 `,k12,教培,` 再两头加逗号匹配——只有完整标签才会命中。
 */
export default async function knowledgeRoutes(app: FastifyInstance) {
  // 启动时预热一次 :8792 探测，避免第一个打开知识库的人拿到「检索服务未启动」的误报
  warmFeishuKbStatus();

  // 目录统计读的是缓存状态（不向 :8792 发同步请求），所以这两个接口保持同步
  app.get('/api/knowledge/archives', (req) => {
    const { q } = z.object({ q: z.string().max(300).default('') }).parse(req.query);
    const like = `%${q.trim()}%`;
    const rows = db.prepare(`
      -- 列表只用于展示摘要：截到 800 字符，够摘要与「含图片」判断，又不至于把整篇正文拉到前端
      SELECT id, title, substr(content, 1, 800) AS content, source_kind, source_url, file_name, tags, status, error, created_at, updated_at FROM knowledge_archives
      WHERE deleted_at IS NULL AND (? = '' OR title LIKE ? OR content LIKE ? OR source_url LIKE ? OR ${TAG_MATCH_SQL} LIKE ?)
      ORDER BY updated_at DESC
    `).all(q.trim(), like, like, like, tagNeedle(q)) as ArchiveRow[];
    return attachCatalogStats(rows.map(archive));
  });

  app.get('/api/knowledge/archives/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const [view] = attachCatalogStats([getArchive(id)]);
    return view;
  });

  app.post('/api/knowledge/archives', (req) => insertArchive(archiveShape.parse(req.body ?? {})));

  // 随手记的一键纳入知识库存档：以 workbench:note:ID 作为稳定来源身份，幂等且保留原笔记。
  app.post('/api/knowledge/from-note/:id', (req) => db.transaction(() => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const note = db.prepare('SELECT id, title, content, tags, updated_at FROM notes WHERE id=? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!note) throw app.httpErrors.notFound('随手记不存在或已删除');
    if (!String(note.content ?? '').trim()) throw app.httpErrors.badRequest('随手记正文为空，无法纳入知识库');
    const sourceUrl = `workbench:note:${id}`;
    const existing = db.prepare('SELECT id FROM knowledge_archives WHERE source_kind=? AND source_url=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1').get('manual', sourceUrl) as { id: number } | undefined;
    if (existing) return { archive: getArchive(existing.id), created: false, sourceNoteId: id };
    const tags = (() => { try { const parsed = JSON.parse(String(note.tags ?? '[]')); return Array.isArray(parsed) ? parsed : []; } catch { return []; } })();
    const archive = insertArchive({ title: String(note.title || '未命名随手记'), content: String(note.content || ''), sourceKind: 'manual', sourceUrl, fileName: null, tags, status: 'indexed', error: null });
    return { archive, created: true, sourceNoteId: id };
  }).immediate());

  app.patch('/api/knowledge/archives/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = archiveShape.partial().parse(req.body ?? {});
    const current = getArchive(id);
    // 目录存档是同步产物，不是用户写的文档：正文头部的「共 N 篇文档」是篇数解析的唯一依据，
    // 用户随手改一个字，篇数就算错；而且下次同步会整体覆盖，改了也白改。
    // 想留一份能编辑的，先走下面的「转为普通文档副本」。
    if (catalogProvider(current.source_url) && (body.title !== undefined || body.content !== undefined)) {
      throw app.httpErrors.conflict('目录存档由同步生成，不能直接编辑；请先「转为普通文档副本」再改');
    }
    // 标签是「合并」而不是「替换」：助手经常只补一个标签，整体替换会把已有的静默抹掉
    const nextTags = body.tags
      ? normalizeTags([...current.tags, ...body.tags])
      : current.tags;
    db.prepare(`UPDATE knowledge_archives SET title=?, content=?, source_kind=?, source_url=?, file_name=?, tags=?, status=?, error=?, updated_at=? WHERE id=?`).run(
      body.title ?? current.title, body.content ?? current.content, body.sourceKind ?? current.source_kind,
      body.sourceUrl === undefined ? current.source_url : body.sourceUrl,
      body.fileName === undefined ? current.file_name : body.fileName,
      JSON.stringify(nextTags),
      body.status ?? current.status, body.error === undefined ? current.error : body.error, now(), id,
    );
    return getArchive(id);
  });

  app.post('/api/knowledge/archives/:id/copy-as-note', (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const current = getArchive(id);
    if (!catalogProvider(current.source_url)) throw app.httpErrors.badRequest('只有目录存档需要转副本，普通文档可以直接编辑');
    // 副本是普通文档：断掉 source_url，不然前端又会按目录渲染成只读
    return insertArchive({
      title: `${current.title || '未命名目录'}（副本）`,
      content: current.content,
      sourceKind: 'manual',
      sourceUrl: null,
      fileName: null,
      tags: current.tags,
      status: 'indexed',
      error: null,
    });
  });

  app.delete('/api/knowledge/archives/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    // 软删除：只打标记，内容和 FTS 索引都留着，回收站可回显全文并恢复
    const info = db.prepare('UPDATE knowledge_archives SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id);
    if (info.changes === 0) throw app.httpErrors.notFound('知识存档不存在或已在回收站里');
    return { ok: true };
  });

  app.get('/api/knowledge/connectors', () => knowledgeConnectorStatus());

  app.post('/api/knowledge/connectors/:provider/select', async (req) => {
    const { provider } = z.object({ provider: z.enum(['feishu', 'dingtalk']) }).parse(req.params);
    const { serverName } = z.object({ serverName: z.string().trim().min(1).max(100) }).parse(req.body);
    const status = await knowledgeConnectorStatus();
    if (!status.servers.some((server) => server.name === serverName && server.enabled)) {
      throw app.httpErrors.badRequest(`MCP「${serverName}」不存在或尚未启用`);
    }
    selectKnowledgeConnector(provider, serverName);
    return knowledgeConnectorStatus();
  });

  // 只断开与这个平台的绑定，Codex 里的 MCP 经仍给其他用途
  app.post('/api/knowledge/connectors/:provider/unlink', async (req) => {
    const { provider } = z.object({ provider: z.enum(['feishu', 'dingtalk']) }).parse(req.params);
    const { serverName } = z.object({ serverName: z.string().trim().min(1).max(100) }).parse(req.body);
    unlinkKnowledgeConnector(provider, serverName);
    return knowledgeConnectorStatus();
  });

  // 真的从 Codex 里移除；前端已经二次确认过才调到这里
  app.delete('/api/knowledge/connectors/mcp/:name', async (req) => {
    const { name } = z.object({ name: z.string().trim().regex(/^[a-zA-Z0-9_-]{2,60}$/) }).parse(req.params);
    await removeCodexMcp(name);
    return knowledgeConnectorStatus();
  });

  app.post('/api/knowledge/connectors/mcp', async (req) => {
    const body = z.object({
      provider: z.enum(['feishu', 'dingtalk']),
      name: z.string().trim().regex(/^[a-zA-Z0-9_-]{2,60}$/, 'MCP 名称只能包含字母、数字、下划线和连字符'),
      url: z.string().trim().min(1).max(2000),
      note: z.string().trim().max(60).optional(),
      bearerTokenEnvVar: z.string().trim().regex(/^[A-Z_][A-Z0-9_]*$/).optional().or(z.literal('')),
    }).parse(req.body);
    const target = new URL(body.url.startsWith('http') ? body.url : `http://${body.url}`);
    if (!/^https?:\/\//i.test(body.url)) throw app.httpErrors.badRequest('这个地址要以 http:// 或 https:// 开头，直接粘钉钉给你的那一串就好');
    if (!['http:', 'https:'].includes(target.protocol)) throw app.httpErrors.badRequest('MCP 地址需以 http(s):// 开头');
    return configureCodexMcp({ ...body, bearerTokenEnvVar: body.bearerTokenEnvVar || undefined });
  });

  app.post('/api/knowledge/connectors/:provider/authorize', async (req) => {
    const { provider } = z.object({ provider: z.enum(['feishu', 'dingtalk']) }).parse(req.params);
    const body = z.object({
      serverName: z.string().trim().min(1).max(100),
      scopes: z.string().trim().max(1000).optional(),
    }).parse(req.body);
    const status = await knowledgeConnectorStatus();
    if (!status.servers.some((server) => server.name === body.serverName && server.enabled)) {
      throw app.httpErrors.badRequest(`MCP「${body.serverName}」不存在或尚未启用`);
    }
    return startCodexMcpLogin(provider, body.serverName, body.scopes);
  });

  app.post('/api/knowledge/connectors/:provider/cli', async (req) => {
    const { provider } = z.object({ provider: z.enum(['feishu', 'dingtalk']) }).parse(req.params);
    const { command } = z.object({ command: z.string().trim().min(1).max(1000) }).parse(req.body);
    return configureKnowledgeCli(provider, command);
  });

  app.post('/api/knowledge/connectors/:provider/cli-authorize', async (req) => {
    const { provider } = z.object({ provider: z.enum(['feishu', 'dingtalk']) }).parse(req.params);
    const { command } = z.object({ command: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
    return startKnowledgeCliLogin(provider, command);
  });

  // 一键连接：装 CLI → 建应用 → 授权，前端只轮询一个 job
  app.post('/api/knowledge/connectors/:provider/one-click', async (req) => {
    const { provider } = z.object({ provider: z.enum(['feishu', 'dingtalk']) }).parse(req.params);
    return startCliOneClick(provider);
  });

  app.get('/api/knowledge/connectors/jobs/:id', (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const job = authorizationJob(id);
    if (!job) throw app.httpErrors.notFound('授权任务不存在或服务已重启');
    return job;
  });

  app.post('/api/knowledge/remote-search', async (req) => {
    const { provider, query, limit } = z.object({
      provider: z.enum(['feishu', 'dingtalk']).optional(),
      query: z.string().max(1000).default(''),
      limit: z.number().int().min(1).max(100).default(20),
    }).parse(req.body ?? {});
    if (provider) return searchRemoteKnowledge(provider, query, limit);
    const providers: KnowledgeProvider[] = ['feishu', 'dingtalk'];
    const results = await Promise.all(providers.map(async (item) => {
      try { return await searchRemoteKnowledge(item, query, limit); }
      catch (error) { return { provider: item, error: (error as Error).message }; }
    }));
    return { results };
  });

  // 补改 MCP 备注（列表里显示的名字）
  app.put('/api/knowledge/connectors/mcp/:name/note', async (req) => {
    const { name } = z.object({ name: z.string().min(2).max(60) }).parse(req.params);
    const { note } = z.object({ note: z.string().max(60) }).parse(req.body);
    renameMcpNote(name, note);
    return knowledgeConnectorStatus();
  });

  app.post('/api/knowledge/remote-read', async (req) => {
    const { provider, reference } = z.object({
      provider: z.enum(['feishu', 'dingtalk']),
      reference: z.string().trim().min(1).max(4000),
    }).parse(req.body);
    return readRemoteKnowledge(provider, reference);
  });

  // 「一键拉取」：列出 / 搜索云端文档（归一化后的干净列表）
  app.post('/api/knowledge/remote-docs', async (req) => {
    const { provider, query, limit } = z.object({
      provider: z.enum(['feishu', 'dingtalk']),
      query: z.string().max(1000).default(''),
      limit: z.number().int().min(1).max(100).default(20),
    }).parse(req.body ?? {});
    return listRemoteDocuments(provider, query, limit);
  });

  // 「一键拉取」：默认只建索引（存标题 / 来源 / 引用，不占本地空间），想存全文用 mode: 'full'
  app.post('/api/knowledge/remote-import', async (req) => {
    const { provider, reference, title, url, mode } = z.object({
      provider: z.enum(['feishu', 'dingtalk']),
      reference: z.string().trim().min(1).max(4000),
      title: z.string().trim().max(200).optional(),
      url: z.string().trim().max(2000).optional(),
      mode: z.enum(['index', 'full']).default('index'),
    }).parse(req.body ?? {});
    if (mode === 'full') {
      const connected = await readRemoteKnowledge(provider, reference);
      return insertArchive({
        title: connected.title || title || '远程文档',
        content: connected.content,
        sourceKind: provider,
        sourceUrl: url ?? (/^https?:\/\//i.test(reference) ? reference : null),
        fileName: null,
        status: 'indexed',
        error: null,
      });
    }
    return insertArchive({
      title: title || '远程文档',
      content: '',
      sourceKind: provider,
      sourceUrl: url ?? (/^https?:\/\//i.test(reference) ? reference : null),
      fileName: null,
      status: 'remote',
      error: null,
    });
  });

  // 云端索引条目：打开时按权限实时去云端读全文，内容不落盘
  app.post('/api/knowledge/archives/:id/fetch-remote', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const current = getArchive(id);
    if (current.status !== 'remote') throw app.httpErrors.badRequest('只有云端索引条目支持实时读取');
    if ((current.source_kind !== 'feishu' && current.source_kind !== 'dingtalk') || !current.source_url) {
      throw app.httpErrors.badRequest('这条索引缺少可用的来源链接');
    }
    const connected = await readRemoteKnowledge(current.source_kind as KnowledgeProvider, String(current.source_url));
    return { title: connected.title || current.title, content: connected.content };
  });

  // 云端拉取批量处理：一次提交多个选中的文档，按 mode 建索引或导入全文
  app.post('/api/knowledge/remote-import-batch', async (req) => {
    const { provider, items, mode } = z.object({
      provider: z.enum(['feishu', 'dingtalk']),
      items: z.array(z.object({
        reference: z.string().trim().min(1).max(4000),
        title: z.string().trim().max(200).optional(),
        url: z.string().trim().max(2000).nullable().optional(),
      })).min(1).max(100),
      mode: z.enum(['index', 'full']).default('index'),
    }).parse(req.body ?? {});

    const succeeded: Array<{ title: string; id: number }> = [];
    const failed: Array<{ title: string; error: string }> = [];
    for (const item of items) {
      const title = item.title || item.reference;
      try {
        if (mode === 'full') {
          const connected = await readRemoteKnowledge(provider, item.reference);
          const saved = insertArchive({
            title: connected.title || title,
            content: connected.content,
            sourceKind: provider,
            sourceUrl: item.url ?? (/^https?:\/\//i.test(item.reference) ? item.reference : null),
            fileName: null,
            status: 'indexed',
            error: null,
          });
          succeeded.push({ title: saved.title, id: saved.id });
        } else {
          const saved = insertArchive({
            title,
            content: '',
            sourceKind: provider,
            sourceUrl: item.url ?? (/^https?:\/\//i.test(item.reference) ? item.reference : null),
            fileName: null,
            status: 'remote',
            error: null,
          });
          succeeded.push({ title: saved.title, id: saved.id });
        }
      } catch (error) {
        failed.push({ title, error: (error as Error).message });
      }
    }
    return { succeeded, failed };
  });

  // 飞书树形选择器：按分支列出下一层节点（知识空间 / 空间节点 / 云文档文件夹）
  app.post('/api/knowledge/browse', async (req) => {
    const { branch } = z.object({
      branch: z.object({
        root: z.enum(['wiki', 'drive']),
        spaceId: z.string().max(200).optional(),
        parentNodeToken: z.string().max(200).optional(),
        folderToken: z.string().max(200).optional(),
      }).nullable().default(null),
    }).parse(req.body ?? {});
    return browseFeishu(branch as BrowseBranch | null);
  });

  // 知识空间同步：飞书全量 / 指定范围 / 钉钉分享链接 → 后台枚举并建索引，前端轮询进度
  app.post('/api/knowledge/sync-space', async (req) => {
    const { provider, spaceUrl: rawSpaceUrl, mode, scope } = z.object({
      provider: z.enum(['feishu', 'dingtalk']),
      spaceUrl: z.string().trim().max(4000).optional(),
      mode: z.enum(['index', 'full']).default('index'),
      scope: z.object({
        wiki: z.array(z.object({
          spaceId: z.string().min(1).max(200),
          spaceName: z.string().max(500).optional(),
          parentNodeToken: z.string().max(200).optional(),
        })).max(200).optional(),
        drive: z.array(z.string().max(200)).max(200).optional(),
        docs: z.array(z.object({
          reference: z.string().min(1).max(4000),
          title: z.string().max(500).optional(),
          url: z.string().max(2000).nullable().optional(),
          space: z.string().max(500).optional(),
        })).max(1000).optional(),
      }).optional(),
    }).parse(req.body ?? {});
    // 钉钉分享链接常被包在一层 OAuth 跳转页里（login.dingtalk.com/...?redirect_uri=真实地址），解出真身再用
    const unwrapDingtalkUrl = (value: string): string => {
      const cleaned = value.trim().replace(/[`'"]/g, '');
      try {
        const url = new URL(cleaned);
        const redirect = url.searchParams.get('redirect_uri');
        if (redirect && /^https?:\/\//i.test(redirect)) return redirect;
      } catch { /* 不是合法 URL 就原样交给 MCP 处理 */ }
      return cleaned;
    };
    const spaceUrl = rawSpaceUrl ? unwrapDingtalkUrl(rawSpaceUrl) : undefined;
    if (provider === 'dingtalk' && !spaceUrl) throw app.httpErrors.badRequest('钉钉同步需要粘贴知识库分享链接');
    if (provider === 'dingtalk' && !/dingtalk\.com|alidocs\.com/i.test(spaceUrl!)) {
      throw app.httpErrors.badRequest('这看起来不是钉钉知识库链接。请粘贴 alidocs.dingtalk.com 或 dingtalk.com 下的知识库分享地址');
    }
    const scoped = Boolean(scope && (scope.wiki?.length || scope.drive?.length || scope.docs?.length));
    const spaceHint = provider === 'dingtalk'
      ? (spaceUrl ?? null)
      : scoped
        ? (scope!.wiki?.length ? `飞书知识空间（已选 ${scope!.wiki.length} 个范围）` : scope!.drive?.length ? `飞书云文档（已选 ${scope!.drive.length} 个文件夹）` : `飞书文档（已选 ${scope!.docs?.length ?? 0} 份）`)
        : '我的飞书知识库';
    // 同一个渠道 + 同一个范围已有任务在跑时直接复用，避免连点/重试堆出一堆僵尸任务
    for (const running of syncJobs.values()) {
      if (running.status === 'running' && running.provider === provider && running.spaceHint === spaceHint) return running;
    }
    const id = Math.random().toString(36).slice(2, 12);
    const job: KnowledgeSyncJob = {
      id, provider, mode,
      status: 'running', total: 0, indexed: 0, failed: 0,
      current: null, error: null, spaceHint, title: null, startedAt: Date.now(),
    };
    syncJobs.set(id, job);
    runKnowledgeSync(job, { spaceUrl: provider === 'dingtalk' ? spaceUrl : undefined, scope });
    return job;
  });

  app.get('/api/knowledge/baseline', async () => {
    // 状态面板是用户主动打开的，要当前真实值，不走 60 秒缓存
    const snapshot = await feishuKbStatus({ force: true });
    const lastSync = db.prepare(
      "SELECT space_hint, started_at, finished_at, status FROM knowledge_sync_history WHERE provider = 'feishu' AND status = 'done' ORDER BY started_at DESC LIMIT 1",
    ).get() as { space_hint: string; started_at: string; finished_at: string | null; status: string } | undefined;
    const archiveCount = db.prepare(
      "SELECT COUNT(*) AS n FROM knowledge_archives WHERE deleted_at IS NULL AND status != 'remote'",
    ).get() as { n: number };
    return {
      snapshot,
      lastSync: lastSync ? { spaceHint: lastSync.space_hint, finishedAt: lastSync.finished_at } : null,
      archiveCount: archiveCount.n,
    };
  });

  // 一键增量更新 feishu-kb 快照：只抓云端有变动的文档，通常几十秒
  app.post('/api/knowledge/baseline/refresh', async () => {
    const result = await refreshFeishuKb();
    if (!result.ok) throw app.httpErrors.badRequest(result.error ?? '快照更新失败');
    return { ok: true, snapshot: await feishuKbStatus({ force: true }) };
  });

  app.get('/api/knowledge/sync-space/jobs', () => {
    // 僵尸清理：running 超过 15 分钟且毫无进度的任务标为失败（服务重启/枚举卡死都不会永远转圈）
    const stale = db.prepare(
      "SELECT id, started_at, total FROM knowledge_sync_history WHERE status = 'running'",
    ).all() as Array<{ id: string; started_at: string; total: number }>;
    for (const row of stale) {
      const started = Date.parse(row.started_at);
      if (Number.isFinite(started) && Date.now() - started > 15 * 60_000) {
        const live = syncJobs.get(row.id);
        if (live && live.status === 'running' && (live.indexed > 0 || Date.now() - live.startedAt <= 15 * 60_000)) continue;
        db.prepare("UPDATE knowledge_sync_history SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'")
          .run('任务超时：15 分钟无进展，已自动终止', new Date().toISOString(), row.id);
        if (live) { live.status = 'failed'; live.error = '任务超时：15 分钟无进展，已自动终止'; }
      }
    }
    const rows = db.prepare('SELECT * FROM knowledge_sync_history ORDER BY started_at DESC LIMIT 20').all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const live = syncJobs.get(String(row.id));
      // 内存里有运行中的同 id 任务时以实时字段为准（current / 进度）
      if (live) return live;
      return {
        id: String(row.id),
        provider: String(row.provider) as KnowledgeProvider,
        mode: String(row.mode) as 'index' | 'full',
        status: String(row.status) as 'running' | 'done' | 'failed',
        total: Number(row.total ?? 0),
        indexed: Number(row.indexed ?? 0),
        failed: Number(row.failed ?? 0),
        current: null,
        error: row.error == null ? null : String(row.error),
        spaceHint: row.space_hint == null ? null : String(row.space_hint),
        title: row.title == null ? null : String(row.title),
        startedAt: Date.parse(String(row.started_at)) || 0,
        finishedAt: row.finished_at == null ? null : String(row.finished_at),
      };
    });
  });

  app.get('/api/knowledge/sync-space/jobs/:id', (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const live = syncJob(id);
    if (live) return live;
    const row = db.prepare('SELECT * FROM knowledge_sync_history WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw app.httpErrors.notFound('同步任务不存在或服务已重启');
    return {
      id, provider: String(row.provider) as KnowledgeProvider,
      mode: String(row.mode) as 'index' | 'full',
      status: String(row.status) as 'running' | 'done' | 'failed',
      total: Number(row.total ?? 0), indexed: Number(row.indexed ?? 0), failed: Number(row.failed ?? 0),
      current: null, error: row.error == null ? null : String(row.error),
      spaceHint: row.space_hint == null ? null : String(row.space_hint),
      title: row.title == null ? null : String(row.title),
      startedAt: Date.parse(String(row.started_at)) || 0,
      finishedAt: row.finished_at == null ? null : String(row.finished_at),
    };
  });

  // 失败任务一键重试：按上次同样的渠道 / 模式 / 范围（钉钉用落库的链接）再跑一次，返回新任务
  app.post('/api/knowledge/sync-space/jobs/:id/retry', async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const row = db.prepare('SELECT * FROM knowledge_sync_history WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw app.httpErrors.notFound('同步任务不存在或服务已重启');
    if (String(row.status) === 'running') throw app.httpErrors.badRequest('这个任务还在运行中，不用重试');
    const provider = String(row.provider) as KnowledgeProvider;
    const mode = String(row.mode) as 'index' | 'full';
    let scope: SyncScope | undefined;
    try { scope = row.scope_json ? (JSON.parse(String(row.scope_json)) as SyncScope) : undefined; } catch { scope = undefined; }
    const spaceUrl = provider === 'dingtalk' && /^https?:\/\//i.test(String(row.space_hint ?? '')) ? String(row.space_hint) : undefined;
    if (provider === 'dingtalk' && !spaceUrl) throw app.httpErrors.badRequest('找不到当时的钉钉链接，请重新粘贴后再同步');
    const retryJob: KnowledgeSyncJob = {
      id: Math.random().toString(36).slice(2, 12), provider, mode,
      status: 'running', total: 0, indexed: 0, failed: 0,
      current: null, error: null, spaceHint: row.space_hint == null ? null : String(row.space_hint),
      title: row.title == null ? null : String(row.title),
      startedAt: Date.now(),
    };
    syncJobs.set(retryJob.id, retryJob);
    runKnowledgeSync(retryJob, { spaceUrl, scope });
    return retryJob;
  });

  // 删除一条同步历史（运行中的任务允许删，等于放弃跟进；后台任务不受影响）
  app.delete('/api/knowledge/sync-space/jobs/:id', (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const result = db.prepare('DELETE FROM knowledge_sync_history WHERE id = ?').run(id);
    if (!result.changes) throw app.httpErrors.notFound('同步任务不存在');
    syncJobs.delete(id);
    return { ok: true };
  });

  app.post('/api/knowledge/import-url', async (req) => {
    const body = z.object({
      url: z.string().trim().min(1).max(4000),
      // 存档时顺手打标签，省得助手再补一次 PATCH
      tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
    }).parse(req.body);
    // 抓取 / 解析 / 落库都在 services/knowledge-archive.ts，助手工具与这里共用同一套
    return importUrlToArchive(body.url, body.tags);
  });

  app.post('/api/knowledge/archives/:id/retry-import', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { serverName: requestedServer } = z.object({ serverName: z.string().trim().min(1).max(100).optional() }).parse(req.body ?? {});
    const current = getArchive(id);
    if ((current.source_kind !== 'feishu' && current.source_kind !== 'dingtalk') || !current.source_url) {
      throw app.httpErrors.badRequest('只有飞书或钉钉链接存档可以通过已授权连接重试');
    }
    const provider = current.source_kind as KnowledgeProvider;
    try {
      let imported: { title: string; content: string };
      if (requestedServer) {
        selectKnowledgeConnector(provider, requestedServer);
        imported = await importThroughCodexMcp(requestedServer, String(current.source_url));
      } else {
        const result = await readRemoteKnowledge(provider, String(current.source_url));
        imported = result;
      }
      db.prepare('UPDATE knowledge_archives SET title=?, content=?, status=?, error=NULL, updated_at=? WHERE id=?')
        .run(imported.title, imported.content, 'indexed', now(), id);
      return getArchive(id);
    } catch (error) {
      const message = `已授权连接读取失败：${(error as Error).message}`;
      db.prepare('UPDATE knowledge_archives SET status=?, error=?, updated_at=? WHERE id=?')
        .run('needs_auth', message, now(), id);
      throw app.httpErrors.badGateway(message);
    }
  });

  app.post('/api/knowledge/import-files', { bodyLimit: 10 * 1024 * 1024 }, (req) => {
    const { files } = z.object({
      files: z.array(z.object({ path: z.string().max(2000), content: z.string().max(1_000_000) })).min(1).max(300),
    }).parse(req.body);
    const total = files.reduce((sum, file) => sum + file.content.length, 0);
    if (total > 8_000_000) throw app.httpErrors.payloadTooLarge('单次导入内容不能超过 8 MB');
    const transaction = db.transaction(() => files.map((file) => insertArchive({
      title: file.path.split('/').pop()?.replace(/\.[^.]+$/, '') || '未命名文档',
      content: file.content, sourceKind: 'folder', sourceUrl: null, fileName: file.path,
      status: 'indexed', error: null,
    })));
    return { items: transaction(), imported: files.length };
  });

  app.post('/api/knowledge/archives/:id/append', (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { content, heading } = z.object({ content: z.string().trim().min(1).max(100_000), heading: z.string().max(300).optional() }).parse(req.body);
    const current = getArchive(id);
    const section = `${current.content.trim() ? '\n\n' : ''}## ${heading?.trim() || `对话摘录 ${now().slice(0, 16).replace('T', ' ')}`}\n\n${content}`;
    db.prepare('UPDATE knowledge_archives SET content = content || ?, updated_at = ? WHERE id = ?').run(section, now(), id);
    return getArchive(id);
  });

  app.post('/api/knowledge/conversation', (req) => {
    const body = z.object({ title: z.string().max(500).default('对话沉淀'), content: z.string().trim().min(1).max(100_000) }).parse(req.body);
    return insertArchive({ ...body, sourceKind: 'conversation', sourceUrl: null, fileName: null, status: 'indexed', error: null });
  });

  app.get('/api/knowledge/search', (req) => {
    const { q, ids } = z.object({ q: z.string().max(1000).default(''), ids: z.string().optional() }).parse(req.query);
    const parsedIds = ids ? ids.split(',').map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 100) : 'all';
    return relevantKnowledge(q, parsedIds as number[] | 'all', 12);
  });
}
