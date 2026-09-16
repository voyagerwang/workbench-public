/**
 * [INPUT]: 可信身份/来源会话和明确修改请求
 * [OUTPUT]: 同任务新轮次、不可变旧版本记录和幂等请求，不启动模型
 * [POS]: 默认未装配的A04修改事务；未知调用/发送不自动重跑
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createReviewQueue,type Scope} from './agent-review-queue.js';
import {executionStore} from './agent-execution-store.js';
import {executionSnapshot} from './execution-snapshot.js';
const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8').split('-- BEGIN AGENT REVISION SCHEMA')[1]?.split('-- END AGENT REVISION SCHEMA')[0];
if(!schema)throw new Error('缺少修改历史表结构');
type Request={taskId:string;expectedAttempt:number;requestId:string;feedback:string};
export function taskRevisionService(config:{db:Database.Database;scope:Scope;source:string;conversationId:string;enabled?:()=>boolean}){
 const {db}=config,identity=Object.freeze({...config.scope,source:config.source,conversationId:config.conversationId});
 db.exec(schema);const queue=createReviewQueue(db),store=executionStore(db);
 const revise=db.transaction((p:Request)=>{
  if(config.enabled?.()!==true)throw new Error('任务修改未启用');
  if(!identity.owner||!identity.projectScope||!identity.source||!identity.conversationId)throw new Error('缺少可信身份');
  if(!p.requestId||Buffer.byteLength(p.requestId)>200||!p.feedback?.trim()||Buffer.byteLength(p.feedback)>2000||!Number.isSafeInteger(p.expectedAttempt)||p.expectedAttempt<1)throw new Error('无效修改请求');
  const task=db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(p.taskId) as Record<string,unknown>|undefined;
  if(!task||task.source!==identity.source||task.source_conversation_id!==identity.conversationId)throw new Error('来源会话不匹配');
  const binding=queue.getAttempt(p.taskId,p.expectedAttempt);
  if(!binding||binding.owner!==identity.owner||binding.project_scope!==identity.projectScope)throw new Error('任务归属不匹配');
  const fingerprint=createHash('sha256').update(JSON.stringify({taskId:p.taskId,expectedAttempt:p.expectedAttempt,requestId:p.requestId,feedback:p.feedback})).digest('hex');
  const existing=db.prepare('SELECT * FROM agent_task_revisions WHERE owner=? AND project_scope=? AND request_id=?').get(identity.owner,identity.projectScope,p.requestId) as {task_id:string;to_attempt:number;request_hash:string}|undefined;
  if(existing){if(existing.request_hash!==fingerprint)throw new Error('修改请求编号冲突');return {taskId:existing.task_id,attempt:existing.to_attempt,duplicate:true};}
  const job=store.get(p.taskId);
  if(task.attempt!==p.expectedAttempt||!job||job.state!==task.status)throw new Error('任务轮次或状态已变化');
  const priorReview=job.review_json?JSON.parse(job.review_json):null;
  if(!(job.state==='completed'||(job.state==='needs_human'&&priorReview?.verdict==='rejected')))throw new Error('仅明确完成或明确验收拒绝的任务可修改');
  if(!priorReview||priorReview.taskId!==p.taskId||priorReview.taskHash!==job.task_hash||priorReview.artifactHash!==job.artifact_hash||!['approved','rejected'].includes(priorReview.verdict))throw new Error('旧验收证据不完整');
  const executions=db.prepare("SELECT detail FROM agent_execution_events WHERE task_id=? AND kind='execution_result'").all(p.taskId) as {detail:string}[];
  if(!executions.length||executions.some(e=>{const u=JSON.parse(e.detail).usage;return !u||![u.inputTokens,u.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0);}))throw new Error('历史执行用量未知');
  if(db.prepare("SELECT 1 FROM agent_review_calls c JOIN agent_review_queue q ON q.id=c.queue_id WHERE q.task_id=? AND c.state!='finished'").get(p.taskId))throw new Error('历史调用结果或用量未知');
  const notice=db.prepare('SELECT * FROM agent_execution_notifications WHERE task_id=?').get(p.taskId) as {state:string}|undefined;
  if(notice&&['sending','unknown'].includes(notice.state))throw new Error('旧通知送达结果未知');
  const attempt=p.expectedAttempt+1,ts=new Date().toISOString();
  if(!Number.isSafeInteger(attempt))throw new Error('轮次超出范围');
  const objective=String(task.objective)+`\n修改要求（第${attempt}轮）：`+p.feedback.trim();
  if(Buffer.byteLength(objective)>8000)throw new Error('修改上下文超过上限，需先整理目标');
  db.prepare(`INSERT INTO agent_task_revisions(owner,project_scope,request_id,task_id,from_attempt,to_attempt,request_hash,feedback,prior_task_json,prior_job_json,prior_notification_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(identity.owner,identity.projectScope,p.requestId,p.taskId,p.expectedAttempt,attempt,fingerprint,p.feedback,JSON.stringify(task),JSON.stringify(job),notice?JSON.stringify(notice):null,ts);
  const changed=db.prepare("UPDATE agent_tasks SET attempt=?,objective=?,status='ready_to_dispatch',last_error=NULL,observed_model=NULL,review_path=NULL,updated_at=? WHERE id=? AND attempt=? AND status=?")
   .run(attempt,objective,ts,p.taskId,p.expectedAttempt,task.status);
  if(changed.changes!==1)throw new Error('并发修改冲突');
  const snapshot=executionSnapshot(db,p.taskId),taskHash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  db.prepare("UPDATE agent_execution_jobs SET state='ready_to_dispatch',task_hash=?,snapshot_json=?,artifact_path=NULL,artifact_hash=NULL,review_json=NULL,error=NULL,updated_at=? WHERE task_id=?")
   .run(taskHash,JSON.stringify(snapshot),ts,p.taskId);
  db.prepare('DELETE FROM agent_execution_notifications WHERE task_id=?').run(p.taskId);
  store.event(p.taskId,'revision_requested',{fromAttempt:p.expectedAttempt,toAttempt:attempt,requestId:p.requestId});
  return {taskId:p.taskId,attempt,duplicate:false};
 });
 return {revise:(p:Request)=>revise.immediate(p)};
}
