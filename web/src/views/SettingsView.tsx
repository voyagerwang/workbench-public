/**
 * [INPUT]: 设置查询结果与保存/测试模型、日历、通知、外部连接的 API 操作
 * [OUTPUT]: 工作台设置页，维护模型协议、复杂/日常推理档位及各外部能力配置
 * [POS]: 设置模块的统一配置入口；模型策略被助手运行时读取，其他卡片消费同一设置缓存
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellRing, Bot, CalendarSync, CalendarClock, Check, ChevronRight, Cloud,
  Download, Image as ImageIcon, KeyRound, Link2, LockKeyhole, Moon, Palette,
  Save, ShieldCheck, Sparkles, Sun, SunMedium, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import { cn, todayStr } from '@/lib/utils';
import { useAssistantName } from '@/lib/assistant-name';
import { useUi } from '@/store/ui';
import { useTheme, type ThemeMode } from '@/store/theme';
import { Card, CardBody, CardHeader, CardTitle } from '@/ui/card';
import { Button } from '@/ui/button';
import { Field, Input, Select } from '@/ui/form';
import { ClawbotCard } from '@/components/ClawbotCard';
import { MoodSettingsCard } from '@/components/MoodSettingsCard';
import { NotifyChannelsCard } from '@/components/NotifyChannelsCard';
import { NotifyStatusChip } from '@/components/NotifyStatusChip';
import { DocumentAccessCard } from '@/components/DocumentAccessCard';
import { SyncSettingsCard } from '@/components/SyncSettingsCard';
import { CHANNEL_OPTIONS } from '@/views/RemindersView';

const ACCENTS = [
  { key: 'violet', color: '#8b80f9', label: '霓虹紫' },
  { key: 'blue', color: '#4da3ff', label: '电光蓝' },
  { key: 'emerald', color: '#34d399', label: '翡翠绿' },
  { key: 'amber', color: '#ffb454', label: '琥珀橙' },
];

const SECTIONS = [
  { id: 'settings-overview', label: '配置概览' },
  { id: 'settings-general', label: '个性化' },
  { id: 'settings-sync', label: '数据与同步' },
  { id: 'settings-orb', label: 'AI 模型' },
  { id: 'settings-notify', label: '通知与日历' },
  { id: 'settings-bots', label: '连接与权限' },
];

/** 快捷键串（'mod+k'）→ 展示用键帽 */
function shortcutKeys(shortcut: string): string[] {
  return shortcut.split('+').map((p) => ({ mod: '⌘', alt: '⌥', shift: '⇧' }[p] ?? p.toUpperCase()));
}

