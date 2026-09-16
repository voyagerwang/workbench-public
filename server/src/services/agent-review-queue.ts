/**
 * [INPUT]: 可信服务注入的 SQLite、身份和回执
 * [OUTPUT]: 增量回执/验收队列与租约审计，不修改业务任务终态
 * [POS]: A 阶段持久验收底层；无网络入口、无自动模型调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type Database from 'better-sqlite3';
import path from 'node:path';
import crypto from 'node:crypto';
import { realpathSync, readFileSync } from 'node:fs';
export type Scope = { owner: string; projectScope: string };
export type Binding = Scope & { taskId: string; attempt: number; boundDir?: string; executor?: string; provider?: string; threadId?: string; turnId?: string };
export type Attempt = {task_id:string;attempt:number;owner:string;project_scope:string;bound_dir:string|null;executor:string|null;provider:string|null;thread_id:string|null;turn_id:string|null};
export type ReceiptInput = Scope & {eventId:string;taskId:string;attempt:number;kind:'completion'|'failure';resultHash?:string;resultPath?:string;fields?:Record<string,unknown>};
export type Receipt = {event_id:string;task_id:string;attempt:number;kind:string;result_key:string};
export type ReviewEntry = {id:number;task_id:string;attempt:number;result_hash:string|null;result_path:string|null;owner:string;project_scope:string;status:string;claim_owner:string|null;claim_token:string|null;lease_until:string|null};
export type ClaimInput = {owner:string;token?:string;id?:number|null;scope?:Scope|null;leaseUntil:string};
export type ResolveInput = {id:number;token:string;outcome?:'confirmed'|'rejected';reviewer?:string;resultHash?:string|null;scope?:Scope|null};
export class QueueError extends Error {
  constructor(public code: string, message: string, public extra: Record<string,unknown> = {}) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
    this.extra = extra;
  }
}

// 回执允许落库的字段白名单（其余字段一律丢弃，绝不信任消息自带的 scope）。
const ALLOWED_RECEIPT_FIELDS = new Set([
  'result_hash', 'result_path', 'summary', 'exit_code', 'duration_ms', 'model', 'error_kind',
]);
const MAX_STR_BYTES = 4096;
const MAX_SUMMARY_BYTES = 1024;

function sanitizeFields(fields?: Record<string,unknown>) {
  const out: Record<string,string|number> = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const k of Object.keys(fields)) {
    if (!ALLOWED_RECEIPT_FIELDS.has(k)) continue; // 丢弃未知字段
    let v = fields[k];
    if (typeof v === 'string') {
      const max = k === 'summary' ? MAX_SUMMARY_BYTES : MAX_STR_BYTES;
      const b = Buffer.byteLength(v, 'utf8');
      if (b > max) { let size=0, result=''; for (const c of v) { const n=Buffer.byteLength(c); if(size+n>max)break; size+=n; result+=c; } v=result; }
      out[k] = String(v);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    }
    // 布尔 / null / 对象 一律不存
  }
  return out;
}

// 路径越界判定：fail-closed。无绑定目录则任何路径都拒绝。
// 用 realpath 解析符号链接（只解析元数据，不读文件正文），避免词法比较被 symlink 越界绕过。
function safeReal(p: string) {
  try { return realpathSync(p); } catch { throw new QueueError('path_out_of_bounds', '成果或绑定目录无法解析，拒绝接收'); }
}
function isWithinBounds(target: string, dir: string|null) {
  if (!dir) return false;
  const base = safeReal(dir);
  const resolved = safeReal(target);
  if (resolved === base) return true;
  const rel = path.relative(base, resolved);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// 建表：纯增量、幂等（CREATE TABLE IF NOT EXISTS），绝不 DROP / ALTER 既有表。
// 只加载 schema.sql 中新增验收表，不创建或弱化现有任务表。
// ---------------------------------------------------------------------------
const reviewSchema = readFileSync(new URL('../schema.sql',import.meta.url),'utf8').split('-- BEGIN AGENT REVIEW SCHEMA')[1]?.split('-- END AGENT REVIEW SCHEMA')[0];
if(!reviewSchema)throw new Error('缺少验收表结构');
export function ensureSchema(db: Database.Database){ db.exec(reviewSchema); }

// ---------------------------------------------------------------------------
// 主工厂：返回审查队列 API。
// ---------------------------------------------------------------------------
export function createReviewQueue(db: Database.Database, opts: {now?:()=>string} = {}) {
  ensureSchema(db);
  const now = opts.now ?? (() => new Date().toISOString());
  const nowStr = () => { const value=now(); if(!Number.isFinite(Date.parse(value))) throw new QueueError('invalid_time','无效时钟'); return new Date(value).toISOString(); };

  // 预编译语句
  const st = {
    getTask: db.prepare<unknown[], {id:string;status:string}>('SELECT id, status FROM agent_tasks WHERE id=?'),
    getAttempt: db.prepare<unknown[], Attempt>(
      'SELECT * FROM agent_execution_attempts WHERE task_id=? AND attempt=?'),
    insAttempt: db.prepare(
      `INSERT INTO agent_execution_attempts
         (task_id, attempt, owner, project_scope, executor, provider, thread_id, turn_id, bound_dir, status, created_at, updated_at)
       VALUES (@task_id, @attempt, @owner, @project_scope, @executor, @provider, @thread_id, @turn_id, @bound_dir, 'registered', @ts, @ts)`),
    getReceipt: db.prepare<unknown[], Receipt>('SELECT * FROM agent_execution_receipts WHERE event_id=?'),
    getQueueByEvent: db.prepare<unknown[], ReviewEntry>('SELECT * FROM agent_review_queue WHERE receipt_event_id=?'),
    getQueueByResult: db.prepare<unknown[], ReviewEntry>(
      'SELECT * FROM agent_review_queue WHERE task_id=? AND attempt=? AND result_key=?'),
    insReceipt: db.prepare(
      `INSERT INTO agent_execution_receipts
         (event_id, task_id, attempt, kind, result_key, result_hash, result_path, allowed_fields_json, status, created_at)
       VALUES (@event_id, @task_id, @attempt, @kind, @result_key, @result_hash, @result_path, @allowed_fields_json, 'pending_review', @ts)`),
    insQueue: db.prepare(
      `INSERT INTO agent_review_queue
         (task_id, attempt, receipt_event_id, result_key, result_hash, result_path, owner, project_scope, status, created_at, updated_at)
       VALUES (@task_id, @attempt, @receipt_event_id, @result_key, @result_hash, @result_path, @owner, @project_scope, 'pending', @ts, @ts)`),
    insEvent: db.prepare(
      `INSERT INTO agent_review_events (queue_id, action, actor, token, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`),
    getQueue: db.prepare<unknown[], ReviewEntry>('SELECT * FROM agent_review_queue WHERE id=?'),
    nextPending: db.prepare<unknown[], {id:number}>(
      `SELECT id FROM agent_review_queue WHERE status='pending' ORDER BY id ASC LIMIT 1`),
    nextPendingScoped: db.prepare<unknown[], {id:number}>(
      `SELECT id FROM agent_review_queue
         WHERE status='pending' AND owner=@owner AND project_scope=@ps ORDER BY id ASC LIMIT 1`),
    claimUpdate: db.prepare(
      `UPDATE agent_review_queue
         SET status='claimed', claim_owner=@owner, claim_token=@token, lease_until=@lease, updated_at=@ts
       WHERE id=@id AND status='pending'`),
    confirmUpdate: db.prepare(
      `UPDATE agent_review_queue
         SET status=@status, confirmed_at=@ts, reviewed_by=@reviewer,
             review_result_hash=@rhash, updated_at=@ts
       WHERE id=@id AND status='claimed' AND claim_token=@token
         AND (lease_until IS NULL OR lease_until > @now)`),
    recoverUpdate: db.prepare(
      `UPDATE agent_review_queue
         SET status='pending', claim_owner=NULL, claim_token=NULL, lease_until=NULL, updated_at=@ts
       WHERE status='claimed' AND lease_until IS NOT NULL AND lease_until <= @now`),
    notifyUpdate: db.prepare(
      `UPDATE agent_review_queue
         SET notified_at=@ts, notify_state=@state, notify_error=@err, updated_at=@ts
       WHERE id=@id`),
    listPending: db.prepare<unknown[], ReviewEntry>(
      `SELECT * FROM agent_review_queue WHERE status='pending' ORDER BY id ASC`),
    listPendingScoped: db.prepare<unknown[], ReviewEntry>(
      `SELECT * FROM agent_review_queue
         WHERE status='pending' AND owner=@owner AND project_scope=@ps ORDER BY id ASC`),
    listConfirmed: db.prepare<unknown[], ReviewEntry>(
      `SELECT * FROM agent_review_queue WHERE status IN ('confirmed','rejected') ORDER BY id ASC`),
    listConfirmedScoped: db.prepare<unknown[], ReviewEntry>(
      `SELECT * FROM agent_review_queue
         WHERE status IN ('confirmed','rejected') AND owner=@owner AND project_scope=@ps ORDER BY id ASC`),
    countAll: db.prepare<unknown[], {n:number}>('SELECT COUNT(*) n FROM agent_review_queue'),
  };

  function audit(queueId: number, action: string, actor: string|null|undefined, token: string|null|undefined, detail: unknown) {
    st.insEvent.run(queueId, action, actor ?? null, token ?? null,
      JSON.stringify(detail ?? {}), nowStr());
  }

  // -------------------------------------------------------------------------
  // 1. 注册 attempt：绑定现有 task + 调用者传入的可信 scope + 绑定目录。
  // -------------------------------------------------------------------------
  const registerAttemptTx = db.transaction((params: Binding) => {
    const { taskId, attempt } = params;
    if (!taskId || !Number.isInteger(attempt) || attempt < 1) {
      throw new QueueError('invalid_attempt', 'taskId 必填且 attempt 须为正整数');
    }
    const owner = params.owner;
    const projectScope = params.projectScope;
    if (!owner || !projectScope) {
      throw new QueueError('missing_scope', 'owner 与 projectScope 必须由调用者显式传入，不可省略');
    }
    const task = st.getTask.get(taskId);
    if (!task) throw new QueueError('unknown_task', `task ${taskId} 不存在，无法绑定 attempt`);

    // 不可静默夺取归属：已注册 attempt 需比对绑定一致性。
    const existing = st.getAttempt.get(taskId, attempt);
    if (existing) {
      const sameBinding =
        existing.owner === owner &&
        existing.project_scope === projectScope &&
        (existing.bound_dir ?? null) === (params.boundDir ?? null) &&
        (existing.executor ?? null) === (params.executor ?? null) &&
        (existing.provider ?? null) === (params.provider ?? null) &&
        (existing.thread_id ?? null) === (params.threadId ?? null) &&
        (existing.turn_id ?? null) === (params.turnId ?? null);
      if (sameBinding) return existing; // 相同绑定：幂等返回
      throw new QueueError('attempt_binding_conflict',
        `task ${taskId} attempt ${attempt} 已绑定到不同 owner/scope，拒绝夺取归属`);
    }
    const ts = nowStr();
    st.insAttempt.run({
      task_id: taskId,
      attempt,
      owner,
      project_scope: projectScope,
      executor: params.executor ?? null,
      provider: params.provider ?? null,
      thread_id: params.threadId ?? null,
      turn_id: params.turnId ?? null,
      bound_dir: params.boundDir ?? null,
      ts,
    });
    return getAttempt(taskId, attempt);
  });
  function registerAttempt(params: Binding) { return registerAttemptTx.immediate(params); }

  function getAttempt(taskId: string, attempt: number) {
    return st.getAttempt.get(taskId, attempt) ?? null;
  }

  // -------------------------------------------------------------------------
  // 2. 收合成回执：校验 scope/绑定、事件去重、成果版本去重；只落 pending_review。
  //    返回 { status: 'queued'|'duplicate_event'|'duplicate_result', entry }。
  // -------------------------------------------------------------------------
  const receiveReceiptTx = db.transaction((p: ReceiptInput) => {
    const { eventId, taskId, attempt, kind, resultHash, resultPath, fields, owner, projectScope } = p;
    for(const [key,value] of Object.entries({eventId,taskId,resultHash,resultPath})) { if(value!=null && (typeof value!=='string' || !value.trim() || Buffer.byteLength(value)>4096)) throw new QueueError('invalid_field',key+'无效或过长'); }
    if (!eventId) throw new QueueError('missing_event_id', '回执必须带 event_id 用于幂等');
    if (kind !== 'completion' && kind !== 'failure') {
      throw new QueueError('invalid_kind', 'kind 只能为 completion 或 failure');
    }
    if (!owner || !projectScope) {
      throw new QueueError('missing_scope', 'owner 与 projectScope 必须由调用者显式传入');
    }

    const resultKey = resultHash ?? `__${kind}__`;

    // 鉴权先于去重返回：先确认该 event_id 已有回执的归属 scope 与调用者一致，
    // 跨 owner 即便知道 event_id 也取不到原成果。
    const prior = st.getReceipt.get(eventId);
    if (prior) {
      const att = st.getAttempt.get(prior.task_id, prior.attempt);
      if (!att || att.owner !== owner || att.project_scope !== projectScope) {
        throw new QueueError('scope_mismatch',
          '调用者 scope 与既有回执归属不一致，拒绝收信');
      }
      // 同 event_id 但核心字段不一致 → 拒绝，不当作成功幂等
      const samePayload = prior.task_id === taskId && prior.attempt === attempt &&
        prior.kind === kind && prior.result_key === resultKey;
      if (!samePayload) {
        throw new QueueError('event_id_conflict',
          'event_id 已存在但 task/attempt/kind/result 不一致，拒绝当作幂等');
      }
      const entry = st.getQueueByEvent.get(eventId)!;
      audit(entry.id, 'duplicate_event', owner, null, { eventId });
      return { status: 'duplicate_event', entry };
    }

    // 绑定校验：attempt 必须已注册
    const att = st.getAttempt.get(taskId, attempt);
    if (!att) {
      throw new QueueError('unknown_attempt',
        `task ${taskId} attempt ${attempt} 未注册，不能收信`);
    }
    // 可信 scope 来自调用者，且必须与注册时一致（跨 scope 拒绝）
    if (att.owner !== owner || att.project_scope !== projectScope) {
      throw new QueueError('scope_mismatch',
        '调用者传入的 scope 与注册 scope 不一致，拒绝收信');
    }

    // 重复成果：同一 (task, attempt, result_key) 已存在 → 返回既有条目
    const byResult = st.getQueueByResult.get(taskId, attempt, resultKey);
    if (byResult) {
      audit(byResult.id, 'duplicate_result', owner, null, { eventId, resultKey });
      return { status: 'duplicate_result', entry: byResult };
    }

    // 成果路径必须限定在绑定目录内，越界即拒，且不读正文
    if (resultPath != null) {
      if (!isWithinBounds(resultPath, att.bound_dir)) {
        throw new QueueError('path_out_of_bounds',
          `result_path 越出绑定目录 ${att.bound_dir}`);
      }
    }

    const ts = nowStr();
    const allowed = sanitizeFields(fields);
    if (resultHash) allowed.result_hash = resultHash;
    if (resultPath != null) allowed.result_path = String(resultPath);

    st.insReceipt.run({
      event_id: eventId,
      task_id: taskId,
      attempt,
      kind,
      result_key: resultKey,
      result_hash: resultHash ?? null,
      result_path: resultPath ?? null,
      allowed_fields_json: JSON.stringify(allowed),
      ts,
    });
    const info = st.insQueue.run({
      task_id: taskId,
      attempt,
      receipt_event_id: eventId,
      result_key: resultKey,
      result_hash: resultHash ?? null,
      result_path: resultPath ?? null,
      owner: att.owner,
      project_scope: att.project_scope,
      ts,
    });
    const entry = st.getQueue.get(info.lastInsertRowid)!;
    // 只在新增回执台账（agent_review_events）追加审计；不写原 agent_execution_events，
    // 以免在缺少 job 的真实原表上触发外键失败（REVIEW §4）。
    audit(entry.id, 'enqueued', owner, null, { eventId, kind, resultKey });
    return { status: 'queued', entry };
  });

  function receiveReceipt(params: ReceiptInput) {
    return receiveReceiptTx(params);
  }

  // -------------------------------------------------------------------------
  // 3a. 原子领取：条件 UPDATE 做 CAS。id 省略则取最旧 pending。
  //     并发/重复领取至多一个成功（返回 null 表示未领取）。
  // -------------------------------------------------------------------------
  const claimReviewTx = db.transaction((p: ClaimInput & {token:string}) => {
    const { owner, token, id, scope } = p;
    if(typeof p.leaseUntil !== 'string' || !Number.isFinite(Date.parse(p.leaseUntil))) throw new QueueError('invalid_claim','无效租约时间');
    const leaseUntil=new Date(p.leaseUntil).toISOString();
    if(leaseUntil <= nowStr()) throw new QueueError('invalid_claim','租约必须在未来');
    if (!owner || !token || !leaseUntil) {
      throw new QueueError('invalid_claim', 'claim 需要 owner / token / leaseUntil');
    }
    let targetId = id;
    if (targetId == null) {
      const row = scope
        ? st.nextPendingScoped.get({ owner: scope.owner, ps: scope.projectScope })
        : st.nextPending.get();
      if (!row) return null;
      targetId = row.id;
    }
    if (scope) {
      // 本服务内单 owner 可信 scope 限制：只领取归属于该 scope 的条目
      const cand = st.getQueue.get(targetId);
      if (!cand || cand.owner !== scope.owner || cand.project_scope !== scope.projectScope) {
        throw new QueueError('scope_mismatch', '目标条目不属于调用者可信 scope');
      }
    }
    const res = st.claimUpdate.run({
      id: targetId, owner, token, lease: leaseUntil, ts: nowStr(),
    });
    if (res.changes === 0) return null; // 已被领取或不存在
    const entry = st.getQueue.get(targetId)!;
    audit(entry.id, 'claimed', owner, token, { leaseUntil });
    return entry;
  });

  function claimReview(params: ClaimInput) {
    const token = params.token ?? crypto.randomBytes(16).toString('hex');
    const entry = claimReviewTx({
      owner: params.owner,
      token,
      leaseUntil: params.leaseUntil,
      id: params.id ?? null,
      scope: params.scope ?? null,
    });
    return entry ? { ...entry, token } : null;
  }

  // -------------------------------------------------------------------------
  // 3b. 确认 / 拒绝：必须匹配当前 claim token，且租约未过期。
  //     本模块只推进队列状态，不标任务 completed（完成由下游确定性程序负责）。
  //     时间比较、CAS 与审计在同一事务内完成；条件 UPDATE 含未过期约束，
  //     过期 token 不可覆盖（REVIEW §3）。
  // -------------------------------------------------------------------------
  const resolveReviewTx = db.transaction((p: ResolveInput) => {
    const { id, token, outcome, reviewer, resultHash, scope } = p;
    if (outcome !== 'confirmed' && outcome !== 'rejected') {
      throw new QueueError('invalid_outcome', 'outcome 只能为 confirmed 或 rejected');
    }
    const entry = st.getQueue.get(id);
    if (!entry) throw new QueueError('no_such_entry', `队列条目 ${id} 不存在`);
    if (entry.status !== 'claimed') {
      throw new QueueError('not_claimed', `条目 ${id} 当前状态 ${entry.status}，无法确认`);
    }
    // 可信 scope 限制（REVIEW §6）：调用者鉴权后的 scope 必须与条目归属一致
    if (scope && (entry.owner !== scope.owner || entry.project_scope !== scope.projectScope)) {
      throw new QueueError('scope_mismatch', '条目不属于调用者可信 scope');
    }
    if (entry.claim_token !== token) {
      throw new QueueError('token_mismatch', `token 不匹配当前领取者，可能被新领取者覆盖`);
    }
    // 统一用注入可信 clock 兜底；等于租约到期时刻即视为过期
    const cur = nowStr();
    if (entry.lease_until && cur >= entry.lease_until) {
      throw new QueueError('lease_expired', `领取租约已于 ${entry.lease_until} 过期`);
    }
    const res = st.confirmUpdate.run({
      id,
      status: outcome,
      ts: cur,
      reviewer: reviewer ?? entry.claim_owner,
      rhash: resultHash ?? entry.result_hash,
      token,
      now: cur,
    });
    if (res.changes === 0) {
      throw new QueueError('resolve_failed', `条目 ${id} 确认失败（并发或租约过期）`);
    }
    const updated = st.getQueue.get(id);
    audit(id, outcome, reviewer ?? entry.claim_owner, token,
      { resultHash: resultHash ?? entry.result_hash });
    return updated;
  });

  function resolveReview(params: ResolveInput) { return resolveReviewTx(params); }
  function confirmReview(params: ResolveInput) { return resolveReview({ ...params, outcome: 'confirmed' }); }
  function rejectReview(params: ResolveInput) { return resolveReview({ ...params, outcome: 'rejected' }); }

  // -------------------------------------------------------------------------
  // 3c. 租约过期恢复：把过期 claimed 重置为 pending，可被重新领取。
  // -------------------------------------------------------------------------
  function recoverExpiredClaims(nowArg = nowStr()) {
    const res = st.recoverUpdate.run({ now: nowArg, ts: nowStr() });
    return res.changes;
  }

  // -------------------------------------------------------------------------
  // 通知结果记录：通知失败不影响队列状态、不重新执行 worker。
  // （体现「通知失败不重新执行 worker」的语义边界）
  // -------------------------------------------------------------------------
  function markNotified(id: number, state: string, error: string|null = null) {
    const entry = st.getQueue.get(id);
    if (!entry) throw new QueueError('no_such_entry', `队列条目 ${id} 不存在`);
    st.notifyUpdate.run({ id, ts: nowStr(), state, err: error ?? null });
    audit(id, 'notified', null, null, { state, error });
    return st.getQueue.get(id);
  }

  // -------------------------------------------------------------------------
  // 查询辅助
  // -------------------------------------------------------------------------
  function getQueueEntry(id: number) { return st.getQueue.get(id) ?? null; }
  function getReceipt(eventId: string) { return st.getReceipt.get(eventId) ?? null; }
  function listPending(scope?: Scope) {
    if (scope) return st.listPendingScoped.all({ owner: scope.owner, ps: scope.projectScope });
    return st.listPending.all();
  }
  function listConfirmed(scope?: Scope) {
    if (scope) return st.listConfirmedScoped.all({ owner: scope.owner, ps: scope.projectScope });
    return st.listConfirmed.all();
  }
  function stats() {
    const row = st.countAll.get()!;
    return { total: row.n };
  }

  return {
    registerAttempt,
    getAttempt,
    receiveReceipt,
    claimReview,
    confirmReview,
    rejectReview,
    recoverExpiredClaims,
    markNotified,
    getQueueEntry,
    getReceipt,
    listPending,
    listConfirmed,
    stats,
  };
}
