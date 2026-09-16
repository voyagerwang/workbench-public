/**
 * [INPUT]: agent_execution_events（执行/验收阶段用量与启动事件，detail JSON）、agent_review_calls（延后验收用量）
 * [OUTPUT]: agentTaskUsage——任务级阶段用量聚合；已知/未知口径严格区分，未知不记 0
 * [POS]: S20 用量透明切片：只读聚合，不估造费用、不把未知当 0、不虚称供应商单次硬封顶；
 *        历史口径与 agent-execution.tick 的预算核验一致（usage 非法整数视为未知）；
 *        未报告轮次按事件证据判定：适配器 start() 即写入启动事件，有启动事件而无
 *        对应 result 事件＝进程已启动、回执缺失，无论 job 处于 executing、隔离 needs_human
 *        还是其他持久态都按未知保留；从未出现启动事件＝确认未调用，不计入未知。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { db } from '../db.js';

export type AgentTaskEvent = { id: number; kind: string; createdAt: string; detail: Record<string, unknown> };

/** 任务全过程事实链（含内容线）：从 agent_execution_events 只追加台账读取，供任务详情"过程"时间线。 */
export function agentTaskEvents(taskId: string): { events: AgentTaskEvent[] } | null {
  const exists = db.prepare('SELECT 1 FROM agent_tasks WHERE id=?').get(taskId);
  if (!exists) return null;
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_execution_events'").get();
  if (!has) return { events: [] };
  const rows = db.prepare('SELECT id,kind,detail,created_at FROM agent_execution_events WHERE task_id=? ORDER BY id DESC LIMIT 200')
    .all(taskId) as Array<{ id: number; kind: string; detail: string; created_at: string }>;
  const events = rows.map((r) => { let d: Record<string, unknown> = {}; try { d = JSON.parse(r.detail) as Record<string, unknown>; } catch { /* 损坏事件按空详情展示 */ } return { id: r.id, kind: r.kind, createdAt: r.created_at, detail: d }; });
  return { events };
}

export type UsageAttempt = {
  stage: 'execution' | 'review';
  attempt: number;
  requestedModel: string | null;
  observedModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reported: boolean;
  /** 该轮正在执行/待验收，尚无用量回执 */
  inFlight?: boolean;
};

export type AgentTaskUsage = {
  taskId: string;
  attempts: UsageAttempt[];
  /** 汇总只累计已报告部分；存在未知尝试时 totals 为 null，unknownAttempts 计数，不把未知记 0。
   *  cachedInputTokens 仅在所有已报告尝试都单独报告了缓存时才汇总，否则为 null（另给已知小计）。 */
  totals: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; cachedKnownSubtotal: number; reportedAttempts: number; unknownAttempts: number };
  /** 延后验收的验收调用台账（state=running/unknown 时用量未知）。 */
  reviewCalls: Array<{ state: string; tokenLimit: number | null; inputTokens: number | null; outputTokens: number | null; reported: boolean }>;
  known: boolean;
};

function nullableInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function detailUsage(detail: string): { usage: Record<string, unknown> | null; attempt: number; requestedModel: string | null; observedModel: string | null } {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(detail) as Record<string, unknown>; } catch { /* 事件损坏按未知处理 */ }
  const usage = (parsed.usage && typeof parsed.usage === 'object') ? parsed.usage as Record<string, unknown> : null;
  return {
    usage,
    attempt: nullableInt(parsed.attempt) ?? 0,
    requestedModel: typeof parsed.requestedModel === 'string' ? parsed.requestedModel : null,
    observedModel: typeof parsed.observedModel === 'string' ? parsed.observedModel : null,
  };
}

