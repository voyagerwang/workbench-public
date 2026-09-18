import { executionErrorMessage } from './execution-error.js';
/**
 * [INPUT]: agent_delegate 工具提交的结构化委派意图（objective/taskType/requestedExecutor）、
 *          inbound-context 归一化的来源元数据、agent-registry 白名单
 * [OUTPUT]: drafted 任务创建、项目/模型/费用约束（含 S19 长期偏好解析）与只读状态投影；不派发、不发送消息
 * [POS]: 编排 V3 第八节的任务聚合根服务端实现起点：SQLite 是唯一真相源；
 *        阶段 1 只负责登记意图与幂等去重，状态机推进/CAS/回执匹配属阶段 2-3，
 *        不读取 .handoff/relay/registry.json
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { createHash } from 'node:crypto';
import { executionConcurrency } from './execution-signals.js';
import { db, now, getSetting } from '../db.js';
import { isExecutorAllowed } from './agent-registry.js';
import { modelRequirement, type ModelCostPolicy } from './agent-model-policy.js';
import { resolveExecutionPreference } from './agent-preferences.js';

export type AgentTaskType = 'code' | 'frontend' | 'document' | 'research' | 'other';

export type SessionActivityState = 'running' | 'attention' | 'queued';
export type SessionTaskActivity = { state: SessionActivityState; running: number; attention: number; queued: number };

/** 会话列表圆点数据：经消息里登记的任务 ID 关联会话，桌面与 IM 归档会话统一覆盖。
 *  attention=needs_human/failed/blocked；running=已派发至验收中/修改中；queued=只登记未派发。 */
export function sessionTaskActivity(): Record<string, SessionTaskActivity> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_tasks'").get()
    || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='assistant_messages'").get()) return {};
  const rows = db.prepare(`SELECT m.session_id AS sid, t.status AS status, COUNT(*) AS n
    FROM assistant_messages m, json_each(m.agent_task_ids_json) je
    JOIN agent_tasks t ON t.id = je.value
    WHERE t.status IN ('planning','ready_to_dispatch','dispatched','acknowledged','executing',
                       'pending_review','changes_requested','needs_human','blocked','failed')
    GROUP BY m.session_id, t.status`).all() as Array<{ sid: string; status: string; n: number }>;
  const activity: Record<string, SessionTaskActivity> = {};
  for (const row of rows) {
    const entry = activity[row.sid] ?? { state: 'queued', running: 0, attention: 0, queued: 0 };
    if (['needs_human', 'failed', 'blocked'].includes(row.status)) entry.attention += row.n;
    else if (['planning', 'ready_to_dispatch'].includes(row.status)) entry.queued += row.n;
    else entry.running += row.n;
    activity[row.sid] = entry;
  }
  for (const entry of Object.values(activity)) {
    entry.state = entry.attention ? 'attention' : entry.running ? 'running' : 'queued';
  }
  return activity;
}

export type AgentTaskView = {
  id: string;
  status: string;
  taskType: AgentTaskType;
  executor: string | null;
  source: string;
  objective: string;
  created: boolean;
  statusLabel?: string;
  statusDetail?: string;
  projectPath?: string | null;
  projectId?: number | null;
  projectName?: string | null;
  updatedAt?: string;
  requestedModel: string | null;
  requestedCostPolicy: ModelCostPolicy;
  observedModel: string | null;
};

