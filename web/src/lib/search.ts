// 全局搜索客户端：独立于 api.ts，避免和并行改动打架（后续可并回去）

// ⌘K 面板当前有预存在 bug（接口正常但 cmdk 不渲染任何条目，见 2026-09-05 排查记录），
// 应 cm 要求先整体下线：改回 true 即恢复入口、快捷键与面板，代码全部保留。
export const GLOBAL_SEARCH_ENABLED = false;
export interface SearchItem {
  id: number | string;
  title: string;
  hint: string;
  route: string;
}

export interface SearchGroup {
  type: 'task' | 'note' | 'knowledge' | 'source_document' | 'archive' | 'prompt' | 'reminder';
  label: string;
  items: SearchItem[];
}

export interface SearchReply {
  groups: SearchGroup[];
}

export async function globalSearch(q: string): Promise<SearchReply> {
  const query = q.trim();
  if (!query) return { groups: [] };
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`搜索失败 (${res.status})`);
  return res.json() as Promise<SearchReply>;
}
