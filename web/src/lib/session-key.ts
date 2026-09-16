/**
 * 会话键解析的纯逻辑，独立成文件以便 node 端 tsx 单测（不引入 @/ 别名与 React，
 * 任何超出前端的脚本都能直接 import）。
 */

/**
 * 删除某条会话后，下一个应该激活的会话键。
 * - 删的不是当前会话：当前不变。
 * - 删的是当前会话、且还有剩余：落到「最近一条剩余」（rows 已按 updatedAt 倒序）。
 * - 删的是当前会话、且已无剩余：调用 mintKey 建一个新会话（调用方负责 ensure）。
 */
export function resolveActiveAfterDelete(
  currentKey: string,
  removedKey: string,
  remainingRows: { key: string; updatedAt: string }[],
  mintKey: () => string,
): string {
  if (currentKey !== removedKey) return currentKey;
  if (remainingRows.length === 0) return mintKey();
  return remainingRows[0].key;
}
