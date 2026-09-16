/**
 * [INPUT]: 本机 G0 探针的持久化回执与固定验收目录下的成果文件
 * [OUTPUT]: Codex/Cola/WorkBuddy 接入状态及固定成果读回；不自动打开派发
 * [POS]: 用户可感知的能力边界，独立于用于意图登记的 agent-registry.enabled
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, getSetting, db } from '../db.js';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export type ExecutorReadiness = {
  id: string; name: string; label: string; summary: string; automaticExecution: boolean;
  checkedAt: string | null; modelAlias: string | null; durationMs: number | null;
  reportedTotalTokens: number | null;
  artifactUrl?: string;
  sampleKind?: 'communication' | 'document' | 'project';
  reportedInputTokens?: number | null;
  reportedOutputTokens?: number | null;
  reportedCacheReadTokens?: number | null;
  reportedCacheCreationTokens?: number | null;
};
function read(path: string): Record<string, any> | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) return null;
    const result = JSON.parse(readFileSync(path, 'utf8'));
    return result && typeof result === 'object' && result.protocolVersion === 1 ? result : null;
  } catch { return null; }
}

const projectBase = fileURLToPath(new URL('../../../.build/executor-projects/', import.meta.url));
export function executorArtifact(kind: 'cola-document' | 'workbuddy-cli', root = join(dataDir, 'executor-probes'), projects = projectBase) {
  try {
    const pattern = kind === 'cola-document' ? /^cola-doc-[a-z0-9-]{1,60}$/ : /^workbuddy-[a-z0-9-]{1,60}$/;
    const candidates = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && pattern.test(entry.name))
      .map((entry) => ({ id: entry.name, run: read(join(root, entry.name, 'result.json')) }))
      .filter(({ run }) => run?.executor === kind)
      .sort((a, b) => String(b.run?.startedAt).localeCompare(String(a.run?.startedAt)));
    const latest = candidates[0];
    if (!latest || latest.run?.status !== 'verified' || latest.run.artifactWriter !== (kind === 'cola-document' ? 'workbench' : 'executor')) return null;
    const path = join(realpathSync(projects), latest.id, 'acceptance.md');
    if (latest.run.artifact?.path !== path || latest.run.projectRoot !== join(realpathSync(projects), latest.id)
      || realpathSync(path) !== path || !lstatSync(path).isFile() || lstatSync(path).size > 100_000) return null;
    const content = readFileSync(path, 'utf8');
    if (createHash('sha256').update(content).digest('hex') !== latest.run.artifact.sha256) return null;
    return { content, run: latest.run };
  } catch { return null; }
}
export function colaDocumentArtifact(root = join(dataDir, 'executor-probes'), projects = projectBase) {
  return executorArtifact('cola-document', root, projects);
}

export function executorReadiness(root = join(dataDir, 'executor-probes'), projects = projectBase): ExecutorReadiness[] {
  const base = (id: string, name: string): ExecutorReadiness => ({ id, name, label: '尚未验证',
    summary: '需要验证指定项目执行、成果、停止和恢复。', automaticExecution: false,
    checkedAt: null, modelAlias: null, durationMs: null, reportedTotalTokens: null });
  const codex = base('codex-cli', 'Codex');
  const cola = base('cola', 'Cola');
  const workbuddy = base('workbuddy-cli', 'WorkBuddy');
  workbuddy.summary = '已接入内置 CLI 适配，需验证账号、指定项目成果及停止/恢复；桌面会话与连接器另验。';
  if (!existsSync(root)) return [codex, cola, workbuddy];
  const runs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => read(join(root, entry.name, 'result.json')))
    .filter((item) => item && typeof item.finishedAt === 'string')
    .sort((a, b) => String(b!.finishedAt).localeCompare(String(a!.finishedAt)));
  const codexRun = runs.find((item) => item?.executor === 'codex-cli');
  if (codexRun) {
    const run = codexRun;
    codex.label = run.status === 'verified' ? '文档探针通过' : '执行验证未通过';
    codex.summary = run.status === 'verified' ? '隔离项目文档已核验；正式任务与恢复能力仍待验收。'
      : '未取得已验收成果。超时任务保留记录并阻止重派；本机退出不等于远端停止。';
    codex.checkedAt = run.finishedAt;
  }
  const communication = read(join(root, 'cola-communication.json'));
  if (communication?.state === 'communication_only' && typeof communication.promptId === 'string') {
    cola.label = '直接消息往返通过';
    cola.summary = '无需经飞书中转。指定项目执行、停止、恢复和上下文成本仍待验证。';
    cola.checkedAt = typeof communication.checkedAt === 'string' ? communication.checkedAt : null;
    cola.modelAlias = typeof communication.modelAlias === 'string' ? communication.modelAlias : null;
    cola.durationMs = typeof communication.durationMs === 'number' && Number.isFinite(communication.durationMs) ? communication.durationMs : null;
    cola.reportedTotalTokens = typeof communication.usage?.totalTokens === 'number' && Number.isFinite(communication.usage.totalTokens) ? communication.usage.totalTokens : null;
    cola.sampleKind = 'communication';
  }
  const document = colaDocumentArtifact(root, projects);
  if (document) {
    cola.label = '文档返回验证通过';
    cola.summary = 'Cola 返回结构化清单，工作台核验后保存。尚不具备已验证的软件原生项目执行、停止与恢复能力。';
    cola.artifactUrl = '/api/assistant/executors/cola-document/artifact';
    cola.sampleKind = 'document';
    cola.modelAlias = typeof document.run.modelAlias === 'string' ? document.run.modelAlias : null;
    cola.reportedTotalTokens = typeof document.run.usage?.reportedTotalTokens === 'number' && Number.isFinite(document.run.usage.reportedTotalTokens) ? document.run.usage.reportedTotalTokens : null;
    const duration = Date.parse(document.run.finishedAt) - Date.parse(document.run.startedAt);
    cola.durationMs = Number.isFinite(duration) && duration >= 0 ? duration : null;
    cola.checkedAt = document.run.finishedAt;
  }
  const wb = runs.find((item) => item?.executor === 'workbuddy-cli');
  if (wb) {
    const artifact = executorArtifact('workbuddy-cli', root, projects);
    workbuddy.label = artifact ? '项目文档验证通过' : /认证/.test(String(wb.reason)) ? '接入待认证' : '执行验证未通过';
    workbuddy.summary = artifact ? '内置 CLI 已在指定验收目录生成文档；桌面任务互通、续接和远端停止仍待验证。'
      : /认证/.test(String(wb.reason)) ? '内置 CLI 未取得可用认证；桌面登录状态不能替代该通道验收。'
        : '适配已接入，尚无有效项目成果；异常运行保留记录，不自动重派。';
    if (artifact) workbuddy.artifactUrl = '/api/assistant/executors/workbuddy-cli/artifact';
    workbuddy.checkedAt = wb.finishedAt;
    workbuddy.modelAlias = typeof wb.modelAlias === 'string' ? wb.modelAlias : null;
    const duration = Date.parse(wb.finishedAt) - Date.parse(wb.startedAt);
    workbuddy.durationMs = Number.isFinite(duration) && duration >= 0 ? duration : null;
    workbuddy.sampleKind = 'project';
    const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    workbuddy.reportedInputTokens = number(wb.usage?.inputTokens);
    workbuddy.reportedOutputTokens = number(wb.usage?.outputTokens);
    workbuddy.reportedCacheReadTokens = number(wb.usage?.cachedInputTokens);
    workbuddy.reportedCacheCreationTokens = number(wb.usage?.cacheCreationInputTokens);
  }
  const policy = getSetting<{enabled?:boolean;paused?:boolean}>('agentExecution');
  if (policy?.enabled) {
    codex.automaticExecution = policy.paused === false;
    codex.label = policy.paused ? '只读执行已暂停' : '只读任务自动执行已启用';
    codex.summary = '已授权项目的研究和文档任务经 Codex 执行、独立验收后回传；修改代码和其他执行器尚未开放。';
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_execution_jobs'").get()) {
      const latest = db.prepare("SELECT task_id,updated_at FROM agent_execution_jobs WHERE state='completed' ORDER BY updated_at DESC LIMIT 1").get() as {task_id:string;updated_at:string}|undefined;
      if (latest) { codex.checkedAt = latest.updated_at; codex.artifactUrl = `/api/assistant/agent-tasks/${latest.task_id}/result`; }
    }
  }
  return [codex, cola, workbuddy];
}
