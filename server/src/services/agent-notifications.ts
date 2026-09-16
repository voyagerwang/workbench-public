/**
 * [INPUT]: 代码与内容执行终态、冻结的来源会话、成果指纹与通道实际发送回执
 * [OUTPUT]: 持久通知台账、来源会话内的最终结果及明确的失败/未知状态
 * [POS]: 执行后的独立投递边界；本地消息与送达状态原子提交，外部发送未知不重试，不更改任务验收事实
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { ensureAgentExecutionSchema } from './agent-execution-store.js';
import { db, now } from '../db.js';
import { sendClawbotMessage } from '../routes/clawbot.js';
import { appendMessage, ensureSession } from './assistant-sessions.js';
import { memoryIdentity } from './assistant-memory.js';
import { normalizeWeixinInbound, normalizeFeishuInbound } from './inbound-context.js';
import { agentResult, dispatchRuntime } from './agent-dispatch.js';

type Notification = { task_id: string; source: string; destination: string; body: string; state: string; ledger: 'agent_execution_notifications' | 'content_execution_notifications' };
export function ensureAgentNotifications() {
  ensureAgentExecutionSchema(db);
}
export function recoverAgentNotifications() {
  ensureAgentNotifications();
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_execution_notifications'").get()) db.prepare("UPDATE content_execution_notifications SET state='unknown',error='服务重启时发送回执未知，禁止自动重复发送',updated_at=? WHERE state='sending'").run(now());
  db.prepare("UPDATE agent_execution_notifications SET state='unknown',error='服务重启时发送回执未知，禁止自动重复发送',updated_at=? WHERE state='sending'").run(now());
}
let sending = false;
/** 可信服务入口：只重试明确失败的当前轮通知，不重派任务；unknown 必须先核对送达事实。 */
export async function retryAgentNotification(input:{taskId:string;attempt:number;source:string;conversationId:string}) {
  ensureAgentNotifications();
  const accepted=db.transaction(()=>{
    const row=db.prepare(`SELECT n.state,n.source,n.destination,a.attempt,j.state AS job_state,j.snapshot_json
      FROM agent_execution_notifications n JOIN agent_tasks a ON a.id=n.task_id JOIN agent_execution_jobs j ON j.task_id=n.task_id WHERE n.task_id=?`).get(input.taskId) as {state:string;source:string;destination:string;attempt:number;job_state:string;snapshot_json:string}|undefined;
    if(!row)throw new Error('通知不存在');
    const snapshot=JSON.parse(row.snapshot_json);
    if(!input.conversationId||row.source!==input.source||row.destination!==input.conversationId||snapshot.source!==input.source||snapshot.source_conversation_id!==input.conversationId||row.attempt!==input.attempt||(snapshot.attempt??1)!==input.attempt)throw new Error('通知身份或轮次不匹配');
    if(!['completed','needs_human'].includes(row.job_state))throw new Error('任务尚未终结');
    if(row.state==='sent'||row.state==='pending')return false;
    if(row.state!=='failed')throw new Error('通知送达结果未知或正在发送，不能重试');
    db.prepare("UPDATE agent_execution_notifications SET state='pending',error=NULL,updated_at=? WHERE task_id=? AND state='failed'").run(now(),input.taskId);
    db.prepare("INSERT INTO agent_execution_events(task_id,kind,detail,created_at) VALUES(?,'notification_retry_requested',?,?)").run(input.taskId,JSON.stringify({attempt:input.attempt}),now());
    return true;
  }).immediate();
  await deliverAgentNotifications();return {accepted};
}
export async function deliverAgentNotifications() {
  if ((process.env.WORKBENCH_DEVICE_ROLE ?? 'primary') !== 'primary' || sending) return;
  sending = true;
  try {
    dispatchRuntime(); ensureAgentNotifications();
    const terminals = db.prepare(`SELECT a.id,COALESCE(json_extract(j.snapshot_json,'$.source'),a.source) AS source,COALESCE(json_extract(j.snapshot_json,'$.source_conversation_id'),a.source_conversation_id) AS source_conversation_id,j.state,j.error FROM agent_tasks a
      JOIN agent_execution_jobs j ON j.task_id=a.id LEFT JOIN agent_execution_notifications n ON n.task_id=a.id
      WHERE j.state IN ('completed','needs_human') AND n.task_id IS NULL`).all() as Array<{ id:string; source:string; source_conversation_id:string|null; state:string; error:string|null }>;
    for (const task of terminals) {
      const artifact = agentResult(task.id);
      // 发送正文是通过验收的成果，不再调用模型生成可能失真的摘要。
      const body = task.state === 'completed' && artifact?.reviewed
        ? `${task.id} 已通过独立验收。\n报告可在工作台任务成果中查看。`
        : `${task.id} 尚未完成。${(task.error ?? '成果凭证不可用，需要核对。').split('\n')[0].slice(0,100)}`;
      db.prepare(`INSERT OR IGNORE INTO agent_execution_notifications(task_id,source,destination,body,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
        .run(task.id, task.source, task.source_conversation_id ?? '', body, now(), now());
    }
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_execution_notifications'").get()) {
      const contentTasks=db.prepare(`SELECT j.task_id,j.state,j.error,j.note_id,j.snapshot_json FROM content_execution_jobs j
        LEFT JOIN content_execution_notifications n ON n.task_id=j.task_id WHERE j.state IN ('completed','needs_human') AND n.task_id IS NULL`).all() as Array<{task_id:string;state:string;error:string;note_id:number;snapshot_json:string}>;
      for(const task of contentTasks){
        const source=JSON.parse(task.snapshot_json);const artifact=agentResult(task.task_id);
        const body=task.state==='completed'&&artifact
          ? `${task.task_id}：已完成，${task.note_id?'转写与总结已保存到随手记':'成果已保存'}。`
          : `${task.task_id}：${artifact?(task.note_id?'转写与总结已保存到随手记。':'整理成果已生成。'): '尚未完成。'}${(task.error??'请查看任务详情。').replace(/^转写及整理成果已生成；/,'').split('\n')[0].slice(0,100)}`;
        db.prepare('INSERT OR IGNORE INTO content_execution_notifications(task_id,source,destination,body,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(task.task_id,source.source,source.source_conversation_id??'',body,now(),now());
      }
    }
    const rows = db.prepare("SELECT *, 'agent_execution_notifications' AS ledger FROM agent_execution_notifications WHERE state='pending'").all() as Notification[];
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_execution_notifications'").get())rows.push(...db.prepare("SELECT *, 'content_execution_notifications' AS ledger FROM content_execution_notifications WHERE state='pending'").all() as Notification[]);
    for (const row of rows) {
      if (!db.prepare(`UPDATE ${row.ledger} SET state='sending',updated_at=? WHERE task_id=? AND state='pending'`).run(now(),row.task_id).changes) continue;
      let state = 'failed'; let error: string | null = null; let messageId: string | null = null;
      try {
        if (!row.destination) throw new Error('缺少原始会话身份，未发送');
        if (row.source === 'weixin') {
          const result = await sendClawbotMessage(row.body, row.destination);
          state = result.ok ? 'sent' : result.outcome === 'unknown' ? 'unknown' : 'failed'; error = result.error ?? null; messageId = result.messageId ?? null;
        } else if (row.source === 'feishu') {
          const { sendFeishuBotMessage } = await import('./feishu-bot.js');
          const result = await sendFeishuBotMessage('chat_id',row.destination,row.body);
          messageId = result.messageId; state = messageId ? 'sent' : 'unknown';
         } else if (row.source === 'workbench') {
          // 本地通知没有外部发送事实：会话消息与 sent 必须一起提交或一起回滚。
          db.transaction(() => {
            ensureSession(row.destination,{title:'任务结果'});
            appendMessage(row.destination,'assistant',row.body,{agentTaskIds:[row.task_id]});
            const changed=db.prepare(`UPDATE ${row.ledger} SET state='sent',updated_at=? WHERE task_id=? AND state='sending'`).run(now(),row.task_id);
            if(!changed.changes)throw new Error('本地通知状态已变化，消息未提交');
          })();
          continue;
        }
        else throw new Error('未知来源，未发送');
        if (state === 'sent') {
          // 先持久送达事实，后续会话写入失败不能把已发送改成未发送。
          db.prepare(`UPDATE ${row.ledger} SET state='sent',message_id=?,updated_at=? WHERE task_id=? AND state='sending'`).run(messageId,now(),row.task_id);
          const inbound = row.source === 'weixin' ? normalizeWeixinInbound({text:row.body,conversationId:row.destination,userId:row.destination})
            : row.source === 'feishu' ? normalizeFeishuInbound({text:row.body,messageId:`result-${row.task_id}`,chatId:row.destination,userId:null}) : undefined;
          const identity = inbound ? memoryIdentity(inbound) : null;
          const key = identity?.conversation ? `im:${identity.conversation}` : null;
          if (key) { ensureSession(key,{ title: row.source === 'weixin' ? '微信对话' : '任务结果' }); appendMessage(key,'assistant',row.body,{agentTaskIds:[row.task_id]}); }
        }
      } catch (cause) { error = (cause as Error).message; if (state !== 'sent') state = row.source === 'feishu' ? 'unknown' : 'failed'; }
      db.prepare(`UPDATE ${row.ledger} SET state=?,message_id=?,error=?,updated_at=? WHERE task_id=? AND state='sending'`)
        .run(state,messageId,error,now(),row.task_id);
    }
  } finally { sending = false; }
}
