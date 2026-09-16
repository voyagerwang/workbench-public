import { currentModelContext } from './model-call.js';
/**
 * [INPUT]: 可信入站会话、持久派发策略、Codex 项目白名单与固定本地内容转写器
 * [OUTPUT]: 新任务自动入队、原任务续办、后台执行与可核验成果读取
 * [POS]: 助手和执行生命周期之间的装配边界；策略不由模型自由提供，不扫描历史任务
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { realpathSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { db, dataDir, getSetting, setSetting, now } from '../db.js';
import { codexCliAdapter } from './codex-cli-adapter.js';
import { executionStore } from './agent-execution-store.js';
import { createAgentExecutionRuntime, type ExecutionPolicy } from './agent-execution.js';
import {createStageARuntime} from './agent-stage-a-runtime.js';
import {artifactNames} from './execution-snapshot.js';
import { getAgentTask, type AgentTaskView } from './agent-orchestrator.js';
import { isExecutorAllowed } from './agent-registry.js';
import type { InboundRequest } from './inbound-context.js';
import { createContentRuntime, transcribeLocal, videoSource, articleSkillSource, type ContentConfig } from './content-execution.js';
import { createContentTaskSkillDraft } from './skill-capture.js';
import { importUrlToArchive } from './knowledge-archive.js';
import { generateContentText } from './content-text.js';
import { wakeExecution, executionSettled, executionConcurrency } from './execution-signals.js';
import { readWeixinIdentity } from '../routes/clawbot.js';

export type AgentDispatchConfig = { enabled: boolean; paused: boolean; binary: string; model: string; reviewModel: string; proxyUrl?: string;
  stageA?:{enabled:boolean;owner:string;projectScope:string;projectPath?:string;accountScope:string;conversationId:string;nativeSession?:boolean;model?:string;reviewModel?:string;reasoningEffort?:'low'|'medium'|'high'};
  maxConcurrentJobs?:number; maxConcurrentContentJobs?:number; allowedFeishuConversations?: string[];
  projects: Array<{ name: string; path: string; aliases?: string[] }>; maxDailyJobs: number; deadlineMs: number; maxTokens: number };
export const dispatchConfig = (): AgentDispatchConfig | null => getSetting<AgentDispatchConfig>('agentExecution') ?? null;
export function executionPolicy(): ExecutionPolicy {
  const c = dispatchConfig();
  return { enabled: c?.enabled === true, paused: c?.paused !== false, isPrimary: (process.env.WORKBENCH_DEVICE_ROLE ?? 'primary') === 'primary',
    allowedProjects: (c?.projects ?? []).map((p) => realpathSync(p.path)), allowedExecutors: ['codex'],
    allowedModels: c ? [...new Set([c.model, c.reviewModel])] : [], executionModel: c?.model ?? '', reviewModel: c?.reviewModel ?? '',
    accountScope: 'local-codex-account', deadlineMs: c?.deadlineMs ?? 600000, maxOutputBytes: 100000,
    maxTokens: c?.maxTokens ?? 250000, maxDailyJobs: c?.maxDailyJobs ?? 10, maxConcurrentJobs: executionConcurrency(c?.maxConcurrentJobs) };
}
type StageBinding=NonNullable<AgentDispatchConfig['stageA']>;
const stageProject=(stage:StageBinding,c:AgentDispatchConfig)=>{
 const path=stage.projectPath??(c.projects.length===1?c.projects[0].path:'');
 if(!path)throw new Error('A阶段须绑定明确项目路径');
 const root=realpathSync(path);
 if(!c.projects.some(p=>realpathSync(p.path)===root))throw new Error('A阶段项目不在授权白名单');
 return root;
};
const stageKey=(stage:StageBinding,root:string)=>'stage-a:'+createHash('sha256').update(JSON.stringify([stage.owner,stage.projectScope,stage.accountScope,stage.conversationId,root])).digest('hex');
let runtime:ReturnType<typeof assembleDispatch>|null=null;
function assembleDispatch(){
 const base={db,artifactRoot:join(dataDir,'agent-results'),policy:executionPolicy,onSettled:executionSettled,
  adapter:(model:string)=>{const c=dispatchConfig()!;return codexCliAdapter({binary:c.binary,model,sandbox:'read-only',env:{...process.env,...(c.proxyUrl?{HTTPS_PROXY:c.proxyUrl,HTTP_PROXY:c.proxyUrl,ALL_PROXY:c.proxyUrl}:{})}});}};
 const legacy=createAgentExecutionRuntime({...base,runtimePartition:'legacy'});
 let stageRuntime:ReturnType<typeof createStageARuntime>|null=null,binding:StageBinding|null=null,partition='',root='',fingerprint='';
 const live=()=>{try{const c=dispatchConfig();return Boolean(c?.stageA?.enabled&&JSON.stringify(c.stageA)===fingerprint&&stageProject(c.stageA,c)===root);}catch{return false;}};
 function ensureStage(){
  const c=dispatchConfig(),stage=c?.stageA;
  if(stageRuntime||!c||!stage?.enabled)return;
  if(!stage.owner||!stage.projectScope||!stage.accountScope||!stage.conversationId)throw new Error('A阶段缺少明确身份、账号和会话绑定');
  root=stageProject(stage,c);binding=Object.freeze({...stage});fingerprint=JSON.stringify(stage);partition=stageKey(stage,root);
  const frozen=binding;
  const policy=()=>{const current=dispatchConfig()!,p=executionPolicy();const executionModel=frozen.model??p.executionModel,reviewModel=frozen.reviewModel??executionModel;
   return {...p,enabled:p.enabled&&live(),allowedProjects:[root],allowedModels:[...new Set([executionModel,reviewModel])],executionModel,reviewModel,accountScope:frozen.accountScope};};
  const adapter=(model:string,session?:Parameters<typeof codexCliAdapter>[0]['session'])=>{const current=dispatchConfig()!;return codexCliAdapter({binary:current.binary,model,reasoningEffort:frozen.reasoningEffort??'low',sandbox:'read-only',session,env:{...process.env,...(current.proxyUrl?{HTTPS_PROXY:current.proxyUrl,HTTP_PROXY:current.proxyUrl,ALL_PROXY:current.proxyUrl}:{})}});};
  stageRuntime=createStageARuntime({...base,policy,runtimePartition:partition,boundProjectPath:root,scope:{owner:frozen.owner,projectScope:frozen.projectScope},revisionSource:{source:'workbench',conversationId:frozen.conversationId},stageAEnabled:live,
   adapter:(model,role,task)=>{if(role==='execution'&&(task?.source!=='workbench'||task.source_conversation_id!==frozen.conversationId||realpathSync(task.project_path)!==root))throw new Error('任务来源或项目已偏离绑定');return adapter(model);},
   ...(frozen.nativeSession?{nativeSessionAdapter:(model:string,session:NonNullable<Parameters<typeof codexCliAdapter>[0]['session']>)=>adapter(model,session)}:{})});
 }
 function matching(id:string){const c=dispatchConfig();if(!c?.stageA?.enabled)return false;const task=db.prepare('SELECT source,source_conversation_id,project_path FROM agent_tasks WHERE id=?').get(id) as {source:string;source_conversation_id:string;project_path:string}|undefined;
  return Boolean(task&&task.source==='workbench'&&task.source_conversation_id===c.stageA.conversationId&&task.project_path&&realpathSync(task.project_path)===stageProject(c.stageA,c));}
 const storedPartition=(id:string)=>(db.prepare('SELECT runtime_partition FROM agent_execution_jobs WHERE task_id=?').get(id) as {runtime_partition:string}|undefined)?.runtime_partition;
 return {
  enqueue(id:string){const existing=storedPartition(id);if(existing){if(existing==='legacy')return legacy.get(id)!;ensureStage();if(existing!==partition||!live())throw new Error('原任务执行绑定未启用，不会改派');return stageRuntime!.get(id)!;}
   if(matching(id)){ensureStage();if(!live())throw new Error('执行绑定已变化，请核对并重启服务');return stageRuntime!.enqueue(id);}return legacy.enqueue(id);},
  get:legacy.get,
  async tick(){let stageError:unknown;try{ensureStage();}catch(e){stageError=e;}
   const [a,b]=await Promise.all([stageRuntime?.tick()??Promise.resolve(null),legacy.tick()]);
   return {status:stageError||a?.status==='paused'&&!b?'paused':'checked',stage:a,legacy:b,...(stageError?{error:(stageError as Error).message}:{})};},
  revise(input:Parameters<ReturnType<typeof createStageARuntime>['revise']>[0]){ensureStage();if(!stageRuntime||!live()||storedPartition(input.taskId)!==partition)throw new Error('原任务不属于已启用执行绑定');return stageRuntime.revise(input);},
  canManage(id:string){try{ensureStage();return Boolean(stageRuntime&&live()&&storedPartition(id)===partition&&matching(id));}catch{return false;}},
  recoverInterrupted(){try{ensureStage();}catch{/* Invalid binding cannot take over legacy jobs. */}
   let count=legacy.recoverInterrupted();if(stageRuntime&&live())count+=stageRuntime.recoverInterrupted();
   // Unconfigured partitions have no live owner after restart. Quarantine unknown work instead of rerunning it or occupying capacity forever.
   const rows=db.prepare("SELECT task_id,state FROM agent_execution_jobs WHERE state IN ('executing','pending_review') AND runtime_partition!='legacy' AND runtime_partition!=?").all(stageRuntime&&live()?partition:'') as {task_id:string;state:string}[];
   for(const row of rows){if(executionStore(db).transition(row.task_id,row.state,'needs_human','服务重启时原执行绑定未启用；保留成果，禁止改派或自动重跑'))count++;}return count;},
  stop(){legacy.stop();stageRuntime?.stop();}
 };
}
export function dispatchRuntime(){return runtime??=assembleDispatch();}
export function reviseDispatchedTask(input:{taskId:string;expectedAttempt:number;requestId:string;feedback:string;conversationId:string}){
  const stage=dispatchConfig()?.stageA;
  if(!stage?.enabled||input.conversationId!==stage.conversationId)throw new Error('A阶段未启用或来源会话不匹配');
  const r=dispatchRuntime();if(!('revise' in r))throw new Error('当前进程未装配 A 阶段');
  return r.revise(input);
}
export function agentTaskActions(id:string){
  const c=dispatchConfig(),stage=c?.stageA;
  const task=db.prepare('SELECT source,source_conversation_id,attempt,project_path FROM agent_tasks WHERE id=?').get(id) as {source:string;source_conversation_id:string;attempt:number;project_path:string}|undefined;
  if(!task)return null;
  const unavailable={attempt:task.attempt,conversationId:null,canRevise:false,canRetryNotification:false,notificationState:null};
  if(!stage?.enabled||!c?.enabled||c.paused||task.source!=='workbench'||task.source_conversation_id!==stage.conversationId||(process.env.WORKBENCH_DEVICE_ROLE??'primary')!=='primary')return unavailable;
  if(!dispatchRuntime().canManage(id))return unavailable;
  const job=dispatchRuntime().get(id);
  const notice=db.prepare('SELECT state FROM agent_execution_notifications WHERE task_id=?').get(id) as {state:string}|undefined;
  let rejected=false;try{rejected=JSON.parse(job?.review_json??'null')?.verdict==='rejected';}catch{}
  return {attempt:task.attempt,conversationId:stage.conversationId,canRevise:Boolean(job?.review_json&&(job.state==='completed'||job.state==='needs_human'&&rejected)&&!['sending','unknown'].includes(notice?.state??'')),canRetryNotification:notice?.state==='failed',notificationState:notice?.state??null};
}
export function setDispatchPaused(paused: boolean) {
  const c = dispatchConfig(); if (!c) throw new Error('执行尚未配置');
  setSetting('agentExecution', { ...c, paused }); if(!paused)wakeExecution(); return { paused };
}

