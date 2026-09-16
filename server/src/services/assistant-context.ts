/** [INPUT]: 当前主题消息 [OUTPUT]: 有限上下文和可见省略标记 [POS]: 历史完整存档不受影响。 */
export function compactHistory(messages: Array<{role:'user'|'assistant';content:string;images?:string[]}>) {
  const selected: typeof messages = []; let chars = 0;
  for (const message of [...messages].reverse()) {
    if (selected.length && (selected.length >= 12 || chars + message.content.length > 20000)) break;
    selected.unshift(message); chars += message.content.length;
  }
  return { messages:selected, omitted:messages.length-selected.length };
}
