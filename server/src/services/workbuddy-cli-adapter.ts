/**
 * [INPUT]: WorkBuddy 内置 CLI、模型/费用约束、可信账号档位目录和指定验收目录
 * [OUTPUT]: ExecutorAdapter 的目录执行或无工具文本返回、关联事件、分项用量与保守结束证据
 * [POS]: WorkBuddy 内置引擎适配；知识文本模式关闭工具，目录模式只开放固定读写，不开启通用派发
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { join, resolve } from 'node:path';
import type { ExecutorAdapter, ExecutorUsage } from './executor-contract.js';
import { executorJsonlProcess } from './executor-jsonl-process.js';
import { modelRequirement, selectTaskModel, type ModelCatalog, type ModelCostPolicy } from './agent-model-policy.js';

export function workbuddyCliAdapter(config: {
  node: string; cli: string; model: string; sessionId: string; env?: NodeJS.ProcessEnv;
  requestedCostPolicy?: ModelCostPolicy;
  /** 知识归纳专用：不开放任何工具，只接受 result.result 作为返回文本。 */
  textOnly?: boolean;
  /** 来自可信装配端的当前 CLI 账号目录；桌面截图不满足此证据契约。 */
  modelCatalog?: ModelCatalog; accountScope?: string;
}): ExecutorAdapter {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/.test(config.sessionId)) throw new Error('WorkBuddy 会话编号不合法');
  return {
    capabilities: { protocolVersion: 1, id: 'workbuddy-cli', projectDirectory: true, progressEvents: true,
      cancellation: 'local-process', resume: false },
    start({ projectRoot, prompt, onEvent }) {
      const requirement = modelRequirement(config.model, config.requestedCostPolicy);
      let selectedModel = requirement.requestedModel ?? 'auto';
      if (requirement.requestedCostPolicy === 'free_only') {
        const selected = selectTaskModel(requirement, config.modelCatalog ?? null,
          { executor: 'workbuddy-cli', accountScope: config.accountScope ?? '' });
        // CLI 只有 --model，不能表达另一个计费档位键；不能猜测它会自动选免费版本。
        if (selected.selectionId !== selected.modelId) throw new Error('WorkBuddy CLI 无法明确选择该免费档位，未启动任务');
        selectedModel = selected.modelId;
      }
      let completed = false; let initialized = false; let failure: string | null = null;
      let usage: ExecutorUsage | null = null; let modelAlias: string | undefined;
      let remoteUnknown = false;
      const settings = { disableAllHooks: true, enabledPlugins: {},
        permissions: { allow: config.textOnly ? [] : [`Read(/${join(projectRoot, 'probe-input.json')})`, `Write(/${join(projectRoot, 'acceptance.md')})`] } };
      let artifactContent: string | undefined;
      const handle = executorJsonlProcess({ binary: config.node,
        args: [config.cli, '-p', '--output-format', 'stream-json', '--verbose', '--model', selectedModel,
          '--session-id', config.sessionId, '--no-session-persistence', '--max-turns', config.textOnly ? '1' : '6',
          '--tools', config.textOnly ? '' : 'Read,Write', '--permission-mode', 'dontAsk', '--setting-sources', '',
          '--settings', JSON.stringify(settings), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
        cwd: projectRoot, env: { ...(config.env ?? globalThis.process.env), CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1' }, prompt,
        onStderr(text) {
          if (/not logged in|authentication required|please login|please log in|请.*登录|未登录/i.test(text)) failure = 'WorkBuddy 内置 CLI 认证不可用，需要连接有效账号';
        },
        onLine(line) {
          const data = JSON.parse(line);
          if (!data || typeof data !== 'object' || typeof data.type !== 'string') throw new Error('无效事件');
          if (data.session_id && data.session_id !== config.sessionId) { failure = 'WorkBuddy 返回了其他会话的事件'; remoteUnknown = true; throw new Error(failure); }
          if (data.type === 'system' && data.subtype === 'init') {
            if (initialized || data.session_id !== config.sessionId || typeof data.cwd !== 'string' || resolve(data.cwd) !== projectRoot) {
              failure = 'WorkBuddy 未确认指定会话和项目目录'; remoteUnknown = true; throw new Error(failure);
            }
            if (!Array.isArray(data.tools) || data.tools.some((tool: unknown) => typeof tool !== 'string')) throw new Error('工具目录协议无效');
            // 2.137.1 的 init 枚举 agent.tools；运行时另按 session.options.tools 过滤。
            // 因此目录不等于实际调用授权，不能因枚举多于 Read/Write 就误判执行越权。
            if (data.tools.some((tool: string) => !['Read', 'Write'].includes(tool))) onEvent({ type: 'diagnostic',
              message: config.textOnly ? '初始化返回软件工具目录；本任务通过空 --tools 禁用实际调用' : '初始化返回软件工具目录；本任务通过 --tools 限定 Read/Write，实际调用另行核验' });
            initialized = true; modelAlias = typeof data.model === 'string' ? data.model : undefined;
            if (selectedModel !== 'auto' && modelAlias !== selectedModel) {
              failure = 'WorkBuddy 未确认指定模型，已请求停止，不能认定模型要求已满足'; remoteUnknown = true; throw new Error(failure);
            }
            onEvent({ type: 'accepted', sessionId: data.session_id });
          }
          if (data.type === 'assistant') {
            if (!initialized) throw new Error('缺少初始化证据');
            onEvent({ type: 'started' });
            if (data.error) failure = 'WorkBuddy 模型调用失败';
            for (const block of data.message?.content ?? []) if (block.type === 'tool_use') {
              if (config.textOnly) {
                failure = 'WorkBuddy 文本任务请求了工具'; remoteUnknown = true; throw new Error(failure);
              }
              const expected = block.name === 'Read' ? 'probe-input.json' : block.name === 'Write' ? 'acceptance.md' : null;
              if (!expected || typeof block.input?.file_path !== 'string' || resolve(projectRoot, block.input.file_path) !== join(projectRoot, expected)) {
                failure = 'WorkBuddy 请求了超出约定范围的工具或文件'; remoteUnknown = true; throw new Error(failure);
              }
              onEvent({ type: 'progress', message: block.name });
            }
          }
          if (data.type === 'system' && String(data.subtype).startsWith('task_')) {
            failure = 'WorkBuddy 启动了未约定的后台任务'; remoteUnknown = true; throw new Error(failure);
          }
          if (data.type === 'result') {
            if (completed) throw new Error('重复结束事件');
            const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
            const raw = data.usage;
            if (raw && valid(raw.input_tokens) && valid(raw.output_tokens)) usage = {
              inputTokens: raw.input_tokens, outputTokens: raw.output_tokens,
              cachedInputTokens: valid(raw.cache_read_input_tokens) ? raw.cache_read_input_tokens : null,
              cacheCreationInputTokens: valid(raw.cache_creation_input_tokens) ? raw.cache_creation_input_tokens : null,
            };
            completed = true;
            if (config.textOnly && typeof data.result === 'string' && data.result.trim()) artifactContent = data.result.trim();
            if (!initialized || data.session_id !== config.sessionId || data.subtype !== 'success' || data.is_error !== false
              || (Array.isArray(data.permission_denials) && data.permission_denials.length) || (config.textOnly && !artifactContent)) {
              const auth = data.errors_info?.some((item: { category?: string }) => item?.category === 'auth');
              failure = auth ? 'WorkBuddy 内置 CLI 认证不可用，需要连接有效账号' : 'WorkBuddy 未成功完成或存在权限拒绝';
            }
          }
        },
      });
      return { interrupt: handle.interrupt, completion: handle.completion.then((exit) => ({ ...exit,
        protocolCompleted: completed && initialized && !failure && !exit.error,
        error: failure ?? exit.error ?? (!completed ? '未收到 WorkBuddy 结束回执' : null), usage, modelAlias, artifactContent,
        remoteOutcomeUnknown: remoteUnknown || !completed })) };
    },
  };
}
