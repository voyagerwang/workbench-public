import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * 助手的「检索资料」信号（引用计数，可叠加）：
 * - AI 分诊 / 改分类：api 层用 orbTrack 自动包裹
 * - 助手输入中 / 命令面板输入中：输入组件用 useOrbTyping 显式上报
 * - 页面首次加载（首屏查询 pending）：AppShell 里的 OrbBusyBridge 桥接 react-query
 */
export const useOrbActivity = create<{
  busy: number;
  start: () => void;
  end: () => void;
}>((set) => ({
  busy: 0,
  start: () => set((s) => ({ busy: s.busy + 1 })),
  end: () => set((s) => ({ busy: Math.max(0, s.busy - 1) })),
}));

/** 包一个在途异步任务：进行期间助手切到「检索资料」状态 */
export async function orbTrack<T>(p: Promise<T>): Promise<T> {
  useOrbActivity.getState().start();
  try {
    return await p;
  } finally {
    useOrbActivity.getState().end();
  }
}

/** 输入态上报：typing 变 true 时计数 +1、变回 false 时 -1（成对，不漏还） */
export function useOrbTyping(typing: boolean): void {
  useEffect(() => {
    if (!typing) return;
    useOrbActivity.getState().start();
    return () => useOrbActivity.getState().end();
  }, [typing]);
}