let content: ReturnType<typeof createContentRuntime> | null = null;
export function contentRuntime() {
  return content ??= createContentRuntime({ db, root: join(dataDir, 'content-results'),
    enabled: () => getSetting<ContentConfig>('contentExecution')?.enabled === true && dispatchConfig()?.paused === false && (process.env.WORKBENCH_DEVICE_ROLE ?? 'primary') === 'primary',
    transcribe: (url, dir) => { const config=getSetting<ContentConfig>('contentExecution'); if(!config?.enabled)throw new Error('本地转写器未配置');return transcribeLocal(config,url,dir); },
    readArticle:async(url)=>{const archive=await importUrlToArchive(url);if(!archive||archive.status!=='indexed'||!archive.content.trim())throw new Error('文章正文不可用，请先在知识库处理来源');return {title:archive.title,content:archive.content};},
    onSkillCandidate: createContentTaskSkillDraft,
    maxConcurrentJobs:()=>executionConcurrency(dispatchConfig()?.maxConcurrentContentJobs),onSettled:executionSettled,
    summarize: generateContentText });
}

/** 路径只来自管理员白名单；意图最多匹配名称，不能提供任意目录。 */
export function prepareAgentDispatch(id: string, contentOptions?: { noteId?: number }): AgentTaskView {
  const task = getAgentTask(id); if (!task) throw new Error('任务不存在');
  if (task.status !== 'drafted') return task;
  const config = dispatchConfig();
  if (!config?.enabled) return task;
  try {
    const origin = db.prepare('SELECT source_conversation_id FROM agent_tasks WHERE id=?').get(id) as { source_conversation_id: string | null };
    if (!origin.source_conversation_id) throw new Error('缺少可信来源会话，未启动任务；请在已绑定会话中重新关联此任务');
    if (task.source === 'weixin' && readWeixinIdentity()?.target !== origin.source_conversation_id) throw new Error('该微信会话不是本机唯一绑定用户，未启动任务');
    if (task.source === 'feishu' && !config.allowedFeishuConversations?.includes(origin.source_conversation_id)) throw new Error('该飞书会话尚未获得自动执行授权，未启动任务');
    if (videoSource(task.objective)||articleSkillSource(task.objective)) {
      if (!getSetting<ContentConfig>('contentExecution')?.enabled) throw new Error('本地视频转写器尚未配置，未写入随手记');
      contentRuntime().enqueue(id, contentOptions); wakeExecution(); return getAgentTask(id)!;
    }
    if (task.executor && task.executor !== 'codex') throw new Error(`${task.executor} 的正式执行通道尚未接通；没有改派给其他 Agent`);
    const matches = config.projects.filter((p) => task.projectPath ? realpathSync(p.path) === task.projectPath
      : [p.name, ...(p.aliases ?? [])].some((name) => name.length > 1 && task.objective.toLowerCase().includes(name.toLowerCase())));
    if (matches.length !== 1) throw new Error('需要明确一个已授权项目；当前没有唯一匹配的执行目录');
    db.prepare("UPDATE agent_tasks SET project_path=?,executor=COALESCE(executor,'codex'),supervisor='codex' WHERE id=? AND status='drafted'")
      .run(realpathSync(matches[0].path), id);
    dispatchRuntime().enqueue(id); wakeExecution();
  } catch (cause) {
    db.prepare("UPDATE agent_tasks SET last_error=?,updated_at=? WHERE id=? AND status='drafted'").run((cause as Error).message, now(), id);
  }
  return getAgentTask(id)!;
}

