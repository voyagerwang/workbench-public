/**
 * [INPUT]: 服务端各业务 HTTP API，包括知识版本、正式执行控制和文本成果契约
 * [OUTPUT]: 统一 JSON/上传/文件下载封装和页面所需的类型化调用
 * [POS]: 工作台前端与服务端之间唯一请求边界，知识引用始终携带资料版本
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
// 极简类型化 API client
import type {
  DocumentAttachment,
  AssistantContext, AssistantMessage, AssistantReply, AssistantAction, AssistantDispatchPlan, AssistantDispatchItem, AssistantSessionRecord,
  BrowseBranch, BrowseNode, CalendarEvent, CaptureResult, Colleague, DocumentEvidence, DocumentTag, Fragment, FragmentDeleteResult, FragmentType, KnowledgeArchive, KnowledgeAuthorizationJob, KnowledgeBaseline, KnowledgeConnectorStatus, KnowledgeDocumentSearchHit, KnowledgeDocumentVersion, KnowledgeItem, KnowledgeItemKind, KnowledgeProvider, KnowledgeSyncJob, KnowledgeSyncScope, KnowledgeTag, KnowledgeTopic, MeetingRoom, MoodSnapshot, Note, NoteWrite, Project, PromptItem, ReclassifyResult, RemoteDoc, Reminder, ReminderPatch, Settings, SkillSummary, SkillCaptureDraft, KnowledgePoolData, SourceDocumentDetail, StoredAssistantMessage, TagBatchOp, TagBatchResult, TagItems, Task, TopicDetail, TopicUnderstanding, TrashData, TrashDetail, TrashType, WeeklyReview, ReviewWeekInfo,
} from '@/types';

/** 周回顾选取：本周(offset:0) / 上周(offset:1) / 自选某一周(weekStart=该周周一) */
export interface WeekSel {
  offset?: number;
  weekStart?: string;
  /** 仅用于界面展示，后端忽略 */
  label?: string;
}

export type { Colleague, MeetingRoom };
import { orbTrack } from '@/store/orbActivity';

async function http<T>(url: string, init?: RequestInit, responseKind: 'json' | 'text' = 'json'): Promise<T> {
  // 只在有 body 时带 Content-Type：Fastify 会拒绝「JSON 头 + 空 body」的无 body 请求（如 DELETE）
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      // Fastify 的默认错误体把具体原因放在 message，error 通常只是 Bad Request/Bad Gateway。
      if (body.message || body.error) msg = body.message ?? body.error!;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (responseKind === 'text' ? res.text() : res.json()) as Promise<T>;
}

async function download(url: string): Promise<void> {
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = ''; document.body.append(anchor); anchor.click(); anchor.remove();
}

