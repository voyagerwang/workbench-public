/**
 * [INPUT]: 服务端任务台账、记忆条目 API、执行暂停控制与文本成果 API
 * [OUTPUT]: 记忆条目列表（增删停用）、任务模型/费用与实际模型、用量/接入验证和成果入口；读取失败保留重试
 * [POS]: 助手的可验证结果与记忆管理面板，复用 React Query 和现有 API 请求封装
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { AgentTask } from '@/lib/assistant-runtime';

// 阶段②包1：任务全过程事实链（含内容线）的中文标签与单行摘要。
const EVENT_LABELS: Record<string, string> = {
  ready_to_dispatch: '已登记，等待领取', executing: '开始执行', execution: '执行过程', execution_result: '本轮执行返回',
  review_result: '验收完成', pending_review: '提交独立验收', completed: '已交付', needs_human: '需要人工处理',
  blocked: '受阻', content_ready: '内容任务已登记', content_transcript: '转写/读取完成', content_note_saved: '成果已保存',
  content_failed: '处理失败', state_conflict: '状态冲突已隔离', switch_executor: '换执行者接手',
};
type TaskEvent = { id: number; kind: string; createdAt: string; detail: Record<string, unknown> };
const eventLine = (e: TaskEvent) => {
  const time = new Date(e.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
  const label = EVENT_LABELS[e.kind] ?? e.kind;
  const d = e.detail as { error?: unknown; message?: unknown; exitCode?: unknown; attempt?: unknown; observedModel?: unknown; chars?: unknown; title?: unknown; noteId?: unknown; from?: unknown; to?: unknown; usage?: unknown };
  const bits: string[] = [];
  if (typeof d.attempt === 'number') bits.push(`第 ${d.attempt} 轮`);
  if (typeof d.title === 'string' && d.title) bits.push(`《${d.title}》`);
  if (typeof d.chars === 'number') bits.push(`${d.chars} 字`);
  if (typeof d.observedModel === 'string' && d.observedModel) bits.push(`模型 ${d.observedModel}`);
  if (d.usage && typeof d.usage === 'object') { const u = d.usage as { inputTokens?: unknown; outputTokens?: unknown }; if (typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number') bits.push(`用量 ${u.inputTokens}+${u.outputTokens} token`); }
  if (typeof d.noteId === 'number') bits.push(`笔记 #${d.noteId}`);
  if (typeof d.from === 'string' && typeof d.to === 'string') bits.push(`${d.from} → ${d.to}`);
  if (typeof d.error === 'string' && d.error) bits.push(d.error);
  if (typeof d.message === 'string' && d.message) {
    const messages: Record<string,string> = { command_execution: '执行本机操作', mcp_tool_call: '调用外部工具', web_search: '检索网页', agent_message: '返回执行说明', file_change: '修改项目文件', error: '执行器报告错误' };
    if (!d.message.startsWith('{')) bits.push(messages[d.message] ?? d.message);
  }
  if (typeof d.exitCode === 'number' && d.exitCode !== 0) bits.push(`操作退出码 ${d.exitCode}`);
  return `${time} · ${label}${bits.length ? '：' + bits.join(' · ') : ''}`;
};

export function AgentTaskDetail({ task }: { task: AgentTask }) {
  const qc=useQueryClient();
  const [open,setOpen]=useState(false),[editing,setEditing]=useState(false),[feedback,setFeedback]=useState(''),[busy,setBusy]=useState(false);
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID());
  const actions=useQuery({queryKey:['agent-task-actions',task.id,task.updatedAt],queryFn:()=>api.assistantAgentActions(task.id),enabled:open});
  const skill=useQuery({queryKey:['skill-capture-task',task.id,task.updatedAt],queryFn:()=>api.skillCaptureContentTask(task.id),enabled:open&&/Skill|技能/i.test(task.objective),retry:false});
  const act=async(retry=false)=>{
    const a=actions.data;if(!a?.conversationId||busy)return;setBusy(true);
    try{
      if(retry)await api.retryAgentNotification(task.id,{conversationId:a.conversationId,attempt:a.attempt});
      else await api.reviseAgentTask(task.id,{conversationId:a.conversationId,expectedAttempt:a.attempt,requestId,feedback});
      setEditing(false);setFeedback('');setRequestId(crypto.randomUUID());
      await qc.invalidateQueries({queryKey:['assistant-agent-tasks']});await actions.refetch();toast.success(retry?'通知重试已处理':'修改要求已提交');
    }catch(e){toast.error((e as Error).message);}finally{setBusy(false);}
  };
  const [showResult, setShowResult] = useState(false);
  const result = useQuery({ queryKey: ['assistant-agent-result', task.id, task.updatedAt], queryFn: () => api.assistantAgentResult(task.id), enabled: showResult, retry: false });
  // S20 阶段用量：未知尝试不记 0，也不把已报告合计当成费用或供应商硬封顶。
  const taskUsage = useQuery({ queryKey: ['agent-task-usage', task.id, task.updatedAt], queryFn: () => api.assistantAgentTaskUsage(task.id), enabled: open, retry: false });
  const running = ['executing', 'pending_review', 'dispatched', 'acknowledged'].includes(task.status);
  const taskEvents = useQuery({ queryKey: ['agent-task-events', task.id, task.updatedAt], queryFn: () => api.assistantAgentTaskEvents(task.id), enabled: open || running, refetchInterval: running ? 5000 : false, retry: false });
  const latestEvent = taskEvents.data?.events?.[0];
  const stageTokens = (stage: 'execution' | 'review') => taskUsage.data?.usage.attempts.filter((a) => a.stage === stage && a.reported).reduce((n, a) => n + (a.inputTokens ?? 0) + (a.outputTokens ?? 0), 0) ?? null;
  return <details data-agent-detail className="rounded-xl border border-line bg-surface-1 p-3 text-xs" onToggle={e=>{
    const element=e.currentTarget;setOpen(element.open);
    if(element.open)document.querySelectorAll<HTMLDetailsElement>('details[data-agent-detail]').forEach(other=>{if(other!==element)other.open=false;});
  }}>
    <summary className="cursor-pointer break-words text-ink"><span className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 text-ink-2">{task.statusLabel ?? '状态待核对'}</span>{task.objective}{running && latestEvent && <span className="mt-1 block text-[11px] font-normal text-ink-3">最近进展 · {eventLine(latestEvent)}</span>}{!running && ['needs_human','failed','blocked'].includes(task.status) && <span className="mt-1 block whitespace-pre-wrap text-[11px] font-normal text-warn">{task.statusDetail?.split('\n')[0]}</span>}</summary>
    <div className="mt-3 space-y-2 break-words text-ink-3">
      <p className="whitespace-pre-wrap">{task.statusDetail}</p>
      <p>任务编号：{task.id}</p>
      {actions.data&&<p>第 {actions.data.attempt} 轮{actions.data.notificationState==='unknown'?' · 通知送达待核对':''}</p>}
      {actions.data?.conversationId&&<a className="inline-block text-accent underline" href={`/assistant?session=${encodeURIComponent(actions.data.conversationId)}`}>回到任务对话</a>}
      {skill.data?.status==='generating'&&<span>Skill 正在提炼，完成后自动写入本地库。</span>}
      {skill.data?.status==='draft'&&<span>Skill 候选已生成，正在写入本地库…</span>}
      {skill.data?.status==='saved'&&skill.data.saved&&<a className="inline-block text-accent underline" href={`/ai-resources/skills?skill=${encodeURIComponent(skill.data.saved.id)}`}>查看已保存 Skill</a>}
      {open&&/Skill|技能/i.test(task.objective)&&task.status==='needs_human'&&!skill.isError&&(skill.data===null||skill.data?.status==='failed'||skill.data?.status==='cancelled')&&<button type="button" className="text-accent underline" disabled={busy} onClick={async()=>{setBusy(true);try{await api.skillCaptureRetryContentTask(task.id);const result=await skill.refetch();if(result.data?.status==='saved')toast.success('Skill 已提炼并保存到本地');else toast.error(result.data?.error??'候选尚未就绪，请核对状态')}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}}>重新提炼 Skill</button>}
      {actions.isError&&<button type="button" onClick={()=>void actions.refetch()}>操作状态读取失败，点击重试</button>}
      {actions.data?.canRevise&&<button type="button" className="text-accent underline" disabled={busy} onClick={()=>setEditing(!editing)}>修改要求</button>}
      {editing&&actions.data?.canRevise&&<div className="space-y-2"><textarea aria-label="修改要求" className="w-full rounded border border-line bg-surface p-2 text-ink" maxLength={2000} value={feedback} disabled={busy} onChange={e=>{setFeedback(e.target.value);setRequestId(crypto.randomUUID());}} placeholder="说明需要调整的内容，旧成果会保留"/><button type="button" className="text-accent" disabled={busy||!feedback.trim()} onClick={()=>void act()}>{busy?'正在提交…':'提交修改'}</button></div>}
      {actions.data?.canRetryNotification&&<button type="button" className="ml-2 text-accent underline" disabled={busy} onClick={()=>void act(true)}>重新发送通知</button>}
      <p>来源：{{ weixin: '微信', feishu: '飞书', workbench: '工作台' }[task.source] ?? task.source} · 执行者：{task.executor ?? '尚未选择'}</p>
      <p>关联项目：{task.projectName ?? '未选择'} · 执行目录：{task.projectPath ?? '尚未验证'}</p>
      <p>指定模型：{task.requestedModel ?? '未指定'} · 费用要求：{task.requestedCostPolicy === 'free_only' ? '仅免费，不扣金额/付费积分' : '未指定'}</p>
      <p>实际模型：{task.observedModel ?? '尚未收到执行端证据'}{task.requestedCostPolicy === 'free_only' ? '；开始前须核实当前免费档位，不自动改用付费模型。' : ''}</p>
      {taskUsage.data?.usage && (taskUsage.data.usage.totals.reportedAttempts > 0 || taskUsage.data.usage.totals.unknownAttempts > 0) ? <p>Token 用量：执行 {stageTokens('execution') ?? '未知'} · 验收 {stageTokens('review') ?? '未知'}{taskUsage.data.usage.totals.unknownAttempts > 0 ? ` · ${taskUsage.data.usage.totals.unknownAttempts} 次用量未知（不记 0，未计入合计）` : ''}——已报告部分合计，不等于费用，也不是供应商单次硬封顶。</p> : null}
      {taskUsage.isError && <p className="text-danger">用量读取失败，可展开重试。</p>}
      {taskEvents.data?.events?.length ? <div className="rounded-lg border border-line bg-surface-2 p-2">
        <p className="font-medium text-ink-2">任务过程（含内容线，最新在后）</p>
        <div className="mt-1 space-y-0.5">{[...taskEvents.data.events].reverse().map((e) => <p key={e.id}>{eventLine(e)}</p>)}</div>
      </div> : null}
      {taskEvents.isError && <p className="text-danger">任务过程读取失败，可展开重试。</p>}
      {['completed', 'pending_review', 'needs_human'].includes(task.status) ? <div>
        <button type="button" className="text-accent underline" onClick={() => setShowResult(!showResult)}>{showResult ? '收起报告' : skill.data?.status==='saved' ? '查看原始内容成果' : task.status === 'completed' ? '查看已验收报告' : '查看本次成果（尚未通过验收）'}</button>
        {showResult && (result.isError ? <button type="button" className="mt-2 block text-danger" onClick={() => void result.refetch()}>{(result.error as Error).message} · 点击重试</button> : result.isPending ? <p className="mt-2">正在读取报告…</p> : <pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded bg-surface p-3 font-sans text-xs text-ink">{result.data}</pre>)}
      </div> : <p>成果：尚未生成</p>}
      {task.updatedAt && <p>状态更新于 {task.updatedAt.replace('T', ' ')}</p>}
    </div>
  </details>;
}

export function AgentTaskCards({ ids }: { ids: string[] }) {
  const query = useQuery({ queryKey: ['assistant-agent-tasks', ...ids], queryFn: () => Promise.all(ids.map((id) => api.assistantAgentTask(id))), refetchInterval: 5000 });
  if (query.isError) return <button type="button" className="text-xs text-danger" onClick={() => void query.refetch()}>任务状态读取失败，点击重试</button>;
  return <div className="mt-2 space-y-2">{query.isPending ? <p className="text-xs text-ink-3">正在读取任务状态…</p> : query.data.map(({ task }) => <AgentTaskDetail key={task.id} task={task} />)}</div>;
}

const MEMORY_KIND_LABEL: Record<string, string> = {
  preference: '对话偏好', fact: '背景事实', skill_preference: 'Skill偏好', task_preference: '任务偏好',
};

export function AssistantRuntimePanel({ sessionKey }: { sessionKey: string }) {
  const qc = useQueryClient();
  const memory = useQuery({ queryKey: ['assistant-memory', sessionKey], queryFn: () => api.assistantMemory(sessionKey) });
  const tasks = useQuery({ queryKey: ['assistant-agent-tasks'], queryFn: api.assistantAgentTasks, refetchInterval: 5000 });
  const execution = useQuery({ queryKey: ['assistant-execution'], queryFn: api.assistantExecution, refetchInterval: 5000 });
  const [changingExecution, setChangingExecution] = useState(false);
  const toggleExecution = async () => {
    if (!execution.data) return;
    setChangingExecution(true);
    try { await api.pauseAssistantExecution(!execution.data.paused); await execution.refetch(); await tasks.refetch(); }
    catch (error) { toast.error((error as Error).message); }
    finally { setChangingExecution(false); }
  };
  const executors = useQuery({ queryKey: ['assistant-executors'], queryFn: api.assistantExecutors });
  const usage = useQuery({ queryKey: ['assistant-usage'], queryFn: api.assistantUsage });
  const [newEntry, setNewEntry] = useState('');
  const [newKind, setNewKind] = useState<'preference' | 'fact' | 'skill_preference' | 'task_preference'>('preference');
  const [entryBusy, setEntryBusy] = useState(false);
  const external = sessionKey.startsWith('im:');
  const refreshEntries = () => void qc.invalidateQueries({ queryKey: ['assistant-memory', sessionKey] });
  const addEntry = async () => {
    if (!newEntry.trim() || entryBusy) return;
    setEntryBusy(true);
    try { await api.addMemoryEntry(sessionKey, { content: newEntry, kind: newKind }); setNewEntry(''); refreshEntries(); }
    catch (error) { toast.error((error as Error).message); }
    finally { setEntryBusy(false); }
  };
  const toggleEntry = async (id: number, status: 'active' | 'disabled') => {
    try { await api.setMemoryEntryStatus(sessionKey, id, status === 'active' ? 'disabled' : 'active'); refreshEntries(); }
    catch (error) { toast.error((error as Error).message); }
  };
  const removeEntry = async (id: number) => {
    try { await api.deleteMemoryEntry(sessionKey, id); refreshEntries(); }
    catch (error) { toast.error((error as Error).message); }
  };
  const refresh = () => { void tasks.refetch(); void usage.refetch(); void executors.refetch(); void execution.refetch(); };
  const entries = memory.data?.entries ?? [];
  return <div className="min-w-0 max-h-[65vh] overflow-y-auto border-b border-line bg-surface-1 p-4 text-sm" aria-label="任务与记忆面板">
    <div className="flex items-center justify-between"><strong>任务与记忆</strong><button type="button" onClick={refresh} className="text-xs text-accent">刷新状态与用量</button></div>
    <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="space-y-3">
        <p className="font-medium">小精灵的记忆</p>
        <p className="text-xs text-ink-3">对话里随口说出的偏好、背景事实和 Skill/任务执行偏好，小精灵会沉淀到这里，同一入口的后续对话自动生效。</p>
        {memory.isError ? <button type="button" className="text-xs text-danger" onClick={() => void memory.refetch()}>记忆读取失败，点击重试</button> : <>
          {external && <p className="text-xs text-ink-3">这是 IM 对话的存档。请在原入口发送「记住：…」「查看记忆」「忘记：关键词」管理该入口的记忆。</p>}
          <ul className="space-y-2" aria-label="记忆条目">
            {memory.isPending ? <li className="text-xs text-ink-3">正在读取记忆…</li> : entries.length ? entries.map((entry) => <li key={entry.id} className="rounded-xl border border-line p-2.5 text-xs">
              <div className="flex items-start justify-between gap-2">
                <p className={entry.status === 'disabled' ? 'text-ink-3 line-through' : 'text-ink'}>{entry.content}</p>
                <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">{MEMORY_KIND_LABEL[entry.kind] ?? '记忆'}</span>
              </div>
              {!external && <div className="mt-1.5 flex items-center gap-3 text-[11px]">
                <button type="button" className="text-accent" onClick={() => void toggleEntry(entry.id, entry.status)}>{entry.status === 'active' ? '停用' : '启用'}</button>
                <button type="button" className="text-ink-3" onClick={() => void removeEntry(entry.id)}>删除</button>
                <span className="text-ink-3">{entry.updatedAt.replace('T', ' ').slice(0, 16)}</span>
              </div>}
            </li>) : <li className="text-xs text-ink-3">还没有记忆。直接在对话里说「记住：……」，或在下方添加。</li>}
          </ul>
          {!external && <div className="space-y-2 border-t border-line pt-3">
            <div className="flex gap-2">
              <input aria-label="新记忆内容" maxLength={600} value={newEntry} onChange={(e) => setNewEntry(e.target.value)}
                placeholder="例如：周报先写结论，再写明细" className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1.5 text-xs text-ink" />
              <button type="button" disabled={entryBusy || !newEntry.trim()} onClick={() => void addEntry()}
                className="rounded bg-accent px-3 py-1.5 text-xs text-accent-ink disabled:opacity-40">{entryBusy ? '保存中…' : '添加'}</button>
            </div>
            <select aria-label="记忆类型" value={newKind} onChange={(e) => setNewKind(e.target.value as typeof newKind)} className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink">
              {Object.entries(MEMORY_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>}
        </>}
        <div className="border-t border-line pt-3 text-xs text-ink-3">
          <p className="mb-1 font-medium text-ink">近期 100 次助手请求用量</p>
          {usage.isError ? <p>用量读取失败，请刷新重试。</p> : usage.data ? <>
            <p>{usage.data.requests} 次请求 · {usage.data.modelCalls} 次模型调用 · {usage.data.failedRequests} 次请求失败</p>
            <p>已报告输入 {usage.data.inputTokens.toLocaleString()} / 输出 {usage.data.outputTokens.toLocaleString()} token</p>
            <p>供应商用量覆盖：{usage.data.reportedCalls}/{usage.data.modelCalls} 次调用；未报告部分未知。</p>
            <p>缓存命中 {usage.data.cachedTokens.toLocaleString()} token（{usage.data.cacheReportedCalls} 次调用报告）。</p>
            <p>仅统计助手请求内的模型循环，其他功能与外部 Agent 不在此口径内。</p>
          </> : <p>正在读取用量…</p>}
        </div>
      </div>
      <div className="space-y-2">
        <div className="mb-4 space-y-2" aria-label="执行器接入验证">
          <div className="rounded-xl border border-line p-3 text-xs">
            <div className="flex items-center justify-between gap-3"><p className="font-medium">任务执行 · {execution.isError ? '状态读取失败' : !execution.data ? '读取中…' : !execution.data.enabled ? '尚未配置开放' : execution.data.paused ? '已暂停' : '已启用'}</p>
              <button type="button" className="text-accent disabled:opacity-40" disabled={!execution.data?.enabled || execution.isError || changingExecution} onClick={() => void toggleExecution()}>{changingExecution ? '更新中…' : execution.data?.paused ? '恢复执行' : '暂停执行'}</button></div>
            <p className="mt-2 text-ink-3">当前仅支持已授权项目的 Codex 只读研究与文档任务，报告经独立验收后才标记完成。</p>
            <p className="mt-1 text-ink-3">暂停会停止领取新任务，并请求终止当前本机执行；远端是否停止需另行核对。历史登记与失败任务不会自动重派。</p>
          </div>
          <p className="font-medium">软件接入验证</p>
          {executors.isError ? <p className="text-xs text-danger">接入状态读取失败，请刷新重试。</p> : executors.isPending ? <p className="text-xs text-ink-3">正在读取…</p> : executors.data.executors.map((item) => <div key={item.id} className="rounded-xl border border-line p-3 text-xs text-ink-3">
            <p className="mb-1 font-medium text-ink">{item.name} · {item.label}</p>
            <p>{item.summary}</p>
            {item.artifactUrl?.startsWith('/api/assistant/agent-tasks/') ? <p className="mt-2">最近任务已验收，报告见下方任务详情。</p> : item.artifactUrl && <a href={item.artifactUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-accent underline">查看验收清单（草稿）</a>}
            {item.reportedTotalTokens !== null && <p className="mt-1">本次{item.sampleKind === 'document' ? '文档生成' : '通信'}探针：{item.reportedTotalTokens.toLocaleString()} token（含缓存，按软件报告口径）{item.durationMs !== null ? ` · ${(item.durationMs / 1000).toFixed(1)} 秒` : ''}</p>}
            {item.sampleKind === 'project' && <>
              <p className="mt-1">本次项目探针：输入 {item.reportedInputTokens?.toLocaleString() ?? '未知'} / 输出 {item.reportedOutputTokens?.toLocaleString() ?? '未知'} token{item.durationMs !== null ? ` · ${(item.durationMs / 1000).toFixed(1)} 秒` : ''}</p>
              <p>缓存读取 {item.reportedCacheReadTokens?.toLocaleString() ?? '未知'} / 写入 {item.reportedCacheCreationTokens?.toLocaleString() ?? '未知'} token；保留软件原始口径，不叠加推算总量。</p>
            </>}
            <p className="mt-1">{item.artifactUrl?.startsWith('/api/assistant/agent-tasks/') ? '正式任务验收记录' : '探针结果仅用于接入验证'}{item.checkedAt ? ` · 验证于 ${new Date(item.checkedAt).toLocaleString()}` : ''}</p>
          </div>)}
        </div>
        <p className="font-medium">任务记录 · 最近 100 条</p><p className="text-xs text-ink-3">状态自动刷新，失败原因和已生成报告可在任务详情中查看。</p>
        {tasks.isError ? <p className="text-xs text-danger">任务读取失败，请刷新重试。</p> : tasks.isPending ? <p className="text-xs text-ink-3">正在读取…</p> : tasks.data.tasks.length ? tasks.data.tasks.map((task) => <AgentTaskDetail key={task.id} task={task} />) : <p className="text-xs text-ink-3">还没有登记任务。</p>}
      </div>
    </div>
  </div>;
}
