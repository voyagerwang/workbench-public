import { useEffect, useRef, useState } from 'react';
import type { MoodCharacter, MoodSnapshot } from '@/types';
import { useMoodUi } from '@/store/mood';
import { useOrbActivity } from '@/store/orbActivity';
import { cn } from '@/lib/utils';

/**
 * GitHub emotion-ball 原版适配器。
 * 原版是独立的 SVG 引擎（环形眼睛、身体形变和彩带），通过 iframe 隔离
 * 它的全局脚本，避免与工作台自身的 CSS / React 状态互相污染。
 *
 * 表情状态机（优先级从高到低，都在这一层算好后下发给 iframe）：
 *   生气 21        3s 内点它 ≥5 次，持续约 2.6s
 *   开心 10        单击一下，持续约 1.6s
 *   检索资料 40    AI 分诊 / 助手输入 / 首屏加载中（见 store/orbActivity）
 *   睡眠 00        22:00 后、7:00 前、午休 12:30–13:00；睡眠时段里
 *                  只要你在动鼠标或点它就会被喚醒（好奇/开心照常），
 *                  停手约 5s 后自己重新睡着（embed 层会变暗 + 飘 z z z）
 *   好奇 03        鼠标正在移动、小球跟着转脑袋的时候
 *   其余           待机放空 02（服务端心情快照只管文案与耳语，不接管表情）
 */

const EMO = { sleep: '00', idle: '02', curious: '03', happy: '10', angry: '21', searching: '40' };

/** 作息：晚上十点后、早上七点前、午休 12:30–13:00 在睡觉 */
export function orbAsleep(now = new Date()): boolean {
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= 22 * 60 || m < 7 * 60 || (m >= 12 * 60 + 30 && m < 13 * 60);
}

/** 跟随窗口：鼠标停下这么久之后就不再算「正在跟随」 */
const TRACKING_GRACE_MS = 1600;

/** 睡眠时段被喚醒后：这么久没有任何动静就重新入睡 */
const SLEEP_GRACE_MS = 5000;

