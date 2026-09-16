/** [INPUT]: 对话文本 [OUTPUT]: 本地标题 [POS]: 装饰性标题不调用模型。 */
export async function generateConversationTitle(content: string): Promise<string | null> {
  const lines = content.split(/\r?\n/).map(line => line.replace(/^(?:用户|助理)[：:]\s*|^#{1,6}\s+/g, '').trim()).filter(Boolean);
  const first = lines.find(line => !/^https?:\/\/\S+$/.test(line)) ?? lines[0];
  return first ? first.slice(0, 30) : null;
}
