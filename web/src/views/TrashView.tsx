// 回收站：软删除内容的浏览 / 恢复 / 彻底删除
// 左侧按「工作台 / 知识库 / AI 资源库」分类，卡片直接回显正文摘要，可展开看全文
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock, Archive, BrainCircuit, ChevronRight, FileCode2, FolderKanban, Inbox,
  LayoutDashboard, LibraryBig, ListTodo, NotebookPen, RotateCcw, ScrollText, Search, Trash2, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import type { TrashChip, TrashEntry, TrashKind, TrashType } from '@/types';
import { cn, parseLocal, relTime } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Input, Select } from '@/ui/form';
import { EmptyState, EllipsisText } from '@/ui/primitives';
import { Dialog, DialogContent } from '@/ui/dialog';

const KIND_ICON: Record<TrashKind, typeof ListTodo> = {
  tasks: ListTodo,
  projects: FolderKanban,
  fragments: Inbox,
  reminders: AlarmClock,
  notes: NotebookPen,
  knowledge: Archive,
  prompts: ScrollText,
  skills: FileCode2,
};

const GROUP_ICON = { workspace: LayoutDashboard, knowledge: LibraryBig, ai: BrainCircuit } as const;

/** 剩余保留天数：服务端按天惰性清除，这里只用于提示 */
function daysLeft(deletedAt: string, retainDays: number): number {
  const spent = Math.floor((Date.now() - parseLocal(deletedAt).getTime()) / 86_400_000);
  return Math.max(0, retainDays - spent);
}

function Chip({ chip }: { chip: TrashChip }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-[180px] items-center gap-1 truncate rounded-full px-2 py-0.5 text-[10px]',
        chip.tone === 'accent' && 'bg-accent-dim text-accent',
        chip.tone === 'warn' && 'bg-warn/10 text-warn',
        chip.tone === 'muted' && 'bg-surface-3 text-ink-3',
      )}
    >
      {chip.label}
    </span>
  );
}

