/**
 * [INPUT]: 本轮（含此前各轮）模型工具调用的名称与原始返回结果、最新一条用户命令原文
 * [OUTPUT]: 能否跳过「再回一次模型写回执」的保守判定（命中时给出任务编号，未命中给出理由）
 * [POS]: assistant 模型循环的只读判定层；不落库、不派发、不生成回执文案，
 *        判定权与执行权仍在 assistant.ts（结果仍走 sealDispatchCollector / takeCreatedAgentTasks / authoritativeReceipt）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/**
 * 只有这两个工具成功时会自己带着可验证的任务对象回来：任务编号 + 真实状态都在服务端，
 * 模型再写一句回执只会被 authoritativeReceipt 整段替换，所以这一轮模型调用是纯浪费。
 * 其余工具（加载工具、读取资料、写入、派发…）一律不参与判定。
 */
export const RECEIPT_SHORTCUT_TOOLS: readonly string[] = ['agent_delegate', 'agent_continue'];

/**
 * 短路时替代模型回执的结构化正文。authoritativeReceipt 只要拿到任务就会整段替换它；
 * 万一没被替换（不应发生，判定已要求至少一条任务凭证），这句话也只说「已登记」，
 * 不会把 drafted 说成已开始或已完成。
 */
export const RECEIPT_SHORTCUT_REPLY = '已登记，状态以服务端回执为准。';

export type ShortcutToolCall = { name: string; result: unknown };

export type ShortcutDecision =
  | { shortcut: true; taskIds: string[] }
  | { shortcut: false; reason: string };

/** 任务编号即凭证：没有它就没有「可验证的任务对象」，一律不短路。 */
const TASK_ID = /^(?:WB-)?\d{8}-\d{3,}$/;

/**
 * 正向委派命令：必须出现明确的「让/用/交/派给/委派给」类动词 + 受派主体
 * （Codex / WorkBuddy / ZCode / Agent / 智能体）+ 工作内容，且动词需落在句首
 * （允许「把…」处置式把宾语前置）。仅靠句子里出现 Agent 名称不算命令——
 * 查询句「Codex 项目有多少任务」、翻译/引用句「请翻译"让 Codex 修复页面"」
 * 因缺少「动词+主体」结构而不命中，不会短路。
 */
const AGENT_NAME = '(?:codex|workbuddy|zcode|agent|智能体)';
const DELEGATE_VERB = '(?:让|用|交给|派给|委派给|委派)';
const DELEGATION_COMMAND = new RegExp(
  `^(?:请\\s*)?(?:把[^，,。；;\\n]*?)?${DELEGATE_VERB}(?:\\s*独立)?\\s*${AGENT_NAME}`,
  'i',
);

/**
 * 续办短口令：完整明确的续办指令，允许「直接派发，不用再确认」这类带单逗号形式。
 * 在「多分句拒绝」之前优先判定，避免被逗号规则误杀。
 */
const CONTINUE_SHORTCUT = /^(?:(?:直接派发|开始派发|确认派发|确认续办|开始执行)(?:[，,]\s*不用(?:再)?(?:跟我)?确认)?|不用(?:再)?(?:跟我)?确认|催(?:一下|办)?|继续(?:这个|上一条|原|之前)?(?:任务)?|接着做)$/;

/**
 * 用户还要求本助手做别的事。命中任何一条都不短路——
 * 「派发后再解释/比较/回答一个问题」「顺手记一下」「你给我列三个风险」都必须留给模型。
 * 宁可多花一轮模型，也不能把用户额外的问题吞掉。
 */
const EXTRA_ASK = /(?:解释|说明|讲讲|讲一下|为什么|为何|对比|比较|区别|优劣|哪个好|怎么样|怎样|如何|评价|看法|建议|意见|告诉我|汇报|回答|帮我(?:看|查|读|找|搜|总结|归纳|整理|写|记|分析|改|做|列|说|讲)|记一下|记下来|记到|保存|存到|存档|提醒我|加个提醒|建个(?:任务|提醒)|添加|周报|总结|归纳|摘要|顺便|另外|同时|还有|以及|并且|并(?!发)|而且|然后|接着|之后|[？?]|你(?:给我|帮我|来|先|再|直接)|给我(?:列|说|讲|写|总结|分析|看|查|找|读))/i;

