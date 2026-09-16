/**
 * [INPUT]: 经 Workbench 确认的项目、任务输入与执行器配置
 * [OUTPUT]: 版本化执行契约、运行事件、内容返回/目录执行能力和本机/服务端分立证据
 * [POS]: 业务与软件 Agent 的边界；供应商会话 ID 不作为业务任务 ID
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
export type ExecutorCapabilities = {
  protocolVersion: 1;
  id: string;
  projectDirectory: boolean;
  /** returned-content 仅返回内容，由工作台写入成果；不表示软件可控制项目目录。 */
  artifactDelivery?: 'returned-content';
  progressEvents: boolean;
  cancellation: 'local-process' | 'none';
  resume: boolean;
  /** 执行端实际施加的文件沙箱；只读任务不得仅靠提示词限制写入。 */
  sandbox?: 'read-only' | 'workspace-write';
};
export type ExecutorUsage = { inputTokens: number; outputTokens: number; cachedInputTokens: number | null;
  cacheCreationInputTokens?: number | null;
  reportedTotalTokens?: number; inputIncludesCache?: boolean };
export type ExecutorEvent = { type: 'accepted' | 'started' | 'progress' | 'diagnostic'; sessionId?: string; message?: string;
  command?: string; exitCode?: number | null };
export type ExecutorExit = {
  exitCode: number | null;
  signal: string | null;
  localProcessClosed: boolean;
  protocolCompleted: boolean;
  usage: ExecutorUsage | null;
  error: string | null;
  artifactContent?: string;
  modelAlias?: string;
  remoteOutcomeUnknown?: boolean;
};
export interface ExecutorAdapter {
  capabilities: ExecutorCapabilities;
  start(input: { projectRoot: string; prompt: string; onEvent: (event: ExecutorEvent) => void }): {
    completion: Promise<ExecutorExit>;
    interrupt: () => void;
  };
}
