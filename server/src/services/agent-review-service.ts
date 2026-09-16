/**
 * [INPUT]: 可信身份/项目绑定与验收者
 * [OUTPUT]: 当前轮次校验、有限领取、超时隔离，不推进业务终态
 * [POS]: A 阶段内部服务边界，未注册网络路由
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
// Trusted in-process boundary only. No HTTP exposure or model invocation.
import type Database from 'better-sqlite3';
import {createReviewQueue,QueueError,type Scope,type ReceiptInput,type ResolveInput} from './agent-review-queue.js';
export function reviewService(db: Database.Database,{scope,reviewer,now=()=>new Date().toISOString()}: {scope:Scope;reviewer:string;now?:()=>string}) {
 if(!scope?.owner || !scope?.projectScope || !reviewer) throw new QueueError('missing_scope','服务必须绑定可信身份/项目与验收人');
 const trusted=Object.freeze({...scope});
 const q=createReviewQueue(db,{now});
 const task=db.prepare<unknown[],{attempt:number;status:string}>('SELECT attempt,status FROM agent_tasks WHERE id=?');
 function current(taskId:string,attempt:number){
  const t=task.get(taskId),a=q.getAttempt(taskId,attempt);
  if(!a || a.owner!==trusted.owner || a.project_scope!==trusted.projectScope) throw new QueueError('scope_mismatch','任务不属于本服务');
  if(!t || t.attempt!==attempt || ['cancelled','failed','completed','blocked','needs_human','changes_requested','approved'].includes(t.status)) throw new QueueError('stale_attempt','过时、等待人工或终止任务不自动验收');
 }
 const receive=db.transaction((p:ReceiptInput)=>{current(p.taskId,p.attempt);return q.receiveReceipt({...p,...trusted});});
 const claim=db.transaction(()=>{
  q.recoverExpiredClaims(now());
  for(const entry of q.listPending(trusted)){
   try{current(entry.task_id,entry.attempt);}catch(e){if(e instanceof QueueError && e.code==='stale_attempt')continue;throw e;}
   db.prepare('INSERT OR IGNORE INTO agent_review_budget(queue_id) VALUES(?)').run(entry.id);
   const budget=db.prepare<unknown[],{attempts:number;blocked:number}>('SELECT * FROM agent_review_budget WHERE queue_id=?').get(entry.id)!;
   if(budget.blocked)continue;
   if(budget.attempts>=3){db.prepare("UPDATE agent_review_budget SET blocked=1,reason='retry_limit' WHERE queue_id=?").run(entry.id);continue;}
   const claimed=q.claimReview({id:entry.id,owner:reviewer,scope:trusted,leaseUntil:new Date(Date.parse(now())+120000).toISOString()});
   if(claimed)db.prepare('UPDATE agent_review_budget SET attempts=attempts+1 WHERE queue_id=?').run(entry.id);
   return claimed ? {...claimed,boundDir:q.getAttempt(entry.task_id,entry.attempt)!.bound_dir} : null;
  }return null;
 });
 const resolve=db.transaction((p:ResolveInput)=>{
  const entry=q.getQueueEntry(p.id);if(!entry)throw new QueueError('no_such_entry','未知验收条目');
  current(entry.task_id,entry.attempt);
  if(entry.claim_owner!==reviewer)throw new QueueError('reviewer_mismatch','非当前验收人');
  if(p.resultHash!==entry.result_hash)throw new QueueError('artifact_changed','成果哈希不一致，不能提交旧结果');
  if(!['confirmed','rejected'].includes(p.outcome??''))throw new QueueError('invalid_outcome','无效验收结果');
  return (p.outcome==='confirmed'?q.confirmReview:q.rejectReview)({...p,reviewer,scope:trusted});
 });
 const fail=db.transaction(({id,token,code,terminal}: {id:number;token:string;code:string;terminal?:boolean})=>{
  const entry=q.getQueueEntry(id);if(!entry)throw new QueueError('no_such_entry','未知条目');
  current(entry.task_id,entry.attempt);
  if(entry.claim_owner!==reviewer||entry.claim_token!==token||entry.status!=='claimed')throw new QueueError('token_mismatch','过期验收调用');
  const b=db.prepare<unknown[],{attempts:number;blocked:number}>('SELECT * FROM agent_review_budget WHERE queue_id=?').get(id)!;
  const blocked=terminal===true||code==='review_timeout'||b.attempts>=3;
  db.prepare('UPDATE agent_review_budget SET blocked=?,reason=? WHERE queue_id=?').run(blocked?1:0,String(code).slice(0,200),id);
  return {status:blocked?'needs_human':'review_error',id,code};
 });
 return {receive:(p:ReceiptInput)=>receive.immediate(p),claim:()=>claim.immediate(),resolve:(p:ResolveInput)=>resolve.immediate(p),fail:(p:{id:number;token:string;code:string;terminal?:boolean})=>fail.immediate(p)};
}
