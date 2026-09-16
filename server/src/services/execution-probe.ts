/**
 * [INPUT]: 固定项目清单、受控探针目标、ExecutorAdapter 与独立证据目录
 * [OUTPUT]: 执行/验收记录与有限诊断；区分软件写文件和工作台保存，共用幂等与未知态防线
 * [POS]: G0 直接执行探针；不消费 agent_tasks 历史队列，不注册自动 worker
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, lstatSync, readdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { ExecutorAdapter, ExecutorExit, ExecutorUsage } from './executor-contract.js';

export type ProbeResult = {
  protocolVersion: 1;
  id: string;
  fingerprint: string;
  executor: string;
  projectId: string;
  projectRoot: string;
  status: 'prepared' | 'running' | 'verified' | 'failed' | 'needs_reconciliation' | 'interrupted';
  reason: string;
  sessionId: string | null;
  startedAt: string;
  finishedAt: string | null;
  localProcessClosed: boolean;
  remoteStopConfirmed: false;
  usage: ExecutorUsage | null;
  artifact: { path: string; sha256: string; bytes: number } | null;
  artifactWriter?: 'workbench' | 'executor';
  modelAlias?: string;
  diagnostics?: string[];
};
export type ProbeInput = {
  id: string;
  projectId: string;
  projectRoot: string;
  /** 应用装配的允许根，不能来源于模型；通过真实路径阻断符号链接逃逸。 */
  allowedRoot: string;
  evidenceRoot: string;
  objective: string;
  artifactName: string;
  requiredText: string[];
  /** 模型/软件版本改变就必须用新探针，不复用此前验证。 */
  configurationId: string;
  timeoutMs: number;
};
const active = new Map<string, { fingerprint: string; promise: Promise<ProbeResult> }>();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, path: string) => { const r = relative(root, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('探针项目不接受符号链接');
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        if (stat.size > 2_000_000 || files.size >= 100) throw new Error('探针输入超出最小项目范围');
        files.set(relative(root, path), hash(readFileSync(path)));
      } else throw new Error('探针项目只接受普通文件和目录');
    }
  };
  visit(root); return files;
}

export function runExecutionProbe(input: ProbeInput, adapter: ExecutorAdapter, signal?: AbortSignal): Promise<ProbeResult> {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.id)) return Promise.reject(new Error('探针编号不合法'));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}\.md$/.test(input.artifactName)) return Promise.reject(new Error('探针产物必须是项目根目录下的 Markdown 文件'));
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 10 || input.timeoutMs > 300_000) return Promise.reject(new Error('探针时限必须在 10ms 到 5 分钟之间'));
  if (!input.objective.trim() || !input.configurationId || (!adapter.capabilities.projectDirectory && adapter.capabilities.artifactDelivery !== 'returned-content')) return Promise.reject(new Error('缺少目标、版本或可用成果交付能力'));
  const projectRoot = realpathSync(input.projectRoot);
  const allowedRoot = realpathSync(input.allowedRoot);
  if (!inside(allowedRoot, projectRoot)) return Promise.reject(new Error('项目真实路径不在允许范围内'));
  let evidenceRoot = resolve(input.evidenceRoot);
  if (inside(projectRoot, evidenceRoot)) return Promise.reject(new Error('证据目录必须与项目输入分离'));
  mkdirSync(evidenceRoot, { recursive: true });
  if (lstatSync(evidenceRoot).isSymbolicLink()) return Promise.reject(new Error('证据目录不能通过符号链接重定向'));
  evidenceRoot = realpathSync(evidenceRoot);
  if (inside(projectRoot, evidenceRoot)) return Promise.reject(new Error('证据真实路径必须与项目输入分离'));
  const root = join(evidenceRoot, input.id);
  const fingerprint = hash(JSON.stringify({ ...input, projectRoot, allowedRoot, evidenceRoot, capabilities: adapter.capabilities }));
  const existing = active.get(root);
  if (existing) return existing.fingerprint === fingerprint ? existing.promise : Promise.reject(new Error('同一探针编号不能更换输入或执行器配置'));
  if (existsSync(root)) {
    const path = join(root, 'result.json');
    if (!existsSync(path)) return Promise.reject(new Error('旧探针认领未完成，必须核对原进程，不可自动重派'));
    const result = JSON.parse(readFileSync(path, 'utf8')) as ProbeResult;
    if (result.fingerprint !== fingerprint) return Promise.reject(new Error('同一探针编号不能更换输入或执行器配置'));
    if (result.status === 'verified') {
      const artifact = result.artifact;
      try {
        if (!artifact || !inside(projectRoot, artifact.path) || lstatSync(artifact.path).isSymbolicLink()
          || hash(readFileSync(artifact.path)) !== artifact.sha256) throw new Error('artifact changed');
      } catch {
        return Promise.resolve({ ...result, status: 'needs_reconciliation', artifact: null,
          reason: '此前验收的产物已丢失或改变；需核对，不重新启动执行器' });
      }
    }
    if (result.status === 'running' || result.status === 'prepared') return Promise.resolve({ ...result, status: 'needs_reconciliation', reason: '此前运行没有结束回执；先核对原进程，不自动重派' });
    return Promise.resolve(result);
  }
  const promise = execute({ ...input, projectRoot, allowedRoot, evidenceRoot }, adapter, root, fingerprint, signal).finally(() => active.delete(root));
  active.set(root, { fingerprint, promise });
  return promise;
}

