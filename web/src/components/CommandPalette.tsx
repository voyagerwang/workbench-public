import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command as Cmdk } from 'cmdk';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search as SearchIcon, BookOpen, Sparkles } from 'lucide-react';
import {
  BellRing, CalendarRange, CalendarSync, FileCode2, FileText, FolderKanban, LibraryBig,
  LineChart, ListChecks, Loader2, NotebookPen, Settings, SunMedium, Trash2,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import { globalSearch, type SearchGroup, type SearchItem } from '@/lib/search';
import { useNotifyPermission } from '@/lib/notify-permission';
import { openNotificationSettings, testSystemNotification } from '@/lib/notify-actions';
import { useUi } from '@/store/ui';
import { Kbd } from '@/ui/primitives';

const GROUP_ICON: Record<SearchGroup['type'], React.ReactNode> = {
  task: <ListChecks className="size-4" />,
  note: <NotebookPen className="size-4" />,
  knowledge: <Sparkles className="size-4" />,
  source_document: <BookOpen className="size-4" />,
  archive: <FileText className="size-4" />,
  prompt: <FileCode2 className="size-4" />,
  reminder: <BellRing className="size-4" />,
};

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchGroup[]>([]);
  const [searching, setSearching] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const syncMut = useMutation({
    mutationFn: api.syncEvents,
    onSuccess: (r) => {
      if (r.ok) toast.success(`日历同步完成：${r.count} 条日程`);
      else toast.error(r.error ?? '同步失败');
      qc.invalidateQueries({ queryKey: qk.events('') });
    },
  });

  // 关闭时重置；输入防抖后调统一搜索接口
  useEffect(() => {
    if (!open) { setQuery(''); setResults([]); return; }
    const q = query.trim();
    if (!q) { setResults([]); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      globalSearch(q)
        .then((r) => setResults(r.groups))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [query, open]);

  const run = (fn: () => void) => () => { setOpen(false); fn(); };
  const go = (route: string) => () => { setOpen(false); navigate(route); };

  // 通知相关只留一条命令：按当前权限变成下一步该做的那件事
  const { permission: notifyPerm } = useNotifyPermission();
  const notifyCommand = notifyPerm === 'granted'
    ? { label: '发一条测试通知', run: testSystemNotification }
    : notifyPerm === 'default'
      ? {
          label: '查看系统通知用途',
          run: () => {
            navigate('/reminders');
            toast.info('系统通知默认不开启', { description: '先看右上角的用途说明，确认后再决定是否授权。' });
          },
        }
      : { label: '打开系统通知设置', run: openNotificationSettings };

  const hasQuery = query.trim().length > 0;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className="pop-panel fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-line-strong data-[state=open]:animate-[palette-in_.15s_ease-out]"
        >
          <DialogPrimitive.Title className="sr-only">全局搜索</DialogPrimitive.Title>
          <Cmdk className="flex flex-col">
            <div className="flex items-center gap-3 border-b border-line px-4">
              <SearchIcon className="size-4 text-accent" />
              <Cmdk.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="搜索清单、随手记、存档、提示词、提醒…"
                className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-4"
              />
              {searching && <Loader2 className="size-3.5 animate-spin text-ink-4" />}
              <Kbd>ESC</Kbd>
            </div>

            <Cmdk.List className="max-h-[46vh] overflow-y-auto p-2">
              <Cmdk.Empty className="px-3 py-6 text-center text-xs text-ink-4">
                {hasQuery ? '没有找到匹配的内容或命令' : '输入即搜索 · 想记点什么交给顶部助手'}
              </Cmdk.Empty>

              {results.map((group) => (
                <Group key={group.type} heading={group.label}>
                  {group.items.map((item) => (
                    <ResultItem key={item.id} icon={GROUP_ICON[group.type]} item={item} onGo={go(item.route)} />
                  ))}
                </Group>
              ))}

              <Group heading="操作">
                <Item icon={<CalendarSync className="size-4" />} action={run(() => syncMut.mutate())}>
                  同步钉钉日历
                </Item>
                <Item icon={<BellRing className="size-4" />} action={run(notifyCommand.run)}>
                  {notifyCommand.label}
                </Item>
              </Group>

              <Group heading="前往">
                <Nav to="/" icon={<SunMedium className="size-4" />} label="今日" run={run} />
                <Nav to="/calendar" icon={<CalendarRange className="size-4" />} label="日历" run={run} />
                <Nav to="/projects" icon={<FolderKanban className="size-4" />} label="项目" run={run} />
                <Nav to="/notes" icon={<NotebookPen className="size-4" />} label="随手记" run={run} />
                <Nav to="/knowledge" icon={<LibraryBig className="size-4" />} label="知识库" run={run} />
                <Nav to="/knowledge/prompts" icon={<NotebookPen className="size-4" />} label="提示词" run={run} />
                <Nav to="/review" icon={<LineChart className="size-4" />} label="回顾" run={run} />
                <Nav to="/trash" icon={<Trash2 className="size-4" />} label="回收站" run={run} />
                <Nav to="/settings" icon={<Settings className="size-4" />} label="设置" run={run} />
              </Group>
            </Cmdk.List>

            <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[10px] text-ink-4">
              <span>全局搜索 · ⌘K</span>
              <span>想记点什么？交给顶部助手</span>
            </div>
          </Cmdk>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Cmdk.Group heading={
      <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-widest text-ink-4">{heading}</div>
    }>
      {children}
    </Cmdk.Group>
  );
}

function Item({ icon, children, action, actionHint }: {
  icon: React.ReactNode; children: React.ReactNode; action?: () => void; actionHint?: string;
}) {
  return (
    <Cmdk.Item onSelect={action ?? (() => {})}>
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {actionHint && <span className="kbd">{actionHint}</span>}
    </Cmdk.Item>
  );
}

function ResultItem({ icon, item, onGo }: { icon: React.ReactNode; item: SearchItem; onGo: () => void }) {
  return (
    <Item icon={icon} action={onGo}>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 shrink-0 truncate">{item.title}</span>
        <span className="min-w-0 truncate text-[11px] text-ink-4">{item.hint}</span>
      </span>
    </Item>
  );
}

function Nav({ to, icon, label, run }: {
  to: string; icon: React.ReactNode; label: string;
  run: (fn: () => void) => () => void;
}) {
  const navigate = useNavigate();
  return <Item icon={icon} action={run(() => navigate(to))}>{label}</Item>;
}
