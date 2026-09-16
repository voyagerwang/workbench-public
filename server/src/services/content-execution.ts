/**
 * [INPUT]: 固定本地转写器、纯文本归纳器与可信任务来源（含抖音完整分享链接）
 * [OUTPUT]: 持久有界并发内容任务（执行者白名单 codex/workbuddy/cola），分离音频与平台元数据，按目标保存随手记或任务成果，额外交付未落实不报完成，原文与标题双重比较避免覆盖用户修改
 * [POS]: 媒体资料处理边界；不借用代码项目权限，不接受模型提供命令或文件路径；任务目录拒绝符号链接，资料标题统一归入文档章节
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, lstatSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
export type ContentConfig = { enabled: boolean; python: string; script: string; deadlineMs?: number };
export function videoSource(objective: string): string | null {
  if (!/转写|逐字稿|视频.*(?:总结|提取|提炼)|(?:提炼|生成|转为|转成).{0,20}(?:Skill|技能)/i.test(objective)) return null;
  const urls=objective.match(/https:\/\/[^\s（()）。，；：、<>"'「」【】]+/g)??[];
  const allowed=['www.iesdouyin.com','iesdouyin.com','v.douyin.com','www.douyin.com','douyin.com','www.bilibili.com','b23.tv','www.youtube.com','youtu.be','www.xiaohongshu.com','xhslink.com'];
  const matched=urls.filter(raw=>{try{const u=new URL(raw);return allowed.includes(u.hostname)&&!u.username&&!u.password&&!u.port;}catch{return false;}});
  return matched.length===1?matched[0]:null;
}
export function articleSkillSource(objective: string): string | null {
  if (/(?:不要|无需|不必|勿)[^。；\n]{0,100}(?:Skill|技能)/i.test(objective) || !/(?:提炼|生成|转为|转换成|整理成).{0,20}(?:Skill|技能)/i.test(objective)) return null;
  const urls=objective.match(/https?:\/\/[^\s（()）。，；：、<>"'「」【】]+/g)??[];
  const videoHosts=['www.iesdouyin.com','iesdouyin.com','v.douyin.com','www.douyin.com','douyin.com','www.bilibili.com','b23.tv','www.youtube.com','youtu.be','www.xiaohongshu.com','xhslink.com'];
  const matched=urls.filter(raw=>{try{const u=new URL(raw);return /^https?:$/.test(u.protocol)&&!videoHosts.includes(u.hostname)&&!u.username&&!u.password&&!u.port;}catch{return false;}});
  return matched.length===1?matched[0]:null;
}
/** 转写器标题可能混入平台壳提示；标题清洗不改变逐字稿正文，也不推断画面内容。 */
export function cleanContentTitle(title: string, objective?: string): string {
  const requested = objective?.match(/[「《]([^」》]{2,100})[」》]/u)?.[1]?.trim();
  if (requested) return requested;
  const noise = /(?:版本过低(?:[,，]?\s*升级后(?:可展示全部信息)?)?|请升级后(?:查看|可展示)全部信息|升级后可展示全部信息)/gi;
  const cleaned = title.split(/\r?\n/)[0].replace(/^#+\s*/, '').replace(noise, '').replace(/[|｜\-—:：]+\s*$/, '').trim();
  return cleaned.slice(0, 100) || '视频转写';
}
export function parseTranscriptMarkdown(markdown: string): { metadata: string; spokenTranscript: string; separated: boolean } {
  const lines = markdown.split(/\r?\n/);
  if (!/^\s*#{1,2}\s+\S/.test(lines[0] ?? '')) return { metadata: '', spokenTranscript: markdown, separated: false };
  let i = 1; const meta: string[] = [];
  while (i < lines.length && (!lines[i].trim() || /^\s*>\s*/.test(lines[i]))) { if (lines[i].trim()) meta.push(lines[i].replace(/^\s*>\s?/, '').trim()); i++; }
  while (i < lines.length && !lines[i].trim()) i++;
  if (!/^\s*#{2,3}\s+(?:\d+\.\s*)?(?:转写片段|逐字稿|音频转写)/.test(lines[i] ?? '')) return { metadata: '', spokenTranscript: markdown, separated: false };
  return { metadata: meta.join('\n'), spokenTranscript: lines.slice(i).join('\n').trim(), separated: true };
}
/** 文档只保留外层一个主标题；资料中的代码块保持逐字不变。 */
export function normalizeContentHeadings(markdown:string):string {
  const lines=markdown.split('\n');let fence:string|null=null;
  return lines.map((line,index)=>{
    const marker=line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;return line;}
    if(fence)return line;
    if(index+1<lines.length&&line.trim()&&/^\s{0,3}(?:=+|-+)\s*$/.test(lines[index+1])){lines[index+1]='';return `### ${line.trim()}`;}
    return line.replace(/^(\s{0,3})(#{1,2})(?=\s|$)/,'$1###');
  }).join('\n');
}
function contentDirectory(root:string,id:string):string {
  mkdirSync(root,{recursive:true});
  if(lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory())throw new Error('内容成果根目录不允许符号链接');
  const canonical=realpathSync(root);const target=join(canonical,createHash('sha256').update(id).digest('hex'));
  try{mkdirSync(target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  if(lstatSync(target).isSymbolicLink()||!lstatSync(target).isDirectory()||realpathSync(target)!==target)throw new Error('内容任务目录越界或为符号链接');
  return target;
}
type Task={id:string;objective:string;status:string;source:string;source_conversation_id:string;executor?:string|null;requested_model?:string|null;requested_cost_policy?:string};
export const needsContentFollowup=(objective:string)=>articleSkillSource(objective)!==null || (!/(?:不要|无需|不必|勿)[^。；\n]{0,100}(?:Skill|技能)/i.test(objective)&&/(?:保存|存入|同步|安装|写入|更新|提炼|生成|转为|转换成|整理成)[^。；\n]{0,100}(?:Skill|技能|资源库)|(?:Skill|技能)\s*(?:保存|存入|安装|同步)/i.test(objective));
type Job={task_id:string;state:string;snapshot_json:string;note_id:number|null;note_content:string|null};
export function createContentRuntime(deps:{db:Database.Database;root:string;enabled:()=>boolean;maxConcurrentJobs?:()=>number;onSettled?:()=>void;onSkillCandidate?:(taskId:string,artifactHash:string)=>Promise<unknown>;readArticle?:(url:string)=>Promise<{title:string;content:string}>;transcribe:(url:string,dir:string)=>Promise<{title:string;content:string}>;summarize:(prompt:string,task:Task,dir:string)=>Promise<string>}){
  const {db}=deps;let active=0;let eventsTable: boolean | null = null;
  // 事件入账：生产 schema 必有 agent_execution_events；最小化测试库没有时静默跳过（不阻塞内容执行）
  const record=(id:string,kind:string,detail:Record<string,unknown>)=>{
    if(eventsTable===null)eventsTable=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_execution_events'").get();
    if(!eventsTable)return;
    db.prepare('INSERT INTO agent_execution_events(task_id,kind,detail,created_at) VALUES(?,?,?,?)').run(id,kind,JSON.stringify(detail),new Date().toISOString());
  };
  const readAttempt=(id:string):number|null=>{try{return (db.prepare('SELECT attempt FROM agent_tasks WHERE id=?').get(id) as {attempt:number|null}|undefined)?.attempt ?? null;}catch{/* 最小化测试库无 attempt 列 */}return null;};
  const get=(id:string)=>db.prepare('SELECT * FROM content_execution_jobs WHERE task_id=?').get(id) as Job|undefined;
  const fail=(id:string,error:string)=>db.transaction(()=>{
    db.prepare("UPDATE content_execution_jobs SET state='needs_human',error=?,updated_at=CURRENT_TIMESTAMP WHERE task_id=?").run(error,id);
    db.prepare("UPDATE agent_tasks SET status='needs_human',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('ready_to_dispatch','executing','pending_review')").run(error,id);
    record(id,'content_failed',{attempt:readAttempt(id)??1,error});
  })();
  return {get,
    enqueue:db.transaction((id:string,options?:{noteId?:number})=>{
      if(get(id))return get(id)!;
      const task=db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(id) as Task;
      const url=task&&(videoSource(task.objective)||articleSkillSource(task.objective));
      const contentKind=task&&articleSkillSource(task.objective)?'article':'video';
      if(!task||task.status!=='drafted'||!url)throw new Error('仅支持尚未派发的单个内容任务');
      if(contentKind==='article'&&!deps.readArticle)throw new Error('文章读取器未配置');
      if(task.executor&&!['codex','workbuddy','cola'].includes(task.executor))throw new Error('指定执行者的内容通道未接通；未改派');
      if(task.requested_cost_policy==='free_only')throw new Error('内容执行缺少当前账号免费模型证据，未启动');
      const saveNote=Boolean(options?.noteId)||/随手记|笔记|notes/i.test(task.objective);
      if(!saveNote&&!/任务成果|资源库|Skill|技能/i.test(task.objective))throw new Error('需要明确保存到随手记或任务成果');
      const note=options?.noteId?db.prepare('SELECT title,content FROM notes WHERE id=? AND deleted_at IS NULL').get(options.noteId) as {title:string;content:string}|undefined:null;
      if(options?.noteId&&!note)throw new Error('原随手记不存在');
      db.prepare("INSERT INTO content_execution_jobs(task_id,state,snapshot_json,note_id,note_content) VALUES(?,'ready_to_dispatch',?,?,?)").run(id,JSON.stringify({...task,url,contentKind,saveNote,noteTitle:note?.title??null}),options?.noteId??null,note?.content??null);
      db.prepare("UPDATE agent_tasks SET status='ready_to_dispatch',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      record(id,'content_ready',{attempt:(task as {attempt?:number|null} | undefined)?.attempt ?? 1,executor:task.executor??null,contentKind,url,saveNote});
      return get(id)!;
    }),
    recover(){if(active)return;for(const row of db.prepare("SELECT task_id FROM content_execution_jobs WHERE state IN ('executing','pending_review')").all() as {task_id:string}[])fail(row.task_id,'服务重启，内容处理结果未知；未自动重派或写入笔记');},
    async tick(){
      if(active>=(deps.maxConcurrentJobs?.()??1)||!deps.enabled())return;active++;let job:Job|undefined;let discarded=false;
      try{
        job=db.transaction(()=>{
          const running=db.prepare("SELECT count(*) n FROM content_execution_jobs WHERE state IN ('executing','pending_review')").get() as {n:number};
          if(running.n>=(deps.maxConcurrentJobs?.()??1))return;
          const row=db.prepare("SELECT * FROM content_execution_jobs WHERE state='ready_to_dispatch' ORDER BY created_at,task_id LIMIT 1").get() as Job|undefined;
          if(!row)return;
          const task=db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(row.task_id) as Task;const snapshot=JSON.parse(row.snapshot_json);
          if(task.status!=='ready_to_dispatch'||task.objective!==snapshot.objective||task.source!==snapshot.source||task.source_conversation_id!==snapshot.source_conversation_id||task.executor!==snapshot.executor||task.requested_model!==snapshot.requested_model||task.requested_cost_policy!==snapshot.requested_cost_policy){fail(row.task_id,'任务或来源已经变化，停止内容处理');discarded=true;return;}
          db.prepare("UPDATE content_execution_jobs SET state='executing',updated_at=CURRENT_TIMESTAMP WHERE task_id=?").run(row.task_id);
          db.prepare("UPDATE agent_tasks SET status='executing',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.task_id);
          record(row.task_id,'execution',{attempt:(task as {attempt?:number|null} | undefined)?.attempt ?? 1,type:'content_started',contentKind:snapshot.contentKind,url:snapshot.url});return row;
        }).immediate();
        if(!job)return;const snapshot=JSON.parse(job.snapshot_json);const dir=contentDirectory(deps.root,job.task_id);
        const attempt=readAttempt(job.task_id) ?? 1;
        const transcript=snapshot.contentKind==='article' ? await deps.readArticle!(snapshot.url) : await deps.transcribe(snapshot.url,dir);
        if(!transcript.content.trim()||transcript.content.length>300000)throw new Error('逐字稿为空或超过文档处理上限');
        record(job.task_id,'content_transcript',{attempt,title:transcript.title,chars:transcript.content.length,source:snapshot.contentKind==='article'?'article':'local-asr'});
        const parsed = parseTranscriptMarkdown(transcript.content);
        const summary=snapshot.contentKind==='article' ? '' : await deps.summarize('请根据以下音频自动转写文本输出中文 Markdown 总结，包含核心结论、流程要点、明确提及的 Skill / 工具名称与用途。\n'+JSON.stringify({objective:snapshot.objective,metadata:parsed.metadata,spokenTranscript:parsed.spokenTranscript,metadataSeparated:parsed.separated})+'\n严格响应任务中要求的要点清单及 Skill 草稿。只生成正文，不声称已保存或安装。',snapshot,dir);
        if(snapshot.contentKind!=='article'&&!summary.trim())throw new Error('总结为空');
        let observedModel:string|null=null;let summaryUsage:Record<string,unknown>|null=null;
        try{const ev=JSON.parse(readFileSync(join(dir,'executor-evidence.json'),'utf8')) as {observedModel?:string|null;requestedModel?:string|null;usage?:Record<string,unknown>};observedModel=ev.observedModel??null;summaryUsage=ev.usage??null;}catch{/* 内部模型分支或证据未写：用量按未知口径 */}
        record(job.task_id,'execution_result',{attempt,requestedModel:snapshot.requested_model??null,observedModel,usage:summaryUsage});
        const title = cleanContentTitle(transcript.title, snapshot.objective);
        const displayTranscript = parsed.separated ? `${parsed.metadata ? '> '+parsed.metadata.split('\n').join('\n> ')+'\n\n' : ''}${parsed.spokenTranscript}` : `${transcript.content}\n\n> 未能按固定格式分离标题/元数据，以上保留原始转写。`;
        const content=snapshot.contentKind==='article' ? `# ${title}\n\n来源：${snapshot.url}\n\n${normalizeContentHeadings(transcript.content)}` : `# ${title}\n\n来源：${snapshot.url}\n\n## 总结与提炼\n\n${normalizeContentHeadings(summary)}\n\n## 音频逐字稿\n\n> 自动转写，未人工核听。\n\n${normalizeContentHeadings(displayTranscript)}`;
        if(contentDirectory(deps.root,job.task_id)!==dir)throw new Error('内容任务目录已经变化');
        // 第 1 轮 wx 防碰撞；换执行器/返工的新轮（attempt>1）覆盖写同路径——成果哈希随轮更新，旧轮内容在事件与笔记历史可溯
        writeFileSync(join(dir,'result.md'),content,{flag:attempt>1?'w':'wx'});
        db.transaction(()=>{
          const current=db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(job!.task_id) as Task;
          if(current.status!=='executing'||current.objective!==snapshot.objective||current.source!==snapshot.source||current.source_conversation_id!==snapshot.source_conversation_id||current.executor!==snapshot.executor||current.requested_model!==snapshot.requested_model||current.requested_cost_policy!==snapshot.requested_cost_policy)throw new Error('任务状态或来源变化，未保存文档');
          let noteId=job!.note_id;
          if(noteId){if(!db.prepare('UPDATE notes SET title=?,content=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND content=? AND title=? AND deleted_at IS NULL').run(title,content,noteId,job!.note_content,snapshot.noteTitle??null).changes)throw new Error('原笔记已编辑或删除，未覆盖');}
          else if(snapshot.saveNote!==false)noteId=Number(db.prepare('INSERT INTO notes(id,title,content) VALUES(sync_id(),?,?)').run(title,content).lastInsertRowid);
          const incomplete=needsContentFollowup(snapshot.objective);
          const state=incomplete?'needs_human':'completed';
          const remaining=incomplete?(/Skill|技能/i.test(snapshot.objective)?'正在提炼 Skill，完成后自动写入本地库并收尾任务。':'资源库同步尚未完成，可在任务成果中查看内容。'):null;
          db.prepare("UPDATE content_execution_jobs SET state=?,error=?,note_id=?,artifact_hash=?,artifact_path=?,updated_at=CURRENT_TIMESTAMP WHERE task_id=?").run(state,remaining,noteId,createHash('sha256').update(content).digest('hex'),join(dir,'result.md'),job!.task_id);
          db.prepare("UPDATE agent_tasks SET status=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(state,remaining,job!.task_id);
          record(job!.task_id,'content_note_saved',{attempt:(current as {attempt?:number|null}).attempt ?? 1,noteId,state,artifactPath:join(dir,'result.md')});
        })();
        if(job && /Skill|技能/i.test(JSON.parse(job.snapshot_json).objective)&&needsContentFollowup(JSON.parse(job.snapshot_json).objective)){
          const row=db.prepare('SELECT artifact_hash FROM content_execution_jobs WHERE task_id=?').get(job.task_id) as {artifact_hash:string|null}|undefined;
          if(row?.artifact_hash && deps.onSkillCandidate){
            try{await deps.onSkillCandidate(job.task_id,row.artifact_hash);}
            catch(error){
              db.prepare("UPDATE agent_tasks SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='needs_human'").run(`内容成果已保存，但 Skill 候选生成失败，可重试：${(error as Error).message}`.slice(0,600),job.task_id);
            }
          }
        }
      }catch(error){if(job)fail(job.task_id,(error as Error).message);}finally{active--;if(job||discarded)deps.onSettled?.();}
    }
  };
}
export async function transcribeLocal(config:ContentConfig,url:string,dir:string):Promise<{title:string;content:string}>{
  const stdout=await new Promise<string>((ok,no)=>{
    const child=spawn(config.python,['-c', 'import importlib.util,sys,os; script=sys.argv.pop(1); work=sys.argv.pop(1); sys.path.insert(0,os.path.dirname(script)); spec=importlib.util.spec_from_file_location("workbench_transcript",script); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.WORK_DIR=work; os.makedirs(work,exist_ok=True); module.main()',config.script,join(dir,'work'),url,'--engine','local','--optimizer','none','--output-dir',dir,'--images-dir',join(dir,'images')],{cwd:dir,stdio:['ignore','pipe','pipe'],detached:true,env:{...Object.fromEntries(['HOME','PATH','LANG','LC_ALL','TMPDIR','HF_HOME','MODELSCOPE_CACHE','XDG_CACHE_HOME','SENSEVOICE_MODEL_DIR'].filter(key=>process.env[key]).map(key=>[key,process.env[key]!])),MINIMAX_API_KEY:'',SENSEVOICE_PYTHON:config.python}});
    let out='',diagnostic='';let error:Error|null=null;let killTimer:ReturnType<typeof setTimeout>|undefined;const terminate=()=>{try{process.kill(-child.pid!,'SIGTERM');}catch{}killTimer=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},2000);};
    const timer=setTimeout(()=>{error=new Error('本地转写超时');terminate();},config.deadlineMs??1800000);
    child.stdout.on('data',chunk=>{out+=chunk.toString();if(out.length>1000000){error=new Error('转写回执超过上限');terminate();}});child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-3000);});child.on('error',e=>{clearTimeout(timer);clearTimeout(killTimer);no(e);});child.on('close',code=>{clearTimeout(timer);clearTimeout(killTimer);if(error||code!==0)no(error??new Error(`本地转写失败，退出码 ${code}：${diagnostic.replace(/(?:Bearer\s+|(?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s]+/gi,'[redacted]').slice(-1500)}`));else ok(out);});
  });
  let result:any;for(const match of [...stdout.matchAll(/\{/g)].reverse()){try{result=JSON.parse(stdout.slice(match.index));break;}catch{}}
  if(result?.status!=='ok'||result.engine!=='local'||result.optimizer!=='none'||typeof result.transcript_path!=='string')throw new Error('转写器没有返回成功的本地转写凭据');
  const path=resolve(result.transcript_path);const root=realpathSync(dir)+sep;
  if(!path.startsWith(root)||lstatSync(path).isSymbolicLink()||!realpathSync(path).startsWith(root)||lstatSync(path).size>1000000)throw new Error('逐字稿路径不属于本次任务');
  return {title:cleanContentTitle(String(result.title??'视频转写')),content:readFileSync(path,'utf8')};
}
