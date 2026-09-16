import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudSun, RefreshCw, Save, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import { cn } from '@/lib/utils';
import { moodEnabledPref, moodIdlePref } from '@/store/mood';
import { assistantName, CHARACTER_NAMES } from '@/lib/assistant-name';
import { MoodOrb } from '@/components/MoodOrb';
import { Card, CardBody, CardHeader, CardTitle } from '@/ui/card';
import { Button } from '@/ui/button';
import { Field, Input } from '@/ui/form';
import type { MoodCharacter, MoodTone } from '@/types';

const TONES: Array<{ key: MoodTone; label: string; desc: string }> = [
  { key: '温和', label: '温和', desc: '轻松友好，不打扰' },
  { key: '中性', label: '自然', desc: '观察天气与日常细节' },
  { key: '冷淡', label: '简洁', desc: '少一点字，多一点留白' },
  { key: '毒舌', label: '俏皮', desc: '调侃天气，不调侃用户' },
];

const CHARACTERS: Array<{ key: MoodCharacter; label: string; en: string }> = [
  { key: 'ball', label: CHARACTER_NAMES.ball, en: 'Ball' },
  { key: 'nimbo', label: CHARACTER_NAMES.nimbo, en: 'Nimbo' },
  { key: 'twinkle', label: CHARACTER_NAMES.twinkle, en: 'Twinkle' },
];

