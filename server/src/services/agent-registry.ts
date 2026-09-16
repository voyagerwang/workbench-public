/**
 * [INPUT]: 内置 Agent 意图登记白名单；WorkBuddy 内置 CLI 的指定目录文档实测与 Cola 文档交付实测
 * [OUTPUT]: listAgents() 全量清单、resolveAgent() 按 id/显示名解析、isExecutorAllowed() 启用校验
 * [POS]: 服务端权威 Agent 注册表（编排 V3 第七节）：模型与用户不能自由填写 chat_id 或 bot id，
 *        登记目标只能引用这里的条目；enabled 仅允许 drafted 意图，实际派发另受执行验收约束
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/**
 * 阶段 1 只读清单：V1 初始仅 codex（软件主管，CLI 通道）与 zcode（已通过 PING-004/005 的
 * 飞书私聊执行器）。WorkBuddy 经项目文档实测加入意图登记；Cola 经 2026-09-09 文档交付实测
 * 加入意图登记（文档与内容线文本总结类，内容分支见 content-text.ts）；
 * Qoder/Hermes 暂不加入。feishuChatId 等通道参数属阶段 2 派发实现，本阶段只消费 id/能力/启用位。
 */
export type AgentRegistryEntry = {
  id: string;
  displayName: string;
  enabled: boolean;
  transport: 'feishu_p2p' | 'cli' | 'manual';
  feishuChatId: string | null;
  feishuOpenBotId: string | null;
  capabilities: string[];
  verifiedModels: string[];
  maxConcurrentTasks: number;
};

const REGISTRY: AgentRegistryEntry[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    enabled: true,
    transport: 'cli',
    feishuChatId: null,
    feishuOpenBotId: null,
    capabilities: ['planning', 'review', 'code'],
    verifiedModels: [],
    maxConcurrentTasks: 1,
  },
  {
    id: 'zcode',
    displayName: 'ZCode',
    enabled: true,
    transport: 'feishu_p2p',
    // 阶段 2 接线时由服务端配置落库，模型与任务卡不可见
    feishuChatId: null,
    feishuOpenBotId: null,
    capabilities: ['code', 'frontend'],
    // PING-004/PING-005 实测自报模型；仅 observed 证据，自动进入 verifiedModels 需人工确认
    verifiedModels: ['GLM-5.3-Flash'],
    maxConcurrentTasks: 1,
  },
  {
    id: 'workbuddy', displayName: 'WorkBuddy', enabled: true, transport: 'cli',
    feishuChatId: null, feishuOpenBotId: null, capabilities: ['document'],
    // 实测使用 auto 路由，不把路由名当作已核实底层模型。
    verifiedModels: [], maxConcurrentTasks: 1,
  },
  {
    id: 'cola', displayName: 'Cola', enabled: true, transport: 'cli',
    feishuChatId: null, feishuOpenBotId: null,
    // 能力按 2026-09-09 文档交付实测与内容线文本总结接线（content-text.ts 文本模式）填写；不做代码/目录执行。
    capabilities: ['document', 'summary'],
    // 实测回执只有模型别名 model0824-01-c，未核实底层模型，不进 verifiedModels。
    // 内容线文本总结已验证，正式派单通道未接通。
    verifiedModels: [], maxConcurrentTasks: 1,
  },
];

export function listAgents(): AgentRegistryEntry[] {
  return REGISTRY.map((entry) => ({ ...entry }));
}

/** 按 id 或显示名解析（大小写不敏感）：模型填 "ZCode"/"zcode" 都收敛到权威 id。查不到返回 null。 */
export function resolveAgent(raw: string): AgentRegistryEntry | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  const found = REGISTRY.find((entry) => entry.id === key || entry.displayName.toLowerCase() === key);
  return found ? { ...found } : null;
}

/** 委派目标合法性：必须是登记过且启用的 Agent。 */
export function isExecutorAllowed(raw: string): AgentRegistryEntry | null {
  const entry = resolveAgent(raw);
  return entry && entry.enabled ? entry : null;
}
