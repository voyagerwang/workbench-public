import { create } from 'zustand';

/** 快捷键表示：'mod+k'（mod = macOS ⌘ / 其他 Ctrl）、'mod+shift+p' 等 */
export interface UiState {
  paletteOpen: boolean;
  setPalette: (open: boolean) => void;
  togglePalette: () => void;
  /** 全局搜索快捷键，默认 ⌘K；设置页可改，settings 加载后写入 */
  paletteShortcut: string;
  setPaletteShortcut: (s: string) => void;
}

export const useUi = create<UiState>((set) => ({
  paletteOpen: false,
  setPalette: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  paletteShortcut: 'mod+k',
  setPaletteShortcut: (paletteShortcut) => set({ paletteShortcut }),
}));

/** 判断 KeyboardEvent 是否命中快捷键串（'mod+k' / 'mod+shift+k' / 'alt+k'） */
export function matchShortcut(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string }, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? '';
  const needMod = parts.includes('mod');
  const needAlt = parts.includes('alt');
  const needShift = parts.includes('shift');
  if (needMod !== (e.metaKey || e.ctrlKey)) return false;
  if (needAlt !== e.altKey) return false;
  if (needShift !== e.shiftKey) return false;
  return e.key.toLowerCase() === key;
}