/** 否定/撤回：说了 agent 字样也可能是在叫停，不能当作委派。 */
const NEGATION = /(?:不要|不必|别|禁止|取消|撤回|先不|暂不|不用派|不要派)/;

/** 「不用再确认」是续办口令，不能被否定规则误杀。 */
const CONFIRM_FREE = /(?:不用(?:再)?(?:跟我)?确认)/g;

function taskIdOf(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const row = result as Record<string, unknown>;
  if (row.ok === false) return null;
  if (typeof row.error === 'string' && row.error.trim()) return null;
  if (typeof row.status !== 'string' || !row.status.trim()) return null;
  const id = typeof row.taskId === 'string' ? row.taskId : typeof row.id === 'string' ? row.id : '';
  return TASK_ID.test(id.trim()) ? id.trim() : null;
}

/**
 * 用户命令是否是「纯委派/续办」：只认从句首开始的明确命令（可选「请」+ 让/用/交/派给/委派给
 * + 可选「独立」+ Codex/WorkBuddy/ZCode/Agent/智能体 + 工作内容），或完整的明确续办短口令。
 * 否定/问句/已有 EXTRA_ASK、以及分号/逗号/换行分出的多分句一律拒绝（末尾句号可移除）。
 * 翻译/引用/查询句因缺少「动词+主体」结构不会命中，保守保留原循环。
 */
export function isPureDelegationCommand(text: string): boolean {
  const value = (text ?? '').trim().replace(/[。.]$/, '');
  if (!value || value.length > 200) return false; // 长指令几乎一定夹带别的要求，保守继续
  if (NEGATION.test(value.replace(CONFIRM_FREE, ''))) return false; // 否定/叫停不能当委派
  if (CONTINUE_SHORTCUT.test(value)) return true; // 完整续办短口令（允许带单逗号）
  // 分号 / 换行 / 逗号分出的多分句一律拒绝，不省这一轮
  if (/[；;\n，,]/.test(value)) return false;
  if (EXTRA_ASK.test(value)) return false; // 夹带让本助手做的第二件事，留给模型
  return DELEGATION_COMMAND.test(value); // 否则必须命中正向委派命令结构
}

/**
 * 联合判定：工具结果（有没有可验证的任务对象）+ 最新用户命令（是不是纯委派/续办）。
 * 不扫描历史、不假定旧授权，只看「本轮」这两份证据。
 */
export function evaluateReceiptShortcut(input: {
  latestUserText: string;
  toolCalls: ShortcutToolCall[];
}): ShortcutDecision {
  const calls = input.toolCalls ?? [];
  if (!calls.length) return { shortcut: false, reason: '本轮没有工具调用' };

  for (const call of calls) {
    if (!RECEIPT_SHORTCUT_TOOLS.includes(call.name)) {
      return { shortcut: false, reason: `本轮调用了 ${call.name}，不是纯委派` };
    }
  }

  const taskIds: string[] = [];
  for (const call of calls) {
    const id = taskIdOf(call.result);
    if (!id) return { shortcut: false, reason: `${call.name} 未返回可验证的任务对象（失败或未知结果不短路）` };
    if (!taskIds.includes(id)) taskIds.push(id);
  }

  if (!isPureDelegationCommand(input.latestUserText)) {
    return { shortcut: false, reason: '用户命令不是纯委派/续办' };
  }
  return { shortcut: true, taskIds };
}

/** 记下的任务有没有被完整带回：少任何一条都不能短路（宁可多一轮模型，不能丢条目）。 */
export function coversTaskIds(recordedTaskIds: string[], expectedTaskIds: string[]): boolean {
  const seen = new Set(recordedTaskIds);
  return expectedTaskIds.every((id) => seen.has(id));
}
