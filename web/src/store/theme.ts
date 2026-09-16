import { create } from 'zustand';
import { api } from '@/lib/api';

export type ThemeMode = 'auto' | 'light' | 'dark';

const resolve = (m: ThemeMode): 'light' | 'dark' => {
  if (m === 'auto') {
    const h = new Date().getHours();
    return h >= 7 && h < 19 ? 'light' : 'dark';
  }
  return m;
};

const apply = (r: 'light' | 'dark') => {
  const root = document.documentElement;
  root.dataset.theme = r;
  root.style.colorScheme = r;
};

interface ThemeState {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  init: () => void;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
}

// 代号重命名迁移：workbench.theme -> workbench.theme（仅执行一次，避免丢失用户主题偏好）
try {
  if (!localStorage.getItem('workbench.theme') && localStorage.getItem('yao.theme') != null) {
    localStorage.setItem('workbench.theme', localStorage.getItem('yao.theme')!);
    localStorage.removeItem('yao.theme');
  }
} catch { /* 隐私模式等场景下 localStorage 不可用，忽略 */ }

export const useTheme = create<ThemeState>((set, get) => ({
  mode: ((): ThemeMode => {
    try { return (localStorage.getItem('workbench.theme') as ThemeMode) || 'auto'; } catch { return 'auto'; }
  })(),
  resolved: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  init: () => {
    const { mode, resolved: prev } = get();
    const r = resolve(mode);
    apply(r);
    set({ resolved: r });
    // auto 模式下每分钟检查是否跨过日/夜切换点
    setInterval(() => {
      if (get().mode !== 'auto') return;
      const nr = resolve('auto');
      if (nr !== get().resolved) { apply(nr); set({ resolved: nr }); }
    }, 60_000);
    void prev;
  },
  setMode: (m) => {
    try { localStorage.setItem('workbench.theme', m); } catch { /* ignore */ }
    // 同步到服务端设置：localStorage 不可靠（被清理/隐私模式）时刷新仍可恢复
    api.saveSettings({ general: { theme: m } }).catch(() => { /* ignore */ });
    const r = resolve(m);
    apply(r);
    set({ mode: m, resolved: r });
  },
  toggle: () => get().setMode(get().resolved === 'dark' ? 'light' : 'dark'),
}));