export function TrashView() {
  const qc = useQueryClient();
  const [active, setActive] = useState<TrashKind | 'all'>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sort, setSort] = useState<'recent' | 'expiring'>('recent');
  const [purgeOne, setPurgeOne] = useState<TrashEntry | null>(null);
  const [scopePurge, setScopePurge] = useState(false);
  const [scopeWord, setScopeWord] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: qk.trash,
    queryFn: api.trash,
    refetchInterval: 60_000,
  });

  const invalidate = () => {
    qc.invalidateQueries();
  };

  const restoreMut = useMutation({
    mutationFn: (v: { type: TrashType; id: number }) => api.restoreTrash(v.type, v.id),
    onSuccess: () => {
      toast.success('已恢复', { description: '内容已放回原模块' });
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const purgeMut = useMutation({
    mutationFn: (v: { type: TrashType; id: number }) => api.purgeTrash(v.type, v.id),
    onSuccess: () => {
      toast.success('已彻底删除');
      setPurgeOne(null);
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // 批量清空：不可逆，需手动输「清空」才能提交
  const scopePurgeMut = useMutation({
    mutationFn: (kinds?: TrashType[]) => api.purgeAllTrash(kinds),
    onSuccess: (result) => {
      toast.success(`已清空 ${result.purged} 条`);
      setScopePurge(false);
      setScopeWord('');
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const total = data?.total ?? 0;
  const scopeCount = active === 'all' ? total : (data?.counts[active] ?? 0);
  const scopeKinds = active === 'all' ? undefined : [active];

  const filtered = useMemo(() => {
    const items = data?.items ?? [];
    const scoped = active === 'all' ? items : items.filter((item) => item.kind === active);
    const q = search.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((item) =>
      `${item.title} ${item.preview} ${item.chips.map((c) => c.label).join(' ')}`.toLowerCase().includes(q),
    );
  }, [data, active, search]);

  // 分组渲染：沿用服务端给出的模块顺序，空分类不占位
  const sections = useMemo(() => {
    const categories = data?.categories ?? [];
    // 默认最近删除优先；切「即将清除」时把先被自动清掉的排前面
    const ordered = sort === 'recent' ? filtered : [...filtered].sort((a, b) => a.deleted_at.localeCompare(b.deleted_at));
    return categories.flatMap((category) =>
      category.kinds
        .map((kind) => ({ ...kind, group: category.label, rows: ordered.filter((item) => item.kind === kind.kind) }))
        .filter((section) => section.rows.length > 0),
    );
  }, [data, filtered, sort]);

  const scopeLabel = active === 'all'
    ? '回收站'
    : (data?.categories.flatMap((c) => c.kinds).find((k) => k.kind === active)?.label ?? '该分类');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">回收站</h1>
          <p className="mt-1 text-sm text-ink-3">
            清单、知识库、AI 资源库里删掉的内容都在这里，保留 {data?.retainDays ?? 30} 天，可随时放回原处。
          </p>
        </div>
        {scopeCount > 0 && (
          <Button
            variant="dangerGhost"
            size="sm"
            onClick={() => { setScopeWord(''); setScopePurge(true); }}
          >
            <Trash2 />{active === 'all' ? '清空回收站' : `清空「${scopeLabel}」`}
          </Button>
        )}
      </div>

      <div className="flex items-start gap-4">
        {/* 分类栏 */}
        <aside className="card sticky top-6 hidden w-[212px] shrink-0 flex-col p-2 lg:flex">
          <RailRow
            label="全部"
            count={total}
            active={active === 'all'}
            icon={Trash2}
            onClick={() => setActive('all')}
          />
          {(data?.categories ?? []).map((category) => {
            const Icon = GROUP_ICON[category.key];
            const groupCount = category.kinds.reduce((n, k) => n + k.count, 0);
            return (
              <div key={category.key} className="mt-2.5">
                <p className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-[10px] uppercase tracking-widest text-ink-4">
                  <Icon className="size-3" /> {category.label}
                  <span className="tnum ml-auto text-ink-4">{groupCount}</span>
                </p>
                {category.kinds.map((kind) => (
                  <RailRow
                    key={kind.kind}
                    label={kind.label}
                    count={kind.count}
                    active={active === kind.kind}
                    icon={KIND_ICON[kind.kind]}
                    onClick={() => setActive(kind.kind)}
                  />
                ))}
              </div>
            );
          })}
          <p className="mt-3 border-t border-line px-2 pt-2.5 text-[10px] leading-relaxed text-ink-4">
            超期自动清除；删除时的提示里点「撤销」也能立即还原。
          </p>
        </aside>

        {/* 内容区 */}
        <main className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] max-w-md flex-1">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-4" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="在回收站里搜索标题或内容…"
                className="h-9 pl-9 text-xs"
              />
            </div>
            <Select
              aria-label="回收站排序"
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
              className="h-9 w-[132px] py-0 text-xs"
            >
              <option value="recent">最近删除优先</option>
              <option value="expiring">即将清除优先</option>
            </Select>
            <p className="text-xs text-ink-4 tnum">
              {isLoading
                ? '正在载入…'
                : search
                  ? `${filtered.length} / ${scopeCount} 条`
                  : active === 'all'
                    ? `${total} 条`
                    : `${scopeCount} 条 · ${scopeLabel}`}
            </p>
          </div>

          {/* 窄屏分类条 */}
          <div className="flex flex-wrap gap-1.5 lg:hidden">
            {(['all'] as Array<TrashKind | 'all'>).concat((data?.categories ?? []).flatMap((c) => c.kinds.map((k) => k.kind))).map((kind) => {
              const count = kind === 'all' ? total : (data?.counts[kind] ?? 0);
              return (
                <button
                  key={kind}
                  onClick={() => setActive(kind)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                    active === kind ? 'border-accent/35 bg-accent-dim text-accent' : 'border-line text-ink-3 hover:text-ink-2',
                    !count && kind !== 'all' && 'opacity-45',
                  )}
                >
                  {kind === 'all' ? '全部' : (data?.categories.flatMap((c) => c.kinds).find((k) => k.kind === kind)?.label ?? kind)}
                  <span className="tnum ml-1">{count}</span>
                </button>
              );
            })}
          </div>

          {total === 0 && !isLoading && (
            <EmptyState
              icon={<Trash2 />}
              title="回收站是空的"
              desc={`删除的清单、项目、随手记、提醒、知识存档、提示词和 Skill 会在这里保留 ${data?.retainDays ?? 30} 天，期间可随时恢复`}
              className="card"
            />
          )}

          {total > 0 && filtered.length === 0 && (
            <EmptyState
              icon={<Search />}
              title={search ? '这个分类里没有匹配的内容' : '这个分类目前是空的'}
              desc={search ? '换个关键词，或切回「全部」看看' : '从左侧选一个有内容的分类'}
              className="card"
            />
          )}

          {sections.map((section) => (
            <section key={section.kind} className="space-y-2">
              <div className="flex items-center gap-2 px-1 text-[11px] tracking-wide text-ink-4">
                <span className="font-medium text-ink-3">{section.group} · {section.label}</span>
                <span className="tnum">{section.rows.length}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {section.rows.map((entry) => (
                  <TrashCard
                    key={`${entry.kind}:${entry.id}`}
                    entry={entry}
                    retainDays={data?.retainDays ?? 30}
                    kindLabel={section.label}
                    expanded={expanded === `${entry.kind}:${entry.id}`}
                    onToggle={() => setExpanded(expanded === `${entry.kind}:${entry.id}` ? null : `${entry.kind}:${entry.id}`)}
                    onRestore={() => restoreMut.mutate({ type: entry.kind, id: entry.id })}
                    onPurge={() => setPurgeOne(entry)}
                    restoring={restoreMut.isPending && restoreMut.variables?.id === entry.id && restoreMut.variables.type === entry.kind}
                  />
                ))}
              </div>
            </section>
          ))}
        </main>
      </div>

      {/* 彻底删除确认 */}
      <Dialog open={Boolean(purgeOne)} onOpenChange={(open) => !open && setPurgeOne(null)}>
        <DialogContent title="彻底删除" className="max-w-md">
          <div className="space-y-3 p-5">
            <p className="text-sm font-medium">彻底删除后无法恢复</p>
            {purgeOne && (
              <div className="rounded-xl border border-line bg-surface-2 p-3">
                <p className="truncate text-xs font-medium">{purgeOne.title}</p>
                {purgeOne.preview && <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-3">{purgeOne.preview}</p>}
              </div>
            )}
            <p className="text-xs leading-relaxed text-ink-4">
              这条内容将从回收站永久清除{purgeOne?.kind === 'skills' ? '，对应的 Skill 备份目录也会一并删除' : ''}。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setPurgeOne(null)}>取消</Button>
              <Button
                variant="primary"
                size="sm"
                className="bg-danger text-white"
                disabled={purgeMut.isPending}
                onClick={() => purgeOne && purgeMut.mutate({ type: purgeOne.kind, id: purgeOne.id })}
              >
                确认删除
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 批量清空：二次确认（输对口令才放行） */}
      <Dialog open={scopePurge} onOpenChange={(open) => !open && setScopePurge(false)}>
        <DialogContent title="清空回收站" className="max-w-md">
          <div className="space-y-3 p-5">
            <p className="text-sm font-medium">彻底清除 {scopeCount} 条内容？</p>
            <div className="rounded-xl border border-danger/25 bg-danger/5 p-3 text-xs leading-relaxed text-ink-2">
              这里清掉的是回收站里的{active === 'all' ? '全部内容' : `「${scopeLabel}」`}，
              删完就找不回来{active === 'skills' || active === 'all' ? '，Skill 备份目录也会一并删除' : ''}。
            </div>
            <label className="block text-xs text-ink-3">
              输入“清空”以确认
              <Input
                value={scopeWord}
                onChange={(event) => setScopeWord(event.target.value)}
                placeholder="清空"
                autoFocus
                className="mt-1.5 h-8 text-xs"
              />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setScopePurge(false)}>
                <X />取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                className="bg-danger text-white"
                disabled={scopeWord.trim() !== '清空' || scopePurgeMut.isPending}
                onClick={() => scopePurgeMut.mutate(scopeKinds)}
              >
                {scopePurgeMut.isPending ? '正在清除…' : `永久清除 ${scopeCount} 条`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RailRow({ label, count, active, icon: Icon, onClick }: {
  label: string;
  count: number;
  active: boolean;
  icon: typeof ListTodo;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!count && !active}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors',
        active ? 'bg-accent-dim text-accent' : 'text-ink-2 hover:bg-surface-2',
        !count && !active && 'cursor-default text-ink-4',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={cn('tnum rounded-full px-1.5 text-[10px]', active ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-ink-4')}>
        {count}
      </span>
    </button>
  );
}

function TrashCard({ entry, kindLabel, retainDays, expanded, onToggle, onRestore, onPurge, restoring }: {
  entry: TrashEntry;
  kindLabel: string;
  retainDays: number;
  expanded: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onPurge: () => void;
  restoring: boolean;
}) {
  const Icon = KIND_ICON[entry.kind];
  const left = daysLeft(entry.deleted_at, retainDays);
  const { data: detail, isFetching } = useQuery({
    queryKey: [...qk.trash, entry.kind, entry.id],
    queryFn: () => api.trashDetail(entry.kind, entry.id),
    enabled: expanded,
    staleTime: 5 * 60_000,
  });

  return (
    <article className={cn('card flex flex-col gap-2.5 p-3.5 transition-colors', expanded && 'border-line-strong bg-surface-1')}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3">
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <EllipsisText className="text-sm font-medium">{entry.title}</EllipsisText>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-4 tnum">
            <span>{kindLabel}</span>
            <span>·</span>
            <span>删除于 {relTime(entry.deleted_at)}</span>
            {entry.created_at && <><span>·</span><span>创建于 {entry.created_at.slice(0, 10)}</span></>}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] tnum',
            left <= 7 ? 'bg-warn/10 text-warn' : 'bg-surface-2 text-ink-4',
          )}
          title={`第 ${retainDays} 天后自动清除`}
        >
          剩 {left} 天
        </span>
      </div>

      {entry.preview && (
        <p className={cn(
          'rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-ink-3',
          expanded ? 'max-h-none whitespace-pre-wrap' : 'line-clamp-2',
        )}>
          {entry.preview}
        </p>
      )}

      {entry.chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {entry.chips.map((chip, index) => <Chip key={`${chip.label}-${index}`} chip={chip} />)}
        </div>
      )}

      {expanded && (
        <div className="rounded-lg border border-line bg-surface-2/60">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
            <p className="text-[10px] text-ink-4">删除前内容回显{entry.chars ? ` · ${entry.chars} 字` : ''}</p>
            <button onClick={onToggle} className="text-[10px] text-ink-3 hover:text-ink">收起</button>
          </div>
          {isFetching
            ? <p className="px-3 py-3 text-[11px] text-ink-4">正在读取…</p>
            : <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink-2">{detail?.body || '（这条内容没有正文）'}</pre>}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-2">
        <Button
          variant="ghost"
          size="xsIcon"
          onClick={onToggle}
          disabled={!entry.expandable}
          title={entry.expandable ? '展开看全文' : '这条内容没有更多正文'}
          className={cn('h-6 w-auto gap-1 px-1.5 text-[11px]', !entry.expandable && 'opacity-40')}
        >
          <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
          {expanded ? '收起' : '看全文'}
        </Button>
        <div className="flex items-center gap-1">
          <Button variant="dangerGhost" size="sm" onClick={onPurge}>彻底删除</Button>
          <Button variant="secondary" size="sm" onClick={onRestore} disabled={restoring}>
            <RotateCcw className={cn(restoring && 'animate-spin')} /> 恢复
          </Button>
        </div>
      </div>
    </article>
  );
}