/** 助手：位置（看天光要用）、语气、是否让模型润色、是否耳语 */
export function MoodSettingsCard() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const { data: snap } = useQuery({ queryKey: [...qk.mood, 'preview'], queryFn: () => api.mood(), staleTime: 60_000 });
  const [city, setCity] = useState('');
  const [nameDraft, setNameDraft] = useState('');

  const mood = settings?.mood ?? { enabled: true, tone: '温和' as MoodTone, ai: true, whisper: true, character: 'ball' as MoodCharacter, name: '' };
  const saved = settings?.general?.location;
  const currentName = assistantName(mood);

  useEffect(() => setNameDraft(mood.name ?? ''), [mood.name]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.settings });
    qc.invalidateQueries({ queryKey: [...qk.mood] });
  };

  const save = useMutation({
    mutationFn: async (b: Record<string, unknown>) => {
      const next = await api.saveSettings(b);
      const requestedCharacter = (b.mood as { character?: MoodCharacter } | undefined)?.character;
      if (requestedCharacter && next.mood?.character !== requestedCharacter) {
        throw new Error('角色未保存成功，请重启后端服务后再试');
      }
      return next;
    },
    onSuccess: (next) => {
      qc.setQueryData(qk.settings, next);
      toast.success('已保存');
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const locate = useMutation({
    mutationFn: () => api.moodCity(city.trim()),
    onSuccess: (r) => {
      setCity('');
      const w = r.weather;
      toast.success(`位置已设为${r.location?.name ?? ''}`, {
        description: w ? `${w.label} ${Math.round(w.tempC)}°（体感 ${Math.round(w.feelsC)}°）` : '位置存下了，但天气没取到——不配天气它也照常工作',
      });
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const refreshWeather = useMutation({
    mutationFn: api.moodWeatherRefresh,
    onSuccess: (r) => {
      toast.success(r.weather ? `天气已更新：${r.weather.label} ${Math.round(r.weather.tempC)}°` : '没取到天气');
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle><Sparkles className="size-4 text-accent" /> 助手</CardTitle>
        <span className="text-[11px] text-ink-4">今日页顶部那个会呼吸的小东西</span>
      </CardHeader>
      <CardBody className="space-y-4 p-5">
        <div className="flex items-center gap-4 rounded-xl border border-line bg-surface-2/60 px-4 py-3">
          <MoodOrb snap={snap ?? null} size={44} character={mood.character ?? 'ball'} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-ink">{snap?.line ?? '在读今天的脸色…'}</p>
            <p className="mt-0.5 text-[11px] text-ink-3">
              {snap
                ? `${snap.label} · 天光 ${Math.round(snap.solar.daylight * 100)}%${snap.weather ? ` · ${snap.weather.label}` : ' · 未接天气'}`
                : '它看天光、看日程、看你手上的事，然后决定自己什么脸色'}
            </p>
          </div>
          <button
            onClick={() => {
              const next = !mood.enabled;
              moodEnabledPref.set(next);
              save.mutate({ mood: { enabled: next } });
            }}
            className={cn(
              'shrink-0 rounded-lg border px-3 py-1.5 text-xs transition-colors',
              mood.enabled ? 'border-accent/40 bg-accent-dim text-ink' : 'border-line text-ink-3 hover:border-line-strong',
            )}
          >
            {mood.enabled ? '已显示' : '已隐藏'}
          </button>
        </div>

        <Field label="城市" hint="只把城市名发给 Open-Meteo（免密钥）取天光与天气；不填就完全不联网，它改用钟点曲线估天光">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder={saved ? `当前：${saved.name}${saved.admin ? ` · ${saved.admin}` : ''}` : '如 杭州'}
              className="h-9 max-w-52 border-dashed bg-transparent text-sm"
              onKeyDown={(e) => { if (e.key === 'Enter' && city.trim()) locate.mutate(); }}
            />
            <Button size="sm" variant="secondary" disabled={!city.trim() || locate.isPending} onClick={() => locate.mutate()}>
              {locate.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <CloudSun className="size-3.5" />}
              定位
            </Button>
            {saved && (
              <Button size="sm" variant="ghost" disabled={refreshWeather.isPending} onClick={() => refreshWeather.mutate()}>
                <RefreshCw className={cn('size-3.5', refreshWeather.isPending && 'animate-spin')} /> 重取天气
              </Button>
            )}
            {saved && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => save.mutate({ general: { location: {} } })}
                title="清除位置后，助手只用本地信号"
              >
                清除
              </Button>
            )}
          </div>
        </Field>

        <Field label="角色">
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-surface-2 p-1">
            {CHARACTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={mood.character === item.key}
                onClick={() => save.mutate({ mood: { character: item.key } })}
                className={cn(
                  'flex min-h-16 items-center justify-center gap-2 rounded-md px-2 transition-colors',
                  mood.character === item.key
                    ? 'bg-surface-1 text-ink shadow-sm ring-1 ring-line-strong'
                    : 'text-ink-3 hover:bg-surface-3 hover:text-ink-2',
                )}
              >
                <MoodOrb snap={snap ?? null} size={34} character={item.key} staticPreview />
                <span className="min-w-0 text-left">
                  <span className="block text-xs leading-tight">{item.label}</span>
                  <span className="mt-0.5 block text-[9px] leading-tight text-ink-4">{item.en}</span>
                </span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="称呼" hint={`留空时跟随角色，当前默认称呼为“${CHARACTER_NAMES[mood.character]}”`}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value.slice(0, 20))}
              placeholder={CHARACTER_NAMES[mood.character]}
              className="h-9 max-w-52 text-sm"
              aria-label="助手称呼"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && nameDraft.trim() !== (mood.name ?? '')) {
                  save.mutate({ mood: { name: nameDraft.trim() } });
                }
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={save.isPending || nameDraft.trim() === (mood.name ?? '')}
              onClick={() => save.mutate({ mood: { name: nameDraft.trim() } })}
            >
              <Save className="size-3.5" /> 保存称呼
            </Button>
            {mood.name && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNameDraft('');
                  save.mutate({ mood: { name: '' } });
                }}
              >
                恢复“{CHARACTER_NAMES[mood.character]}”
              </Button>
            )}
            <span className="text-[11px] text-ink-4">对话中会称为“{currentName}”</span>
          </div>
        </Field>

        <Field label="语气">
          <div className="flex flex-wrap gap-1.5">
            {TONES.map((t) => (
              <button
                key={t.key}
                onClick={() => save.mutate({ mood: { tone: t.key } })}
                title={t.desc}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-left text-xs transition-all',
                  mood.tone === t.key
                    ? 'border-accent/45 bg-accent-dim text-ink'
                    : 'border-line text-ink-3 hover:border-line-strong',
                )}
              >
                {t.label}
                <span className="ml-1.5 text-[10px] text-ink-4">{t.desc.slice(0, 6)}</span>
              </button>
            ))}
          </div>
        </Field>

        <div className="flex flex-wrap gap-2">
          {([
            { key: 'ai', label: '让模型润色文案', hint: '先用规则句上屏，模型写好再换；没配模型或超时就不换' },
            { key: 'whisper', label: '允许耳语', hint: '勾完成、记一笔时回一句短的，一天最多六句' },
          ] as const).map((t) => (
            <label
              key={t.key}
              title={t.hint}
              className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs text-ink-2 transition-colors hover:border-line-strong"
            >
              <input
                type="checkbox"
                defaultChecked={mood[t.key]}
                className="size-3.5 accent-[var(--color-accent)]"
                onChange={(e) => save.mutate({ mood: { [t.key]: e.target.checked } })}
              />
              {t.label}
            </label>
          ))}
          {/* idle 自言自语存本地（不进 mood 配置）：默认关，避免长时间挂着时叨叨 */}
          <label
            title="长时间没动时偶尔小声说一句；默认关"
            className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs text-ink-2 transition-colors hover:border-line-strong"
          >
            <input
              type="checkbox"
              defaultChecked={moodIdlePref.get()}
              className="size-3.5 accent-[var(--color-accent)]"
              onChange={(e) => moodIdlePref.set(e.target.checked)}
            />
            无操作时自言自语
          </label>
        </div>

        {mood.ai && !settings?.model.hasApiKey && (
          <p className="flex items-center gap-1.5 text-[11px] text-warn">
            <Save className="size-3" /> 还没配模型 API：AI 润色会静默跳过，只用规则文案（这也够好看）
          </p>
        )}
      </CardBody>
    </Card>
  );
}
