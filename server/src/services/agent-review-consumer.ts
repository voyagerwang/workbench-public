/**
 * [INPUT]: 可信身份/项目绑定与验收者
 * [OUTPUT]: 当前轮次校验、有限领取、超时隔离，不推进业务终态
 * [POS]: A 阶段内部服务边界，未注册网络路由
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type {reviewService} from './agent-review-service.js';
type Service=ReturnType<typeof reviewService>;
type Entry=NonNullable<ReturnType<Service['claim']>>;
export type Reviewer=(input:{taskId:string;attempt:number;idempotencyKey:string;signal:AbortSignal;artifact:string})=>Promise<{outcome:'confirmed'|'rejected'}>;
import {openSync,closeSync,readSync,fstatSync,realpathSync,constants} from 'node:fs';
import {relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

// The reviewer must be read-only and accept an idempotency key: a process crash
// after its response can require repeating the review after lease recovery.
export function reviewConsumer({service,review,maxBytes=1024*1024,timeoutMs=60000}: {service:Service;review:Reviewer;maxBytes?:number;timeoutMs?:number}) {
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('invalid_size_limit');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>90000)throw new Error('invalid_timeout');
 function snapshot(entry:Entry){
  if(!entry.boundDir||!entry.result_path)throw new Error('missing_artifact');
  const root=realpathSync(entry.boundDir),path=realpathSync(entry.result_path);
  const rel=relative(root,path);
  if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new Error('artifact_outside_workspace');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   if(!fstatSync(fd).isFile())throw new Error('artifact_not_file');
   const buffer=Buffer.alloc(maxBytes+1);let size=0;
   while(size<buffer.length){const n=readSync(fd,buffer,size,buffer.length-size,null);if(!n)break;size+=n;}
   if(size>maxBytes)throw new Error('artifact_too_large');
   const data=buffer.subarray(0,size);
   const hash=createHash('sha256').update(data).digest('hex');
   if(hash!==entry.result_hash)throw new Error('artifact_changed');
   return data;
  }finally{closeSync(fd);}
 }
 return {async runOne(){
  const entry=service.claim();if(!entry)return {status:'idle'};
  let timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
  try{
   const data=snapshot(entry);
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new Error('review_timeout'));controller.abort();},timeoutMs);});
   const verdict=await Promise.race([deadline,Promise.resolve().then(()=>review({taskId:entry.task_id,attempt:entry.attempt,
    idempotencyKey:`review:${entry.id}:${entry.result_hash}`,signal:controller.signal,artifact:data.toString('utf8')}))]);
   if(!['confirmed','rejected'].includes(verdict?.outcome))throw new Error('invalid_verdict');
   snapshot(entry); // Refuse an approval of a changed file after a slow review.
   return service.resolve({id:entry.id,token:entry.token,resultHash:entry.result_hash,outcome:verdict.outcome});
  }catch(error){
   // Timeout cancellation is uncertain: block automatic retries immediately.
   return service.fail({id:entry.id,token:entry.token,code:error instanceof Error ? ('code' in error ? String(error.code) : error.message) : 'review_error'});
  }finally{clearTimeout(timer);}
 }};
}
