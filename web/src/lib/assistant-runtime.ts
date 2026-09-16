/**
 * [INPUT]: 助手任务、记忆、用量和包含已核验成果链接的执行器 REST 响应
 * [OUTPUT]: 运行态与执行暂停展示类型，指定模型/费用与执行端观测模型分开
 * [POS]: 运行态契约；不从自然语言或本地缓存推断执行成功
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
export type AgentTask = {
  id: string; status: string; objective: string; executor: string | null; source: string;
  statusLabel?: string; statusDetail?: string; projectPath?: string | null;
  projectId?: number | null; projectName?: string | null; updatedAt?: string;
  requestedModel?: string | null; requestedCostPolicy?: 'unspecified' | 'free_only'; observedModel?: string | null;
};
export type AssistantExecution = { enabled: boolean; paused: boolean };
export type MemoryEntry = {
  id: number;
  kind: 'preference' | 'fact' | 'skill_preference' | 'task_preference';
  content: string;
  status: 'active' | 'disabled';
  source: 'command' | 'conversation' | 'manual';
  createdAt: string;
  updatedAt: string;
};
export type AssistantMemory = {
  instructions: string;
  project: { id: number; name: string } | null;
  revision: number;
  entries?: MemoryEntry[];
};
export type SessionActivityState = 'running' | 'attention' | 'queued';
export type SessionTaskActivity = { state: SessionActivityState; running: number; attention: number; queued: number };
export type AssistantUsage = {
  requests: number; modelCalls: number; reportedCalls: number; inputTokens: number; outputTokens: number;
  cachedTokens: number; cacheReportedCalls: number; failedRequests: number;
};

export type ExecutorReadiness = {
  id: string; name: string; label: string; summary: string; automaticExecution: false;
  checkedAt: string | null; modelAlias: string | null; durationMs: number | null; reportedTotalTokens: number | null;
  artifactUrl?: string;
  sampleKind?: 'communication' | 'document' | 'project';
  reportedInputTokens?: number | null;
  reportedOutputTokens?: number | null;
  reportedCacheReadTokens?: number | null;
  reportedCacheCreationTokens?: number | null;
};
