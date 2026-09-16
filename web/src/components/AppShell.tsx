/**
 * [INPUT]: 当前路由、工作台设置与导航/助手组件
 * [OUTPUT]: AppShell 全局导航和页面容器；文档工作区分配动态视口剩余高度
 * [POS]: 页面布局边界，分流滚动方式并让展开文档覆盖导航
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Blocks, CalendarRange, FolderKanban, LibraryBig, LineChart, MessageCircle, Moon,
  NotebookPen, Search, Settings, Sun, SunMedium, Trash2,
} from 'lucide-react';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useUi } from '@/store/ui';
import { GLOBAL_SEARCH_ENABLED } from '@/lib/search';
import { useTheme } from '@/store/theme';
import { useOrbActivity } from '@/store/orbActivity';
import { CommandPalette } from './CommandPalette';
import { NotifyStatusDot } from './NotifyStatusChip';
import { Kbd } from '@/ui/primitives';
import { AssistantDock } from './AssistantDock';

/** 首屏加载桥：有还没拿到过数据的查询在途时，助手切「检索资料」状态 */
function OrbBusyBridge() {
  const qc = useQueryClient();
  useEffect(() => {
    let prev = 0;
    const evaluate = () => {
      const n = qc.getQueryCache().getAll().filter(
        (q) => q.state.status === 'pending' && q.state.fetchStatus === 'fetching',
      ).length;
      for (let i = prev; i < n; i++) useOrbActivity.getState().start();
      for (let i = n; i < prev; i++) useOrbActivity.getState().end();
      prev = n;
    };
    const unsub = qc.getQueryCache().subscribe(evaluate);
    evaluate();
    return () => {
      unsub();
      for (let i = 0; i < prev; i++) useOrbActivity.getState().end(); // 卸载时不漏还计数
    };
  }, [qc]);
  return null;
}

const NAV = [
  { to: '/', icon: SunMedium, label: '今日' },
  { to: '/calendar', icon: CalendarRange, label: '日历' },
  { to: '/notes', icon: NotebookPen, label: '随手记' },
  { to: '/projects', icon: FolderKanban, label: '项目' },
  { to: '/knowledge', icon: LibraryBig, label: '知识库' },
  { to: '/ai-resources', icon: Blocks, label: 'AI 资源库' },
  { to: '/assistant', icon: MessageCircle, label: '助手' },
  { to: '/review', icon: LineChart, label: '回顾' },
];

