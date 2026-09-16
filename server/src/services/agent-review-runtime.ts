/**
 * [INPUT]: 显式启用的交接桥、只读验收器和可信预算
 * [OUTPUT]: 有界验收调用、持久用量以及带证据的原子业务完成
 * [POS]: A 阶段延后验收执行器；没有生产装配，未知用量阻断后续调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type Database from 'better-sqlite3';
import type {createReviewHandoff,HandoffVerdict} from './agent-review-handoff.js';
type Bridge=ReturnType<typeof createReviewHandoff>;
type Usage={inputTokens:number;outputTokens:number;cachedInputTokens?:number|null;inputIncludesCache?:boolean};
export type DeferredReviewInput=ReturnType<Bridge['input']> & {remainingTokens:number;signal:AbortSignal;idempotencyKey:string;reviewClaim?:{id:number;token:string}};
function tokens(u:Usage){
 if(!u||![u.inputTokens,u.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0)||!Number.isSafeInteger(u.inputTokens+u.outputTokens))throw new Error('unknown_usage');
 return u.inputTokens+u.outputTokens;
}
export function createDeferredReviewRuntime(config:{db:Database.Database;bridge:Bridge;maxTokens:number;timeoutMs?:number;
 review:(input:DeferredReviewInput)=>Promise<{verdict:HandoffVerdict;usage:Usage}>}){
 const {db,bridge}=config;const timeoutMs=config.timeoutMs??60000;
 if(!Number.isSafeInteger(config.maxTokens)||config.maxTokens<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>90000)throw new Error('invalid_budget');
 const reserve=db.transaction((id:number,token:string,taskId:string,attempt:number)=>{
  const prior=db.prepare(`SELECT c.* FROM agent_review_calls c JOIN agent_review_queue q ON q.id=c.queue_id WHERE q.task_id=?`).all(taskId) as {state:string;token_limit:number;input_tokens:number;output_tokens:number}[];
  if(prior.some(r=>r.state!=='finished'))throw new Error('unknown_previous_call');
  const events=db.prepare("SELECT detail FROM agent_execution_events WHERE task_id=? AND kind='execution_result'").all(taskId) as {detail:string}[];
  const executions=events.map(e=>JSON.parse(e.detail) as {attempt?:number;usage:Usage});
  // Exactly one current execution; previous versions still consume this task's budget.
  if(executions.filter(e=>(e.attempt??1)===attempt).length!==1)throw new Error('unknown_execution_usage');
  const used=executions.reduce((n,e)=>n+tokens(e.usage),0)+prior.reduce((n,r)=>n+tokens({inputTokens:r.input_tokens,outputTokens:r.output_tokens}),0);
  const limit=Math.min(config.maxTokens,...prior.map(r=>r.token_limit)),remaining=limit-used;
  if(remaining<=0)throw new Error('token_budget_exhausted');
  const ts=new Date().toISOString();db.prepare("INSERT INTO agent_review_calls(claim_token,queue_id,state,token_limit,created_at,updated_at) VALUES(?,?,'running',?,?,?)").run(token,id,limit,ts,ts);
  return remaining;
 });
 return {async tick(){
  const claim=bridge.claim();if(!claim)return {status:'idle'};
  let timer:ReturnType<typeof setTimeout>|undefined,reserved=false,usageKnown=false;
  const controller=new AbortController();
  try{
   const input=bridge.input(claim.id),remainingTokens=reserve.immediate(claim.id,claim.token,claim.task_id,claim.attempt);reserved=true;
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new Error('review_timeout'));controller.abort();},timeoutMs);});
   const result=await Promise.race([deadline,Promise.resolve().then(()=>config.review({...input,remainingTokens,signal:controller.signal,idempotencyKey:`review:${claim.id}:${input.artifactHash}`,reviewClaim:{id:claim.id,token:claim.token}}))]);
   const used=tokens(result.usage);
   db.transaction(()=>{
    const ts=new Date().toISOString();
    db.prepare("UPDATE agent_review_calls SET state='finished',input_tokens=?,output_tokens=?,updated_at=? WHERE claim_token=? AND state='running'")
     .run(result.usage.inputTokens,result.usage.outputTokens,ts,claim.token);
    const cached=result.usage.cachedInputTokens;
    db.prepare('INSERT INTO agent_review_events(queue_id,action,actor,token,detail_json,created_at) VALUES(?,?,?,?,?,?)')
     .run(claim.id,'usage_reported',claim.claim_owner,claim.token,JSON.stringify({inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,
      cachedInputTokens:typeof cached==='number'&&Number.isSafeInteger(cached)&&cached>=0?cached:null,
      inputIncludesCache:typeof result.usage.inputIncludesCache==='boolean'?result.usage.inputIncludesCache:null}),ts);
   }).immediate();usageKnown=true;
   if(used>remainingTokens)throw new Error('token_budget_exceeded');
   return bridge.complete({id:claim.id,token:claim.token,verdict:result.verdict});
  }catch(error){
   const code=error instanceof Error?error.message:'review_error';
   if(reserved&&!usageKnown)db.prepare("UPDATE agent_review_calls SET state='unknown',updated_at=? WHERE claim_token=? AND state='running'").run(new Date().toISOString(),claim.token);
   // No repeated model calls when spend/outcome is unknown. Preserve diagnostic.
   const fatal=!usageKnown||code==='token_budget_exceeded';
   const result=bridge.fail({id:claim.id,token:claim.token,code,terminal:fatal});
   return {...result,code};
  }finally{clearTimeout(timer);}
 }};
}
