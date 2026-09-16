import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Bell, Sparkles } from 'lucide-react';
import { api, qk } from '@/lib/api';
import { moodEnabledPref, startIdleWhisper, useMoodUi } from '@/store/mood';
import { useAssistantActions } from '@/store/assistant';
import { MoodOrb } from '@/components/MoodOrb';
import { AssistantConversation } from '@/components/AssistantConversation';
import { cn, greeting } from '@/lib/utils';
import { assistantName } from '@/lib/assistant-name';
import type { MoodSnapshot } from '@/types';

/** 今日页头部：把「晚上好，开始今天」换成一个会看天光、会回应动作、偶尔自己开口的情绪球。 */
export function MoodHeader() {
  const { data, refetch } = useQuery({
    queryKey: qk.mood,
    queryFn: () => api.mood(true),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
  // 模型未配置时给出明确引导，不让用户对着一个不会回答的输入区。
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 60_000 });
  const modelConfigured = Boolean(settings?.model.hasApiKey && settings.model.model);
  const snap = data ?? null;
  const petName = assistantName(snap?.config);
  const isYoona = snap?.config.character === 'yoona';
  const [enabled, setEnabled] = useState(moodEnabledPref.get);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const setSnapshot = useMoodUi((s) => s.setSnapshot);
  const whisper = useMoodUi((s) => s.whisper);

  // 首页不渲染 AssistantDock，派单结果的未读提示得由头部自己扛
  const unreadIds = useAssistantActions((s) => s.unreadIds);
  const refreshUnread = useAssistantActions((s) => s.refreshUnread);
  const markRead = useAssistantActions((s) => s.markRead);
  useEffect(() => {
    void refreshUnread();
    const timer = window.setInterval(() => void refreshUnread(), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshUnread]);

  // AI 润色：首帧先用模板句，回来再补间——头部永远不等模型
  const [aiLine, setAiLine] = useState<string | null>(null);
  const asked = useRef('');
  const lineMut = useMutation({ mutationFn: () => api.moodLine(false) });

  // 散会那一刻：球自己弹一下回常态，不说话
  const wasQuiet = useRef(false);
  useEffect(() => {
    if (!snap) return;
    if (wasQuiet.current && !snap.quiet) useMoodUi.getState().pulseOnly();
    wasQuiet.current = snap.quiet;
    if (snap.config.enabled !== enabled) {
      moodEnabledPref.set(snap.config.enabled);
      setEnabled(snap.config.enabled);
    }
    setSnapshot(snap);
    setAiLine(snap.aiLine);
    const key = `${snap.dayKey}|${snap.kind}|${snap.tone}`;
    if (snap.ai && !snap.aiLine && asked.current !== key) {
      asked.current = key;
      lineMut.mutate(undefined, { onSuccess: (r) => setAiLine(r.line) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap]);

  // 清单/日程一变，心情就跟着变（不用等 staleTime）
  useEffect(() => {
    const onFocus = () => void refetch();
    addEventListener('focus', onFocus);
    return () => removeEventListener('focus', onFocus);
  }, [refetch]);

  useEffect(() => {
    const stop = startIdleWhisper(() => useMoodUi.getState().snapshot);
    return stop;
  }, []);

  const shown = useMemo(() => {
    if (!snap) return { text: '正在读取今天的安排…', rare: false };
    if (snap.quiet) return { text: '', rare: false };           // 正在开会：安静陪着
    return { text: aiLine ?? snap.line, rare: Boolean(snap.rare) };
  }, [snap, aiLine]);

  const sub = useMemo(() => subline(snap), [snap]);

  if (!enabled) return <PlainHeader />;

  return (
    <motion.header
      className={cn("relative overflow-visible rounded-3xl border border-line bg-surface-1/60 px-4 py-4 shadow-[0_22px_70px_-58px_var(--color-accent)] backdrop-blur-xl sm:min-h-[168px] sm:px-7 sm:py-6", isYoona && "mt-2 sm:mt-12")}
    >
      <div className="flex items-start gap-4 sm:items-center sm:gap-6">
        <div className={cn("shrink-0 overflow-visible", isYoona ? "static h-[72px] w-[108px] sm:h-[118px] sm:w-[208px]" : "relative z-30 h-[72px] w-[78px] sm:h-[118px] sm:w-[128px]")}>
          <MoodOrb
            snap={snap}
            size={isYoona ? 240 : 68}
            className={cn("absolute origin-top-left", isYoona ? "left-4 -bottom-[123px] z-30 scale-50 sm:left-7 sm:-bottom-[6px] sm:scale-100" : "left-0 top-0 sm:scale-[1.65]")}
            label={assistantOpen ? `逗逗${petName}` : `打开${petName}对话`}
            onClick={() => setAssistantOpen((open) => !open)}
          />
          <AnimatePresence>
            {whisper && snap?.config.whisper && (
              <motion.span
                initial={{ opacity: 0, x: -6, y: 6, scale: 0.92 }}
                animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -5, scale: 0.96 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
                className="pointer-events-none absolute left-[76px] top-[2px] z-50"
              >
                {/* 气泡悬在助手右上：半透明毛玻璃 + 底部小尾巴指向它 */}
                <span className="relative block whitespace-nowrap rounded-2xl rounded-bl-md border border-line/70 bg-surface/75 px-2.5 py-1 text-[11px] leading-none text-ink-2/90 shadow-sm backdrop-blur-md">
                  {whisper}
                  <span
                    aria-hidden
                    className="absolute -left-[3px] -bottom-[3.5px] size-2 rotate-45 border-b border-l border-line/70 bg-surface/75"
                  />
                </span>
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <div className="min-w-0 flex-1">
          <AnimatePresence mode="wait" initial={false}>
            {assistantOpen ? (
              <motion.div
                key="assistant"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
              >
                {!modelConfigured && (
                  <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-dim px-3 py-2 text-xs text-ink-2">
                    <Sparkles className="size-3.5 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1">与{petName}对话需要先配置模型</span>
                    <Link to="/settings#settings-orb" className="shrink-0 font-medium text-accent underline underline-offset-2">
                      去配置
                    </Link>
                  </div>
                )}
                <AssistantConversation
                  compact
                  autoFocus
                  context={{
                    kind: 'global',
                    title: '今天',
                    content: [shown.text, ...sub].filter(Boolean).join('\n'),
                  }}
                  onClose={() => setAssistantOpen(false)}
                />
              </motion.div>
            ) : (
              <motion.button
                key="mood"
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setAssistantOpen(true)}
                className="group block w-full rounded-xl px-1 py-1 text-left outline-none transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent/45"
              >
                <span
                  className={cn(
                    'block text-[17px] font-medium leading-snug tracking-[.2px] transition-opacity duration-500 sm:text-[23px] sm:font-semibold',
                    shown.text ? 'text-ink' : 'text-ink-4',
                    !snap && 'opacity-60',
                  )}
                >
                  {shown.text || <span className="text-ink-3">会议进行中</span>}
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3 sm:mt-3">
                  {sub.map((s, i) => (
                    <span key={s + i} className="rounded-full border border-line bg-surface-2/75 px-2.5 py-1">
                      {s}
                    </span>
                  ))}
                </span>
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* 未读提示不跟着 md 断点隐藏——派单结果到了，手机上一样该看见 */}
        {!assistantOpen && <div className="flex shrink-0 items-center gap-3 pt-1">
          {unreadIds.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setAssistantOpen(true);
                void markRead();
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-accent/45 bg-surface-1/90 px-2.5 py-1 text-[11px] text-ink-2 transition-colors hover:border-accent/70 hover:text-ink"
            >
              <span className="relative flex items-center">
                <Bell className="size-3 text-accent" />
                <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-danger" />
              </span>
              {petName}带回 {unreadIds.length} 个结果
            </button>
          )}
          <Link to="/review" className="hidden items-center gap-1 text-xs text-ink-3 transition-colors hover:text-accent md:flex">
            本周回顾 <ArrowRight className="size-3" />
          </Link>
        </div>}
      </div>

    </motion.header>
  );
}

/** 关掉情绪球时的退路：还是那行朴素的问候 */
function PlainHeader() {
  const g = greeting();
  return (
    <header className="flex items-end justify-between px-1">
      <div>
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight">
          {g.text}，开始今天 <span className="neon-text">✦</span>
        </h1>
        <p className="mt-1 text-sm text-ink-3">{g.sub} · 把最重要的事排进来</p>
      </div>
      <Link to="/review" className="hidden items-center gap-1 text-xs text-ink-3 transition-colors hover:text-accent md:flex">
        本周回顾 <ArrowRight className="size-3" />
      </Link>
    </header>
  );
}

function subline(snap: MoodSnapshot | null): string[] {
  const d = new Date();
  const week = '日一二三四五六'[d.getDay()];
  const out = [`${d.getMonth() + 1}月${d.getDate()}日 周${week}`];
  if (!snap) return out;
  if (snap.solar.termToday) out.push(snap.solar.termToday);
  else if (snap.solar.termNext) out.push(`${snap.solar.termNext.name}还有 ${snap.solar.termNext.days} 天`);
  if (snap.weather) out.push(`${snap.weather.label} ${Math.round(snap.weather.feelsC)}°`);
  return out;
}
