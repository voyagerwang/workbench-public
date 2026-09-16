/**
 * [INPUT]: 清单详情实例的保存与关闭回调
 * [OUTPUT]: 唯一活动详情；切换等待保存，快速连点只打开最后一次请求
 * [POS]: 清单详情跨列表入口的互斥协调器
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
type Owner = { flush: () => Promise<void>; close: () => void };
export function createTaskDetailOwner() {
  let active: Owner | null = null;
  let pending: Owner | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => active,
    async open(owner: Owner) {
      if (active === owner) return;
      const superseded = pending;
      pending = owner;
      if (superseded && superseded !== owner) superseded.close();
      try {
        const previous = active;
        if (previous) await previous.flush();
        if (pending !== owner) return;
        pending = null;
        active = owner;
        previous?.close();
        emit();
      } catch (error) {
        if (pending !== owner) return;
        pending = null;
        owner.close();
        throw error;
      }
    },
    release(owner: Owner) {
      if (pending === owner) pending = null;
      if (active === owner) { active = null; emit(); }
    },
  };
}
export const taskDetailOwner = createTaskDetailOwner();
