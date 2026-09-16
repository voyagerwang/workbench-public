/** [INPUT]: 当前目标、全部工具定义 [OUTPUT]: 按需工具集合 [POS]: 选择只影响提示体积，不改变工具权限。 */
import { KNOWLEDGE_TRIGGER } from './assistant-knowledge-rule.js';
type AssistantToolDefinition = { name: string };
export const discoveryTool = {
  name: 'workbench_load_tools',
  description: '加载本轮尚未提供的工具组。calendar=钉钉日程/通讯录/会议室，feishu=飞书消息与派发，library=Skill/提示词，knowledge=知识库/云文档，records=清单/笔记/提醒，agents=委派/续办。返回后使用完整工具参数，不能猜参数。',
  parameters: { type:'object', properties:{ group:{type:'string',enum:['calendar','feishu','library','knowledge','records','agents','all']} }, required:['group'], additionalProperties:false },
};
export function groupFor(name: string): string {
  if (name.startsWith('dingtalk_')) return 'calendar';
  if (name.startsWith('feishu_')) return 'feishu';
  if (name.startsWith('agent_')) return 'agents';
  if (/library|use_skill|use_prompt|save_skill/.test(name)) return 'library';
  if (/knowledge|remote_document|archive/.test(name)) return 'knowledge';
  return 'records';
}
export function initialToolNames(text: string, tools: readonly AssistantToolDefinition[]): Set<string> {
  const groups = new Set(['records','agents']);
  if (/钉钉|日程|会议|预约|忙闲|空闲|有空/.test(text)) groups.add('calendar');
  if (/飞书|lark|群聊|群消息|艾特|群里|发送/i.test(text)) groups.add('feishu');
  if (/skill|提示词|技能|方法论/i.test(text)) groups.add('library');
  // 资料类事实问题（文档里怎么规定的、适用对象是什么）也要能拿到检索工具，
  // 否则模型看不见 workbench_search_knowledge_base 就只能凭印象回答
  // 资料类事实问题（文档里怎么规定的、适用对象是什么）也要能拿到检索工具，
  // 否则模型看不见 workbench_search_knowledge_base 就只能凭印象回答
  if (KNOWLEDGE_TRIGGER.test(text)) groups.add('knowledge');
  return new Set(tools.filter(t => groups.has(groupFor(t.name))).map(t => t.name));
}