async function execute(input: ProbeInput, adapter: ExecutorAdapter, root: string, fingerprint: string, signal?: AbortSignal): Promise<ProbeResult> {
  const manifestPath = join(input.projectRoot, 'probe-input.json');
  const before = snapshot(input.projectRoot);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { project: string; nonce: string; projectRoot: string };
  if (manifest.project !== input.projectId || manifest.projectRoot !== input.projectRoot || !manifest.nonce?.trim()) throw new Error('项目清单与指定项目不一致，拒绝启动');
  if (before.has(input.artifactName)) throw new Error('验收产物已存在，不能把旧文件当作本轮交付');
  const lock = join(input.evidenceRoot, `project-${hash(input.projectRoot)}.lock`);
  const fd = openSync(lock, 'wx', 0o600); closeSync(fd);
  let result: ProbeResult = {
    protocolVersion: 1, id: input.id, fingerprint, executor: adapter.capabilities.id,
    projectId: input.projectId, projectRoot: input.projectRoot, status: 'prepared', reason: '已认领，尚未启动',
    sessionId: null, startedAt: new Date().toISOString(), finishedAt: null,
    localProcessClosed: true, remoteStopConfirmed: false, usage: null, artifact: null,
    artifactWriter: adapter.capabilities.artifactDelivery === 'returned-content' ? 'workbench' : 'executor',
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerFallback: ReturnType<typeof setTimeout> | undefined;
  let stopReason: 'timeout' | 'cancel' | null = null;
  let stop = () => {};
  let journalError = false;
  const save = () => {
    writeFileSync(join(root, 'result.tmp'), JSON.stringify(result, null, 2), { mode: 0o600 });
    renameSync(join(root, 'result.tmp'), join(root, 'result.json'));
  };
  const abort = () => { stopReason ??= 'cancel'; stop(); };
  try {
    mkdirSync(root);
    save();
    if (signal?.aborted) { result = { ...result, status: 'interrupted', reason: '启动前已取消，未调用执行器', localProcessClosed: true }; return result; }
    const handle = adapter.start({ projectRoot: input.projectRoot, prompt: input.objective, onEvent: (event) => {
      if (event.sessionId) result.sessionId = event.sessionId;
      if (event.type === 'diagnostic' && event.message) result.diagnostics = [...(result.diagnostics ?? []), event.message.slice(0, 500)].slice(-20);
      if (event.type === 'started') { result.status = 'running'; result.reason = '执行器已返回运行开始事件'; }
      try { save(); } catch { journalError = true; stop(); }
    } });
    result.localProcessClosed = false;
    stop = handle.interrupt;
    if (journalError) stop();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => { stopReason = 'timeout'; stop(); }, input.timeoutMs);
    // 停止后仍无本机 close 回执时返回未知，不假装已停止；持久化项目锁继续阻止重派。
    const unknown = new Promise<ExecutorExit>((resolveExit) => {
      timerFallback = setTimeout(() => resolveExit({ exitCode: null, signal: null, localProcessClosed: false,
        protocolCompleted: false, usage: null, error: '停止请求后仍未获得进程结束回执' }), input.timeoutMs + 5000);
    });
    const exit = await Promise.race([handle.completion, unknown]);
    if (timerFallback) clearTimeout(timerFallback);
    result.localProcessClosed = exit.localProcessClosed;
    result.usage = exit.usage;
    if (exit.modelAlias) result.modelAlias = exit.modelAlias;
    if (stopReason || journalError || !exit.localProcessClosed || exit.remoteOutcomeUnknown) {
      result.status = stopReason === 'cancel' && exit.localProcessClosed ? 'interrupted' : 'needs_reconciliation';
      result.reason = journalError ? '执行记录写入失败，已请求停止，需核对结果' : stopReason === 'cancel'
        ? '已请求停止；本机进程结束状态单列，远端推理结束未确认'
        : exit.remoteOutcomeUnknown && exit.error ? `${exit.error}；结果待核对，不自动重派`
        : '执行超时或结束回执缺失；保留已有文件，不自动重派';
      return result;
    }
    if (exit.exitCode !== 0 || !exit.protocolCompleted || exit.error) {
      result.status = 'failed'; result.reason = exit.error ?? '缺少成功结束协议回执，不能认定交付完成'; return result;
    }
    let after = snapshot(input.projectRoot);
    if (result.artifactWriter === 'workbench') {
      // 返回内容模式下，软件不应修改任何输入；只由本地受控写入建立成果文件。
      if (after.size !== before.size || [...before].some(([path, checksum]) => after.get(path) !== checksum)) throw new Error('返回内容期间项目文件发生变化，拒绝保存成果');
      if (!exit.artifactContent || Buffer.byteLength(exit.artifactContent) > 100_000) throw new Error('缺少有效返回文档或内容超限');
      for (const text of [manifest.nonce, input.projectRoot, ...input.requiredText]) if (!exit.artifactContent.includes(text)) throw new Error('返回文档缺少项目证据或必要内容');
      writeFileSync(join(input.projectRoot, input.artifactName), exit.artifactContent, { flag: 'wx', mode: 0o600 });
      after = snapshot(input.projectRoot);
    }
    for (const [path, checksum] of before) if (after.get(path) !== checksum) throw new Error(`项目输入被修改或删除：${path}`);
    for (const path of after.keys()) if (!before.has(path) && path !== input.artifactName) throw new Error(`出现未约定的文件：${path}`);
    const artifactPath = join(input.projectRoot, input.artifactName);
    if (!after.has(input.artifactName)) throw new Error('执行器声称完成，但验收文件不存在');
    const content = readFileSync(artifactPath);
    for (const text of [manifest.nonce, input.projectRoot, ...input.requiredText]) if (!content.toString('utf8').includes(text)) throw new Error('产物缺少项目证据或必要验收内容');
    result.artifact = { path: artifactPath, sha256: hash(content), bytes: content.length };
    result.status = 'verified'; result.reason = result.artifactWriter === 'workbench'
      ? '返回文档结构与项目关联核验通过，由工作台保存；不证明软件原生项目执行或语义质量已验收'
      : '文件、项目标识、必要内容与输入不变检查通过；不代表生产功能已应用';
    return result;
  } catch (error) {
    stop();
    result.status = result.localProcessClosed ? 'failed' : 'needs_reconciliation';
    result.reason = (error as Error).message;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (timerFallback) clearTimeout(timerFallback);
    signal?.removeEventListener('abort', abort);
    result.finishedAt = new Date().toISOString();
    if (existsSync(root)) save();
    if (result.status === 'verified' || (result.status === 'failed' && result.localProcessClosed) || (result.status === 'interrupted' && !stopReason)) unlinkSync(lock);
  }
}
