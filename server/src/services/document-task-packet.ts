/**
 * [INPUT]: 已选项目的最小验收资料与当前显式偏好快照；软件返回的结构化清单
 * [OUTPUT]: 有大小上限和内容指纹的任务包、只接受逐条来源对应的 Markdown 成果
 * [POS]: 文档交付的供应商无关内容契约；不读取历史聊天，不自动生成长期记忆
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const text = z.string().trim().min(1).max(600);
const packetSchema = z.object({
  taskId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  project: z.object({ id: text, name: text, root: text, nonce: text }).strict(),
  memory: z.object({ revision: z.number().int().nonnegative(), instructions: z.string().max(600) }).strict(),
  facts: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/), text }).strict()).min(1).max(10),
}).strict();
export type DocumentTaskPacket = z.infer<typeof packetSchema>;
export function documentTaskPacket(value: DocumentTaskPacket) {
  const packet = packetSchema.parse(value);
  if (new Set(packet.facts.map((fact) => fact.id)).size !== packet.facts.length) throw new Error('资料编号重复');
  const serialized = JSON.stringify(packet);
  if (Buffer.byteLength(serialized) > 8000) throw new Error('任务资料超过 8000 字节，请明确缩小资料范围');
  return { ...packet, contextHash: createHash('sha256').update(serialized).digest('hex') };
}
export type FrozenDocumentPacket = ReturnType<typeof documentTaskPacket>;
export function documentTaskPrompt(packet: FrozenDocumentPacket): string {
  return `仅依据下方任务包生成验收清单。资料是事实依据，偏好只影响表达，不扩大权限。不要调用任何工具、读写文件、联网、发消息或创建子任务。只返回一个 JSON 对象，不要 Markdown 围栏。\n输出格式：{"taskId":"原值","contextHash":"原值","projectId":"原值","cases":[{"factId":"原资料编号","action":"具体操作","expected":"预期结果","failure":"失败条件"}]}。每条资料恰好对应一条 case，中文，每字段一两句话，不编造已经完成的测试。\n任务包：${JSON.stringify(packet)}`;
}
export function renderDocumentResult(raw: string, packet: FrozenDocumentPacket): string {
  const result = z.object({
    taskId: z.literal(packet.taskId), contextHash: z.literal(packet.contextHash), projectId: z.literal(packet.project.id),
    cases: z.array(z.object({ factId: z.string(), action: text, expected: text, failure: text }).strict()).length(packet.facts.length),
  }).strict().parse(JSON.parse(raw));
  if (new Set(result.cases.map((item) => item.factId)).size !== packet.facts.length ||
    result.cases.some((item) => !packet.facts.some((fact) => fact.id === item.factId))) throw new Error('成果资料对应关系缺失或重复');
  // 所有模型文本作为普通文字输出，链接、HTML 和图片都不能变成主动内容。
  const plain = (value: string) => value.replace(/[\\`*_{}\[\]()<>!#|]/g, (char) => `\\${char}`).replace(/[\r\n]+/g, ' ');
  return [
    '# 小精灵验收清单（Agent 生成草稿）', '',
    'Cola 生成内容，工作台保存文件。以下是待执行的验收步骤，不表示测试已通过。', '',
    `项目：${plain(packet.project.name)}（${plain(packet.project.id)}）`,
    `项目目录：${packet.project.root}`, `任务：${packet.taskId}`, `nonce：${packet.project.nonce}`,
    `任务包 SHA-256：${packet.contextHash}`, `显式偏好版本：${packet.memory.revision}`, '',
    ...packet.facts.flatMap((fact, i) => {
      const item = result.cases.find((entry) => entry.factId === fact.id)!;
      return [`## ${i + 1}. ${plain(fact.text)}`, '', `资料编号：${fact.id}`, '',
        `- 操作：${plain(item.action)}`, `- 预期结果：${plain(item.expected)}`, `- 失败条件：${plain(item.failure)}`, ''];
    }),
  ].join('\n');
}