export const api = {
  assistantExecution: () => http<import('./assistant-runtime').AssistantExecution>('/api/assistant/execution'),
  pauseAssistantExecution: (paused: boolean) => http<{ paused: boolean }>('/api/assistant/execution/pause', { method: 'POST', body: JSON.stringify({ paused }) }),
  assistantAgentResult: (id: string) => http<string>(`/api/assistant/agent-tasks/${encodeURIComponent(id)}/result`, undefined, 'text'),
  assistantExecutors: () => http<{ executors: import('./assistant-runtime').ExecutorReadiness[] }>('/api/assistant/executors'),
  assistantAgentTasks: () => http<{ tasks: import('./assistant-runtime').AgentTask[] }>('/api/assistant/agent-tasks'),
  assistantAgentTask: (id: string) => http<{ task: import('./assistant-runtime').AgentTask }>(`/api/assistant/agent-tasks/${encodeURIComponent(id)}`),
  assistantAgentActions: (id:string)=>http<{attempt:number;conversationId:string|null;canRevise:boolean;canRetryNotification:boolean;notificationState:string|null}>(`/api/assistant/agent-tasks/${encodeURIComponent(id)}/actions`),
  reviseAgentTask:(id:string,input:{conversationId:string;expectedAttempt:number;requestId:string;feedback:string})=>http(`/api/assistant/agent-tasks/${encodeURIComponent(id)}/revise`,{method:'POST',body:JSON.stringify(input)}),
  retryAgentNotification:(id:string,input:{conversationId:string;attempt:number})=>http(`/api/assistant/agent-tasks/${encodeURIComponent(id)}/retry-notification`,{method:'POST',body:JSON.stringify(input)}),
  assistantMemory: (key: string) => http<import('./assistant-runtime').AssistantMemory>(`/api/assistant/memory/${encodeURIComponent(key)}`),
  saveAssistantMemory: (key: string, patch: { instructions?: string; projectId?: number | null }) => http<import('./assistant-runtime').AssistantMemory>(`/api/assistant/memory/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  addMemoryEntry: (key: string, input: { content: string; kind: 'preference' | 'fact' | 'skill_preference' | 'task_preference' }) => http<import('./assistant-runtime').MemoryEntry>(`/api/assistant/memory/${encodeURIComponent(key)}/entries`, { method: 'POST', body: JSON.stringify(input) }),
  setMemoryEntryStatus: (key: string, id: number, status: 'active' | 'disabled') => http<import('./assistant-runtime').MemoryEntry>(`/api/assistant/memory/${encodeURIComponent(key)}/entries/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  deleteMemoryEntry: (key: string, id: number) => http<{ ok: boolean }>(`/api/assistant/memory/${encodeURIComponent(key)}/entries/${id}`, { method: 'DELETE' }),
  sessionActivity: () => http<{ activity: Record<string, import('./assistant-runtime').SessionTaskActivity> }>('/api/assistant/sessions/activity'),
  assistantUsage: () => http<import('./assistant-runtime').AssistantUsage>('/api/assistant/usage'),
  // 助手对话：普通回答之外，服务端会把模型产出的条目直接落库，并在 captured 里回传凭证。
  //
  // 会话由服务端持有：这里只发「这一轮的新消息」，历史由服务端从库里读，
  // 所以刷新、换浏览器看到的都是同一份对话。seed 仅用于把老 localStorage 会话补种进库一次。
  assistantChat: (message: string, context: AssistantContext, sessionKey: string, seed?: AssistantMessage[], skillIds?: string[], images?: string[]) =>
    orbTrack(http<AssistantReply>('/api/assistant/chat', {
      method: 'POST',
      body: JSON.stringify({ message, context: {...context, ...(skillIds?.length ? { skillIds } : {})}, sessionKey, ...(seed?.length ? { seed } : {}), ...(images?.length ? { images } : {}) }),
    })),

  /**
   * 重新发送最后一轮：服务端把会话退回到那条用户消息之前重跑，**不新开会话**。
   * 返回的 appended 就是本轮新的两条消息，replaced 是被覆盖掉的旧消息条数。
   */
  assistantResend: (sessionKey: string) =>
    orbTrack(http<AssistantReply & { replaced: number }>('/api/assistant/chat/resend', {
      method: 'POST', body: JSON.stringify({ sessionKey }),
    })),

  noteAssistantSession: (body: { noteId?: number; draftKey?: string; title?: string }) =>
    http<{ session: AssistantSessionRecord }>('/api/assistant/note-session', { method: 'POST', body: JSON.stringify(body) }),

  // ── 会话档案 ──────────────────────────────────────────────────────────
  assistantSessions: (limit = 50) => http<{ sessions: AssistantSessionRecord[] }>(`/api/assistant/sessions?limit=${limit}`),
  /** 进入会话时拉全量历史；本地缓存以它为准覆盖。404 表示服务端还没有这个会话。 */
  assistantSession: (key: string) =>
    http<{ session: AssistantSessionRecord; messages: StoredAssistantMessage[] }>(
      `/api/assistant/sessions/${encodeURIComponent(key)}`,
    ),
  renameAssistantSession: (key: string, title: string) =>
    http<{ session: AssistantSessionRecord }>(`/api/assistant/sessions/${encodeURIComponent(key)}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    }),
  deleteAssistantSession: (key: string) =>
    http<{ ok: true }>(`/api/assistant/sessions/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  // 派出去的外部动作（当前只有飞书派单）。状态由服务端后台轮询推进，前端只展示。
  assistantActions: (limit = 20) => http<{ actions: AssistantAction[] }>(`/api/assistant/actions?limit=${limit}`),
  assistantAction: (id: string) => http<{ action: AssistantAction }>(`/api/assistant/actions/${encodeURIComponent(id)}`),
  /** 人工结案：分类器没认出终态、或自己确认已经做完了。 */
  resolveAssistantAction: (id: string, status: 'succeeded' | 'failed', note?: string) =>
    http<{ action: AssistantAction }>(`/api/assistant/actions/${encodeURIComponent(id)}/resolve`, {
      method: 'POST', body: JSON.stringify({ status, note }),
    }),
  /** 未读的终态结果：机器人回没回，不打开对话也能知道。 */
  unreadAssistantActions: () => http<{ actions: AssistantAction[] }>('/api/assistant/actions/unread'),
  /** 看过就标已读；不传 ids 表示全部已读。 */
  readAssistantActions: (ids?: string[]) =>
    http<{ updated: number }>('/api/assistant/actions/read', { method: 'POST', body: JSON.stringify({ ids }) }),
  /** 不等下一个调度周期，立刻扫一遍。 */
  pollAssistantActions: () => http<{ scanned: number; updated: number; errors: string[] }>('/api/assistant/actions/poll', { method: 'POST' }),
  /**
   * 手动重发护栏：已发出过（outboundMessageId 非空）返回 resent:false + 409，绝不二发；
   * 没发出过才真正重发。前端据此给「已发送，无需重发」提示。
   */
  retryAssistantAction: (id: string) =>
    http<{ action: AssistantAction; resent: boolean }>(`/api/assistant/actions/${encodeURIComponent(id)}/retry`, { method: 'POST' }),

  // 原子派发计划：确认/取消只提交 plan id，正文与目标由服务端冻结。
  assistantDispatchPlan: (id: string) =>
    http<{ plan: AssistantDispatchPlan }>(`/api/assistant/dispatch-plans/${encodeURIComponent(id)}`),
  confirmAssistantDispatchPlan: (id: string) =>
    http<{ plan: AssistantDispatchPlan }>(`/api/assistant/dispatch-plans/${encodeURIComponent(id)}/confirm`, { method: 'POST' }),
  cancelAssistantDispatchPlan: (id: string) =>
    http<{ plan: AssistantDispatchPlan }>(`/api/assistant/dispatch-plans/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  retryAssistantDispatchItem: (id: string) =>
    http<{ plan: AssistantDispatchPlan; item: AssistantDispatchItem }>(`/api/assistant/dispatch-items/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  recallAssistantDispatchItem: (id: string) =>
    http<{ plan: AssistantDispatchPlan }>(`/api/assistant/dispatch-items/${encodeURIComponent(id)}/recall`, { method: 'POST' }),

  // 任务
  tasks: () => http<Task[]>('/api/tasks'),
  task: (id: number) => http<Task>(`/api/tasks/${id}`),
  createTask: (b: TaskWrite & { title: string }) => http<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(b) }),
  updateTask: (id: number, b: TaskWrite) => http<Task>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  // 图片沿用原接口；文件附件使用独立资源身份，共用 HTTP 错误处理。
  uploadFile: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return http<{ url: string; size: number }>('/api/uploads', { method: 'POST', body: fd });
  },
  uploadAttachment: (file: File) => {
    const body = new FormData(); body.append('file', file);
    return http<DocumentAttachment>('/api/attachments', { method: 'POST', body });
  },
  attachment: (id: string) => http<DocumentAttachment>(`/api/attachments/${encodeURIComponent(id)}`),
  prepareAttachmentPreview: (id: string) => http<DocumentAttachment>(`/api/attachments/${encodeURIComponent(id)}/preview`, { method: 'POST' }),
  deleteTask: (id: number) => http<{ ok: true }>(`/api/tasks/${id}`, { method: 'DELETE' }),
  // 拖拽重排：整组可见列表的新顺序
  reorderTasks: (ids: number[]) => http<{ ok: true }>('/api/tasks/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),

  // 项目
  projects: () => http<Project[]>('/api/projects'),
  createProject: (b: { name: string; domain: 'work' | 'life'; description?: string }) =>
    http<Project>('/api/projects', { method: 'POST', body: JSON.stringify(b) }),
  updateProject: (id: number, b: Partial<Project>) => http<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteProject: (id: number) => http<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),

  // 碎片 / 随手记（提交与改分类期间助手切「检索资料」状态）
  fragments: (untriagedOnly = false) => http<Fragment[]>(`/api/fragments?untriaged=${untriagedOnly ? 1 : 0}`),
  captureFragment: (input: string | { content: string; richContent?: string }) => {
    const body = typeof input === 'string' ? { content: input } : input;
    return orbTrack(http<CaptureResult>('/api/fragments', { method: 'POST', body: JSON.stringify(body) }));
  },
  /** 改分类：服务端把内容迁移到目标模块，旧条目软删进回收站 */
  reclassifyFragment: (id: number, type: FragmentType, reminderAt?: string | null) =>
    orbTrack(http<ReclassifyResult>(`/api/fragments/${id}/reclassify`, { method: 'POST', body: JSON.stringify({ type, reminderAt }) })),
  deleteFragment: (id: number, mode: 'auto' | 'both' = 'auto') =>
    http<FragmentDeleteResult>(`/api/fragments/${id}${mode === 'both' ? '?mode=both' : ''}`, { method: 'DELETE' }),
  repairFragments: () => http<{ fixed: number }>('/api/fragments/repair', { method: 'POST' }),

  // 笔记
  notes: (q = '') => http<Note[]>(`/api/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  archiveNote: (id: number) => http<{ archive: KnowledgeArchive; created: boolean; sourceNoteId: number }>(`/api/knowledge/from-note/${id}`, { method: 'POST' }),
  note: (id: number) => http<Note>(`/api/notes/${id}`),
  createNote: (b: NoteWrite = {}) => http<Note>('/api/notes', { method: 'POST', body: JSON.stringify(b) }),
  updateNote: (id: number, b: NoteWrite) => http<Note>(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteNote: (id: number) => http<{ ok: true }>(`/api/notes/${id}`, { method: 'DELETE' }),
  tagBatch: (op: TagBatchOp) => http<TagBatchResult>('/api/notes/tags/batch', { method: 'POST', body: JSON.stringify(op) }),

  // AI 资源库
  skills: () => http<SkillSummary[]>('/api/ai-resources/skills'),
  scanSkills: () => http<{ skills: SkillSummary[]; scannedAt: string; roots: string[] }>('/api/ai-resources/skills/scan', { method: 'POST' }),
  skill: (id: string) => http<SkillSummary>(`/api/ai-resources/skills/${id}`),
  updateSkill: (id: string, content: string) => http<SkillSummary>(`/api/ai-resources/skills/${id}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  deleteSkill: (id: string) => http<{ ok: true; recoverable: true; trashPath: string; trashId: number }>(`/api/ai-resources/skills/${id}`, { method: 'DELETE' }),
  skillDuplicates: () => http<{ exact: SkillSummary[][]; possible: SkillSummary[][] }>('/api/ai-resources/skills/duplicates', { method: 'POST' }),
  skillCaptureContentTask: (taskId:string) => http<SkillCaptureDraft|null>(`/api/skill-capture/content-tasks/${encodeURIComponent(taskId)}`),
  skillCaptureRetryContentTask: (taskId:string) => http<SkillCaptureDraft>(`/api/skill-capture/content-tasks/${encodeURIComponent(taskId)}/retry`, {method:'POST'}),
  prompts: (q = '') => http<PromptItem[]>(`/api/ai-resources/prompts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createPrompt: (body: Partial<PromptItem> = {}) => http<PromptItem>('/api/ai-resources/prompts', { method: 'POST', body: JSON.stringify(body) }),
  updatePrompt: (id: number, body: Partial<PromptItem>) => http<PromptItem>(`/api/ai-resources/prompts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePrompt: (id: number) => http<{ ok: true }>(`/api/ai-resources/prompts/${id}`, { method: 'DELETE' }),

  // 知识存档
  knowledgeArchives: (q = '') => http<KnowledgeArchive[]>(`/api/knowledge/archives${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  knowledgeArchive: (id: number) => http<KnowledgeArchive>(`/api/knowledge/archives/${id}`),
  createKnowledgeArchive: (body: Partial<KnowledgeArchive> = {}) => http<KnowledgeArchive>('/api/knowledge/archives', { method: 'POST', body: JSON.stringify({
    title: body.title, content: body.content,
    sourceKind: body.source_kind, sourceUrl: body.source_url, fileName: body.file_name,
  }) }),
  updateKnowledgeArchive: (id: number, body: Partial<KnowledgeArchive>) => http<KnowledgeArchive>(`/api/knowledge/archives/${id}`, { method: 'PATCH', body: JSON.stringify({
    title: body.title, content: body.content,
  }) }),
  deleteKnowledgeArchive: (id: number) => http<{ ok: true }>(`/api/knowledge/archives/${id}`, { method: 'DELETE' }),
  /** 目录存档只读，想编辑就先复制成一份普通文档 */
  copyArchiveAsNote: (id: number) => http<KnowledgeArchive>(`/api/knowledge/archives/${id}/copy-as-note`, { method: 'POST' }),
  importKnowledgeUrl: (url: string) => http<KnowledgeArchive>('/api/knowledge/import-url', { method: 'POST', body: JSON.stringify({ url }) }),
  importKnowledgeFiles: (files: Array<{ path: string; content: string }>) => http<{ items: KnowledgeArchive[]; imported: number }>('/api/knowledge/import-files', { method: 'POST', body: JSON.stringify({ files }) }),
  remoteDocs: (body: { provider: KnowledgeProvider; query?: string; limit?: number }) =>
    http<{ provider: KnowledgeProvider; connector: string; docs: RemoteDoc[] }>('/api/knowledge/remote-docs', { method: 'POST', body: JSON.stringify(body) }),
  remoteImport: (body: { provider: KnowledgeProvider; reference: string; title?: string; url?: string | null; mode?: 'index' | 'full' }) =>
    http<KnowledgeArchive>('/api/knowledge/remote-import', { method: 'POST', body: JSON.stringify(body) }),
  fetchArchiveRemote: (id: number) =>
    http<{ title: string; content: string }>(`/api/knowledge/archives/${id}/fetch-remote`, { method: 'POST', body: JSON.stringify({}) }),
  remoteImportBatch: (body: { provider: KnowledgeProvider; items: Array<{ reference: string; title?: string; url?: string | null }>; mode: 'index' | 'full' }) =>
    http<{ succeeded: Array<{ title: string; id: number }>; failed: Array<{ title: string; error: string }> }>('/api/knowledge/remote-import-batch', { method: 'POST', body: JSON.stringify(body) }),
  syncSpace: (body: { provider: KnowledgeProvider; spaceUrl?: string; mode?: 'index' | 'full'; scope?: KnowledgeSyncScope }) =>
    http<KnowledgeSyncJob>('/api/knowledge/sync-space', { method: 'POST', body: JSON.stringify(body) }),
  browseKnowledge: (branch: BrowseBranch | null) =>
    http<BrowseNode[]>('/api/knowledge/browse', { method: 'POST', body: JSON.stringify({ branch }) }),
  syncSpaceJob: (id: string) =>
    http<KnowledgeSyncJob>(`/api/knowledge/sync-space/jobs/${id}`),
  retrySyncSpace: (id: string) =>
    http<KnowledgeSyncJob>(`/api/knowledge/sync-space/jobs/${id}/retry`, { method: 'POST' }),
  deleteSyncSpaceJob: (id: string) =>
    http<{ ok: true }>(`/api/knowledge/sync-space/jobs/${id}`, { method: 'DELETE' }),
  syncSpaceJobs: () =>
    http<KnowledgeSyncJob[]>('/api/knowledge/sync-space/jobs'),
  knowledgeBaseline: () =>
    http<KnowledgeBaseline>('/api/knowledge/baseline'),
  refreshKnowledgeBaseline: () =>
    http<{ ok: true; snapshot: KnowledgeBaseline['snapshot'] }>('/api/knowledge/baseline/refresh', { method: 'POST', body: JSON.stringify({}) }),
  knowledgeConnectors: () => http<KnowledgeConnectorStatus>('/api/knowledge/connectors'),
  selectKnowledgeConnector: (provider: KnowledgeProvider, serverName: string) =>
    http<KnowledgeConnectorStatus>(`/api/knowledge/connectors/${provider}/select`, { method: 'POST', body: JSON.stringify({ serverName }) }),
  configureKnowledgeMcp: (body: { provider: KnowledgeProvider; name: string; url: string; note?: string; bearerTokenEnvVar?: string }) => http<{ serverName: string }>('/api/knowledge/connectors/mcp', { method: 'POST', body: JSON.stringify(body) }),
  renameMcp: (name: string, note: string) => http<KnowledgeConnectorStatus>(`/api/knowledge/connectors/mcp/${encodeURIComponent(name)}/note`, { method: 'PUT', body: JSON.stringify({ note }) }),
  unlinkKnowledgeConnector: (provider: KnowledgeProvider, serverName: string) =>
    http<KnowledgeConnectorStatus>(`/api/knowledge/connectors/${provider}/unlink`, { method: 'POST', body: JSON.stringify({ serverName }) }),
  deleteKnowledgeMcp: (name: string) =>
    http<KnowledgeConnectorStatus>(`/api/knowledge/connectors/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  authorizeKnowledgeConnector: (provider: KnowledgeProvider, serverName: string, scopes?: string) =>
    http<KnowledgeAuthorizationJob>(`/api/knowledge/connectors/${provider}/authorize`, { method: 'POST', body: JSON.stringify({ serverName, scopes }) }),
  configureKnowledgeCli: (provider: KnowledgeProvider, command: string) =>
    http<KnowledgeConnectorStatus>(`/api/knowledge/connectors/${provider}/cli`, { method: 'POST', body: JSON.stringify({ command }) }),
  authorizeKnowledgeCli: (provider: KnowledgeProvider, command?: string) =>
    http<KnowledgeAuthorizationJob>(`/api/knowledge/connectors/${provider}/cli-authorize`, { method: 'POST', body: JSON.stringify({ command }) }),
  oneClickKnowledgeCli: (provider: KnowledgeProvider) =>
    http<KnowledgeAuthorizationJob>(`/api/knowledge/connectors/${provider}/one-click`, { method: 'POST', body: JSON.stringify({}) }),
  knowledgeAuthorizationJob: (id: string) => http<KnowledgeAuthorizationJob>(`/api/knowledge/connectors/jobs/${id}`),
  searchRemoteKnowledge: (body: { provider?: KnowledgeProvider; query?: string; limit?: number }) =>
    http<unknown>('/api/knowledge/remote-search', { method: 'POST', body: JSON.stringify(body) }),
  readRemoteKnowledge: (provider: KnowledgeProvider, reference: string) =>
    http<{ title: string; content: string; connector: string }>('/api/knowledge/remote-read', { method: 'POST', body: JSON.stringify({ provider, reference }) }),
  retryKnowledgeImport: (id: number, serverName?: string) => http<KnowledgeArchive>(`/api/knowledge/archives/${id}/retry-import`, { method: 'POST', body: JSON.stringify({ serverName }) }),
  appendKnowledge: (id: number, content: string, heading?: string) => http<KnowledgeArchive>(`/api/knowledge/archives/${id}/append`, { method: 'POST', body: JSON.stringify({ content, heading }) }),
  saveConversationKnowledge: (title: string, content: string) => http<KnowledgeArchive>('/api/knowledge/conversation', { method: 'POST', body: JSON.stringify({ title, content }) }),
  conversationTitle: (content: string) => http<{ title: string | null }>('/api/assistant/conversation-title', { method: 'POST', body: JSON.stringify({ content }) }),

  // 提醒
  reminders: () => http<Reminder[]>('/api/reminders'),
  createReminder: (b: ReminderPatch & { message: string; triggerAt: string }) =>
    http<Reminder>('/api/reminders', { method: 'POST', body: JSON.stringify(b) }),
  updateReminder: (id: number, b: ReminderPatch) => http<Reminder>(`/api/reminders/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteReminder: (id: number) => http<{ ok: true }>(`/api/reminders/${id}`, { method: 'DELETE' }),
  resendReminder: (id: number) => http<{ ok: true }>(`/api/reminders/${id}/resend`, { method: 'POST' }),
  /** 停止重复系列：本条留着转成一次性，后续期次全部取消 */
  stopReminderSeries: (id: number) => http<{ ok: true; keptId: number; stopped: number }>(`/api/reminders/${id}/stop-series`, { method: 'POST' }),
  /** 合并重复实例：同一刻建重了的只留本条，其余进回收站 */
  dedupeReminder: (id: number) => http<{ ok: true; keptId: number; removed: number }>(`/api/reminders/${id}/dedupe`, { method: 'POST' }),

  // 日历
  eventStatus: () => http<{
    dingtalk: { appKey?: string; configured: boolean };
    ics: { configured: boolean; url: string };
    caldav: { configured: boolean; username: string; server: string };
  }>('/api/events/status'),
  events: (from: string, to: string) => http<CalendarEvent[]>(`/api/events?from=${from}&to=${to}`),
  updateEvent: (id: number, b: { detail: string; externalId?: string }) =>
    http<CalendarEvent>(`/api/events/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  syncEvents: () => http<{ ok: boolean; count?: number; error?: string; detail?: string }>('/api/events/sync', { method: 'POST' }),
  saveCaldav: (b: { username: string; password?: string; server?: string }) =>
    http<{ ok: boolean; count?: number; error?: string }>('/api/events/caldav', { method: 'POST', body: JSON.stringify(b) }),
  importIcs: (text: string) => http<{ ok: boolean; count?: number; error?: string }>('/api/events/import-ics', { method: 'POST', body: JSON.stringify({ text }) }),

  // 钉钉创建日程（MCP 网关）
  searchColleagues: (keyword: string) =>
    http<{ ok: boolean; users: Colleague[]; error?: string }>(`/api/dingtalk/contacts/search?keyword=${encodeURIComponent(keyword)}`),
  availableRooms: (start: string, end: string, name?: string) =>
    http<{ ok: boolean; rooms: MeetingRoom[]; error?: string }>(
      `/api/dingtalk/rooms/available?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${name ? `&name=${encodeURIComponent(name)}` : ''}`,
    ),
  // 参与人忙闲（只返回占用时间段，不含日程内容）
  busyStatus: (start: string, end: string, userIds: string[]) =>
    http<{ ok: boolean; busy: Array<{ userId: string; busy: Array<{ start: string; end: string }> }>; error?: string }>(
      `/api/dingtalk/busy-status?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&userIds=${encodeURIComponent(userIds.join(','))}`,
    ),
  // 根据参与人闲忙推荐共同空闲时段
  suggestedTimes: (start: string, end: string, userIds: string[], duration: number) =>
    http<{ ok: boolean; times: Array<{ start: string; end: string; conflicts: string[] }>; error?: string }>(
      `/api/dingtalk/suggested-times?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&userIds=${encodeURIComponent(userIds.join(','))}&duration=${duration}`,
    ),
  createDingtalkEvent: (b: {
    title: string;
    description?: string;
    startAt: string;
    endAt: string;
    attendeeUserIds: string[];
    roomId?: string;
    location?: string;
    reminderMinutes?: number | null;
  }) => http<{ ok: boolean; eventId?: string | null; error?: string }>('/api/events/dingtalk', { method: 'POST', body: JSON.stringify(b) }),

  // 设置 / 回顾 / 导出
  settings: () => http<Settings>('/api/settings'),
  saveSettings: (b: unknown) => http<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(b) }),
  testModel: (b: {
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    wireApi?: 'responses' | 'chat_completions';
    reasoningEffort?: string;
    disableResponseStorage?: boolean;
  }) =>
    http<{ ok: true; latencyMs: number; model: string; wireApi: string; endpoint: string; reply: string }>('/api/model/test', {
      method: 'POST', body: JSON.stringify(b),
    }),
  testImageModel: (b: { baseUrl?: string; model?: string; apiKey?: string }) =>
    http<{ ok: true; latencyMs: number; model: string; endpoint: string }>('/api/image-model/test', {      method: 'POST', body: JSON.stringify(b),
    }),
  weeklyReview: (sel: WeekSel = {}) => {
    const p = new URLSearchParams();
    if (sel.offset) p.set('offset', String(sel.offset));
    if (sel.weekStart) p.set('weekStart', sel.weekStart);
    return http<WeeklyReview>(`/api/review/weekly?${p.toString()}`);
  },
  /** 保存周报自定义段落（前端发送的是带序号的原始文本，服务端会剥掉序号后落库） */
  saveWeeklyReport: (weekStart: string, sections: string[]) =>
    http<{ ok: true; weekStart: string; updatedAt: string }>('/api/review/weekly/save', {
      method: 'POST',
      body: JSON.stringify({ weekStart, sections }),
    }),
  /** 重置周报自定义段落：清除该周所有 override，回退到自动生成 */
  resetWeeklyReport: (weekStart: string) =>
    http<{ ok: true; weekStart: string }>('/api/review/weekly/reset', {
      method: 'POST',
      body: JSON.stringify({ weekStart }),
    }),
  /** 某年某月各周是否有完成记录（周选择器打点） */
  reviewWeeks: (year: number, month: number) =>
    http<ReviewWeekInfo[]>(`/api/review/weeks?year=${year}&month=${month}`),

  // Supabase 双设备同步（密钥只在服务端 .env，前端只读状态和触发动作）
  syncStatus: () => http<SyncStatus>('/api/sync/status'),
  initializeSync: (mode: 'seed' | 'join' | 'merge') =>
    http<{ mode: string; result: SyncResult }>('/api/sync/initialize', {
      method: 'POST',
      body: JSON.stringify({ mode, ...(mode === 'join' ? { confirm: 'replace-local' } : {}) }),
    }),
  syncNow: () => http<SyncResult>('/api/sync/now', { method: 'POST' }),

  // 推送通道（钉钉 / 飞书群机器人）：不传 webhook/secret 则用已保存的凭据试发
  testNotify: (b: { channel: 'dingtalk' | 'feishu'; webhook?: string; secret?: string; text?: string }) =>
    http<{ ok: true }>('/api/notify/test', { method: 'POST', body: JSON.stringify(b) }),

  // 微信 ClawBot 绑定
  clawbotStatus: () => http<ClawbotStatus>('/api/clawbot/status'),
  clawbotBind: () => http<{ ok: true; startedAt: number }>('/api/clawbot/bind', { method: 'POST' }),
  clawbotQr: () => http<ClawbotQr>('/api/clawbot/bind/qr'),
  clawbotCancel: () => http<{ ok: true }>('/api/clawbot/cancel', { method: 'POST' }),
  clawbotUnbind: () => http<{ ok: boolean } & ClawbotStatus>('/api/clawbot/unbind', { method: 'POST' }),

  // 助手：快照（seen=true 顺带上报「我来过了」）、AI 换句、位置与天气
  mood: (seen = false, rotate = false) =>
    http<MoodSnapshot>(`/api/mood?seen=${seen ? 1 : 0}&rotate=${rotate ? 1 : 0}`),
  moodLine: (force = false) =>
    http<{ ok: boolean; line: string | null; template: string; kind: MoodSnapshot['kind']; ai: boolean }>(
      '/api/mood/line', { method: 'POST', body: JSON.stringify({ force }) },
    ),
  moodCity: (city: string) =>
    http<{ ok: boolean; location: MoodSnapshot['location']; weather: MoodSnapshot['weather'] }>(
      '/api/mood/location', { method: 'POST', body: JSON.stringify({ city }) },
    ),
  moodWeatherRefresh: () =>
    http<{ ok: boolean; weather: MoodSnapshot['weather'] }>('/api/mood/weather/refresh', { method: 'POST', body: '{}' }),

  // 阶段 1 三层知识模型：主题 / 资料 / 知识与证据（docs/knowledge-phase1-handoff.md 第八节）
  topicList: () => http<{ topics: KnowledgeTopic[] }>('/api/knowledge/topics'),
  topicCreate: (name: string, summary = '', scope = '', focusQuestions: string[] = []) =>
    http<{ topic: KnowledgeTopic }>('/api/knowledge/topics', { method: 'POST', body: JSON.stringify({ name, summary, scope, focusQuestions }) }),
  topicDetail: (id: number) => http<TopicDetail>(`/api/knowledge/topics/${id}`),
  topicUpdate: (id: number, patch: { name?: string; summary?: string; scope?: string; focusQuestions?: string[]; manualNotes?: string }) =>
    http<{ topic: KnowledgeTopic }>(`/api/knowledge/topics/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  topicMembersAdd: (id: number, documentKeys: string[]) =>
    http<{ added: number }>(`/api/knowledge/topics/${id}/members`, { method: 'POST', body: JSON.stringify({ documentKeys }) }),
  topicMemberRemove: (id: number, sourceKey: string) =>
    http<{ ok: true }>(`/api/knowledge/topics/${id}/members/${encodeURIComponent(sourceKey)}`, { method: 'DELETE' }),
  topicMemberOverride: (id: number, sourceKey: string, decision: 'include' | 'exclude') =>
    http<{ ok: true }>(`/api/knowledge/topics/${id}/member-overrides/${encodeURIComponent(sourceKey)}`, { method: 'PUT', body: JSON.stringify({ decision }) }),
  knowledgeAutoOrganize: (offset=0) => http<{ status:string; created_topics:number; associated:number; error?:string; coverage?:{offset:number;count:number;total:number;next_offset:number|null;partial:boolean} }>('/api/knowledge/lifecycle/auto-organize', { method:'POST', body:JSON.stringify({offset}) }),
  knowledgeModelDestination:()=>http<{available:boolean;host:string;model:string;wire:string}>('/api/knowledge/lifecycle/model-destination'),
  topicUnderstanding: (id:number) => http<TopicUnderstanding>(`/api/knowledge/lifecycle/topics/${id}/understanding`),
  generateTopicUnderstanding: (id:number) => http<TopicUnderstanding>(`/api/knowledge/lifecycle/topics/${id}/understanding`, {method:'POST',body:'{}'}),
  knowledgeDocument: (sourceKey: string) =>
    http<{ document: SourceDocumentDetail; evidence: DocumentEvidence[] }>(`/api/knowledge/documents/${encodeURIComponent(sourceKey)}`),
  knowledgeDocumentRefresh: (sourceKey: string) =>
    http<{ document: SourceDocumentDetail; outcome: string }>(`/api/knowledge/documents/${encodeURIComponent(sourceKey)}/refresh`, { method: 'POST' }),

  // 阶段 1.5 P0：资料池 / 失败恢复 / 手动正文通道（docs/knowledge-phase1_5-topics-redesign.md 3.2/3.7）
  knowledgePool: (filter: 'all' | 'failed' | 'untopic' = 'all', query = '', offset = 0, provider='', topicId?:number, tag?:string) =>
    http<KnowledgePoolData>(`/api/knowledge/pool?filter=${filter}&query=${encodeURIComponent(query)}&offset=${offset}${provider?`&provider=${provider}`:''}${topicId?`&topicId=${topicId}`:''}${tag?`&tag=${encodeURIComponent(tag)}`:''}`),
  knowledgeDocumentRefetch: (sourceKey: string) =>
    http<{ document: SourceDocumentDetail }>(`/api/knowledge/documents/${encodeURIComponent(sourceKey)}/refetch`, { method: 'POST' }),
  knowledgeRetryFailed: () =>
    http<{ results: Array<{ document_key: string; outcome: 'succeeded' | 'failed' | 'skipped'; error_code?: string }> }>(
      '/api/knowledge/documents/retry-failed', { method: 'POST' }),
  knowledgeManualBody: (sourceKey: string, content: string, title?: string) =>
    http<{ document: SourceDocumentDetail }>(`/api/knowledge/documents/${encodeURIComponent(sourceKey)}/manual-body`,
      { method: 'POST', body: JSON.stringify({ content, ...(title ? { title } : {}) }) }),
  knowledgeManualCreate: (title: string, content: string, documentType = 'other') =>
    http<{ document: SourceDocumentDetail }>('/api/knowledge/documents/manual',
      { method: 'POST', body: JSON.stringify({ title, content, documentType }) }),
  knowledgeSearch: (q: string, limit = 30) =>
    http<{ results: KnowledgeDocumentSearchHit[] }>(`/api/knowledge/lifecycle/documents/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  // 统一标签池（docs/knowledge-tags-unified-pool.md）：自动与手动同池，改名/删除波及资料与手记
  tagList: () => http<{ tags: KnowledgeTag[] }>('/api/tags'),
  tagItems: (name: string) =>
    http<TagItems>(`/api/tags/${encodeURIComponent(name)}/items`),
  tagRename: (from: string, to: string) =>
    http<{ documents: number; notes: number }>('/api/tags/rename', { method: 'POST', body: JSON.stringify({ from, to }) }),
  tagDelete: (name: string) =>
    http<{ documents: number; notes: number }>(`/api/tags/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  tagAutoRun: (sourceKeys?: string[], force = false) =>
    http<{ scheduled: number }>('/api/tags/auto-tag', { method: 'POST', body: JSON.stringify({ sourceKeys, force }) }),
  knowledgeDocumentTagAdd: (sourceKey: string, name: string) =>
    http<{ tag: DocumentTag }>(`/api/knowledge/documents/${encodeURIComponent(sourceKey)}/tags`, { method: 'POST', body: JSON.stringify({ name }) }),
  knowledgeDocumentTagRemove: (sourceKey: string, name: string) =>
    http<{ ok: true }>(`/api/knowledge/documents/${encodeURIComponent(sourceKey)}/tags/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  knowledgeDocumentVersions: (sourceKey: string) =>
    http<{ current: KnowledgeDocumentVersion | null; versions: KnowledgeDocumentVersion[] }>(`/api/knowledge/lifecycle/documents/${encodeURIComponent(sourceKey)}/versions`),
  knowledgeDocumentVersion: async (sourceKey: string, versionId: number) => {
    let offset=0;let merged:KnowledgeDocumentVersion|null=null;
    do { const page=await http<{version:KnowledgeDocumentVersion}>(`/api/knowledge/lifecycle/documents/${encodeURIComponent(sourceKey)}/versions/${versionId}?offset=${offset}&limit=100000`);merged=merged?{...page.version,content:`${merged.content??''}${page.version.content??''}`} : page.version;offset=page.version.range?.to??0;if(!page.version.range?.truncated)break; } while(merged);
    return {version:merged!};
  },
  knowledgeExport: (format: 'markdown' | 'json', topicId?: number) =>
    download(`/api/knowledge/lifecycle/export?format=${format}${topicId ? `&topicId=${topicId}` : ''}`),
  topicCandidatesGenerate: (offset=0) => http<{ candidates: import('@/types').TopicCandidate[]; reused:boolean;coverage:{offset:number;count:number;total:number;next_offset:number|null} }>('/api/knowledge/lifecycle/topic-candidates/generate', { method:'POST', body:JSON.stringify({offset}) }),
  topicCandidates: () => http<{candidates:import('@/types').TopicCandidate[]}>('/api/knowledge/lifecycle/topic-candidates'),
  topicCandidateDecision: (id:number, action:'accept'|'ignore', excluded:string[] = [], mergeTopicId?:number) => http<{candidate:import('@/types').TopicCandidate}>(`/api/knowledge/lifecycle/topic-candidates/${id}/decision`, { method:'POST', body:JSON.stringify({action,excluded,mergeTopicId}) }),
  topicBriefGenerate: (id:number) => http<{output:import('@/types').KnowledgeOutput}>(`/api/knowledge/lifecycle/topics/${id}/brief`,{method:'POST',body:'{}'}),
  saveKnowledgeOutputAsDocument:(id:number,saveKey:string,overwriteManual?:boolean)=>http<{document_key:string;reused:boolean;updated?:boolean;derived_from:number}>(`/api/knowledge/lifecycle/outputs/${id}/save-as-document`,{method:'POST',body:JSON.stringify({saveKey,overwriteManual})}),
  assistantAgentTaskUsage:(id:string)=>http<{usage:import('@/types').AgentTaskUsage}>(`/api/assistant/agent-tasks/${id}/usage`),
  assistantAgentTaskEvents:(id:string)=>http<{events:Array<{id:number;kind:string;createdAt:string;detail:Record<string,unknown>}>}>(`/api/assistant/agent-tasks/${encodeURIComponent(id)}/events`),
  knowledgeOutputs:()=>http<{outputs:import('@/types').KnowledgeOutput[]}>('/api/knowledge/lifecycle/outputs'),
  knowledgeOutput:(id:number)=>http<{output:import('@/types').KnowledgeOutput}>(`/api/knowledge/lifecycle/outputs/${id}`),
  knowledgeBatches:()=>http<{batches:import('@/types').KnowledgeImportBatch[]}>('/api/knowledge/lifecycle/batches'),
  knowledgeBatch:(id:string)=>http<import('@/types').KnowledgeImportBatchDetail>(`/api/knowledge/lifecycle/batches/${id}`),
  knowledgeBatchPreview:(body:{provider:'feishu';wiki:Array<{spaceId:string;spaceName:string;parentNodeToken?:string}>;drive:string[]}|{provider:'dingtalk';spaceUrl:string})=>http<import('@/types').KnowledgeImportBatchDetail>('/api/knowledge/lifecycle/batches/preview',{method:'POST',body:JSON.stringify(body)}),
  knowledgeBatchStart:(id:string)=>http<import('@/types').KnowledgeImportBatchDetail>(`/api/knowledge/lifecycle/batches/${id}/start`,{method:'POST',body:'{}'}),
  knowledgeBatchAction:(id:string,action:'pause'|'resume'|'retry')=>http<import('@/types').KnowledgeImportBatchDetail>(`/api/knowledge/lifecycle/batches/${id}/${action}`,{method:'POST',body:'{}'}),
  knowledgeItemUpdate: (id:number,patch:{statement?:string;status?:'active'|'deprecated'|'disputed'}) => http<{knowledge:KnowledgeItem}>(`/api/knowledge/items/${id}`,{method:'PATCH',body:JSON.stringify(patch)}),
  knowledgeItemRestore: (id:number)=>http<{knowledge:KnowledgeItem}>(`/api/knowledge/items/${id}/restore`,{method:'POST',body:'{}'}),
  topicItemCreate: (topicId: number, body: {
    statement: string; kind: KnowledgeItemKind;
    evidence: { document_key: string; quote_text: string; quote_prefix: string; quote_suffix: string; anchor_from: number; anchor_to: number; anchor_basis: string; doc_hash_at_ref: string };
  }) => http<{ knowledge: KnowledgeItem; evidence_id: number }>(`/api/knowledge/topics/${topicId}/items`, { method: 'POST', body: JSON.stringify(body) }),
  knowledgeItemDelete: (id: number) => http<{ ok: true }>(`/api/knowledge/items/${id}`, { method: 'DELETE' }),
  evidenceRelocate: (id: number, anchor_from: number, anchor_to: number, doc_hash_at_ref: string) =>
    http<{ ok: true }>(`/api/knowledge/evidence/${id}`, { method: 'PATCH', body: JSON.stringify({ anchor_from, anchor_to, doc_hash_at_ref }) }),

  // 回收站：按模块分类回显已删内容，可展开看全文、恢复或彻底删除
  trash: () => http<TrashData>('/api/trash'),
  trashDetail: (type: TrashType, id: number) => http<TrashDetail>(`/api/trash/${type}/${id}`),
  restoreTrash: (type: TrashType, id: number) =>
    http<{ ok: true }>(`/api/trash/${type}/${id}/restore`, { method: 'POST' }),
  purgeTrash: (type: TrashType, id: number) =>
    http<{ ok: true }>(`/api/trash/${type}/${id}`, { method: 'DELETE' }),
  /** 唯一入口的批量操作：清空（不可逆），UI 里输了口令才会调 */
  purgeAllTrash: (types?: TrashType[]) =>
    http<{ ok: true; purged: number }>('/api/trash/purge-all', { method: 'POST', body: JSON.stringify({ kinds: types }) }),
};

export const qk = {
  tasks: ['tasks'] as const,
  projects: ['projects'] as const,
  fragments: ['fragments'] as const,
  notes: (q = '') => ['notes', q] as const,
  skills: ['ai-resources', 'skills'] as const,
  prompts: ['ai-resources', 'prompts'] as const,
  knowledge: ['knowledge', 'archives'] as const,
  knowledgeConnectors: ['knowledge', 'connectors'] as const,
  knowledgeTopics: ['knowledge', 'topics'] as const,
  tags: ['tags'] as const,
  knowledgeTopic: (id: number) => ['knowledge', 'topics', id] as const,
  knowledgeDocument: (sourceKey: string) => ['knowledge', 'documents', sourceKey] as const,
  knowledgePool: (filter: string) => ['knowledge', 'pool', filter] as const,
  reminders: ['reminders'] as const,
  events: (d: string) => ['events', d] as const,
  eventStatus: ['eventStatus'] as const,
  settings: ['settings'] as const,
  review: (r: WeekSel = {}) => ['review', JSON.stringify(r)] as const,
  trash: ['trash'] as const,
  mood: ['mood'] as const,
  clawbot: ['clawbot'] as const,
  sync: ['supabase-sync'] as const,
};

export type SyncStatus = {
  configured: boolean;
  initialized: boolean;
  workspaceId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  running: boolean;
  pendingRows: number;
  pendingFiles: number;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export type SyncResult = { pushed: number; pulled: number; files: number };

export type ClawbotStatus = {
  installed: boolean;
  bound: boolean;
  running: boolean;
  account: string | null;
};

export type ClawbotQr = {
  alive: boolean;
  qrUrl: string | null;
} & ClawbotStatus;

/** 任务写入体（camelCase，服务端已适配） */
export type TaskWrite = {
  title?: string;
  notes?: string;
  projectId?: number | null;
  status?: 'todo' | 'doing' | 'done';
  priority?: number;
  dueAt?: string | null;
  plannedDate?: string | null;
  remindAt?: string | null; // 任务提醒（可选，默认不设）
  repeatRule?: 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | `ndays:${number}`; // 完成后生成下一次任务
  detail?: string;          // 详情文档（Markdown）
};