/** 展示口径保守依赖现有台账；尚无成果验证凭证，不把 completed 当成应用已升级。 */
function taskPresentation(status: string): { statusLabel: string; statusDetail: string } {
  if (status === 'drafted') return { statusLabel: '已登记 · 尚未派发', statusDetail: '执行通道尚未启用，不会自动开始。' };
  if (['planning', 'ready_to_dispatch'].includes(status)) return { statusLabel: '准备启动', statusDetail: '收到，正在安排执行。' };
  if (['dispatched', 'acknowledged'].includes(status)) return { statusLabel: '等待执行回执', statusDetail: '消息送达不代表任务已经完成。' };
  if (status === 'executing') return { statusLabel: '执行中', statusDetail: '以执行端回执为准，成果尚未验收。' };
  if (status === 'pending_review') return { statusLabel: '独立验收中', statusDetail: '执行端已返回成果，独立验收尚未通过。' };
  if (['approved', 'completed'].includes(status)) return { statusLabel: '已通过验收', statusDetail: '任务成果已通过独立验收；实际变更与验证结果见报告。' };
  if (status === 'needs_human') return { statusLabel: '需要处理', statusDetail: '执行或验收未完成，详细原因见任务记录；不会盲目重跑。' };
  if (status === 'cancelled') return { statusLabel: '已记录取消', statusDetail: '外部执行是否停止仍需执行端确认。' };
  if (status === 'failed') return { statusLabel: '未完成', statusDetail: '请查看任务说明；不会自动重复派发。' };
  return { statusLabel: '等待处理', statusDetail: '需要核对任务状态，不能据此重复派发。' };
}

export function getAgentTask(id: string): AgentTaskView | null {
  const row = db.prepare('SELECT a.*, p.name AS project_name FROM agent_tasks a LEFT JOIN projects p ON p.id = a.project_id WHERE a.id = ?').get(id) as (AgentTaskRow & { project_path: string | null; project_id: number | null; project_name: string | null; updated_at: string; last_error: string | null }) | undefined;
  if (!row) return null;
  const view = { ...rowToView(row, false), ...taskPresentation(row.status), projectPath: row.project_path, projectId: row.project_id, projectName: row.project_name,
    updatedAt: row.updated_at, ...(row.last_error ? { statusDetail: executionErrorMessage(row.last_error) } : {}) };
  if(row.status==='ready_to_dispatch') {
    const config=getSetting<{paused?:boolean;enabled?:boolean;maxConcurrentJobs?:number;maxConcurrentContentJobs?:number;maxDailyJobs?:number}>('agentExecution');
    const isContent=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_execution_jobs'").get()&&db.prepare('SELECT 1 FROM content_execution_jobs WHERE task_id=?').get(id));
    const table=isContent?'content_execution_jobs':'agent_execution_jobs';
    const limit=executionConcurrency(isContent?config?.maxConcurrentContentJobs:config?.maxConcurrentJobs);
    if(!config?.enabled||config.paused||(isContent&&getSetting<{enabled?:boolean}>('contentExecution')?.enabled!==true)||(process.env.WORKBENCH_DEVICE_ROLE??'primary')!=='primary') {
      view.statusLabel='等待恢复';view.statusDetail='执行已暂停，恢复后会自动继续。';
    } else if(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) {
      const active=(db.prepare(`SELECT count(*) n FROM ${table} WHERE state IN ('executing','pending_review')`).get() as {n:number}).n;
      const used=!isContent&&db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_execution_events'").get()
        ?(db.prepare("SELECT count(*) n FROM agent_execution_events WHERE kind='executing' AND created_at>=?").get(new Date().toISOString().slice(0,10)) as {n:number}).n:0;
      if(!isContent&&config.maxDailyJobs!=null&&used>=config.maxDailyJobs) {
        view.statusLabel='等待额度';view.statusDetail='今日任务额度已用完，额度恢复后自动继续。';
      } else if(active>=limit) {
        const ahead=(db.prepare(`SELECT count(*) n FROM ${table} WHERE state='ready_to_dispatch' AND (created_at,task_id)<(SELECT created_at,task_id FROM ${table} WHERE task_id=?)`).get(id) as {n:number}).n;
        view.statusLabel='等待空位';view.statusDetail=`当前 ${active} 个任务在处理，并发上限 ${limit}${ahead?`；前面还有 ${ahead} 个待办`:''}。空位释放后自动开始。`;
      }
    }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_execution_jobs'").get()) {
    const content=db.prepare('SELECT state,note_id,artifact_path,error FROM content_execution_jobs WHERE task_id=?').get(id) as {state:string;note_id:number;artifact_path:string|null;error:string|null}|undefined;
    if(content?.state==='completed') {view.statusLabel='内容已保存';view.statusDetail=content.note_id?'转写与总结已保存到随手记。':'转写与总结已保存为任务成果。';}
    if(content?.state==='needs_human'&&content.artifact_path&&/Skill 保存或 AI 资源库同步尚未完成/.test(content.error??'')){view.statusDetail=`${content.note_id?'转写与总结已保存到随手记':'整理成果已生成'}；${/Skill|技能/i.test(row.objective)?'Skill 尚未保存':'资源库尚未同步'}。`;}
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_execution_notifications'").get()) {
      const notice=db.prepare('SELECT state,error FROM content_execution_notifications WHERE task_id=?').get(id) as {state:string;error:string}|undefined;
      if(notice&&['failed','unknown'].includes(notice.state))view.statusDetail+=` 结果通知${notice.state==='unknown'?'送达未知':'失败'}：${notice.error??'请核对原渠道'}；未自动重复发送。`;
    }
  }
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='skill_capture_drafts'").get()) {
    const saved=db.prepare("SELECT saved_json FROM skill_capture_drafts WHERE source_type='content_task' AND source_id=? AND status='saved' ORDER BY rowid DESC LIMIT 1").get(id) as {saved_json:string}|undefined;
    if(saved){view.statusLabel=row.status==='completed'?'Skill 已保存':view.statusLabel;view.statusDetail=row.status==='completed'?'方法型 Skill 已保存到本地，可在任务详情查看并使用；未安装或执行脚本。':view.statusDetail;}
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_execution_notifications'").get()) {
    const notice = db.prepare('SELECT state,error FROM agent_execution_notifications WHERE task_id=?').get(id) as {state:string;error:string|null}|undefined;
    if (notice && ['failed','unknown'].includes(notice.state)) view.statusDetail += ` 结果通知${notice.state === 'unknown' ? '送达未知' : '失败'}：${notice.error ?? '请核对原渠道'}；未自动重复发送。`;
  }
  return view;
}

