/**
 * [INPUT]: 固定 Codex 配置、指定项目与共用 JSONL 进程边界
 * [OUTPUT]: 进程/正文/usage回执；默认临时会话，可显式绑定项目创建或续接持久会话
 * [POS]: Codex 供应商适配层；仅解释 Codex 协议，不规划任务、不判定产物正确、不自动重试
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { ExecutorAdapter, ExecutorEvent, ExecutorUsage } from './executor-contract.js';
import { executorJsonlProcess } from './executor-jsonl-process.js';
import {realpathSync} from 'node:fs';
export type CodexSessionOption={mode:'create';projectRoot:string}|{mode:'resume';projectRoot:string;id:string};

/** 配置只能由服务端装配，不能使用模型或 HTTP 自由传入的命令/参数。 */
export function codexCliAdapter(config: { binary: string; model: string; env?: NodeJS.ProcessEnv; sandbox?: 'read-only' | 'workspace-write'; reasoningEffort?:'low'|'medium'|'high';session?:CodexSessionOption }): ExecutorAdapter {
  const sandbox = config.sandbox ?? 'workspace-write';
  const session=config.session?Object.freeze({...config.session,projectRoot:realpathSync(config.session.projectRoot)}):undefined;
  if(session?.mode==='resume'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.id))throw new Error('续接必须指定有效会话UUID');
  return {
    capabilities: { protocolVersion: 1, id: 'codex-cli', projectDirectory: true, progressEvents: true, cancellation: 'local-process', resume: Boolean(session), sandbox },
    start({ projectRoot, prompt, onEvent }) {
      if(session&&realpathSync(projectRoot)!==session.projectRoot)throw new Error('会话绑定项目不匹配');
      let completed = false; let protocolFailure = false;
      let observedSession:string|null=null;
      let usage: ExecutorUsage | null = null; let error: string | null = null;
      let artifactContent = '';
      const parse = (line: string) => {
        if (!line.trim()) return;
        let data: Record<string, any>;
        try { data = JSON.parse(line); } catch { protocolFailure = true; throw new Error('invalid protocol'); }
        if (!data || typeof data !== 'object') { protocolFailure = true; throw new Error('invalid protocol'); }
        if(data.type==='thread.started'){
          observedSession=typeof data.thread_id==='string'?data.thread_id:null;
          if(session?.mode==='resume'&&observedSession!==session.id){protocolFailure=true;error='续接回执会话ID不匹配';throw new Error('session mismatch');}
        }
        const event: ExecutorEvent | null = data.type === 'thread.started' ? { type: 'accepted', sessionId: typeof data.thread_id === 'string' ? data.thread_id : undefined }
          : data.type === 'turn.started' ? { type: 'started' }
          : data.type === 'item.completed' ? { type: 'progress', message: String(data.item?.type ?? 'item'),
            ...(data.item?.type === 'command_execution' && typeof data.item.command === 'string' ? {
              command: data.item.command.replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s;]+/gi, '$1[redacted]').slice(0, 8000),
              exitCode: typeof data.item.exit_code === 'number' ? data.item.exit_code : null,
            } : {}) }
          : null;
        if (event) onEvent(event);
        if (data.type === 'item.completed' && data.item?.type === 'agent_message' && typeof data.item.text === 'string') artifactContent = data.item.text;
        if (data.type === 'turn.failed' || data.type === 'error') {
          protocolFailure = true; error = String(data.error?.message ?? data.message ?? '执行器报告失败').slice(0, 500);
        }
        if (data.type === 'turn.completed') {
          completed = true;
          const raw = data.usage;
          const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
          if (raw && valid(raw.input_tokens) && valid(raw.output_tokens)) usage = {
            inputTokens: raw.input_tokens, outputTokens: raw.output_tokens,
            cachedInputTokens: valid(raw.cached_input_tokens) ? raw.cached_input_tokens : null,
          };
        }
      };
      let warned = false;
      const shared=['--ignore-user-config','--skip-git-repo-check','--model',config.model,'--json',
        ...(config.reasoningEffort?['-c',`model_reasoning_effort="${config.reasoningEffort}"`]:[])];
      const args=session?.mode==='resume'
        ?['exec','--sandbox',sandbox,'--cd',projectRoot,'resume',...shared,session.id,'-']
        :['exec',...shared,...(session?[]:['--ephemeral']),'--sandbox',sandbox,'--cd',projectRoot,'-'];
      onEvent({type:'diagnostic',message:JSON.stringify({kind:'launch_configuration',model:config.model,reasoningEffort:config.reasoningEffort??'provider-default',sandbox,projectRoot,sessionMode:session?.mode??'ephemeral'})});
      const handle = executorJsonlProcess({ binary: config.binary,
        args, cwd: projectRoot, env: config.env,
        prompt, onLine: parse, onStderr(text) {
          if (!warned && /timed out|stream disconnected/.test(text)) {
            warned = true; onEvent({ type: 'diagnostic', message: '模型连接中断或超时，等待本次截止时间，不自动重派' });
          }
        },
      });
      return { interrupt: handle.interrupt, completion: handle.completion.then((exit) => ({ ...exit,
        protocolCompleted: completed && !protocolFailure && !exit.error && (!session||Boolean(observedSession)), usage, artifactContent,
        error: error ?? exit.error ?? (session&&!observedSession?'缺少持久会话回执':null) })) };
    },
  };
}