/** 纯续办命令在模型前处理，严格按可信会话选最近一条；不会创建新任务或重试终态。 */
export function continueAgentDispatch(text: string, inbound: InboundRequest): AgentTaskView | null | 'missing' {
  const normalized = text.trim().replace(/[，,。！!\s]/g, '');
  if (!/^(?:(?:好的|好|那就))?(?:直接派发(?:就行)?|确认派发|开始派发|继续执行|继续这个任务|继续上一条任务|继续|确认)(?:不用(?:再)?(?:跟我)?确认)?$/.test(normalized)) return null;
  return continueAgentTask(inbound);
}
/** 模型识别出的续办意图也必须引用原任务，不能通过改写目标新建任务。 */
export function continueAgentTask(inbound: InboundRequest, id?: string): AgentTaskView | 'missing' {
  if (!inbound.sourceConversationId) return 'missing';
  const sessionId = currentModelContext().sessionId;
  if (!id && sessionId) {
    const segment = db.prepare('SELECT start_message_id FROM assistant_context_segments WHERE session_id=?').get(sessionId) as {start_message_id:number}|undefined;
    if (segment) {
      const rows = db.prepare('SELECT agent_task_ids_json FROM assistant_messages WHERE session_id=? AND id>=? AND role=? ORDER BY id DESC').all(sessionId,segment.start_message_id,'assistant') as Array<{agent_task_ids_json:string|null}>;
      const ids = rows.flatMap(r => { try {return JSON.parse(r.agent_task_ids_json ?? '[]') as string[];} catch {return [];} });
      if (!ids.length) return 'missing';
      id = ids[0];
    }
  }
  const row = (id ? db.prepare('SELECT id FROM agent_tasks WHERE source=? AND source_conversation_id=? AND id=?')
    .get(inbound.source, inbound.sourceConversationId, id)
    : db.prepare('SELECT id FROM agent_tasks WHERE source=? AND source_conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1')
      .get(inbound.source, inbound.sourceConversationId)) as { id: string } | undefined;
  return row ? prepareAgentDispatch(row.id) : 'missing';
}

