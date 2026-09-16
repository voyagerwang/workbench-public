// 情绪球的界面态：动作回应的耳语 + 「我在看什么」的展开态。
// 注意：耳语只在本地发生，不打接口——它要的是即时，不是准确。
import { create } from 'zustand';
import type { MoodPulse, MoodSnapshot } from '@/types';

// 代号重命名迁移：workbench.mood.* -> workbench.mood.*（仅执行一次，避免丢失情绪球开关偏好）
try {
  for (const k of ['enabled', 'idle'] as const) {
    if (localStorage.getItem(`workbench.mood.${k}`) == null && localStorage.getItem(`yao.mood.${k}`) != null) {
      localStorage.setItem(`workbench.mood.${k}`, localStorage.getItem(`yao.mood.${k}`)!);
      localStorage.removeItem(`yao.mood.${k}`);
    }
  }
} catch { /* 隐私模式等场景下 localStorage 不可用，忽略 */ }

/** 兜底词池：快照还没回来时用（服务端 WHISPER 为准） */
const FALLBACK: Record<MoodPulse, string[]> = {
  tick: ['嗯', '好', '收'],
  capture: ['知道了'],
  snooze: ['挪过来了'],
  delete: [],
  remind: ['到点叫你'],
  idle: ['……'],
};

/** 显示开关存在 localStorage，首帧就能决定渲染哪套头部（服务端 config 为准，回来再校正） */
const ENABLE_KEY = 'workbench.mood.enabled';
export const moodEnabledPref = {
  get(): boolean {
    try { return localStorage.getItem(ENABLE_KEY) !== '0'; } catch { return true; }
  },
  set(v: boolean) {
    try { localStorage.setItem(ENABLE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  },
};

/** idle 自言自语：默认关（最容易做过头的一项），想要在设置里开 */
const IDLE_KEY = 'workbench.mood.idle';
export const moodIdlePref = {
  get(): boolean {
    try { return localStorage.getItem(IDLE_KEY) === '1'; } catch { return false; }
  },
  set(v: boolean) {
    try { localStorage.setItem(IDLE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  },
};

interface MoodUiState {
  snapshot: MoodSnapshot | null;
  /** 耳语文本；null = 不说话 */
  whisper: string | null;
  /** 每次耳语自增，让球体重播一次「被戳」动画 */
  pulseSeq: number;
  pulseKind: MoodPulse | null;
  /** 说话预算：耳语每天有限，超了只动表情不动嘴 */
  budget: number;
  setSnapshot: (s: MoodSnapshot) => void;
  emit: (kind: MoodPulse, text?: string) => void;
  /** 只弹一下、不说话（散会、状态回位这类时刻） */
  pulseOnly: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

export const useMoodUi = create<MoodUiState>((set, get) => ({
  snapshot: null,
  whisper: null,
  pulseSeq: 0,
  pulseKind: null,
  budget: 6,
  setSnapshot: (snapshot) => {
    // 换日重新给预算
    const day = snapshot.dayKey;
    if (sessionStorage.getItem('mood.day') !== day) {
      sessionStorage.setItem('mood.day', day);
      set({ budget: 6 });
    }
    set({ snapshot });
  },
  emit: (kind, text) => {
    const { snapshot, budget } = get();
    if (!snapshot?.config.whisper || !snapshot.whisper) return;
    if (snapshot.quiet) { set({ pulseKind: kind, pulseSeq: get().pulseSeq + 1 }); return; }
    if (budget <= 0 && !text) return;
    const pool = snapshot.whispers?.[kind]?.length ? snapshot.whispers[kind] : FALLBACK[kind];
    const line = text ?? pool[Math.floor(Math.random() * pool.length)] ?? '';
    if (!line) { set({ pulseKind: kind, pulseSeq: get().pulseSeq + 1 }); return; }
    set({ whisper: line, pulseKind: kind, pulseSeq: get().pulseSeq + 1, budget: budget - 1 });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => set({ whisper: null }), 2400);
  },
  pulseOnly: () => set({ pulseSeq: get().pulseSeq + 1, pulseKind: 'idle' }),
}));

/** 给业务动作用的一行式调用：勾完成、捕获、挪期、加提醒 */
export const pulseMood = (kind: MoodPulse, text?: string) => useMoodUi.getState().emit(kind, text);

/** 长时间无操作时的低语：概率小、池子小，宁可不说；默认关闭（moodIdlePref 控制） */
export function startIdleWhisper(getSnapshot: () => MoodSnapshot | null): () => void {
  let idleSince = Date.now();
  const bump = () => { idleSince = Date.now(); };
  const tick = setInterval(() => {
    if (document.hidden || !moodIdlePref.get()) return;
    const idle = Date.now() - idleSince;
    if (idle < 45_000) return;
    if (Math.random() > 0.12) return;
    const s = getSnapshot();
    if (!s || s.quiet) return;
    idleSince = Date.now();
    pulseMood('idle');
  }, 90_000);
  ['pointermove', 'keydown', 'pointerdown'].forEach((e) => addEventListener(e, bump, { passive: true }));
  return () => {
    clearInterval(tick);
    ['pointermove', 'keydown', 'pointerdown'].forEach((e) => removeEventListener(e, bump));
  };
}
