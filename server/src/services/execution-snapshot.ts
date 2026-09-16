/**
 * [INPUT]: 业务任务行与已知执行轮次
 * [OUTPUT]: 稳定执行快照、兼容第一轮的版本化成果文件名
 * [POS]: 执行、验收和成果读取共用版本约定
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type Database from 'better-sqlite3';
export type ExecutionSnapshot={id:string;objective:string;task_type:string;executor:string;project_path:string;
 source:string;source_conversation_id:string|null;requested_model:string|null;requested_cost_policy:'unspecified'|'free_only';attempt?:number};
const fields=['id','objective','task_type','executor','project_path','source','source_conversation_id','requested_model','requested_cost_policy'];
export function executionSnapshot(db:Database.Database,id:string):ExecutionSnapshot{
 const row=db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(id) as Record<string,unknown>|undefined;
 if(!row)throw new Error('任务不存在');
 const attempt=row.attempt??1;artifactNames(attempt as number);
 const snapshot=Object.fromEntries(fields.map(key=>[key,row[key]])) as ExecutionSnapshot;
 // Preserve old v1 serialized hashes; only subsequent versions append a field.
 if((attempt as number)>1)snapshot.attempt=attempt as number;return snapshot;
}
export function artifactNames(attempt=1){
 if(!Number.isSafeInteger(attempt)||attempt<1)throw new Error('无效执行轮次');
 const suffix=attempt===1?'':`.v${attempt}`;
 return {result:`result${suffix}.md`,review:`review${suffix}.json`,evidence:`execution-evidence${suffix}.json`};
}