export function SettingsView() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const petName = useAssistantName();
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const { data: eventStatus } = useQuery({ queryKey: qk.eventStatus, queryFn: api.eventStatus });
  const { data: trash } = useQuery({ queryKey: qk.trash, queryFn: api.trash });
  const { data: syncStatus } = useQuery({ queryKey: qk.sync, queryFn: api.syncStatus });

  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [userId, setUserId] = useState('');
  const [icsUrl, setIcsUrl] = useState('');
  const [caldavUser, setCaldavUser] = useState('');
  const [caldavServer, setCaldavServer] = useState('https://calendar.dingtalk.com');
  const [caldavPass, setCaldavPass] = useState('');
  const [modelProvider, setModelProvider] = useState('OpenAI 兼容');
  const [modelBaseUrl, setModelBaseUrl] = useState('https://api.openai.com/v1');
  const [modelName, setModelName] = useState('');
  const [modelApiKey, setModelApiKey] = useState('');
  const [modelWireApi, setModelWireApi] = useState<'responses' | 'chat_completions'>('responses');
  const [modelReasoningEffort, setModelReasoningEffort] = useState('xhigh');
  const [assistantReasoningEffort, setAssistantReasoningEffort] = useState('low');
  const [disableResponseStorage, setDisableResponseStorage] = useState(true);
  const [imgProvider, setImgProvider] = useState('OpenAI 兼容');
  const [imgBaseUrl, setImgBaseUrl] = useState('https://api.openai.com/v1');
  const [imgModelName, setImgModelName] = useState('');
  const [imgApiKey, setImgApiKey] = useState('');
  const [imgSize, setImgSize] = useState('1:1');
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id);
  // 品牌
  const [appName, setAppName] = useState('');
  const avatarRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (settings) {
      setAppKey(settings.dingtalk.appKey);
      setUserId(settings.dingtalk.userId);
      setModelProvider(settings.model.provider);
      setModelBaseUrl(settings.model.baseUrl);
      setModelName(settings.model.model);
      setModelWireApi(settings.model.wireApi);
      setModelReasoningEffort(settings.model.reasoningEffort);
      setAssistantReasoningEffort(settings.model.assistantReasoningEffort);
      setDisableResponseStorage(settings.model.disableResponseStorage);
      if (settings.imageModel) {
        setImgProvider(settings.imageModel.provider);
        setImgBaseUrl(settings.imageModel.baseUrl);
        setImgModelName(settings.imageModel.model);
        setImgSize(settings.imageModel.aspect || '1:1');
      }
      setAppName(settings.general?.appName ?? '');
    }
  }, [settings]);
  useEffect(() => {
    if (eventStatus) {
      setIcsUrl(eventStatus.ics.url);
      if (eventStatus.caldav.configured) {
        setCaldavUser(eventStatus.caldav.username);
        setCaldavServer(eventStatus.caldav.server);
      }
    }
  }, [eventStatus?.ics.url, eventStatus?.caldav.username]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMut = useMutation({
    mutationFn: (b: Parameters<typeof api.saveSettings>[0]) => api.saveSettings(b),
    onSuccess: () => {
      toast.success('已保存');
      setAppSecret('');
      qc.invalidateQueries({ queryKey: qk.settings });
      qc.invalidateQueries({ queryKey: qk.eventStatus });
    },
    onError: (e) => toast.error(e.message),
  });

  const syncMut = useMutation({
    mutationFn: api.syncEvents,
    onSuccess: (r) => {
      if (r.ok) toast.success(`同步完成：${r.detail ?? `${r.count} 条日程`}`);
      else toast.error(r.error ?? '同步失败');
      qc.invalidateQueries({ queryKey: qk.eventStatus });
    },
  });

  const modelConfigured = Boolean(settings?.model.hasApiKey && settings.model.model);
  const imageModelConfigured = Boolean(settings?.imageModel?.hasApiKey && settings.imageModel.model);

  const saveModelMut = useMutation({
    mutationFn: () => api.saveSettings({
      model: {
        provider: modelProvider.trim(),
        baseUrl: modelBaseUrl.trim(),
        model: modelName.trim(),
        apiKey: modelApiKey.trim(), // 留空 = 不修改已保存的
        wireApi: modelWireApi,
        reasoningEffort: modelReasoningEffort,
        assistantReasoningEffort,
        disableResponseStorage,
      },
    }),
    onSuccess: () => {
      toast.success('已保存');
      setModelApiKey('');
      qc.invalidateQueries({ queryKey: qk.settings });
    },
    onError: (e) => toast.error(e.message),
  });

  const testModelMut = useMutation({
    mutationFn: () => api.testModel({
      provider: modelProvider.trim(),
      baseUrl: modelBaseUrl.trim(),
      model: modelName.trim(),
      apiKey: modelApiKey.trim() || undefined,
      wireApi: modelWireApi,
      reasoningEffort: modelReasoningEffort,
      disableResponseStorage,
    }),
    onSuccess: (r) => toast.success(`连接成功 · ${r.latencyMs} ms`, { description: `${r.model} · ${r.wireApi}` }),
    onError: (e) => toast.error('连接失败', { description: e.message }),
  });

  const saveImageModelMut = useMutation({
    mutationFn: () => api.saveSettings({
      imageModel: {
        provider: imgProvider.trim(),
        baseUrl: imgBaseUrl.trim(),
        model: imgModelName.trim(),
        apiKey: imgApiKey.trim(), // 留空 = 不修改已保存的
        aspect: imgSize,      },
    }),
    onSuccess: () => {
      toast.success('已保存');
      setImgApiKey('');
      qc.invalidateQueries({ queryKey: qk.settings });
    },
    onError: (e) => toast.error(e.message),
  });

  const testImageModelMut = useMutation({
    mutationFn: () => api.testImageModel({
      baseUrl: imgBaseUrl.trim(),
      model: imgModelName.trim(),
      apiKey: imgApiKey.trim() || undefined,
    }),
    onSuccess: (r) => toast.success(`连接成功 · ${r.latencyMs} ms`, { description: `${r.model} · 真实生成了一张测试图` }),
    onError: (e) => toast.error('连接失败', { description: e.message }),
  });

  const saveIcs = () => {
    saveMut.mutate({ ics: { url: icsUrl.trim() } });
  };

  const caldavMut = useMutation({
    mutationFn: api.saveCaldav,
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(`CalDAV 已连接，同步到 ${r.count ?? 0} 条日程`);
        setCaldavPass('');
      } else toast.error(r.error ?? '连接失败');
      qc.invalidateQueries({ queryKey: qk.eventStatus });
      qc.invalidateQueries({ queryKey: qk.events(todayStr()) });
    },
    onError: (e) => toast.error(e.message),
  });

  const importIcsMut = useMutation({
    mutationFn: api.importIcs,
    onSuccess: (r) => {
      if (r.ok) toast.success(`导入成功：${r.count} 条日程`);
      else toast.error(r.error ?? '导入失败');
    },
  });

  const saveDingtalk = () =>
    saveMut.mutate({
      dingtalk: {
        appKey: appKey.trim(),
        appSecret: appSecret.trim(), // 留空 = 不修改已保存的
        userId: userId.trim(),
      },
    });

  const accent = settings?.general?.accent ?? 'violet';
  const pickAccent = (key: string) => {
    document.documentElement.dataset.accent = key;
    saveMut.mutate({ general: { accent: key } });
  };

  const saveBrand = () => {
    saveMut.mutate({ general: { appName: appName.trim() || 'YZ工作台' } });
  };

  const uploadAvatar = (file: File) => {
    api.uploadFile(file)
      .then(({ url }) => saveMut.mutate({ general: { appAvatar: url } }))
      .catch((e: Error) => toast.error(e.message));
  };

  // 快捷键：settings 加载后同步到 ui store；保存时双写
  const shortcut = settings?.general?.shortcut ?? 'mod+k';
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setListening(false); return; }
      const k = e.key.toLowerCase();
      if (['control', 'meta', 'alt', 'shift'].includes(k)) return; // 只按了修饰键
      if (!/^[a-z0-9]$/.test(k)) return;
      const parts: string[] = [];
      if (e.metaKey || e.ctrlKey) parts.push('mod');
      if (e.altKey) parts.push('alt');
      if (e.shiftKey) parts.push('shift');
      parts.push(k);
      setListening(false);
      useUi.getState().setPaletteShortcut(parts.join('+'));
      saveMut.mutate({ general: { shortcut: parts.join('+') } });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  const scrollTo = (id: string) => {
    setActiveSection(id);
    window.history.replaceState(null, '', `${window.location.pathname}#${id}`);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 深链锚点：/settings#settings-orb 这类链接进来直接滚到对应分区
  useEffect(() => {
    const h = window.location.hash.slice(1);
    if (h) {
      const section = SECTIONS.find((s) => s.id === h)?.id
        ?? (h === 'settings-calendar' ? 'settings-notify' : h === 'document-access' ? 'settings-bots' : null);
      if (section) setActiveSection(section);
      requestAnimationFrame(() => document.getElementById(h)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible?.target.id) setActiveSection(visible.target.id);
    }, { rootMargin: '-18% 0px -68% 0px', threshold: 0 });
    for (const section of SECTIONS) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  const calendarConfigured = Boolean(
    eventStatus?.dingtalk.configured || eventStatus?.ics.configured || eventStatus?.caldav.configured,
  );
  const syncReady = Boolean(syncStatus?.configured && syncStatus.initialized);

  return (
    <div className="mx-auto max-w-5xl px-1">
      <header className="px-1 pb-5">
        <h1 className="text-xl font-semibold tracking-tight">设置</h1>
        <p className="mt-0.5 text-sm text-ink-3">核心数据默认保存在本机，需要时再开启云同步与外部连接</p>
      </header>

      <nav className="sticky top-[57px] z-20 -mx-3 mb-5 overflow-x-auto border-y border-line bg-chrome/95 px-3 py-2 backdrop-blur-md md:hidden">
        <div className="flex min-w-max gap-1">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => scrollTo(section.id)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs transition-colors',
                activeSection === section.id ? 'bg-surface-2 font-medium text-ink' : 'text-ink-3',
              )}
            >
              {section.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[9rem_1fr]">
        {/* 分类锚点导航 */}
        <nav className="top-24 hidden self-start md:sticky md:block">
          <ul className="space-y-1">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => scrollTo(s.id)}
                  className={cn(
                    'w-full rounded-lg px-3 py-1.5 text-left text-sm transition-colors',
                    activeSection === s.id
                      ? 'bg-surface-2 font-medium text-ink'
                      : 'text-ink-3 hover:bg-surface-1 hover:text-ink',
                  )}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-8">
          <section id="settings-overview" className="scroll-mt-28 space-y-5 md:scroll-mt-20">
            <SectionHeading
              title="配置概览"
              desc="先完成唯一必备项；其他能力在真正需要时再打开"
            />
            <SetupOverview
              modelConfigured={modelConfigured}
              syncReady={syncReady}
              calendarConfigured={calendarConfigured}
              onJump={scrollTo}
            />
          </section>

          {/* ============ 个性化 ============ */}
          <section id="settings-general" className="scroll-mt-28 space-y-5 md:scroll-mt-20">
            <SectionHeading title="个性化" desc="名称、外观和助手只影响使用体验，不影响核心数据" />
            <Card>
              <CardHeader><CardTitle><Palette className="size-4 text-accent" /> 品牌</CardTitle></CardHeader>
              <CardBody className="space-y-4 p-5">
                <p className="text-xs leading-relaxed text-ink-3">
                  工作台是每个人自己的：名称和头像会显示在侧栏、移动端顶栏和浏览器标题。macOS 菜单栏 App 名需重新打包才能改。
                </p>
                <div className="flex items-end gap-4">
                  <div className="shrink-0 text-center">
                    {settings?.general?.appAvatar ? (
                      <img src={settings.general.appAvatar} alt="头像" className="size-14 rounded-xl border border-line object-cover" />
                    ) : (
                      <div className="flex size-14 items-center justify-center rounded-xl border border-accent/25 bg-accent-dim text-xl font-semibold neon-text">
                        {(appName || 'YZ工作台').slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <input
                      ref={avatarRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) uploadAvatar(file);
                        e.target.value = '';
                      }}
                    />
                    <button
                      onClick={() => avatarRef.current?.click()}
                      className="mt-1 inline-flex items-center gap-1 text-[10px] text-ink-4 transition-colors hover:text-accent"
                    >
                      <ImageIcon className="size-3" /> {settings?.general?.appAvatar ? '更换' : '上传头像'}
                    </button>
                    {settings?.general?.appAvatar && (
                      <button
                        onClick={() => saveMut.mutate({ general: { appAvatar: '' } })}
                        className="ml-1 text-[10px] text-ink-4 transition-colors hover:text-danger"
                      >
                        移除
                      </button>
                    )}
                  </div>
                  <Field label="工作台名称" className="flex-1" hint="默认「YZ工作台」">
                    <Input value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="YZ工作台" maxLength={40} />
                  </Field>
                  <Button variant="secondary" size="sm" onClick={saveBrand} disabled={saveMut.isPending}>
                    <Save /> 保存
                  </Button>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader><CardTitle><Palette className="size-4 text-accent" /> 外观</CardTitle></CardHeader>
              <CardBody className="space-y-4 p-5">
                <Field label="主题" hint="跟随时间：7:00–19:00 日间，其余夜间；右侧栏也可随时切换">
                  <div className="flex gap-1.5">
                    {([
                      { key: 'auto', label: '跟随时间', icon: <SunMedium className="size-3.5" /> },
                      { key: 'light', label: '日间', icon: <Sun className="size-3.5" /> },
                      { key: 'dark', label: '夜间', icon: <Moon className="size-3.5" /> },
                    ] as Array<{ key: ThemeMode; label: string; icon: React.ReactNode }>).map((t) => (
                      <button
                        key={t.key}
                        onClick={() => useTheme.getState().setMode(t.key)}
                        className={cn(
                          'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-all',
                          useTheme((s) => s.mode) === t.key
                            ? 'border-accent/50 bg-accent-dim text-ink'
                            : 'border-line text-ink-3 hover:border-line-strong',
                        )}
                      >
                        {t.icon}{t.label}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="强调色">
                  <div className="flex gap-2">
                    {ACCENTS.map((a) => (
                      <button
                        key={a.key}
                        onClick={() => pickAccent(a.key)}
                        title={a.label}
                        className={cn(
                          'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-all',
                          accent === a.key ? 'border-line-strong bg-surface-2 text-ink' : 'border-line text-ink-3 hover:border-line-strong',
                        )}
                      >
                        <span
                          className="size-3.5 rounded-full"
                          style={{ background: a.color, boxShadow: `0 0 10px ${a.color}` }}
                        />
                        {a.label}
                      </button>
                    ))}
                  </div>
                </Field>
              </CardBody>
            </Card>

            <Card>
              <CardHeader><CardTitle>快捷键</CardTitle></CardHeader>
              <CardBody className="space-y-3 p-5">
                <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
                  <span className="text-sm text-ink-2">全局搜索</span>
                  {listening ? (
                    <span className="animate-pulse text-xs text-accent">按下新的组合键（Esc 取消）…</span>
                  ) : (
                    <button
                      onClick={() => setListening(true)}
                      className="flex items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-surface-1"
                      title="点击修改快捷键"
                    >
                      <span className="flex gap-1">
                        {shortcutKeys(shortcut).map((k) => <kbd key={k} className="kbd">{k}</kbd>)}
                      </span>
                      <span className="text-[10px] text-ink-4">修改</span>
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-ink-4">⌘ = macOS Command / Windows Ctrl；支持组合 ⌥ ⌥⇧ 等修饰键 + 字母或数字</p>
              </CardBody>
            </Card>

            <MoodSettingsCard />
          </section>

          <section id="settings-sync" className="scroll-mt-28 space-y-5 md:scroll-mt-20">
            <SectionHeading title="数据与同步" desc="本机是数据底座；需要多设备时再开启云同步" />
            <SyncSettingsCard />
            <Card>
              <CardHeader><CardTitle><Download className="size-4 text-accent" /> 数据导出</CardTitle></CardHeader>
              <CardBody className="space-y-3 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <a href="/api/export" download="workbench-backup.json">
                    <Button variant="secondary" size="sm"><Download /> 导出数据包 (JSON)</Button>
                  </a>
                </div>
                <p className="text-xs leading-relaxed text-ink-4">
                  包含项目、清单、笔记、提醒、知识与 MCP 连接配置；OAuth 和密钥不会导出。本期暂不提供导入恢复。
                </p>
              </CardBody>
            </Card>
            <div id="settings-trash" className="scroll-mt-28 md:scroll-mt-20">
              <Card>
                <CardBody className="flex items-center justify-between gap-4 p-5">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-1">
                      <Trash2 className="size-5 text-ink-3" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{trash ? `${trash.items.length} 项可找回` : '回收站'}</p>
                      <p className="text-xs text-ink-4">删除内容保留 30 天，回收站也可从侧栏进入</p>
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => navigate('/trash')}><Trash2 /> 打开</Button>
                </CardBody>
              </Card>
            </div>
          </section>

          {/* ============ AI 模型 ============ */}
          <section id="settings-orb" className="scroll-mt-28 space-y-5 md:scroll-mt-20">
            <SectionHeading title="AI 模型" desc={`唯一必备配置：自动分发、${petName}对话和 AI 内容处理都依赖它`} />
            <Card className={cn(!modelConfigured && 'border-accent/50 ring-1 ring-accent/30')}>
              <CardHeader>
                <CardTitle><Bot className="size-4 text-accent" /> 模型 API</CardTitle>
                <span className={cn(
                  'rounded-full border px-2 py-px text-[10px]',
                  modelConfigured ? 'border-ok/25 bg-ok/10 text-ok' : 'border-accent/40 bg-accent-dim text-accent',
                )}>
                  {modelConfigured ? '已配置' : '未配置 · 助手需要它'}
                </span>
              </CardHeader>
              <CardBody className="space-y-4 p-5">
                <ModelPermissionSummary />
                <p className="text-xs leading-relaxed text-ink-3">
                  可使用任意 OpenAI 兼容接口。API Key 只保存在本机数据库，页面不会读取明文。
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="服务名称" hint="仅用于识别，例如 OpenAI、DeepSeek、OpenRouter">
                    <Input value={modelProvider} onChange={(e) => setModelProvider(e.target.value)} placeholder="OpenAI 兼容" />
                  </Field>
                  <Field label="模型名称" hint="填写接口实际支持的模型 ID">
                    <Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="例如 gpt-5-mini" className="font-mono text-xs" />
                  </Field>
                </div>
                <Field label="Base URL" hint={`系统会调用 ${modelBaseUrl.replace(/\/+$/, '') || 'Base URL'}/${modelWireApi === 'responses' ? 'responses' : 'chat/completions'}`}>
                  <Input value={modelBaseUrl} onChange={(e) => setModelBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="font-mono text-xs" />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="调用协议" hint="你的中转站 wire_api = responses">
                    <Select value={modelWireApi} onChange={(e) => setModelWireApi(e.target.value as typeof modelWireApi)} className="text-xs">
                      <option value="responses">Responses API (/responses)</option>
                      <option value="chat_completions">Chat Completions (/chat/completions)</option>
                    </Select>
                  </Field>
                  <Field label="复杂任务推理强度" hint="周报、规划、分析等复杂请求；对应 model_reasoning_effort">
                    <Select value={modelReasoningEffort} onChange={(e) => setModelReasoningEffort(e.target.value)} className="text-xs">
                      <option value="">不指定</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                    </Select>
                  </Field>
                  <Field label="日常助手推理强度" hint="普通问答和简单操作；建议 low">
                    <Select value={assistantReasoningEffort} onChange={(e) => setAssistantReasoningEffort(e.target.value)} className="text-xs">
                      <option value="">不指定</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                    </Select>
                  </Field>
                </div>
                <Field label="API Key" hint={settings?.model.hasApiKey ? '已保存（留空则继续使用当前密钥）' : '密钥将保存在本机 SQLite'}>
                  <Input
                    type="password"
                    value={modelApiKey}
                    onChange={(e) => setModelApiKey(e.target.value)}
                    placeholder={settings?.model.hasApiKey ? '••••••••' : 'sk-…'}
                    autoComplete="off"
                    className="font-mono text-xs"
                  />
                </Field>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-2">
                  <input
                    type="checkbox"
                    checked={disableResponseStorage}
                    onChange={(e) => setDisableResponseStorage(e.target.checked)}
                    className="size-3.5 accent-[var(--color-accent)]"
                  />
                  禁止服务端存储响应 <span className="text-ink-4">（disable_response_storage）</span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => saveModelMut.mutate()}
                    disabled={saveModelMut.isPending || !modelBaseUrl.trim() || !modelName.trim() || (!settings?.model.hasApiKey && !modelApiKey.trim())}
                  >
                    <Save /> {saveModelMut.isPending ? '保存中…' : '保存配置'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => testModelMut.mutate()}
                    disabled={testModelMut.isPending || !modelBaseUrl.trim() || !modelName.trim() || (!settings?.model.hasApiKey && !modelApiKey.trim())}
                  >
                    <KeyRound /> {testModelMut.isPending ? '测试中…' : '测试连接'}
                  </Button>
                  <span className="text-[11px] text-ink-4">使用 Bearer API Key 鉴权</span>
                </div>
                {testModelMut.isError && (
                  <div role="alert" className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
                    <span className="font-medium">连接失败：</span>{testModelMut.error.message}
                  </div>
                )}
                {testModelMut.isSuccess && (
                  <div className="rounded-lg border border-ok/25 bg-ok/10 px-3 py-2 text-xs leading-relaxed text-ok">
                    连接成功 · {testModelMut.data.latencyMs} ms · {testModelMut.data.endpoint}
                  </div>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle><ImageIcon className="size-4 text-accent" /> 生图模型</CardTitle>
                <span className={cn(
                  'rounded-full border px-2 py-px text-[10px]',
                  imageModelConfigured ? 'border-ok/25 bg-ok/10 text-ok' : 'border-line text-ink-3',
                )}>
                  {imageModelConfigured ? '已配置' : '未配置'}
                </span>
              </CardHeader>
              <CardBody className="space-y-4 p-5">
                <p className="text-xs leading-relaxed text-ink-3">
                  走 OpenAI images 协议（/images/generations），配置后{petName}就能用它生成图片。
                  API Key 只保存在本机数据库，页面不会读取明文；不配置不影响其他能力。
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="服务名称" hint="仅用于识别">
                    <Input value={imgProvider} onChange={(e) => setImgProvider(e.target.value)} placeholder="OpenAI 兼容" />
                  </Field>
                  <Field label="模型名称" hint="生图模型 ID，例如 gpt-image-1">
                    <Input value={imgModelName} onChange={(e) => setImgModelName(e.target.value)} placeholder="例如 gpt-image-1" className="font-mono text-xs" />
                  </Field>
                </div>
                <Field label="Base URL" hint={`系统会调用 ${imgBaseUrl.replace(/\/+$/, '') || 'Base URL'}/images/generations`}>
                  <Input value={imgBaseUrl} onChange={(e) => setImgBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="font-mono text-xs" />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="默认画面比例" hint="服务端自动映射为生图模型支持的具体尺寸（首次调用会自适应校准）">
                    <Select value={imgSize} onChange={(e) => setImgSize(e.target.value)} className="text-xs">
                      <option value="1:1">1:1 方图</option>
                      <option value="3:2">3:2 横图</option>
                      <option value="2:3">2:3 竖图</option>
                      <option value="16:9">16:9 宽屏</option>
                      <option value="9:16">9:16 长图</option>
                    </Select>
                  </Field>
                  <Field label="API Key" hint={settings?.imageModel?.hasApiKey ? '已保存（留空则继续使用当前密钥）' : '密钥将保存在本机 SQLite'}>
                    <Input
                      type="password"
                      value={imgApiKey}
                      onChange={(e) => setImgApiKey(e.target.value)}
                      placeholder={settings?.imageModel?.hasApiKey ? '••••••••' : 'sk-…'}
                      autoComplete="off"
                      className="font-mono text-xs"
                    />
                  </Field>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => saveImageModelMut.mutate()}
                    disabled={saveImageModelMut.isPending || !imgBaseUrl.trim() || !imgModelName.trim() || (!settings?.imageModel?.hasApiKey && !imgApiKey.trim())}
                  >
                    <Save /> {saveImageModelMut.isPending ? '保存中…' : '保存配置'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => testImageModelMut.mutate()}
                    disabled={testImageModelMut.isPending || !imgBaseUrl.trim() || !imgModelName.trim() || (!settings?.imageModel?.hasApiKey && !imgApiKey.trim())}
                  >
                    <KeyRound /> {testImageModelMut.isPending ? '测试中…（真实生成一张图，约需十几秒）' : '测试连接'}
                  </Button>
                  <span className="text-[11px] text-ink-4">使用 Bearer API Key 鉴权</span>
                </div>
                {testImageModelMut.isError && (
                  <div role="alert" className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
                    <span className="font-medium">连接失败：</span>{testImageModelMut.error.message}
                  </div>
                )}
                {testImageModelMut.isSuccess && (
                  <div className="rounded-lg border border-ok/25 bg-ok/10 px-3 py-2 text-xs leading-relaxed text-ok">
                    连接成功 · {testImageModelMut.data.latencyMs} ms · {testImageModelMut.data.endpoint}
                  </div>
                )}
              </CardBody>
            </Card>
          </section>

          {/* ============ 通知与日历 ============ */}
          <section id="settings-notify" className="scroll-mt-28 space-y-5 md:scroll-mt-20">
            <SectionHeading title="通知与日历" desc="两项都是按需能力：不配置也不影响任务、项目和笔记" />
            <Card>
              <CardHeader><CardTitle><BellRing className="size-4 text-accent" /> 默认送达渠道</CardTitle></CardHeader>
              <CardBody className="space-y-3 p-5">
                <Field label="提醒默认渠道" hint="单条提醒可在新建或待触发列表中单独修改；「自动」会使用应用内提醒和当前可用的通知通道">
                  <Select
                    value={settings?.notify?.defaultChannel ?? 'auto'}
                    onChange={(e) => saveMut.mutate({ notify: { defaultChannel: e.target.value as 'auto' | 'inapp' | 'system' | 'feishu' | 'dingtalk' | 'weixin' } })}
                    className="max-w-xs text-xs"
                  >
                    {CHANNEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {settings?.notify?.systemSupported || o.value !== 'system' ? o.label : `${o.label}（仅支持 macOS）`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <NotifyStatusChip />
                </div>
              </CardBody>
            </Card>
            <NotifyChannelsCard />

            <div id="settings-calendar" className="scroll-mt-28 space-y-5 border-t border-line pt-7 md:scroll-mt-20">
            <SectionHeading title="日历源" desc="钉钉 CalDAV 与 ICS 订阅都会每 5 分钟自动同步进日历" />
            <Card>
              <CardHeader>
                <CardTitle><CalendarSync className="size-4 text-accent" /> 日历数据源</CardTitle>
                <span className={cn(
                  'rounded-full border px-2 py-px text-[10px]',
                  calendarConfigured ? 'border-ok/25 bg-ok/10 text-ok' : 'border-line text-ink-3',
                )}>
                  {calendarConfigured ? '已接入' : '未接入'}
                </span>
              </CardHeader>
              <CardBody className="space-y-5 p-5">
                {/* 钉钉 CalDAV：无需开发者权限 */}
                <div className="space-y-3">
                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <CalendarClock className="size-3.5 text-accent" /> 钉钉日历 · CalDAV
                      <span className="rounded-full bg-ok/10 px-1.5 py-px text-[10px] text-ok">推荐 · 无需开发者权限</span>
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-3">
                      钉钉 → 日历 → 设置 → 「使用 CalDAV 账号同步」→ 选择设备 → 获取 CalDAV 账号，
                      把用户名和专用密码填到这里（密码只显示一次），每 5 分钟自动同步。
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr]">
                    <Input
                      value={caldavUser}
                      onChange={(e) => setCaldavUser(e.target.value)}
                      placeholder="CalDAV 用户名"
                      className="font-mono text-xs"
                    />
                    <Input
                      value={caldavPass}
                      onChange={(e) => setCaldavPass(e.target.value)}
                      type="password"
                      placeholder={eventStatus?.caldav.configured ? '专用密码（已保存，留空不改）' : '专用密码'}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={caldavServer}
                      onChange={(e) => setCaldavServer(e.target.value)}
                      placeholder="https://calendar.dingtalk.com"
                      className="w-64 font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={caldavMut.isPending || !caldavUser.trim() || (!eventStatus?.caldav.configured && !caldavPass.trim())}
                      onClick={() => caldavMut.mutate({ username: caldavUser.trim(), password: caldavPass.trim() || undefined, server: caldavServer.trim() || undefined })}
                    >
                      <KeyRound /> 保存并连接
                    </Button>
                    {eventStatus?.caldav.configured && (
                      <span className="text-[11px] text-ink-4">已连接：{eventStatus.caldav.username.slice(0, 24)}</span>
                    )}
                  </div>
                </div>

                <div className="border-t border-line pt-4">
                  {/* ICS 订阅 */}
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm font-medium">ICS 订阅 <span className="ml-1 rounded-full bg-ok/10 px-1.5 py-px text-[10px] text-ok">推荐 · 无需开发者权限</span></p>
                      <p className="mt-1 text-xs leading-relaxed text-ink-3">
                        填入任意日历的 ICS 链接（飞书 / Google / iCloud / 系统日历的「公开日历」订阅地址都可以），每 5 分钟自动同步。
                      </p>
                    </div>
                    <Input
                      value={icsUrl}
                      onChange={(e) => setIcsUrl(e.target.value)}
                      onBlur={() => { if (!icsUrl && eventStatus?.ics.url) setIcsUrl(eventStatus.ics.url); }}
                      placeholder="https://…/calendar.ics"
                      className="font-mono text-xs"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="primary" disabled={saveMut.isPending || !icsUrl.trim()} onClick={saveIcs}>
                        <Save /> 保存
                      </Button>
                      <Button size="sm" variant="secondary" disabled={!eventStatus?.ics.configured || syncMut.isPending} onClick={() => syncMut.mutate()}>
                        <CalendarSync /> 立即同步
                      </Button>
                      <label>
                        <input
                          type="file"
                          accept=".ics,text/calendar"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            file.text().then((t) => importIcsMut.mutate(t));
                            e.target.value = '';
                          }}
                        />
                        <span className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 text-xs font-medium text-ink transition-colors hover:border-line-strong hover:bg-surface-3">
                          <Download className="size-3.5" /> 导入 .ics 文件
                        </span>
                      </label>
                      {eventStatus?.ics.configured && (
                        <span className="text-[11px] text-ink-4">当前：{eventStatus.ics.url.slice(0, 42)}…</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="border-t border-line pt-4">
                  <details>
                    <summary className="cursor-pointer text-sm font-medium text-ink-2 select-none">
                      钉钉直连（需要开发者权限，暂无权限可跳过）
                    </summary>
                    <div className="mt-4 space-y-4">
                      <Field label="AppKey (Client ID)">
                        <Input value={appKey} onChange={(e) => setAppKey(e.target.value)} placeholder="dingXXXXXXXX" />
                      </Field>
                      <Field label="App Secret (Client Secret)" hint={settings?.dingtalk.hasSecret ? '已保存（留空则不修改）' : '应用密钥'}>
                        <Input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)}
                          placeholder={settings?.dingtalk.hasSecret ? '••••••••' : '请输入 App Secret'} />
                      </Field>
                      <Field label="你的 userId" hint="通讯录里你的 userid；系统会自动换取 unionId">
                        <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="例如 manager1234" />
                      </Field>
                      <div className="flex items-center gap-2">
                        <Button variant="secondary" size="sm" onClick={saveDingtalk} disabled={saveMut.isPending}>
                          <Save /> 保存钉钉凭据
                        </Button>
                      </div>
                    </div>
                  </details>
                </div>
              </CardBody>
            </Card>
            </div>
          </section>

          {/* ============ 连接与权限 ============ */}
          <section id="settings-bots" className="scroll-mt-28 space-y-5 md:scroll-mt-20">
            <SectionHeading title="连接与权限" desc="按平台集中管理；只有主动使用对应能力时才需要授权" />
            <ConnectionPermissionSummary />
            <ClawbotCard />
            <DocumentAccessCard />
          </section>
        </div>
      </div>
    </div>
  );
}

function SetupOverview({
  modelConfigured,
  syncReady,
  calendarConfigured,
  onJump,
}: {
  modelConfigured: boolean;
  syncReady: boolean;
  calendarConfigured: boolean;
  onJump: (id: string) => void;
}) {
  const rows = [
    {
      id: 'settings-orb',
      icon: Bot,
      level: '必备',
      title: 'AI 模型',
      desc: '用于助手对话、自动分发和 AI 内容处理',
      status: modelConfigured ? '已就绪' : '待配置',
      ready: modelConfigured,
    },
    {
      id: 'settings-sync',
      icon: Cloud,
      level: '推荐',
      title: '云同步',
      desc: '多设备使用或希望云端留存时开启',
      status: syncReady ? '已开启' : '推荐开启',
      ready: syncReady,
    },
    {
      id: 'settings-notify',
      icon: CalendarSync,
      level: '按需',
      title: '通知与日历',
      desc: '需要自动提醒或汇总日程时再接入',
      status: calendarConfigured ? '日历已接入' : '暂不需要',
      ready: calendarConfigured,
    },
    {
      id: 'settings-bots',
      icon: Link2,
      level: '按需',
      title: '外部平台',
      desc: '需要微信入口、飞书文档或钉钉能力时再授权',
      status: '使用时授权',
      ready: false,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle><Sparkles className="size-4 text-accent" /> 配置顺序</CardTitle>
        <span className={cn(
          'rounded-full border px-2 py-px text-[10px]',
          modelConfigured ? 'border-ok/25 bg-ok/10 text-ok' : 'border-accent/35 bg-accent-dim text-accent',
        )}>
          {modelConfigured ? '核心能力已就绪' : '还差 1 项必备配置'}
        </span>
      </CardHeader>
      <CardBody className="p-0">
        {rows.map((row, index) => (
          <button
            key={row.id}
            type="button"
            onClick={() => onJump(row.id)}
            className={cn(
              'group flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-surface-1',
              index > 0 && 'border-t border-line',
            )}
          >
            <span className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-lg border',
              row.ready ? 'border-ok/25 bg-ok/10 text-ok' : 'border-line bg-surface-1 text-ink-3',
            )}>
              {row.ready ? <Check className="size-4" /> : <row.icon className="size-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">{row.title}</span>
                <span className={cn(
                  'rounded px-1.5 py-0.5 text-[10px]',
                  row.level === '必备' ? 'bg-accent-dim text-accent' : 'bg-surface-2 text-ink-4',
                )}>{row.level}</span>
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{row.desc}</span>
            </span>
            <span className={cn('hidden text-xs sm:block', row.ready ? 'text-ok' : 'text-ink-4')}>{row.status}</span>
            <ChevronRight className="size-4 shrink-0 text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-2" />
          </button>
        ))}
      </CardBody>
    </Card>
  );
}

function ModelPermissionSummary() {
  return (
    <div className="grid gap-4 border-y border-line py-4 sm:grid-cols-2">
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" />
        <div>
          <p className="text-xs font-medium text-ink-2">模型可以做什么</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-4">理解当前输入、回答问题、自动分发记录，并在你确认后执行工作台操作。</p>
        </div>
      </div>
      <div className="flex items-start gap-2.5">
        <LockKeyhole className="mt-0.5 size-4 shrink-0 text-accent" />
        <div>
          <p className="text-xs font-medium text-ink-2">会发送哪些内容</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-4">仅发送当前请求和完成请求所需的上下文，不会主动上传整个本地数据库。</p>
        </div>
      </div>
    </div>
  );
}

function ConnectionPermissionSummary() {
  const items = [
    { name: '微信', text: '作为对话入口，接收你的消息并返回工作台结果' },
    { name: '飞书', text: '按需读取你有权访问的文档，或在你要求时发送消息' },
    { name: '钉钉', text: '文档、日历、待办等能力逐项连接，互不捆绑' },
  ];
  return (
    <div className="border-y border-line py-4">
      <div className="flex items-start gap-2.5">
        <LockKeyhole className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-2">权限按需开启</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-4">未连接不影响本地功能；只有点击绑定、授权或保存连接后，对应平台能力才会生效。</p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {items.map((item) => (
          <div key={item.name} className="border-l-2 border-line pl-3">
            <p className="text-xs font-medium text-ink-2">{item.name}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-4">{item.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionHeading({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="px-1">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <p className="mt-0.5 text-xs text-ink-4">{desc}</p>
    </div>
  );
}