/**
 * 阶段②包2：整任务换执行器续办（愿景附录 D 边界）。同一任务编号 attempt+1，
 * 内容任务复用同一 job 行与同一笔记（成果原位交接）；执行中的任务拒换（等本轮结束或失败）；
 * 项目类任务当前仅 Codex 可执行，不支持换派。迟到回执防护沿用 execution 域既有快照比对。
 */
export function switchContentExecutor(inbound: InboundRequest, rawExecutor: string, id?: string, reason?: string): AgentTaskView {
  const entry = isExecutorAllowed(rawExecutor);
  if (!entry) throw new Error(`${rawExecutor} 未登记或未启用，不能接手`);
  if (!inbound.sourceConversationId) throw new Error('换执行者需要在已绑定的可信会话中操作');
  let taskId = id?.trim();
  if (!taskId) {
    const row = db.prepare('SELECT id FROM agent_tasks WHERE source=? AND source_conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1')
      .get(inbound.source, inbound.sourceConversationId) as { id: string } | undefined;
    if (!row) throw new Error('当前会话没有可换手的任务，请提供任务编号');
    taskId = row.id;
  }
  const task = getAgentTask(taskId);
  if (!task) throw new Error('任务不存在');
  const raw = db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(taskId) as { source: string; source_conversation_id: string | null; executor: string | null; status: string; objective: string; attempt: number | null } | undefined;
  if (!raw) throw new Error('任务不存在');
  if (raw.source !== inbound.source || raw.source_conversation_id !== inbound.sourceConversationId) throw new Error('该任务不属于当前会话，不能在此换手');
  if (raw.executor === entry.id) throw new Error(`${entry.displayName} 已经在负责这个任务`);
  if (!videoSource(raw.objective) && !articleSkillSource(raw.objective)) throw new Error('项目类任务当前仅 Codex 可执行；视频/文章总结任务才支持换执行者');
  if (!['drafted', 'ready_to_dispatch', 'needs_human', 'completed'].includes(raw.status)) throw new Error('任务正在执行中，等本轮结束或失败后再换执行者');
  const attempt = (raw.attempt ?? 1) + 1;
  const updated = db.prepare("UPDATE agent_tasks SET executor=?,attempt=?,status='ready_to_dispatch',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('drafted','ready_to_dispatch','needs_human','completed')").run(entry.id, attempt, task.id);
  if (!updated.changes) throw new Error('任务状态已变化，未换手；请刷新后重试');
  const rawRow = db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(task.id) as Record<string, unknown>;
  const url = videoSource(raw.objective) || articleSkillSource(raw.objective);
  const contentKind = articleSkillSource(raw.objective) ? 'article' : 'video';
  const job = db.prepare('SELECT note_id FROM content_execution_jobs WHERE task_id=?').get(task.id) as { note_id: number | null } | undefined;
  let noteId = job?.note_id ?? null; let noteContent: string | null = null; let noteTitle: string | null = null;
  if (noteId) {
    const note = db.prepare('SELECT content,title FROM notes WHERE id=? AND deleted_at IS NULL').get(noteId) as { content: string; title: string } | undefined;
    if (note) { noteContent = note.content; noteTitle = note.title; } else noteId = null;
  }
  const snapshot = JSON.stringify({ ...rawRow, url, contentKind, saveNote: true, noteTitle });
  if (job) {
    db.prepare("UPDATE content_execution_jobs SET state='ready_to_dispatch',snapshot_json=?,note_id=?,note_content=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE task_id=?").run(snapshot, noteId, noteContent, task.id);
  } else {
    db.prepare("INSERT INTO content_execution_jobs(task_id,state,snapshot_json) VALUES(?,'ready_to_dispatch',?)").run(task.id, snapshot);
  }
  db.prepare('INSERT INTO agent_execution_events(task_id,kind,detail,created_at) VALUES(?,?,?,?)')
    .run(task.id, 'switch_executor', JSON.stringify({ from: task.executor ?? null, to: entry.id, attempt, reason: reason ?? null }), new Date().toISOString());
  wakeExecution();
  return getAgentTask(task.id)!;
}
export function agentResult(id: string) {
  const contentJob = db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_execution_jobs'").get() ? db.prepare('SELECT artifact_path,artifact_hash,state,note_id FROM content_execution_jobs WHERE task_id=?').get(id) as {artifact_path:string;artifact_hash:string;state:string;note_id:number}|undefined : undefined;
  if (contentJob?.artifact_path && ['completed','needs_human'].includes(contentJob.state)) {
    try {
      const expected=join(realpathSync(join(dataDir,'content-results')),createHash('sha256').update(id).digest('hex'),'result.md');
      if(contentJob.artifact_path!==expected||lstatSync(expected).isSymbolicLink()||lstatSync(expected).size>1500000)return null;
      const value=readFileSync(expected,'utf8');if(createHash('sha256').update(value).digest('hex')!==contentJob.artifact_hash)return null;
      return {content:value,path:expected,reviewed:false,review:null,noteId:contentJob.note_id};
    }catch{return null;}
  }
  const job = dispatchRuntime().get(id);
  if (!job?.artifact_path || !job.artifact_hash) return null;
  try {
  const expected = join(realpathSync(join(dataDir, 'agent-results')), createHash('sha256').update(id).digest('hex'), artifactNames(JSON.parse(job.snapshot_json).attempt??1).result);
  if (job.artifact_path !== expected) return null;
    const stat = lstatSync(expected); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100000) return null;
    const content = readFileSync(expected, 'utf8');
    if (createHash('sha256').update(content).digest('hex') !== job.artifact_hash) return null;
    return { content, path: expected, reviewed: job.state === 'completed', review: job.review_json ? JSON.parse(job.review_json) : null };
  } catch { return null; }
}
