/** 撤回窗口纯逻辑，独立成文件以便单测（前端无 React 测试运行时，等价测试走 tsx 脚本）。 */

export const RECALL_WINDOW_MS = 5 * 60_000;

/**
 * 判断某条已发消息此刻是否仍在可撤回窗口内。
 * 纯函数：不读系统时钟，由调用方传入 `now`，方便测试与组件内定时刷新复用。
 * 返回 false 的情形：未发送时间、时间不可解析、已超出 5 分钟。
 */
export function isWithinRecallWindow(sentAt: string | undefined | null, now: number): boolean {
  if (!sentAt) return false;
  const sentMs = Date.parse(sentAt);
  if (!Number.isFinite(sentMs)) return false;
  // 过去时间才可能在窗口内；未来时间（含时钟抖动）视作异常，按 false 处理，
  // 与后端 fail-closed 门禁一致——按钮该禁用，最终裁决仍在服务端。
  const elapsed = now - sentMs;
  return elapsed >= 0 && elapsed <= RECALL_WINDOW_MS;
}