export function MoodOrb({
  snap, size = 40, character, staticPreview = false, className, onClick, label,
}: {
  snap: MoodSnapshot | null;
  size?: number;
  character?: MoodCharacter;
  staticPreview?: boolean;
  className?: string;
  onClick?: () => void;
  label?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frameNameRef = useRef(
    `yz-mood-orb-frame-${staticPreview ? 'static' : 'live'}-${character ?? snap?.config.character ?? 'ball'}-${crypto.randomUUID()}`,
  );
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const gazeFrameRef = useRef<number | null>(null);
  const moveUntilRef = useRef(0);
  const clickTimesRef = useRef<number[]>([]);
  const reactionTimerRef = useRef<number | undefined>(undefined);
  const lastActivityRef = useRef(0);
  const lastPostedRef = useRef<string | null>(null);
  const suppressedRef = useRef(false);
  const [asleep, setAsleep] = useState(orbAsleep);
  const [awake, setAwake] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [reaction, setReaction] = useState<string | null>(null);
  const busy = useOrbActivity((s) => s.busy > 0);
  const pulseSeq = useMoodUi((s) => s.pulseSeq);
  const activeCharacter = character ?? snap?.config.character ?? 'ball';

  const post = (data: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(data, '*');
  };

  const sendPointerGaze = () => {
    gazeFrameRef.current = null;
    const pointer = pointerRef.current;
    const orb = frameRef.current;
    if (!pointer || !orb || suppressedRef.current) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const rect = orb.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    // 灵敏度：比按视口比例的旧算法更跟手——光标偏一点，眼神和身体就跟上
    const horizontalRange = Math.max(140, innerWidth * 0.3);
    const verticalRange = Math.max(120, innerHeight * 0.34);

    post({
      type: 'gaze',
      x: Math.max(-1, Math.min(1, (pointer.x - centerX) / horizontalRange)),
      y: Math.max(-1, Math.min(1, (pointer.y - centerY) / verticalRange)),
    });
  };

  /** 点击反应：单击开心；3s 内点满 5 次翻脸变生气 */
  const registerClick = () => {
    if (staticPreview) return;
    const now = Date.now();
    lastActivityRef.current = now;
    const times = clickTimesRef.current.filter((t) => now - t < 3000);
    times.push(now);
    clickTimesRef.current = times;
    if (times.length >= 5) {
      clickTimesRef.current = [];
      setReaction(EMO.angry);
      clearTimeout(reactionTimerRef.current);
      reactionTimerRef.current = window.setTimeout(() => setReaction(null), 2600);
    } else {
      setReaction(EMO.happy);
      clearTimeout(reactionTimerRef.current);
      reactionTimerRef.current = window.setTimeout(() => setReaction(null), 1600);
    }
  };

  // 作息钟：每半分钟核对一次是否到了睡觉时间
  useEffect(() => {
    const tick = () => setAsleep(orbAsleep());
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);

  // 「正在跟随」与「被喚醒」判定：每 300ms 核对一次最近的动静
  useEffect(() => {
    if (staticPreview) return;
    const timer = setInterval(() => {
      setTracking(pointerRef.current !== null && Date.now() < moveUntilRef.current);
      setAwake(lastActivityRef.current > 0 && Date.now() - lastActivityRef.current < SLEEP_GRACE_MS);
    }, 300);
    return () => clearInterval(timer);
  }, [staticPreview]);

  useEffect(() => () => clearTimeout(reactionTimerRef.current), []);

  useEffect(() => {
    if (pulseSeq > 0) post({ type: 'poke' });
  }, [pulseSeq]);

  useEffect(() => {
    if (staticPreview) return;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || reducedMotion.matches) return;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      moveUntilRef.current = Date.now() + TRACKING_GRACE_MS;
      lastActivityRef.current = Date.now();
      if (gazeFrameRef.current === null) gazeFrameRef.current = requestAnimationFrame(sendPointerGaze);
    };

    const clearGaze = () => {
      pointerRef.current = null;
      moveUntilRef.current = 0;
      if (gazeFrameRef.current !== null) cancelAnimationFrame(gazeFrameRef.current);
      gazeFrameRef.current = null;
      post({ type: 'gaze-clear' });
    };

    const onMotionPreferenceChange = () => {
      if (reducedMotion.matches) clearGaze();
    };

    addEventListener('pointermove', onPointerMove, { passive: true });
    addEventListener('blur', clearGaze);
    document.documentElement.addEventListener('pointerleave', clearGaze);
    reducedMotion.addEventListener('change', onMotionPreferenceChange);

    return () => {
      removeEventListener('pointermove', onPointerMove);
      removeEventListener('blur', clearGaze);
      document.documentElement.removeEventListener('pointerleave', clearGaze);
      reducedMotion.removeEventListener('change', onMotionPreferenceChange);
      if (gazeFrameRef.current !== null) cancelAnimationFrame(gazeFrameRef.current);
    };
  }, [staticPreview]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === frameRef.current?.contentWindow && event.data?.type === 'emotion-ball-clicked') {
        registerClick();
        onClick?.();
      }
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, [onClick]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 最终表情。注意 reaction 排最前：睡觉时戳它也会醒过来笑一下，
   * 笑完回到本行算出来的基底（多半是接着睡）。
   * 睡眠时段里有动静（awake）就当它醒着：动鼠标→好奇，停下→放空，
   * 5s 彻底没动静→重新睡回去。
   */
  const sleeping = asleep && !awake;
  const effective =
    reaction
    ?? (busy ? EMO.searching : sleeping ? EMO.sleep : tracking && activeCharacter !== 'yoona' ? EMO.curious : EMO.idle);

  // 只在变化时下发：引擎对重复 setEmotion 会重放入场动画，不能每帧都发
  useEffect(() => {
    if (lastPostedRef.current === effective) return;
    lastPostedRef.current = effective;
    post({ type: 'emotion', id: effective });
  }, [effective]);

  // 睡着（作息内且没被喚醒）/ 检索资料时不跟随鼠标：收住视线，身体也归位
  useEffect(() => {
    const suppress = !reaction && (sleeping || busy);
    suppressedRef.current = suppress;
    if (suppress) {
      moveUntilRef.current = 0;
      post({ type: 'gaze-clear' });
    }
  }, [reaction, sleeping, busy]);

  useEffect(() => {
    post({ type: 'quiet', value: Boolean(snap?.quiet) });
    post({ type: 'character', value: activeCharacter });
  }, [activeCharacter, snap?.quiet]);

  const ariaLabel = label
    ?? (snap
      ? `今日心情：${snap.label}。${snap.line}${snap.weather ? ` ${snap.weather.label} ${Math.round(snap.weather.feelsC)} 度。` : ''}`
      : '今日心情：正在看天光');

  return (
    <span
      className={cn('mood-orb', snap?.quiet && 'is-quiet', className)}
      style={{ width: size, height: size, fontSize: size }}
      role={staticPreview ? undefined : 'button'}
      tabIndex={staticPreview ? -1 : 0}
      aria-hidden={staticPreview || undefined}
      aria-label={staticPreview ? undefined : ariaLabel}
      onPointerEnter={staticPreview || activeCharacter !== 'yoona' ? undefined : (event) => {
        if (event.pointerType !== 'touch') post({ type: 'hover', value: true });
      }}
      onPointerLeave={staticPreview || activeCharacter !== 'yoona' ? undefined : () => post({ type: 'hover', value: false })}
      onClick={staticPreview ? undefined : () => {
        // 打开外部交互面板时，表情切换本身就是反馈，避免再叠加一套 poke 动画。
        if (!onClick) post({ type: 'poke' });
        registerClick();
        onClick?.();
      }}
      onKeyDown={staticPreview ? undefined : (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!onClick) post({ type: 'poke' });
          registerClick();
          onClick?.();
        }
      }}
    >
      <iframe
        ref={frameRef}
        name={frameNameRef.current}
        src={staticPreview
          ? `/emotion-ball-embed.html?character=${activeCharacter}&static=1&v=wink-still-v2`
          : '/emotion-ball-embed.html?v=wink-still-v2'}
        title=""
        aria-hidden="true"
        tabIndex={-1}
        allowTransparency
        className="emotion-ball-frame"
        style={{ backgroundColor: 'transparent' }}
        onLoad={() => {
          lastPostedRef.current = effective;
          post({ type: 'emotion', id: effective });
          post({ type: 'quiet', value: Boolean(snap?.quiet) });
          post({ type: 'character', value: activeCharacter });
          if (pointerRef.current && gazeFrameRef.current === null) {
            gazeFrameRef.current = requestAnimationFrame(sendPointerGaze);
          }
        }}
      />
    </span>
  );
}
