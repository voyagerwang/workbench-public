/**
 * [INPUT]: 单 owner/project 授权、既有执行策略和固定执行器
 * [OUTPUT]: 执行到延后验收的可选完整装配；空队列不调用模型
 * [POS]: A 阶段装配工厂，默认关闭，尚未替换生产 dispatchRuntime
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import {dirname} from 'node:path';
import {realpathSync} from 'node:fs';
import {createAgentExecutionRuntime} from './agent-execution.js';
import {createReviewQueue,type Scope} from './agent-review-queue.js';
import {createReviewHandoff} from './agent-review-handoff.js';
import {createDeferredReviewRuntime} from './agent-review-runtime.js';
import {executorReviewer} from './agent-review-adapter.js';
import {selectTaskModel,modelRequirement} from './agent-model-policy.js';
import {executionStore} from './agent-execution-store.js';
import {evidenceCollector} from './agent-review-evidence.js';
import {taskRevisionService} from './agent-task-revision.js';
import {executionSnapshot} from './execution-snapshot.js';
import {providerSessionRegistry} from './agent-provider-session.js';
import type {CodexSessionOption} from './codex-cli-adapter.js';
type Base=Parameters<typeof createAgentExecutionRuntime>[0];
export function createStageARuntime(config:Omit<Base,'handoffReview'|'canResumeReview'> & {scope:Scope;boundProjectPath?:string;stageAEnabled?:()=>boolean;reviewEvidencePaths?:readonly string[];revisionSource?:{source:string;conversationId:string};nativeSessionAdapter?:(model:string,session:CodexSessionOption)=>ReturnType<Base['adapter']>}){
 let stopped=false,busy=false;
 const scope=Object.freeze({...config.scope});
 const evidencePaths=config.reviewEvidencePaths?[...config.reviewEvidencePaths]:undefined;
 const reviewInterrupts=new Set<()=>void>();
 const sessions=new Map<string,{account:string;root:string;attempt:number;record:ReturnType<typeof providerSessionRegistry>['record'];id?:string}>();
 function gate(){
  const p=config.policy();
  if(stopped||config.stageAEnabled?.()!==true||!p.enabled||p.paused||!p.isPrimary)throw new Error('A阶段已暂停或未启用');
  if(!scope.owner||!scope.projectScope||p.allowedProjects.length!==1||(config.boundProjectPath&&realpathSync(config.boundProjectPath)!==realpathSync(p.allowedProjects[0])))throw new Error('A阶段需要单个已授权真实项目');
  if(!p.allowedModels.includes(p.reviewModel))throw new Error('验收模型未授权');
  return {...p,allowedProjects:[...p.allowedProjects],allowedExecutors:[...p.allowedExecutors],allowedModels:[...p.allowedModels]};
 }
 const enabled=()=>{try{gate();return true;}catch{return false;}};
 const queue=createReviewQueue(config.db),bridge=createReviewHandoff({db:config.db,scope,reviewer:'codex',enabled});
 const execution=createAgentExecutionRuntime({...config,onSettled:()=>{},policy:()=>({...config.policy(),enabled:enabled()}),
  adapter:(model,role,task)=>{
   if(role==='execution'&&config.revisionSource&&(task?.source!==config.revisionSource.source||task.source_conversation_id!==config.revisionSource.conversationId))throw new Error('任务来源不属于绑定会话');
   if(!config.nativeSessionAdapter||role!=='execution')return config.adapter(model,role,task);
   if(!task||task.executor!=='codex')throw new Error('原生会话仅支持明确的 Codex 任务');
   const p=gate(),root=realpathSync(task.project_path),attempt=task.attempt??1;
   const registry=providerSessionRegistry({db:config.db,scope,projectRoot:root,accountScope:p.accountScope,provider:'codex-cli',role:'execution'});
   const option:CodexSessionOption=attempt===1?{mode:'create',projectRoot:root}:{mode:'resume',projectRoot:root,id:registry.previous(task.id,attempt).session_id};
   const adapter=config.nativeSessionAdapter(model,option);
   if(!adapter.capabilities.resume)throw new Error('执行器未支持原生续接');
   const binding={account:p.accountScope,root,attempt,record:registry.record,id:option.mode==='resume'?option.id:undefined};
   sessions.set(task.id,binding);
   return adapter;
  },
  handoffReview:p=>{
   gate();const task=config.db.prepare('SELECT attempt FROM agent_tasks WHERE id=?').get(p.taskId) as {attempt:number};
   queue.registerAttempt({taskId:p.taskId,attempt:task.attempt,...scope,boundDir:realpathSync(dirname(p.artifactPath))});
   if(config.nativeSessionAdapter){
    const binding=sessions.get(p.taskId),policy=gate();
    if(!binding||binding.attempt!==task.attempt||binding.account!==policy.accountScope||binding.root!==realpathSync(policy.allowedProjects[0]))throw new Error('执行期间会话身份已改变');
    const events=(config.db.prepare("SELECT detail FROM agent_execution_events WHERE task_id=? AND kind='execution'").all(p.taskId) as {detail:string}[]).map(r=>JSON.parse(r.detail));
    const ids=[...new Set(events.filter(e=>e.attempt===task.attempt&&e.type==='accepted').map(e=>e.sessionId))];
    if(ids.length!==1||typeof ids[0]!=='string'||(binding.id&&binding.id!==ids[0]))throw new Error('缺少唯一且匹配的会话回执');
    binding.record({taskId:p.taskId,attempt:task.attempt,sessionId:ids[0]});
   }
   bridge.deliver({...p,attempt:task.attempt,eventId:`delivery:${p.taskId}:${task.attempt}:${p.artifactHash}`});
  },canResumeReview:bridge.canResume});
 const revisions=config.revisionSource?taskRevisionService({db:config.db,scope,...config.revisionSource,enabled}):null;
 async function tick(){
  if(busy)return {status:'busy'};if(!enabled())return {status:'paused'};busy=true;
  let shouldNotify=false,settledTaskId:string|undefined;
  try{
   const executionResult=await execution.tick();
   shouldNotify=Boolean(executionResult);settledTaskId=executionResult?.task_id;
   if(!enabled())return {status:'paused'};
   const p=gate();
   const reviewer=createDeferredReviewRuntime({db:config.db,bridge,maxTokens:p.maxTokens,timeoutMs:Math.min(p.deadlineMs,90000),
    review:async input=>{
     const current=gate(),root=realpathSync(current.allowedProjects[0]),model=current.reviewModel;
     const base=config.adapter(model,'review');
     const adapter={...base,start:(args:Parameters<typeof base.start>[0])=>{
      const handle=base.start(args);reviewInterrupts.add(handle.interrupt);
      const monitor=setInterval(()=>{if(!enabled())handle.interrupt();},250);
      return {...handle,completion:handle.completion.finally(()=>{clearInterval(monitor);reviewInterrupts.delete(handle.interrupt);})};
     }};
     return executorReviewer({adapter,model,projectRoot:root,executionEvidence:()=>({sandbox:'read-only',executionReachedPendingReview:true,events:(config.db.prepare("SELECT kind,detail FROM agent_execution_events WHERE task_id=? AND kind IN ('execution','execution_result') ORDER BY id").all(input.taskId) as {kind:string;detail:string}[]).map(row=>({kind:row.kind,...JSON.parse(row.detail)})).filter(row=>(row.attempt??1)===(input.task.attempt??1))}),collectEvidence:evidencePaths?evidenceCollector({projectRoot:root,paths:evidencePaths}):undefined,onEvidence:(phase,evidence)=>{
      const claim=input.reviewClaim;if(!claim)throw new Error('缺少证据审计绑定');
      const entry=queue.getQueueEntry(claim.id);
      if(!entry||entry.task_id!==input.taskId||entry.claim_token!==claim.token||entry.status!=='claimed')throw new Error('证据审计领取已失效');
      config.db.prepare('INSERT INTO agent_review_events(queue_id,action,actor,token,detail_json,created_at) VALUES(?,?,?,?,?,?)')
       .run(claim.id,`source_evidence_${phase}`,'codex',claim.token,JSON.stringify(evidence),new Date().toISOString());
     },authorize:async()=>{
      gate();if(typeof input.task.executor!=='string'||!current.allowedExecutors.includes(input.task.executor))throw new Error('执行者授权已失效');
      const requirement=modelRequirement(model,input.task.requested_cost_policy);
      if(config.catalog){const chosen=selectTaskModel(requirement,await config.catalog(),{executor:input.task.executor,accountScope:current.accountScope});if(chosen.modelId!==model)throw new Error('验收模型目录不匹配');}
      else if(requirement.requestedCostPolicy==='free_only')throw new Error('缺少当前免费档位证据');
      const latest=gate();if(latest.reviewModel!==model||realpathSync(latest.allowedProjects[0])!==root
       ||latest.accountScope!==current.accountScope||!latest.allowedExecutors.includes(input.task.executor)||latest.maxTokens!==current.maxTokens)throw new Error('验收授权已变更');
     }})(input);
    }});
   const reviewResult=await reviewer.tick();
   if(executionResult||!('status' in reviewResult)||reviewResult.status!=='idle'){
     const result=reviewResult as {task_id?:string;id?:number};
     settledTaskId=result.task_id??(result.id?queue.getQueueEntry(result.id)?.task_id:undefined)??settledTaskId;shouldNotify=true;
   }
   return {status:'checked',execution:executionResult,review:reviewResult};
  }finally{
   sessions.clear();
   busy=false; // Release before an onSettled callback immediately wakes the next job.
   if(shouldNotify){try{config.onSettled?.();}catch{if(settledTaskId)executionStore(config.db).event(settledTaskId,'notification_wake_failed',{reason:'callback_failed'});}}
  }
 }
 return {tick,enqueue:(id:string)=>{gate();return execution.enqueue(id);},get:execution.get,
  revise:(request:Parameters<ReturnType<typeof taskRevisionService>['revise']>[0])=>{
   const p=gate();if(!revisions)throw new Error('未配置可信修改来源');
   const snapshot=executionSnapshot(config.db,request.taskId);
   if(realpathSync(snapshot.project_path)!==realpathSync(p.allowedProjects[0])||!p.allowedExecutors.includes(snapshot.executor))throw new Error('任务不属于当前执行授权');
   const result=revisions.revise(request);
   try{config.onSettled?.();}catch{executionStore(config.db).event(request.taskId,'revision_wake_failed',{reason:'callback_failed'});}
   return result;
  },
  recoverInterrupted:execution.recoverInterrupted,stop:()=>{stopped=true;execution.stop();for(const interrupt of reviewInterrupts)interrupt();}};
}
