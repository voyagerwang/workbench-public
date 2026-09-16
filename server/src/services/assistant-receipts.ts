/**
 * [INPUT]: 服务端任务/派发/写入凭证与入口类型
 * [OUTPUT]: 以真实登记状态为准的简短操作回执
 * [POS]: 对话展示边界；模型措辞不得把 drafted 或待确认计划说成正在执行
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { AssistantReply } from './assistant.js';
import { getAgentTask, type AgentTaskView } from './agent-orchestrator.js';

export function shortTaskReceipt(task:AgentTaskView):string {
  const label=task.executor==='codex'?'Codex':task.executor==='workbuddy'?'WorkBuddy':task.executor==='cola'?'Cola':task.executor??'';
  let message:string;
  if(task.status==='executing')message=label?`${label} 已接手，完成后告诉你。`:'已开始处理，完成后告诉你。';
  else if(task.status==='ready_to_dispatch'||task.status==='planning')message=task.statusDetail??'收到，正在安排执行。';
  else if(task.status==='pending_review')message='成果已生成，正在验收。';
  else if(['completed','approved'].includes(task.status))message=task.statusLabel==='内容已保存'?'已完成，成果已保存。':'已完成并通过验收。';
  else if(task.status==='drafted')message=`尚未派发：${(task.statusDetail??'需要补充任务信息。').slice(0,100)}`;
  else message=(task.statusDetail??task.statusLabel??'需要处理').split('\n')[0].slice(0,120);
  return `${message}（${task.id}）`;
}

export function authoritativeReceipt(result: AssistantReply, source: string): AssistantReply {
  const pending = result.plans.filter((plan) => plan.status === 'pending_confirmation');
  if (!result.agentTasks.length && !pending.length) return result;
  const tasks=result.agentTasks.map(task=>getAgentTask(task.id)??task);
  const lines = tasks.map(shortTaskReceipt);
  if (pending.length) lines.push(`有 ${pending.reduce((n, p) => n + p.itemCount, 0)} 条消息尚未发送。${source === 'workbench' ? '请在确认卡中确认发送' : '请打开工作台，在助手对话的确认卡中确认发送'}（15 分钟内有效）。`);
  if (result.actions.length) lines.push('另有外部消息已登记发送，发送结果以派单回执为准。');
  if (result.captured) lines.push(`另已保存 ${result.captured.items.length} 条工作台记录。`);
  if (result.captureError) lines.push(result.captureError);
  return { ...result, agentTasks:tasks, reply: lines.join('\n') };
}