export function agentTaskUsage(taskId: string): AgentTaskUsage | null {
  const exists = db.prepare('SELECT 1 FROM agent_tasks WHERE id=?').get(taskId);
  if (!exists) return null;
  const attempts: UsageAttempt[] = [];
  const hasEvents = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_execution_events'").get();
  if (hasEvents) {
    const rows = db.prepare(`SELECT kind,detail FROM agent_execution_events WHERE task_id=? AND kind IN ('execution_result','review_result') ORDER BY id`)
      .all(taskId) as Array<{ kind: string; detail: string }>;
    for (const row of rows) {
      const { usage, attempt, requestedModel, observedModel } = detailUsage(row.detail);
      const inputTokens = usage ? nullableInt(usage.inputTokens) : null;
      const outputTokens = usage ? nullableInt(usage.outputTokens) : null;
      attempts.push({
        stage: row.kind === 'review_result' ? 'review' : 'execution',
        attempt, requestedModel, observedModel,
        inputTokens, outputTokens,
        cachedInputTokens: usage ? nullableInt(usage.cachedInputTokens) : null,
        reported: inputTokens != null && outputTokens != null,
      });
    }
  }
  // 未报告轮次按事件证据判定（Codex 补充复验 P2）：执行/验收适配器 start() 会立即持久化
  // 启动事件，因此“有启动事件而无对应 result 事件”＝进程已启动、用量回执缺失（可能已调用）。
  // 该未知与当前 job 状态无关：执行中、被隔离为 needs_human、blocked 等持久态都不得让
  // 缺失回执消失，否则旧轮合计会重新冒充完整。反之，从未出现启动事件的轮次＝确认未调用
  //（如模型选择阶段即失败），不得计入未知，也不能把所有 needs_human 任务永久视为未知。
  const resultKeys = new Set(attempts.map((a) => `${a.stage}:${a.attempt}`));
  const startedUnknown = new Set<string>();
  if (hasEvents) {
    const startedRows = db.prepare(`SELECT kind,detail FROM agent_execution_events WHERE task_id=? AND kind IN ('execution','review') ORDER BY id`)
      .all(taskId) as Array<{ kind: string; detail: string }>;
    for (const row of startedRows) {
      let attempt: number | null = null;
      try { attempt = nullableInt((JSON.parse(row.detail) as Record<string, unknown>).attempt); } catch { /* 损坏事件无法归属轮次，不作启动证据 */ }
      if (attempt == null) continue;
      const key = `${row.kind === 'review' ? 'review' : 'execution'}:${attempt}`;
      if (!resultKeys.has(key)) startedUnknown.add(key);
    }
  }
  for (const key of startedUnknown) {
    const [stage, attemptText] = key.split(':');
    attempts.push({
      stage: stage as 'execution' | 'review',
      attempt: Number(attemptText),
      requestedModel: null, observedModel: null,
      inputTokens: null, outputTokens: null, cachedInputTokens: null,
      reported: false, inFlight: true,
    });
  }
  // 新一轮已登记待执行/执行中/待验收时都尚无本轮 result 事件，必须按未报告计入，
  // 否则返工登记后、执行开始前后都会拿旧轮总量冒充完整（评审边界补充：ready_to_dispatch 也算）。
  // 若该轮已被启动事件证据或未报告回执行覆盖，则不重复计入。
  const hasJobs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_execution_jobs'").get();
  if (hasJobs) {
    const job = db.prepare('SELECT state FROM agent_execution_jobs WHERE task_id=?').get(taskId) as { state: string } | undefined;
    if (job && ['ready_to_dispatch', 'executing', 'pending_review'].includes(job.state)) {
      const taskRow = db.prepare('SELECT attempt FROM agent_tasks WHERE id=?').get(taskId) as { attempt: number | null } | undefined;
      const stage = job.state === 'pending_review' ? 'review' : 'execution';
      const attemptNo = taskRow?.attempt ?? 1;
      const covered = startedUnknown.has(`${stage}:${attemptNo}`)
        || attempts.some((a) => a.stage === stage && a.attempt === attemptNo && !a.reported);
      if (!covered) {
        attempts.push({
          stage,
          attempt: attemptNo,
          requestedModel: null, observedModel: null,
          inputTokens: null, outputTokens: null, cachedInputTokens: null,
          reported: false, inFlight: true,
        });
      }
    }
  }
  const reviewCalls: AgentTaskUsage['reviewCalls'] = [];
  const hasReviewCalls = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_review_calls'").get();
  if (hasReviewCalls) {
    const rows = db.prepare(`SELECT c.state,c.token_limit,c.input_tokens,c.output_tokens FROM agent_review_calls c JOIN agent_review_queue q ON q.id=c.queue_id WHERE q.task_id=? ORDER BY c.rowid`)
      .all(taskId) as Array<{ state: string; token_limit: number | null; input_tokens: number | null; output_tokens: number | null }>;
    for (const call of rows) {
      const inputTokens = nullableInt(call.input_tokens);
      const outputTokens = nullableInt(call.output_tokens);
      const reported = call.state === 'finished' && inputTokens != null && outputTokens != null;
      reviewCalls.push({ state: call.state, tokenLimit: nullableInt(call.token_limit), inputTokens, outputTokens, reported });
      attempts.push({ stage: 'review', attempt: 0, requestedModel: null, observedModel: null, inputTokens, outputTokens, cachedInputTokens: null, reported });
    }
  }
  const reportedAttempts = attempts.filter((a) => a.reported);
  const unknownAttempts = attempts.length - reportedAttempts.length;
  const sum = (pick: (a: UsageAttempt) => number | null) => reportedAttempts.reduce((n, a) => n + (pick(a) ?? 0), 0);
  // 未知尝试存在时整体口径为未知：不把未知记 0，也不给出只含已知部分的误导性合计
  const allKnown = unknownAttempts === 0 && reportedAttempts.length > 0;
  // 缓存分项（评审复验 P2）：完整合计只有整体 known 且全部尝试都单独报告缓存时才给；
  // 只遍历 reportedAttempts 会漏掉 inFlight 未知轮次。已知小计单列，未知不记 0。
  const cacheFullyReported = allKnown && reportedAttempts.every((a) => a.cachedInputTokens != null);
  return {
    taskId,
    attempts,
    totals: {
      inputTokens: allKnown ? sum((a) => a.inputTokens) : null,
      outputTokens: allKnown ? sum((a) => a.outputTokens) : null,
      cachedInputTokens: cacheFullyReported ? sum((a) => a.cachedInputTokens) : null,
      cachedKnownSubtotal: reportedAttempts.reduce((n, a) => n + (a.cachedInputTokens ?? 0), 0),
      reportedAttempts: reportedAttempts.length,
      unknownAttempts,
    },
    reviewCalls,
    known: unknownAttempts === 0,
  };
}
