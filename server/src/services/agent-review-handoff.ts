/**
 * [INPUT]: 显式启用策略、可信任务绑定与独立验收 JSON
 * [OUTPUT]: 回执登记和验收队列/业务任务的原子提交
 * [POS]: 可选延后验收桥接；未装配到生产入口，不调用模型
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {realpathSync,openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import {relative,isAbsolute} from 'node:path';
import {createReviewQueue,type Scope,type ReviewEntry} from './agent-review-queue.js';
import {reviewService} from './agent-review-service.js';
import {executionStore} from './agent-execution-store.js';
import {executionSnapshot} from './execution-snapshot.js';
export type HandoffVerdict={verdict:'approved'|'rejected';taskId:string;taskHash:string;artifactHash:string;reason:string};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function createReviewHandoff(config:{db:Database.Database;scope:Scope;reviewer:string;enabled?:()=>boolean}){
 const {db,reviewer}=config;const scope=Object.freeze({...config.scope});
 const queue=createReviewQueue(db),service=reviewService(db,{scope,reviewer}),store=executionStore(db);
 function gate(){if(config.enabled?.()!==true)throw new Error('延后验收未启用');}
 function check(taskId:string,attempt:number){
  const binding=queue.getAttempt(taskId,attempt);
  if(!binding||binding.owner!==scope.owner||binding.project_scope!==scope.projectScope)throw new Error('身份或项目绑定不匹配');
  const task=db.prepare('SELECT attempt,status FROM agent_tasks WHERE id=?').get(taskId) as {attempt:number;status:string}|undefined;
  const job=store.get(taskId);
  if(!task||!job||task.attempt!==attempt||task.status!==job.state||job.state!=='pending_review')throw new Error('任务不处于当前轮次待验收状态');
  const snapshot=executionSnapshot(db,taskId);
  if(hash(JSON.stringify(snapshot))!==job.task_hash)throw new Error('任务输入已变更');
  return {binding,job};
 }
 function artifact(path:string,root:string|null,expected:string){
  if(!root)throw new Error('缺少成果目录绑定');
  const resolved=realpathSync(path),rel=relative(realpathSync(root),resolved);
  if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new Error('成果目录越界');
  const fd=openSync(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   if(!fstatSync(fd).isFile())throw new Error('成果类型无效');
   const bytes=Buffer.alloc(1024*1024+1);let size=0;
   while(size<bytes.length){const n=readSync(fd,bytes,size,bytes.length-size,null);if(!n)break;size+=n;}
   if(size===bytes.length)throw new Error('成果超过大小限制');
   if(createHash('sha256').update(bytes.subarray(0,size)).digest('hex')!==expected)throw new Error('成果已变化');
   return bytes.subarray(0,size).toString('utf8');
  }finally{closeSync(fd);}
 }
 const deliver=db.transaction((p:{taskId:string;attempt:number;eventId:string;artifactPath:string;artifactHash:string})=>{
  gate();const {binding,job}=check(p.taskId,p.attempt);
  if(job.artifact_path!==p.artifactPath||job.artifact_hash!==p.artifactHash)throw new Error('交付与执行台账不一致');
  artifact(p.artifactPath,binding.bound_dir,p.artifactHash);
  return service.receive({...scope,taskId:p.taskId,attempt:p.attempt,eventId:p.eventId,kind:'completion',resultPath:p.artifactPath,resultHash:p.artifactHash});
 });
 const complete=db.transaction((p:{id:number;token:string;verdict:HandoffVerdict})=>{
  gate();const entry=queue.getQueueEntry(p.id);if(!entry)throw new Error('未知验收条目');
  const {binding,job}=check(entry.task_id,entry.attempt),v=p.verdict;
  if(!v||Object.keys(v).sort().join(',')!=='artifactHash,reason,taskHash,taskId,verdict'||!['approved','rejected'].includes(v.verdict)
    ||v.taskId!==entry.task_id||v.taskHash!==job.task_hash||v.artifactHash!==entry.result_hash||typeof v.reason!=='string'||!v.reason.trim()||Buffer.byteLength(v.reason)>8192)throw new Error('验收证据结构或指纹不匹配');
  if(!entry.result_path||!entry.result_hash||job.artifact_hash!==entry.result_hash||job.artifact_path!==entry.result_path)throw new Error('交付指纹漂移');
  artifact(entry.result_path,binding.bound_dir,entry.result_hash);
  service.resolve({id:p.id,token:p.token,resultHash:entry.result_hash,outcome:v.verdict==='approved'?'confirmed':'rejected'});
  if(!store.transition(entry.task_id,'pending_review',v.verdict==='approved'?'completed':'needs_human',v.verdict==='approved'?null:v.reason,{reviewJson:JSON.stringify(v)}))throw new Error('任务状态提交冲突');
  return store.get(entry.task_id)!;
 });
 function canResume(taskId:string){
  try{
   gate();const task=db.prepare('SELECT attempt FROM agent_tasks WHERE id=?').get(taskId) as {attempt:number}|undefined;if(!task)return false;
   const {binding,job}=check(taskId,task.attempt);
   const rows=db.prepare(`SELECT q.* FROM agent_review_queue q
    JOIN agent_execution_receipts r ON r.event_id=q.receipt_event_id
    LEFT JOIN agent_review_budget b ON b.queue_id=q.id
    WHERE q.task_id=? AND q.attempt=? AND q.owner=? AND q.project_scope=?
    AND q.status IN ('pending','claimed') AND r.kind='completion'
    AND COALESCE(b.blocked,0)=0 AND COALESCE(b.attempts,0)<3`).all(taskId,task.attempt,scope.owner,scope.projectScope) as ReviewEntry[];
   if(rows.length!==1)return false;
   const entry=rows[0];if(!entry.result_path||!entry.result_hash||entry.result_path!==job.artifact_path||entry.result_hash!==job.artifact_hash)return false;
   if(db.prepare("SELECT 1 FROM agent_review_calls WHERE queue_id=? AND state!='finished'").get(entry.id))return false;
   artifact(entry.result_path,binding.bound_dir,entry.result_hash);return true;
  }catch{return false;}
 }
 return {deliver:(p:Parameters<typeof deliver>[0])=>deliver.immediate(p),complete:(p:Parameters<typeof complete>[0])=>complete.immediate(p),canResume,
  input:(id:number)=>{gate();const entry=queue.getQueueEntry(id);if(!entry)throw new Error('未知验收条目');const {binding,job}=check(entry.task_id,entry.attempt);
   if(!entry.result_path||!entry.result_hash||entry.result_path!==job.artifact_path||entry.result_hash!==job.artifact_hash)throw new Error('成果不匹配');
   return {taskId:entry.task_id,taskHash:job.task_hash,artifactHash:entry.result_hash,task:JSON.parse(job.snapshot_json) as Record<string,unknown>,artifact:artifact(entry.result_path,binding.bound_dir,entry.result_hash)};},
  fail:(p:{id:number;token:string;code:string;terminal?:boolean})=>db.transaction(()=>{
   const entry=queue.getQueueEntry(p.id);
   if(!entry||entry.owner!==scope.owner||entry.project_scope!==scope.projectScope||entry.claim_token!==p.token||entry.claim_owner!==reviewer)throw new Error('失败回执绑定不匹配');
   let result;
   try{result=service.fail(p);}catch(error){
    const task=db.prepare('SELECT attempt,status FROM agent_tasks WHERE id=?').get(entry.task_id) as {attempt:number;status:string}|undefined;
    if(task?.attempt===entry.attempt&&task.status==='pending_review')throw error;
    db.prepare('UPDATE agent_review_budget SET blocked=1,reason=? WHERE queue_id=?').run('task_changed',p.id);
    if(task?.attempt===entry.attempt)store.quarantine(entry.task_id,'验收期间任务已变更，保留用户状态');
    return {status:'needs_human',id:p.id,code:'task_changed'};
   }
   if(result.status==='needs_human'){const entry=queue.getQueueEntry(p.id)!;store.transition(entry.task_id,'pending_review','needs_human',p.code);}
   return result;
  }).immediate(),
  claim:()=>{gate();return service.claim();}};
}
