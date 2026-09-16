/**
 * [INPUT]: 文档会话注册的保存守卫与 React Router 数据路由
 * [OUTPUT]: registerDocumentGuard、DocumentNavigationGuard，统一阻止未保存的路由离开
 * [POS]: 页面导航与文档保存之间的唯一桥梁；多个文档依次排空
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { toast } from 'sonner';

type Guard = { dirty: () => boolean; flush: () => Promise<void> };
const guards = new Set<Guard>();
export function registerDocumentGuard(guard: Guard) {
  guards.add(guard);
  return () => { guards.delete(guard); };
}
export function DocumentNavigationGuard() {
  const blocker = useBlocker(() => [...guards].some((guard) => guard.dirty()));
  const working = useRef(false);
  useEffect(() => {
    if (blocker.state !== 'blocked' || working.current) return;
    working.current = true;
    void (async () => {
      try {
        for (const guard of guards) await guard.flush();
        blocker.proceed();
      } catch (error) {
        toast.error(`暂未离开：${(error as Error).message}`);
        blocker.reset();
      } finally { working.current = false; }
    })();
  }, [blocker]);
  return null;
}
