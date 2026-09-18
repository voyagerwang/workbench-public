import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,readFileSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStageARuntime} from './src/services/agent-stage-a-runtime.js';
import {taskSandbox,type ExecutionPolicy} from './src/services/agent-execution.js';
import type {ExecutorAdapter} from './src/services/executor-contract.js';
const root=realpathSync(mkdtempSync(join(tmpdir(),'project-write-'))),db=new Database(':memory:');
try {
 db.exec(readFileSync(new URL('./src/schema.sql',import.meta.url),'utf8'));
 db.prepare("INSERT INTO agent_tasks(id,source,source_conversation_id,source_message_id,objective,intent_key,created_at,updated_at,task_type,executor,project_path) VALUES('install','workbench','owner','m','安装项目 Skill','i','now','now','other','codex',?)").run(root);
 const policy:ExecutionPolicy={enabled:true,isPrimary:true,paused:false,allowWorkspaceWrites:true,allowedProjects:[root],allowedExecutors:['codex'],allowedModels:['test'],executionModel:'test',reviewModel:'test',accountScope:'test',deadlineMs:1000,maxOutputBytes:10000,maxTokens:1000};
 const roles:string[]=[];
 const adapter=(role:'execution'|'review'):ExecutorAdapter=>({capabilities:{protocolVersion:1,id:'fixture',projectDirectory:true,progressEvents:true,cancellation:'local-process',resume:true,sandbox:role==='execution'?'workspace-write':'read-only'},start({prompt,onEvent}){
  roles.push(role);let artifactContent='installed skill fixture';
  if(role==='execution'){
   assert.match(prompt,/安装项目依赖或项目级 Skill/);assert.doesNotMatch(prompt,/完成以下只读研究/);
   writeFileSync(join(root,'SKILL.md'),'---\nname: fixture\ndescription: verification fixture\n---\n');
   onEvent({type:'accepted',sessionId:'11111111-2222-4333-8444-555555555555'});
  } else {
   const payload=JSON.parse(prompt.split('\n')[1]);assert.equal(payload.executionEvidence.sandbox,'workspace-write');
   assert.match(readFileSync(join(root,'SKILL.md'),'utf8'),/name: fixture/);
   artifactContent=JSON.stringify({taskId:payload.taskId,taskHash:payload.taskHash,artifactHash:payload.artifactHash,verdict:'approved',reason:'independently read installed fixture'});
  }
  return {interrupt(){},completion:Promise.resolve({exitCode:0,signal:null,error:null,protocolCompleted:true,localProcessClosed:true,artifactContent,usage:{inputTokens:10,outputTokens:10,cachedInputTokens:0}})};
 }});
 const runtime=createStageARuntime({db,scope:{owner:'owner',projectScope:'project'},boundProjectPath:root,stageAEnabled:()=>true,revisionSource:{source:'workbench',conversationId:'owner'},policy:()=>policy,artifactRoot:join(root,'results'),adapter:(_m,role)=>adapter(role),nativeSessionAdapter:(_m,session,task)=>{
  assert.equal(session.mode,'create');assert.equal(taskSandbox(task!,policy),'workspace-write');return adapter('execution');
 }});
 runtime.enqueue('install');await runtime.tick();assert.equal(runtime.get('install')?.state,'completed');assert.deepEqual(roles,['execution','review']);
 const evidence=JSON.parse(readFileSync(runtime.get('install')!.artifact_path!.replace('result.md','execution-evidence.json'),'utf8'));assert.equal(evidence.sandbox,'workspace-write');
 console.log('PASS: project write + native session task propagation + actual fixture file + independent read-only review + truthful evidence');
} finally {db.close();rmSync(root,{recursive:true,force:true});}
