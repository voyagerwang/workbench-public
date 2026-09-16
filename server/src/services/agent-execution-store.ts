/**
 * [INPUT]: 显式注入的 SQLite 连接与执行状态变更
 * [OUTPUT]: 幂等执行台账、原子领取和只追加事件；重启仅保留经调用方核验的已交付待验收任务
 * [POS]: 正式执行的持久边界；业务任务投影和 job 在同一事务推进，状态冲突只隔离 job 而不覆盖外部变更
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
// schema.sql 是 DDL 唯一来源，隔离测试也只加载同一段正式表结构。
const executionSchema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').split('-- BEGIN AGENT EXECUTION SCHEMA')[1]?.split('-- END AGENT EXECUTION SCHEMA')[0];
if (!executionSchema) throw new Error('缺少正式执行表结构');
export type ExecutionJob = { runtime_partition:string; task_id: string; state: string; task_hash: string; snapshot_json: string; artifact_path: string | null;
  artifact_hash: string | null; review_json: string | null; error: string | null; created_at: string; updated_at: string };
export function ensureAgentExecutionSchema(db: Database.Database) {
  db.exec(executionSchema);
  if(!(db.prepare('PRAGMA table_info(agent_execution_jobs)').all() as {name:string}[]).some(c=>c.name==='runtime_partition'))db.exec("ALTER TABLE agent_execution_jobs ADD COLUMN runtime_partition TEXT NOT NULL DEFAULT 'legacy'");
}
export function executionStore(db: Database.Database) {
  const get = (id: string) => db.prepare('SELECT * FROM agent_execution_jobs WHERE task_id=?').get(id) as ExecutionJob | undefined;
  const event = (id: string, kind: string, detail: unknown) => db.prepare('INSERT INTO agent_execution_events(task_id,kind,detail,created_at) VALUES(?,?,?,?)')
    .run(id, kind, JSON.stringify(detail), new Date().toISOString());
  const quarantine = db.transaction((id: string, error: string) => {
    const job = get(id); if (!job || !['ready_to_dispatch', 'executing', 'pending_review'].includes(job.state)) return false;
    const task = db.prepare('SELECT status FROM agent_tasks WHERE id=?').get(id) as {status:string}|undefined;
    db.prepare("UPDATE agent_execution_jobs SET state='needs_human',error=?,updated_at=? WHERE task_id=? AND state=?")
      .run(error,new Date().toISOString(),id,job.state);
    event(id,'state_conflict',{error,jobState:job.state,taskState:task?.status??null});
    return true;
  });
  const transition = db.transaction((id: string, from: string, to: string, error: string | null = null,
    fields: { artifactPath?: string; artifactHash?: string; reviewJson?: string; reviewPath?: string; model?: string } = {}) => {
    const ts = new Date().toISOString();
    const existingJob = get(id);
    if (!existingJob || existingJob.state !== from) return false;
    const existingTask = db.prepare('SELECT status FROM agent_tasks WHERE id=?').get(id) as {status:string}|undefined;
    if (!existingTask || existingTask.status !== from) {
      quarantine(id,'任务状态已变更，保留外部状态并隔离执行记录');
      return false;
    }
    const change = db.prepare(`UPDATE agent_execution_jobs SET state=?,error=?,updated_at=?,artifact_path=COALESCE(?,artifact_path),
      artifact_hash=COALESCE(?,artifact_hash),review_json=COALESCE(?,review_json) WHERE task_id=? AND state=?`)
      .run(to,error,ts,fields.artifactPath??null,fields.artifactHash??null,fields.reviewJson??null,id,from);
    if (!change.changes) return false;
    const taskChange = db.prepare('UPDATE agent_tasks SET status=?,last_error=?,updated_at=?,observed_model=COALESCE(?,observed_model),review_path=COALESCE(?,review_path) WHERE id=? AND status=?')
      .run(to,error,ts,fields.model??null,fields.reviewPath??null,id,from);
    if (!taskChange.changes) {
      // 回执字段不应随失败的任务投影落地；恢复原 job 状态后单独隔离。
      db.prepare('UPDATE agent_execution_jobs SET state=? WHERE task_id=?').run(from,id);
      quarantine(id,'任务状态已变更，保留外部状态并隔离执行记录');
      return false;
    }
    event(id,to,{error,...fields}); return true;
  });
  return { get, event, transition, quarantine,
    enqueue: db.transaction((id: string, hash: string, snapshot: unknown, runtimePartition = 'legacy') => {
      const existing=get(id); if(existing) return existing;
      const ts=new Date().toISOString();
      if(!db.prepare("UPDATE agent_tasks SET status='ready_to_dispatch',updated_at=?,last_error=NULL WHERE id=? AND status='drafted'").run(ts,id).changes)
        throw new Error('仅已登记任务可以首次派发；终态不会自动重试');
      db.prepare("INSERT INTO agent_execution_jobs(task_id,state,task_hash,snapshot_json,runtime_partition,created_at,updated_at) VALUES(?,'ready_to_dispatch',?,?,?, ?,?)")
        .run(id,hash,JSON.stringify(snapshot),runtimePartition,ts,ts); event(id,'ready_to_dispatch',{hash,runtimePartition}); return get(id)!;
    }),
    claim: db.transaction((maxDailyJobs?: number, maxConcurrentJobs = 1, runtimePartition = 'legacy', belongs?: (taskId: string) => boolean) => {
      if (maxDailyJobs != null) {
        const count=db.prepare("SELECT count(*) n FROM agent_execution_events WHERE kind='executing' AND created_at>=?").get(new Date().toISOString().slice(0,10)) as {n:number};
        if(count.n>=maxDailyJobs) return null;
      }
      const active=db.prepare("SELECT count(*) n FROM agent_execution_jobs WHERE state IN ('executing','pending_review')").get() as {n:number};
      if(active.n>=maxConcurrentJobs) return null;
      while(true) {
        const row=db.prepare("SELECT task_id FROM agent_execution_jobs WHERE state='ready_to_dispatch' AND runtime_partition=? ORDER BY created_at,task_id LIMIT 1").get(runtimePartition) as {task_id:string}|undefined;
        if(!row) return null;
        if (belongs && !belongs(row.task_id)) {
          // This queue is shared by runtimes. Leave another runtime's partition untouched.
          const skipped = db.prepare("SELECT task_id FROM agent_execution_jobs WHERE state='ready_to_dispatch' AND runtime_partition=? AND task_id<>? ORDER BY created_at,task_id LIMIT 1").get(runtimePartition,row.task_id) as {task_id:string}|undefined;
          if (!skipped) return null;
          // Move the cursor by selecting the next candidate; no state mutation is needed.
          const candidates = db.prepare("SELECT task_id FROM agent_execution_jobs WHERE state='ready_to_dispatch' AND runtime_partition=? ORDER BY created_at,task_id").all(runtimePartition) as {task_id:string}[];
          const next = candidates.find(candidate => belongs(candidate.task_id));
          if (!next) return null;
          if (transition(next.task_id,'ready_to_dispatch','executing')) return get(next.task_id)!;
          continue;
        }
        if(transition(row.task_id,'ready_to_dispatch','executing'))return get(row.task_id)!;
      }
    }),
    recover: db.transaction((preserveReview?:(taskId:string)=>boolean, runtimePartition = 'legacy', belongs?:(taskId:string)=>boolean) => {
      const rows=db.prepare("SELECT task_id,state FROM agent_execution_jobs WHERE state IN ('executing','pending_review') AND runtime_partition=?").all(runtimePartition) as ExecutionJob[];
      let recovered=0;
      for(const row of rows) {
        if (belongs && !belongs(row.task_id)) continue;
        let preserve=false;
        if(row.state==='pending_review'&&preserveReview){try{preserve=preserveReview(row.task_id)===true;}catch{preserve=false;}}
        if(preserve)continue;
        transition(row.task_id,row.state,'needs_human','服务重启，之前执行结果未知；禁止自动重派');recovered++;
      }
      return recovered;
    }),
  };
}
