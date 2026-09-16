/**
 * [INPUT]: 可信身份/项目/账号/执行者与已完成执行的外部会话回执
 * [OUTPUT]: 不可夺取的按任务轮次会话绑定，精确前轮查询
 * [POS]: 可选原生续接台账；不调用外部Agent，不使用最近会话猜测
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type Database from 'better-sqlite3';
import {readFileSync,realpathSync} from 'node:fs';
import type {Scope} from './agent-review-queue.js';
const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8').split('-- BEGIN AGENT PROVIDER SESSION SCHEMA')[1]?.split('-- END AGENT PROVIDER SESSION SCHEMA')[0];
if(!schema)throw new Error('缺少会话绑定表');
type Row={task_id:string;attempt:number;role:string;owner:string;project_scope:string;project_root:string;account_scope:string;provider:string;session_id:string};
export function providerSessionRegistry(config:{db:Database.Database;scope:Scope;projectRoot:string;accountScope:string;provider:string;role:'execution'|'review'}){
 const {db}=config;const identity=Object.freeze({...config.scope,projectRoot:realpathSync(config.projectRoot),accountScope:config.accountScope,provider:config.provider,role:config.role});
 if(!identity.owner||!identity.projectScope||!identity.accountScope||!identity.provider)throw new Error('缺少会话身份');db.exec(schema);
 const matches=(r:Row)=>r.owner===identity.owner&&r.project_scope===identity.projectScope&&r.project_root===identity.projectRoot&&r.account_scope===identity.accountScope&&r.provider===identity.provider&&r.role===identity.role;
 const record=db.transaction((p:{taskId:string;attempt:number;sessionId:string})=>{
  if(!Number.isSafeInteger(p.attempt)||p.attempt<1||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.sessionId))throw new Error('无效会话回执');
  const existing=db.prepare('SELECT * FROM agent_provider_sessions WHERE task_id=? AND attempt=? AND role=?').get(p.taskId,p.attempt,identity.role) as Row|undefined;
  if(existing){if(!matches(existing)||existing.session_id!==p.sessionId)throw new Error('会话绑定不可覆盖');return existing;}
  const task=db.prepare('SELECT attempt,status,project_path FROM agent_tasks WHERE id=?').get(p.taskId) as {attempt:number;status:string;project_path:string}|undefined;
  const job=db.prepare('SELECT state FROM agent_execution_jobs WHERE task_id=?').get(p.taskId) as {state:string}|undefined;
  const binding=db.prepare('SELECT owner,project_scope FROM agent_execution_attempts WHERE task_id=? AND attempt=?').get(p.taskId,p.attempt) as {owner:string;project_scope:string}|undefined;
  if(!task||!job||task.attempt!==p.attempt||task.status!=='pending_review'||job.state!=='pending_review'||realpathSync(task.project_path)!==identity.projectRoot||binding?.owner!==identity.owner||binding?.project_scope!==identity.projectScope)throw new Error('未核验的任务完成绑定');
  const used=db.prepare('SELECT * FROM agent_provider_sessions WHERE provider=? AND account_scope=? AND session_id=?').all(identity.provider,identity.accountScope,p.sessionId) as Row[];
  if(used.some(r=>r.task_id!==p.taskId||!matches(r)))throw new Error('外部会话已属于其他任务或角色');
  db.prepare('INSERT INTO agent_provider_sessions(task_id,attempt,role,owner,project_scope,project_root,account_scope,provider,session_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
   .run(p.taskId,p.attempt,identity.role,identity.owner,identity.projectScope,identity.projectRoot,identity.accountScope,identity.provider,p.sessionId,new Date().toISOString());
  return db.prepare('SELECT * FROM agent_provider_sessions WHERE task_id=? AND attempt=? AND role=?').get(p.taskId,p.attempt,identity.role) as Row;
 });
 return {record:(p:Parameters<typeof record>[0])=>record.immediate(p),previous:(taskId:string,nextAttempt:number)=>{
  if(!Number.isSafeInteger(nextAttempt)||nextAttempt<2)throw new Error('仅查询明确前轮会话');
  const row=db.prepare('SELECT * FROM agent_provider_sessions WHERE task_id=? AND attempt=? AND role=?').get(taskId,nextAttempt-1,identity.role) as Row|undefined;
  if(!row||!matches(row))throw new Error('前轮会话不存在或归属已改变');return row;
 }};
}
