/**
 * [INPUT]: 依赖 db.ts（sync_id）、knowledge-connectors.ts（readRemoteKnowledge）、remote-document.ts（校验/清洗/哈希）
 * [OUTPUT]: 对外提供 sourceKeyFromUrl、importSourceDocument（读取→校验→清洗→哈希→幂等落库→成员/证据联动）、
 *           markSourceDeleted、classifyFetchError（P0 错误契约）、refetchSourceDocument/retryFailedDocuments（重试）、
 *           saveManualBody/createManualDocument（允许空白草稿的手动正文通道）
 * [POS]: 阶段 1 的导入服务 + 阶段 1.5 P0 的失败恢复与手动正文通道。
 *        连接器只负责读，本模块决定 body_status、重试与落库口径；
 *        last_fetch_status（最近抓取结果）与 body_status（当前正文质量）两维度独立；
 *        种子脚本与 /api/knowledge/documents/:sourceKey/refresh 共用，禁止旁路直写 source_documents
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { db, now, sync_id } from '../db.js';
import { readRemoteKnowledge } from './knowledge-connectors.js';
import {
  CONTENT_NORMALIZER_VERSION,
  contentHashOf,
  normalizeDocumentContent,
  validateRemoteDocument,
} from './remote-document.js';
import { appendDocumentVersion, ensureDocumentVersion } from './knowledge-documents.js';
import { autoAssociateDocument } from './knowledge-topics-v2.js';
import { scheduleDocumentAutoTag } from './tag-auto.js';

/** 钉钉文档节点 URL → 稳定业务键 dingtalk:<nodeId>；无法识别的 URL 返回 null（不猜） */
export function sourceKeyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    const nodeMatch = parsed.pathname.match(/\/nodes\/([A-Za-z0-9]+)/);
    if (nodeMatch && /dingtalk\.com$|alidocs\.dingtalk\.com$/.test(parsed.hostname)) {
      return `dingtalk:${nodeMatch[1]}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** source_key → 连接器引用（当前就是 nodeId） */
function referenceFromSourceKey(sourceKey: string): string | null {
  const match = sourceKey.match(/^dingtalk:([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

export type SourceDocumentRow = {
  source_key: string;
  provider: string;
  external_id: string;
  title: string;
  canonical_url: string | null;
  document_type: string;
  source_version: string | null;
  content: string;
  content_hash: string | null;
  normalizer_version: string;
  body_status: 'pending' | 'fetched' | 'suspect' | 'failed';
  fetch_error: string | null;
  last_fetch_status: 'ok' | 'failed' | null;
  fetch_error_code: string | null;
  fetch_error_retryable: 0 | 1 | null;
  content_origin: 'fetch' | 'manual';
  fetch_attempts: number;
  last_attempt_at: string | null;
  fetched_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export function getSourceDocument(sourceKey: string): SourceDocumentRow | undefined {
  return db.prepare(`SELECT * FROM source_documents WHERE source_key = ?`).get(sourceKey) as SourceDocumentRow | undefined;
}

/**
 * 从标题提取版本号（自研直播 V1.0 → V4.0 主线用），识别不了返回 null，不猜测。
 */
export function sourceVersionFromTitle(title: string): string | null {
  return title.match(/\bV\d+\.\d+\b/)?.[0] ?? null;
}

/**
 * 错误契约单一事实源（P0 3.2）：把错误消息归一为稳定 code + 是否可重试。
 * 权限 / 参数 / 明确业务错误不重试；超时、连接中断、5xx、尚未就绪可重试。
 * 连接器层抛出的错误信封（success=false）归入「明确业务错误」。
 * 写库（fetch_error_code/fetch_error_retryable）与 API 响应共用本函数，禁止前端解析错误文案。
 */
export function classifyFetchError(message: string): { code: string; retryable: boolean } {
  const m = message ?? '';
  if (/权限|没有权限|无权访问|未授权/.test(m)) return { code: 'permission_denied', retryable: false };
  if (/不存在|已删除|已失效/.test(m)) return { code: 'not_found', retryable: false };
  if (/invalidRequest|参数/.test(m)) return { code: 'invalid_request', retryable: false };
  if (/错误信封|登录页/.test(m)) return { code: 'business_error', retryable: false };
  if (/timeout|timed?\s*out|ETIMEDOUT/i.test(m)) return { code: 'timeout', retryable: true };
  if (/ECONNRESET|ECONNABORTED|ECONNREFUSED|socket hang up|网络/.test(m)) return { code: 'connection', retryable: true };
  if (/HTTP 5\d\d|HTTP\/1\.1 5|internal server error/i.test(m)) return { code: 'server_error', retryable: true };
  if (/尚未就绪|not.?ready/i.test(m)) return { code: 'not_ready', retryable: true };
  return { code: 'unknown', retryable: true };
}

function isDefinitiveFailure(message: string): boolean {
  return !classifyFetchError(message).retryable;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type ImportOptions = {
  /** 期望的业务键；传 url 时必须能解析出同一 key，否则拒绝（防串文档） */
  sourceKey: string;
  canonicalUrl?: string | null;
  documentType?: string;
  /** 连接器返回的标题优先于种子标题（连接器没有时回落） */
  fallbackTitle?: string;
  /** 最大尝试次数（含首次），默认 3 */
  maxAttempts?: number;
};

export type ImportResult = {
  row: SourceDocumentRow;
  /** fetched / suspect / failed —— 便于批量脚本汇总 */
  outcome: SourceDocumentRow['body_status'];
  /** 本次是否改变了已有正文（false = 幂等重跑且正文未变） */
  contentChanged: boolean;
};

/**
 * 导入 / 刷新一篇资料。
 *
 * 状态口径（交接文档 6.2）：
 * - 非空正文且不是壳页/明确截断 → fetched，正文=清洗后 Markdown，content_hash=sha256(正文)；
 * - 只有明确截断正文 → suspect，保留内容等待补全；
 * - 权限 / 参数 / 明确业务错误 → failed，正文置空（首次导入）；
 * - 超时 / 连接中断 / 5xx / 尚未就绪 / suspect → 重试（默认共 3 次，间隔 2s、5s）；
 * - 刷新失败时保留上一版有效正文与哈希，只更新 fetch_error，绝不用空内容覆盖。
 */
export async function importSourceDocument(opts: ImportOptions): Promise<ImportResult> {
  const reference = referenceFromSourceKey(opts.sourceKey);
  if (!reference) throw new Error(`无法识别的 source_key：${opts.sourceKey}（当前只支持 dingtalk:<nodeId>）`);

  const existing = getSourceDocument(opts.sourceKey);
  const hadValidBody = !!existing && (existing.body_status === 'fetched' || existing.body_status === 'suspect');
  const maxAttempts = opts.maxAttempts ?? 3;

  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    db.prepare(`UPDATE source_documents SET fetch_attempts = ?, last_attempt_at = ? WHERE source_key = ?`)
      .run(attempt, now(), opts.sourceKey);
    try {
      const remote = await readRemoteKnowledge('dingtalk', reference);
      const verdict = validateRemoteDocument(remote);

      if (verdict.verdict === 'error') {
        // 明确失败：不重试。首次导入正文置空；刷新时保留旧正文。
        lastError = verdict.reason;
        if (!hadValidBody) markFailed(opts.sourceKey, lastError, attempt);
        else markErrorKeepingBody(opts.sourceKey, lastError, attempt);
        return { row: getSourceDocument(opts.sourceKey)!, outcome: 'failed', contentChanged: false };
      }

      const normalized = normalizeDocumentContent(remote.content);
      if(existing)ensureDocumentVersion(existing);
      const contentHash = contentHashOf(normalized);
      const changed = !existing || existing.content_hash !== contentHash;
      const bodyStatus = verdict.verdict === 'ok' ? 'fetched' : 'suspect';
      const ts = now();
      const title = remote.title?.trim() || opts.fallbackTitle?.trim() || existing?.title || opts.sourceKey;
      const documentType = opts.documentType ?? existing?.document_type ?? 'other';

      db.prepare(`
        INSERT INTO source_documents
          (source_key, provider, external_id, title, canonical_url, document_type, source_version,
           content, content_hash, normalizer_version, body_status, fetch_error, last_fetch_status,
           fetch_error_code, fetch_error_retryable, content_origin, fetch_attempts,
           last_attempt_at, fetched_at, updated_at)
        VALUES (?, 'dingtalk', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ok', NULL, NULL, 'fetch', ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          title = excluded.title,
          canonical_url = COALESCE(excluded.canonical_url, source_documents.canonical_url),
          document_type = excluded.document_type,
          source_version = excluded.source_version,
          content = excluded.content,
          content_hash = excluded.content_hash,
          normalizer_version = excluded.normalizer_version,
          body_status = excluded.body_status,
          fetch_error = NULL,
          last_fetch_status = 'ok',
          fetch_error_code = NULL,
          fetch_error_retryable = NULL,
          fetch_attempts = excluded.fetch_attempts,
          last_attempt_at = excluded.last_attempt_at,
          fetched_at = excluded.fetched_at,
          updated_at = excluded.updated_at
      `).run(
        opts.sourceKey,
        reference,
        title,
        opts.canonicalUrl ?? existing?.canonical_url ?? null,
        documentType,
        sourceVersionFromTitle(title),
        normalized,
        contentHash,
        CONTENT_NORMALIZER_VERSION,
        bodyStatus,
        attempt,
        ts,
        bodyStatus === 'fetched' ? ts : null,
        ts,
      );
      appendDocumentVersion(opts.sourceKey, normalized, 'remote', sourceVersionFromTitle(title), existing?.content_origin !== 'manual');
      if (changed) updateEvidenceDrift(opts.sourceKey, contentHash);
      return { row: getSourceDocument(opts.sourceKey)!, outcome: bodyStatus, contentChanged: changed };
    } catch (error) {
      lastError = (error as Error).message;
      if (attempt < maxAttempts && !isDefinitiveFailure(lastError)) {
        await sleep(attempt === 1 ? 2_000 : 5_000);
        continue;
      }
      break;
    }
  }

  // 重试耗尽或明确失败：保留旧正文，只记错误
  if (!hadValidBody) markFailed(opts.sourceKey, lastError, maxAttempts);
  else markErrorKeepingBody(opts.sourceKey, lastError, maxAttempts);
  return { row: getSourceDocument(opts.sourceKey)!, outcome: 'failed', contentChanged: false };
}

function markFailed(sourceKey: string, error: string, attempts: number): void {
  const ts = now();
  const { code, retryable } = classifyFetchError(error);
  db.prepare(`
    INSERT INTO source_documents (source_key, provider, external_id, body_status, fetch_error,
      last_fetch_status, fetch_error_code, fetch_error_retryable, content_origin, fetch_attempts, last_attempt_at, updated_at)
    VALUES (?, 'dingtalk', ?, 'failed', ?, 'failed', ?, ?, 'fetch', ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      body_status = 'failed',
      content = '',
      content_hash = NULL,
      fetch_error = excluded.fetch_error,
      last_fetch_status = 'failed',
      fetch_error_code = excluded.fetch_error_code,
      fetch_error_retryable = excluded.fetch_error_retryable,
      fetch_attempts = excluded.fetch_attempts,
      last_attempt_at = excluded.last_attempt_at,
      updated_at = excluded.updated_at
  `).run(sourceKey, referenceFromSourceKey(sourceKey) ?? sourceKey, error.slice(0, 500), code, retryable ? 1 : 0, attempts, ts, ts);
}

function markErrorKeepingBody(sourceKey: string, error: string, attempts: number): void {
  const { code, retryable } = classifyFetchError(error);
  db.prepare(`
    UPDATE source_documents
    SET fetch_error = ?, last_fetch_status = 'failed', fetch_error_code = ?, fetch_error_retryable = ?,
        fetch_attempts = ?, last_attempt_at = ?, updated_at = ?
    WHERE source_key = ?
  `).run(error.slice(0, 500), code, retryable ? 1 : 0, attempts, now(), now(), sourceKey);
}

/**
 * 漂移第一道判定（刷新后）：哈希一致保持 ok；哈希变化一律 changed。
 * 引文仍存在只说明可尝试重定位，不代表新上下文中的语义仍被确认。
 */
export function updateEvidenceDrift(sourceKey: string, newHash: string | null): void {
  const rows = db.prepare(
    `SELECT id, quote_text, doc_hash_at_ref, drift_state FROM knowledge_evidence WHERE document_key = ?`,
  ).all(sourceKey) as Array<{ id: number; quote_text: string; doc_hash_at_ref: string; drift_state: string }>;
  const ts = now();
  for (const row of rows) {
    if (row.doc_hash_at_ref === newHash) {
      db.prepare(`UPDATE knowledge_evidence SET drift_state = 'ok', checked_at = ? WHERE id = ?`).run(ts, row.id);
      continue;
    }
    db.prepare(`UPDATE knowledge_evidence SET drift_state = ?, checked_at = ? WHERE id = ?`)
      .run('changed', ts, row.id);
  }
}

/** 资料被删除（软删）后，关联证据标记 missing */
export function markSourceDeleted(sourceKey: string, deleted: boolean): void {
  if (!deleted) return;
  db.prepare(`UPDATE knowledge_evidence SET drift_state = 'missing', checked_at = ? WHERE document_key = ?`)
    .run(now(), sourceKey);
}

/** 向主题幂等添加成员（已存在则更新状态为 confirmed，不新增行） */
export function addTopicMember(topicId: number, sourceKey: string, origin: 'user' | 'ai' = 'user'): void {
  const ts = now();
  db.prepare(`
    INSERT INTO topic_members (id, topic_id, document_key, origin, state, confirmed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?)
    ON CONFLICT(topic_id, document_key) DO UPDATE SET
      state = 'confirmed', confirmed_at = excluded.confirmed_at, updated_at = excluded.updated_at
  `).run(sync_id(), topicId, sourceKey, origin, ts, ts, ts);
}

// ---------------------------------------------------------------------------
// 阶段 1.5 P0：失败恢复与手动正文通道（docs/knowledge-phase1_5-topics-redesign.md 3.2/3.7）
// ---------------------------------------------------------------------------

/**
 * 单篇重试（结构化闸门）：只有「最近一次抓取失败且错误可重试」的 fetch 来源文档才放行；
 * 其余情况抛带稳定 code 的错误，由路由层转 409。成功后返回新的落库行。
 */
export async function refetchSourceDocument(sourceKey: string): Promise<SourceDocumentRow> {
  const doc = getSourceDocument(sourceKey);
  if (!doc || doc.deleted_at) throw Object.assign(new Error('资料不存在'), { publicCode: 'not_found', statusCode: 404 });
  if (doc.content_origin === 'manual') {
    throw Object.assign(new Error('手动来源的文档没有抓取通道，请直接编辑正文'), { publicCode: 'manual_no_pipeline', statusCode: 409 });
  }
  if (doc.last_fetch_status === 'ok') {
    throw Object.assign(new Error('最近一次抓取成功，无需重试；需要刷新请用 refresh'), { publicCode: 'fetch_ok', statusCode: 409 });
  }
  if (doc.last_fetch_status === 'failed' && doc.fetch_error_retryable !== 1) {
    throw Object.assign(new Error(`最近一次抓取失败且不可重试（${doc.fetch_error_code ?? 'unknown'}）`), {
      publicCode: doc.fetch_error_code ?? 'unknown', statusCode: 409,
    });
  }
  const result = await importSourceDocument({
    sourceKey,
    canonicalUrl: doc.canonical_url,
    documentType: doc.document_type,
    fallbackTitle: doc.title,
  });
  return result.row;
}

export type RetryOutcome = {
  document_key: string;
  outcome: 'succeeded' | 'failed' | 'skipped';
  error_code?: string;
};

/**
 * 批量重试：只挑「最近抓取失败且可重试」的未删除文档，逐项执行，允许部分成功。
 * 固定并发上限 2，防长尾超时打满连接器。
 */
export async function retryFailedDocuments(): Promise<RetryOutcome[]> {
  const rows = db.prepare(`
    SELECT source_key FROM source_documents
    WHERE deleted_at IS NULL AND last_fetch_status = 'failed' AND fetch_error_retryable = 1
    ORDER BY updated_at ASC
  `).all() as Array<{ source_key: string }>;

  const outcomes: RetryOutcome[] = [];
  const queue = [...rows];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        const row = await refetchSourceDocument(item.source_key);
        outcomes.push({ document_key: item.source_key, outcome: row.body_status === 'failed' ? 'failed' : 'succeeded' });
      } catch (error) {
        const err = error as Error & { code?: string };
        outcomes.push({ document_key: item.source_key, outcome: 'skipped', error_code: err.code ?? 'unknown' });
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return outcomes;
}

/**
 * 手动补正文 / 编辑正文（3.7）：不触发任何外部抓取，纯本地落库。
 * 人工正文非空即直接可用；空白草稿可保存但不进入正文检索和分析；
 * content_origin 置 manual，content_hash 重算（自动进入下一轮归纳输入集），
 * last_fetch_status/fetch_error_* 保留不动（最近抓取结果维度），证据漂移按既有规则标注。
 */
export function saveManualBody(sourceKey: string, content: string, title?: string): SourceDocumentRow {
  const doc = getSourceDocument(sourceKey);
  if (!doc || doc.deleted_at) throw Object.assign(new Error('资料不存在'), { publicCode: 'not_found', statusCode: 404 });

  // 共用编辑器输出已是 Markdown，逐字保留代码块、附件及空行；抓取清洗仅用于远程输入。
  const normalized = content;
  // 人工明确保存的非空正文是用户资产，不沿用远程抓取的 500 字完整性阈值。
  const contentHash = contentHashOf(normalized);
  const changed = doc.content_hash !== contentHash;
  const bodyStatus = normalized.trim() ? 'fetched' : 'pending';
  // 空白草稿首次补上正文时才触发自动打标；之后的每次自动保存不再反复调模型
  const firstFill = !String(doc.content).trim() && Boolean(normalized.trim());
  const ts = now();
  ensureDocumentVersion(doc);
  db.prepare(`
    UPDATE source_documents SET
      title = COALESCE(?, title), content = ?, content_hash = ?, normalizer_version = ?,
      body_status = ?, content_origin = 'manual',
      fetched_at = CASE WHEN fetched_at IS NULL AND ? = 'fetched' THEN ? ELSE fetched_at END,
      updated_at = ?
    WHERE source_key = ?
  `).run(
    title?.trim() || null, normalized, contentHash, CONTENT_NORMALIZER_VERSION,
    bodyStatus, bodyStatus, ts, ts, sourceKey,
  );
  if (changed) updateEvidenceDrift(sourceKey, contentHash);
  appendDocumentVersion(sourceKey, normalized, 'manual', doc.source_version);
  autoAssociateDocument(sourceKey);
  if (firstFill) scheduleDocumentAutoTag(sourceKey);
  return getSourceDocument(sourceKey)!;
}

/**
 * 手动新建文档（3.7）：不经过 URL/抓取，直接以 manual 来源入资料池。
 * source_key 用 manual:<sync_id>，provider 用 'local'（schema 白名单内），同样进入归纳输入集。
 */
export function createManualDocument(input: { title: string; content: string; documentType?: string }): SourceDocumentRow {
  const title = input.title.trim();
  if (!title) throw Object.assign(new Error('标题不能为空'), { publicCode: 'empty_title', statusCode: 400 });
  if (title.length > 200) throw Object.assign(new Error('标题过长（最多 200 字）'), { publicCode: 'title_too_long', statusCode: 400 });

  const normalized = input.content;
  const bodyStatus = normalized.trim() ? 'fetched' : 'pending';
  const ts = now();
  const externalId = sync_id();
  const sourceKey = `manual:${externalId}`;
  db.prepare(`
    INSERT INTO source_documents
      (source_key, provider, external_id, title, document_type, content, content_hash,
       normalizer_version, body_status, content_origin, fetched_at, updated_at)
    VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
  `).run(
    sourceKey, externalId, title, input.documentType ?? 'other',
    normalized, contentHashOf(normalized), CONTENT_NORMALIZER_VERSION, bodyStatus,
    bodyStatus === 'fetched' ? ts : null, ts,
  );
  appendDocumentVersion(sourceKey, normalized, 'manual', null);
  autoAssociateDocument(sourceKey);
  if (bodyStatus === 'fetched') scheduleDocumentAutoTag(sourceKey);
  return getSourceDocument(sourceKey)!;
}