export function listAgentTasks(limit = 100): AgentTaskView[] {
  const rows = db.prepare('SELECT id FROM agent_tasks ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as { id: string }[];
  return rows.map((row) => getAgentTask(row.id)!);
}

export type CreateAgentTaskInput = {
  objective: string;
  projectId?: number;
  taskType?: AgentTaskType;
  /** 用户/模型指定的执行 Agent；明确指定时必须原样保留，服务端只做白名单校验，不改派。 */
  requestedExecutor?: string;
  requestedModel?: string;
  requestedCostPolicy?: ModelCostPolicy;
  source: 'feishu' | 'weixin' | 'workbench';
  sourceConversationId: string | null;
  sourceMessageId: string;
};

type AgentTaskRow = {
  id: string;
  status: string;
  task_type: string;
  executor: string | null;
  source: string;
  objective: string;
  requested_model: string | null;
  requested_cost_policy: ModelCostPolicy;
  observed_model: string | null;
};

function rowToView(row: AgentTaskRow, created: boolean): AgentTaskView {
  return {
    id: row.id,
    status: row.status,
    taskType: row.task_type as AgentTaskType,
    executor: row.executor,
    source: row.source,
    objective: row.objective,
    created,
    ...modelRequirement(row.requested_model, row.requested_cost_policy),
    observedModel: row.observed_model ?? null,
  };
}

/** YYYYMMDD-NNN：任务 id 标识一次交办，执行者/轮次是任务属性不进 id；历史 WB- 前缀保留原样并计入当日序号。 */
function nextTaskId(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  const row = db.prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE id LIKE ? OR id LIKE ?").get(`WB-${day}-%`, `${day}-%`) as { n: number };
  return `${day}-${String(row.n + 1).padStart(3, '0')}`;
}

/**
 * 幂等键：同一外部消息重复投递（webhook 重推、轮询重复入库、用户重发）+ 相同语义（类型/执行者/目标）
 * 命中唯一索引，只建一条任务。不同语义（改了 objective 或换了执行者）仍各自成任务。
 */
function intentKey(input: CreateAgentTaskInput, executor: string | null): string {
  const parts = [input.source, input.sourceMessageId, input.taskType ?? 'other', executor ?? '', input.objective];
  if (input.projectId != null) parts.push(`project:${input.projectId}`);
  if (input.requestedModel) parts.push(`model:${input.requestedModel}`);
  if (input.requestedCostPolicy === 'free_only') parts.push('cost:free_only');
  return createHash('sha1').update(parts.join('|'), 'utf8').digest('hex');
}

/**
 * 创建 drafted 任务（阶段 1 终点：只登记，绝不发送）。
 * 幂等命中时返回既有任务且 created=false，不更新任何字段。
 * 明确指定的执行者只做白名单校验：不在册/未启用直接抛错，由工具层把错误回给模型转述用户，
 * 绝不静默改派别的 Agent。
 */
export function createAgentTask(input: CreateAgentTaskInput): AgentTaskView {
  const objective = input.objective.trim();
  if (!objective) throw new Error('缺少任务目标 objective');
  if (objective.length > 2000) throw new Error('任务目标过长（最多 2000 字）');

  // S19：临时指定 > 长期偏好 > 默认；解析出的执行者仍走白名单校验，
  // 不支持/未启用在这里明确失败，绝不静默改派或换模型。
  const resolved = resolveExecutionPreference({
    executor: input.requestedExecutor, model: input.requestedModel, costPolicy: input.requestedCostPolicy,
  });
  let executor: string | null = null;
  if (resolved.executor) {
    const entry = isExecutorAllowed(resolved.executor);
    if (!entry) throw new Error(`未登记或未启用的 Agent：${resolved.executor}`);
    executor = entry.id; // 收敛为权威 id（"ZCode" → zcode），但不改变"用户指定了谁"
  }
  const taskType: AgentTaskType = input.taskType ?? 'other';
  const requirement = modelRequirement(resolved.requestedModel ?? undefined, resolved.requestedCostPolicy);
  const key = intentKey({ ...input, objective, ...requirement, requestedModel: requirement.requestedModel ?? undefined }, executor);

  const existing = db.prepare('SELECT * FROM agent_tasks WHERE intent_key = ?')
    .get(key) as AgentTaskRow | undefined;
  if (existing) return rowToView(existing, false);
  // 兼容旧幂等键，但只有模型与费用约束相同才复用，不吞掉用户的新选择。
  const legacyKey = intentKey({ ...input, objective, requestedModel: undefined, requestedCostPolicy: undefined }, executor);
  const legacy = db.prepare('SELECT * FROM agent_tasks WHERE intent_key = ?').get(legacyKey) as AgentTaskRow | undefined;
  if (legacy) {
    const previous = modelRequirement(legacy.requested_model, legacy.requested_cost_policy);
    if (previous.requestedModel === requirement.requestedModel && previous.requestedCostPolicy === requirement.requestedCostPolicy) return rowToView(legacy, false);
  }

  const id = nextTaskId();
  const ts = now();
  db.prepare(`
    INSERT INTO agent_tasks
      (id, source, source_conversation_id, source_message_id, task_type, objective,
       supervisor, executor, requested_model, requested_cost_policy, status, attempt, intent_key, created_at, updated_at, project_id)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'drafted', 1, ?, ?, ?, ?)
  `).run(id, input.source, input.sourceConversationId, input.sourceMessageId, taskType, objective,
    executor, requirement.requestedModel, requirement.requestedCostPolicy, key, ts, ts, input.projectId ?? null);
  return {
    id,
    status: 'drafted',
    taskType,
    executor,
    source: input.source,
    objective,
    created: true,
    ...requirement,
    observedModel: null,
  };
}