export function AppShell() {
  const { pathname } = useLocation();
  // 文档工作区占满动态视口，剩余高度通过 flex 下传，避免页面重复扣减页头。
  const documentWorkspace = pathname === '/notes' || pathname.startsWith('/documents/');
  const setPalette = useUi((s) => s.setPalette);
  const resolved = useTheme((s) => s.resolved);
  const toggle = useTheme((s) => s.toggle);
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 60_000 });
  const appName = settings?.general?.appName || 'YZ工作台';
  const appAvatar = settings?.general?.appAvatar;

  // 提醒触发监听：新触发的提醒弹通知
  useReminderWatcher();

  return (
    <div className={cn('relative min-h-screen', documentWorkspace && 'flex h-dvh min-h-0 flex-col overflow-hidden')}>
      <div className="orb orb-a" aria-hidden />
      <div className="orb orb-b" aria-hidden />

      {/* 侧栏 */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-line bg-chrome backdrop-blur-md md:flex">
        <div className="flex items-center gap-2.5 px-5 pb-6 pt-6">
          {appAvatar ? (
            <img src={appAvatar} alt="logo" className="size-9 rounded-xl object-cover" />
          ) : (
            <div className="flex size-9 items-center justify-center rounded-xl border border-accent/25 bg-accent-dim text-lg font-semibold neon-text">
              {appName.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div>
            <p className="max-w-28 truncate text-sm font-semibold tracking-wide" title={appName}>{appName}</p>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-1 hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      'absolute left-0 h-4 w-0.5 -translate-x-2 rounded-full bg-accent transition-all',
                      isActive && 'translate-x-[-10px]',
                    )}
                    style={{ display: isActive ? 'block' : 'none' }}
                  />
                  <Icon className={cn('size-4', isActive ? 'text-accent' : 'text-ink-3 group-hover:text-ink-2')} />
                  {label}
                  {to === '/reminders' && <NotifyStatusDot />}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-2 border-t border-line p-3">
          {GLOBAL_SEARCH_ENABLED && (
            <button
              onClick={() => setPalette(true)}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs text-ink-4 transition-colors hover:text-ink-2"
            >
              <span className="flex items-center gap-2"><Search className="size-3.5" /> 全局搜索</span>
              <Kbd>⌘K</Kbd>
            </button>
          )}
          <div className="flex items-center justify-between px-1">
            <button
              onClick={toggle}
              title={resolved === 'dark' ? '切换到日间模式' : '切换到夜间模式'}
              aria-label={resolved === 'dark' ? '切换到日间模式' : '切换到夜间模式'}
              className="rounded-lg p-2 text-ink-3 transition-colors hover:bg-surface-1 hover:text-ink"
            >
              {resolved === 'dark' ? <Sun className="size-4 text-warn" /> : <Moon className="size-4 text-accent" />}
            </button>
            <div className="flex items-center gap-1">
              <NavLink
                to="/trash"
                title="回收站" aria-label="回收站"
                className={({ isActive }) =>
                  cn('relative rounded-lg p-2 transition-colors', isActive ? 'bg-surface-2 text-accent' : 'text-ink-3 hover:bg-surface-1 hover:text-ink')
                }
              >
                <Trash2 className="size-4" />
              </NavLink>
              <NavLink
                to="/settings"
                title="设置" aria-label="设置"
                className={({ isActive }) =>
                  cn('relative rounded-lg p-2 transition-colors', isActive ? 'bg-surface-2 text-accent' : 'text-ink-3 hover:bg-surface-1 hover:text-ink')
                }
              >
                <Settings className="size-4" />
                <span className="absolute -right-0.5 -top-0.5"><NotifyStatusDot /></span>
              </NavLink>
            </div>
          </div>
        </div>
      </aside>

      {/* 移动端顶栏 */}
      <header className="sticky top-0 z-30 flex shrink-0 items-center justify-between border-b border-line bg-chrome px-4 py-3 backdrop-blur-md md:hidden">
        <div className="flex items-center gap-2">
          {appAvatar ? (
            <img src={appAvatar} alt="logo" className="size-7 rounded-lg object-cover" />
          ) : (
            <div className="flex size-7 items-center justify-center rounded-lg border border-accent/25 bg-accent-dim neon-text text-[10px] font-semibold">{appName.slice(0, 2).toUpperCase()}</div>
          )}
          <span className="text-sm font-semibold">{appName}</span>
        </div>
        <nav className="flex max-w-[calc(100vw-9rem)] items-center gap-1 overflow-x-auto">
          {NAV.map(({ to, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => cn('rounded-lg p-2', isActive ? 'bg-surface-2 text-accent' : 'text-ink-3')}>
              <Icon className="size-4" />
            </NavLink>
          ))}
          <NavLink to="/settings" aria-label="设置" className={({ isActive }) => cn('rounded-lg p-2', isActive ? 'bg-surface-2 text-accent' : 'text-ink-3')}>
            <Settings className="size-4" />
          </NavLink>
          <button onClick={toggle} className="rounded-lg p-2 text-ink-3" aria-label={resolved === 'dark' ? '切换到日间模式' : '切换到夜间模式'}>
            {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </nav>
      </header>

      {/* 主内容：全宽利用工作区（参考 Notion / Linear，不再居中限宽） */}
      <main className={cn('relative z-10 has-[[data-document-expanded=true]]:z-50 md:pl-56', documentWorkspace && 'flex min-h-0 flex-1 flex-col')}>
        <div className={cn('w-full px-4 md:px-8', documentWorkspace
          ? 'flex min-h-0 flex-1 flex-col py-4 md:py-6'
          : 'py-6 md:py-8')}>
          <Outlet />
        </div>
      </main>

      {GLOBAL_SEARCH_ENABLED && <CommandPalette />}
      <AssistantDock />
      <OrbBusyBridge />
    </div>
  );
}

const SEEN_KEY = 'workbench.seenFired';
const SEEN_LIMIT = 200;

// 代号重命名迁移：yao.seenFired -> workbench.seenFired（仅执行一次，避免重复弹已见过的提醒）
try {
  if (localStorage.getItem('workbench.seenFired') == null && localStorage.getItem('yao.seenFired') != null) {
    localStorage.setItem('workbench.seenFired', localStorage.getItem('yao.seenFired')!);
    localStorage.removeItem('yao.seenFired');
  }
} catch { /* 隐私模式等场景下 localStorage 不可用，忽略 */ }

/** 已见标记带上 fired_at：延后后 fired_at 被清空，再次到点时就是新的 key，能重新提示 */
function seenKeyOf(id: number, firedAt: string | null): string {
  return `${id}:${firedAt ?? ''}`;
}

function readSeen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return new Set();
    // 旧格式存的是纯 id 数组，统一补成 legacy key，避免升级后把历史提醒又弹一遍
    return new Set(raw.map((v) => (typeof v === 'number' ? `${v}:legacy` : String(v))));
  } catch {
    return new Set();
  }
}

/**
 * 轮询提醒，按渠道分工：
 * - inapp：服务端不投递，应用内提示由前端负责（这是它唯一的送达路径）
 * - system / auto / feishu / dingtalk：服务端已投递，前端只更新未读状态，不重复打扰
 */
function useReminderWatcher() {
  const { data: reminders } = useQuery({
    queryKey: qk.reminders,
    queryFn: api.reminders,
    refetchInterval: 15_000,
  });

  useEffect(() => {
    if (!reminders) return;
    const seen = readSeen();
    const newlyFired = reminders.filter((r) => r.status === 'fired' && !seen.has(seenKeyOf(r.id, r.fired_at)));
    if (newlyFired.length === 0) return;
    for (const r of newlyFired) seen.add(seenKeyOf(r.id, r.fired_at));
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_LIMIT)));

    const mine = newlyFired.filter((r) => (r.channel ?? 'auto') === 'inapp');
    if (mine.length === 0) return;
    import('sonner').then(({ toast }) => {
      for (const r of mine.slice(0, 3)) {
        toast(r.message, { description: '提醒时间已到', duration: 10_000 });
      }
    });
  }, [reminders]);
}
