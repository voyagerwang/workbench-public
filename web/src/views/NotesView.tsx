/**
 * [INPUT]: 笔记列表与标签查询、NoteDocument 共享详情
 * [OUTPUT]: NotesView 列表筛选、标签管理与笔记切换入口，双栏填满父级可用高度
 * [POS]: 随手记路由编排；正文、保存和助手行为交由 document 模块
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Image as ImageIcon, NotebookPen, PenLine, Pin, Plus, SearchX, Sparkles, Tags, Trash2,
} from 'lucide-react';
import { api, qk } from '@/lib/api';
import { notifyDeleted } from '@/lib/trash';
import { countImages, markdownSummary } from '@/lib/markdown';
import { countTags, hasTag, normalizeTags, remapFilters, removeTag, tagMatches } from '@/lib/tags';
import type { Note, TagBatchOp } from '@/types';
import { cn, relTime } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Input } from '@/ui/form';
import { EmptyState } from '@/ui/primitives';
import { NoteDocument } from '@/components/document/NoteDocument';
import { toast } from 'sonner';
import { TagRowMenu, useTagManager } from '@/components/TagManager';

const RECENT_TAGS_KEY = 'workbench.notes.recentTags';
const RECENT_TAGS_MAX = 8;
function readRecentTags(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_TAGS_KEY) ?? '[]');
    return Array.isArray(parsed) ? normalizeTags(parsed).slice(0, RECENT_TAGS_MAX) : [];
  } catch { return []; }
}

/** 最近用过的标签：选择器里排最前，跨会话保留（localStorage） */
function useRecentTags() {
  const [recent, setRecent] = useState<string[]>(readRecentTags);
  const push = useCallback((tag: string) => {
    setRecent((prev) => {
      const next = normalizeTags([tag, ...prev]).slice(0, RECENT_TAGS_MAX);
      try { localStorage.setItem(RECENT_TAGS_KEY, JSON.stringify(next)); } catch { /* 隐私模式下写不进就算了 */ }
      return next;
    });
  }, []);
  return [recent, push] as const;
}

/** 新建态的占位笔记。必须是模块级常量：每次渲染都造新对象会让编辑器无谓重挂。 */
const NEW_NOTE: Note = {
  id: 0, title: '', content: '', tags: [], source_fragment_id: null, pinned: 0, created_at: '', updated_at: '',
};

/** 列表顺序：置顶 > 最近编辑 */
function compareNotes(a: Note, b: Note): number {
  const pinDiff = (b.pinned ?? 0) - (a.pinned ?? 0);
  if (pinDiff) return pinDiff;
  return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
}

export function NotesView({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  // 页面入口直接进入临时编辑态；临时态不等于已经创建了一条随手记。
  const [activeId, setActiveId] = useState<number | null>(0);
  // 随手记卡片点落点时带 ?note=ID 过来，直接打开那一条
  const [params, setParams] = useSearchParams();
  const focusNote = params.get('note');

  // 多标签筛选，第一版用 AND：选得越多范围越窄，符合「找东西」的直觉
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [allTagsOpen, setAllTagsOpen] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [recentTags, pushRecentTag] = useRecentTags();

  // 编辑器把自己的 flush 注册进来，切换笔记前先把未提交的改动写掉
  const flushRef = useRef<null | (() => Promise<void>)>(null);
  const registerFlush = useCallback((fn: (() => Promise<void>) | null) => { flushRef.current = fn; }, []);

  /**
   * 编辑器实例的 key。**新建成功后不换 key**：换 key 会让编辑器重挂，
   * 光标当场丢失，用户接着敲的字会掉在地上（实测：新建后立刻继续输入，后半段直接没了）。
   * 编辑器内部已经用 idRef 把「新建」切成「更新」，不需要靠重挂来切换。
   */
  const openSeq = useRef(0);
  const switchRequest = useRef(0);
  const [editorKey, setEditorKey] = useState('new-0');

  const { data: notes } = useQuery({ queryKey: qk.notes(''), queryFn: () => api.notes('') });

  const tagStats = useMemo(() => countTags(notes ?? []), [notes]);
  // 统一标签池：知识资料侧的标签也进候选，资料与手记共用同一套词汇（跨载体改名/删除走知识库的标签池管理）
  const poolTags = useQuery({ queryKey: qk.tags, queryFn: api.tagList });
  const allTagNames = useMemo(() => {
    const names = new Set(tagStats.map((t) => t.tag));
    for (const item of poolTags.data?.tags ?? []) names.add(item.name);
    return [...names];
  }, [tagStats, poolTags.data]);
  const tagCounts = useMemo(
    () => Object.fromEntries(tagStats.map((t) => [t.tag, t.count])) as Record<string, number>,
    [tagStats],
  );

  const filtered = useMemo(() => {
    let list = [...(notes ?? [])].sort(compareNotes);
    if (tagFilters.length) list = list.filter((n) => tagFilters.every((t) => hasTag(n.tags, t)));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
    }
    return list;
  }, [notes, search, tagFilters]);

  const visibleTags = useMemo(
    () => tagStats.filter((t) => tagMatches(t.tag, tagQuery)),
    [tagStats, tagQuery],
  );

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteNote(id),
    onSuccess: (_, id) => {
      if (activeId === id) setActiveId(null);
      notifyDeleted(qc, 'notes', id);
    },
  });

  const archiveNoteMut = useMutation({
    mutationFn: (id: number) => api.archiveNote(id),
    onSuccess: (result) => {
      void qc.invalidateQueries({queryKey:qk.knowledge});
      toast.success(result.created ? '已纳入知识库' : '这条笔记已在知识库中', {
        action: { label: '查看', onClick: () => { window.location.href = `/knowledge/archives?archive=${result.archive.id}`; } },
      });
    },
  });

  // 标签的全局管理（重命名 / 合并 / 删除）。改完把筛选条件一起迁过去，
  // 否则用户会卡在「筛着一个已经不存在的标签 → 列表空白」。
  const tagOps = useTagManager({
    allTags: allTagNames,
    counts: tagCounts,
    onDone: (op: TagBatchOp) => {
      if (op.op === 'add') return;
      setTagFilters((prev) => remapFilters(prev, op));
    },
  });

  /** 切换/关闭前先把当前编辑器落盘，避免最后一次输入丢在防抖窗口里 */
  const openNote = useCallback(async (id: number | null) => {
    const request = ++switchRequest.current;
    try { await flushRef.current?.(); } catch (error) { toast.error(`暂未切换：${(error as Error).message}`); return; }
    if (request !== switchRequest.current) return;
    openSeq.current += 1;
    setEditorKey(id ? `note-${id}-${openSeq.current}` : `new-${openSeq.current}`);
    setActiveId(id);
  }, []);

  // 随手记卡片点落点时带 ?note=ID 过来，直接打开那一条（深链无需 flush，此时还没有编辑器）
  useEffect(() => {
    if (!focusNote) return;
    const id = Number(focusNote);
    if (Number.isFinite(id) && id > 0) void openNote(id);
    params.delete('note');
    setParams(params, { replace: true });
  }, [focusNote, params, setParams, openNote]);

  const toggleTagFilter = (tag: string) => {
    setTagFilters((prev) => (hasTag(prev, tag) ? removeTag(prev, tag) : normalizeTags([...prev, tag])));
  };

  // 深链进来的随手记可能不在当前筛选结果里，从全量里找，保证编辑区能打开
  const active = (notes ?? []).find((n) => n.id === activeId) ?? null;
  const hasNotes = (notes ?? []).length > 0;

  /**
   * 新建成功后 activeId 立刻变成真实 id，但 notes 要等回流才会包含它。
   * 这段空窗期必须继续渲染「新建编辑器」：写成两个独立分支的话，
   * 编辑器会先被 EmptyState 顶掉再挂回来，光标当场丢失，用户接着敲的字会掉在地上。
   * 所以这里把「新建」和「已有」收敛成同一个元素，只靠 key 变化来切换。
   */
  const [creatingId, setCreatingId] = useState<number | null>(null);
  useEffect(() => {
    if (creatingId !== null && active) setCreatingId(null);
  }, [creatingId, active]);
  const editorNote = active
    ?? (activeId === 0 || (creatingId !== null && activeId === creatingId) ? NEW_NOTE : null);
  const editorOpen = Boolean(editorNote);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {!embedded && (
        <div className="flex shrink-0 items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">随手记</h1>
          </div>
          <Link to="/" className="hidden text-xs text-ink-3 transition-colors hover:text-accent sm:block">回到今日</Link>
        </div>
      )}
    <div className="flex min-h-0 flex-1 gap-4">
      {/* 列表 */}
      <aside className={cn('card flex min-h-0 w-72 shrink-0 flex-col', editorOpen && 'hidden lg:flex')}>
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex items-center justify-between">
            <h1 className="text-sm font-semibold">随手记</h1>
            <Button size="xsIcon" variant="ghost" title="新建随手记" onClick={() => void openNote(0)}>
              <Plus />
            </Button>
          </div>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索标题或正文…" className="h-8 text-xs" />

          {/* 当前筛选：看得见、可单条清除、可一次清空 */}
          {(tagFilters.length > 0 || search.trim()) && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-ink-4">筛选</span>
              {search.trim() && (
                <FilterChip label={`“${search.trim()}”`} onClear={() => setSearch('')} />
              )}
              {tagFilters.map((t) => (
                <FilterChip key={t} label={`#${t}`} onClear={() => setTagFilters((prev) => removeTag(prev, t))} />
              ))}
              {tagFilters.length > 1 && (
                <span className="ml-auto text-[10px] text-ink-4" title="同时满足所有选中的标签">需同时满足</span>
              )}
            </div>
          )}

          {/* 常用标签 + 全部标签入口 */}
          {allTagNames.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {tagStats.slice(0, 6).map(({ tag, count }) => (
                <button
                  key={tag}
                  onClick={() => toggleTagFilter(tag)}
                  title={hasTag(tagFilters, tag) ? `取消筛选 #${tag}` : `只看 #${tag}`}
                  className={cn(
                    'rounded-full border px-1.5 py-px text-[10px] transition-colors',
                    hasTag(tagFilters, tag)
                      ? 'border-accent/50 bg-accent-dim text-accent'
                      : 'border-line text-ink-3 hover:border-line-strong hover:text-ink-2',
                  )}
                >
                  {tag} · {count}
                </button>
              ))}
              <button
                onClick={() => setAllTagsOpen((v) => !v)}
                className={cn(
                  'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[10px] transition-colors',
                  allTagsOpen
                    ? 'border-accent/50 bg-accent-dim text-accent'
                    : 'border-line text-ink-3 hover:border-line-strong hover:text-ink-2',
                )}
                title="查看全部标签"
              >
                <Tags className="size-2.5" />
                全部 {allTagNames.length}
              </button>
            </div>
          )}

          {/* 全部标签：可搜索 + 多选（AND） */}
          {allTagsOpen && (
            <div className="rounded-lg border border-line bg-surface-1 p-1.5">
              <input
                value={tagQuery}
                onChange={(e) => setTagQuery(e.target.value)}
                placeholder="搜索全部标签…"
                className="w-full bg-transparent px-1 py-1 text-[11px] text-ink outline-none placeholder:text-ink-4"
              />
              <div className="mt-1 max-h-44 overflow-y-auto">
                {visibleTags.length === 0 ? (
                  <p className="px-1 py-2 text-center text-[11px] text-ink-4">没有匹配的标签</p>
                ) : (
                  visibleTags.map(({ tag, count }) => {
                    const on = hasTag(tagFilters, tag);
                    return (
                      <div
                        key={tag}
                        className={cn(
                          'group/tagrow flex items-center gap-0.5 rounded-md pr-0.5 transition-colors',
                          on ? 'bg-accent-dim' : 'hover:bg-surface-2',
                        )}
                      >
                        <button
                          onClick={() => toggleTagFilter(tag)}
                          title={on ? `取消筛选 #${tag}` : `只看 #${tag}`}
                          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px]"
                        >
                          <span className={cn(
                            'flex size-3 shrink-0 items-center justify-center rounded-[3px] border',
                            on ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong',
                          )}>
                            {on && <span className="text-[8px] leading-none">✓</span>}
                          </span>
                          <span className={cn('min-w-0 flex-1 truncate', on ? 'text-accent' : 'text-ink-2')}>{tag}</span>
                          <span className="shrink-0 font-mono text-[10px] text-ink-4">{count}</span>
                        </button>
                        <TagRowMenu items={tagOps.menu(tag)} title={`管理标签「${tag}」`} />
                      </div>
                    );
                  })
                )}
              </div>
              {tagFilters.length > 0 && (
                <button
                  onClick={() => setTagFilters([])}
                  className="mt-1 w-full rounded-md px-1.5 py-1 text-[11px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
                >
                  清除标签筛选
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {!hasNotes ? (
            <EmptyState
              icon={<NotebookPen />}
              title="还没有随手记"
              desc="从收件箱分诊，或直接新建"
              action={<Button size="sm" variant="secondary" onClick={() => void openNote(0)}>写第一条</Button>}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<SearchX />}
              title="没有找到相关随手记"
              desc={tagFilters.length > 1 ? '选中的标签需要同时满足，可以去掉几个再试' : '换个关键词，或者清掉当前筛选'}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {search.trim() && (
                    <Button size="sm" variant="secondary" onClick={() => setSearch('')}>清除搜索</Button>
                  )}
                  {tagFilters.length > 0 && (
                    <Button size="sm" variant="secondary" onClick={() => setTagFilters([])}>清除标签筛选</Button>
                  )}
                </div>
              }
            />
          ) : (
            filtered.map((n) => (
              <NoteRow key={n.id} note={n} active={n.id === activeId} onClick={() => void openNote(n.id)} onDelete={() => { void (async () => { if (n.id === activeId) await flushRef.current?.(); await deleteMut.mutateAsync(n.id); })().catch((error) => toast.error(error.message)); }} onArchive={() => { void (async () => { if (n.id === activeId) await flushRef.current?.(); await archiveNoteMut.mutateAsync(n.id); })().catch((error) => toast.error(error.message)); }} archiving={archiveNoteMut.isPending} />
            ))
          )}
        </div>
        {/* 标签重命名 / 合并 / 删除的确认弹窗（portal 渲染，位置只影响代码可读性） */}
        {tagOps.dialog}
      </aside>

      {/* 编辑器 */}
      <main className={cn('min-h-0 min-w-0 flex-1', !editorOpen && 'hidden lg:block')}>
        {editorNote ? (
          <NoteDocument
            key={editorKey}
            note={editorNote}
            allTags={allTagNames}
            tagCounts={tagCounts}
            recentTags={recentTags}
            onTagUsed={pushRecentTag}
            onRegisterFlush={registerFlush}
            onClose={() => void openNote(null)}
            onDelete={active ? () => deleteMut.mutateAsync(active.id) : undefined}
            // 只更新高亮，不换 key：换 key 会重挂编辑器、丢光标
            onCreated={(id) => { setActiveId(id); setCreatingId(id); }}
          />
        ) : (
          <EmptyState
            icon={<PenLine />}
            title={hasNotes ? '选择左侧随手记开始编辑' : '想法先放在这里'}
            desc="支持 Markdown 书写；碎片可以一键整理到随手记"
            className="card h-full"
          />
        )}
      </main>
    </div>
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex max-w-[9rem] items-center gap-1 rounded-full border border-accent/40 bg-accent-dim px-1.5 py-px text-[10px] text-accent">
      <span className="truncate">{label}</span>
      <button onClick={onClear} title="清除这一项" className="shrink-0 opacity-60 transition-opacity hover:opacity-100">×</button>
    </span>
  );
}

function NoteRow({ note, active, onClick, onDelete, onArchive, archiving }: {
  note: Note; active: boolean; onClick: () => void; onDelete: () => void; onArchive: () => void; archiving?: boolean;
}) {
  const images = countImages(note.content);
  const extraTags = note.tags.length - 3;
  return (
    <div
      onClick={onClick}
      className={cn(
        'group mb-1 cursor-pointer rounded-lg border border-transparent px-3 py-2.5 transition-colors',
        active ? 'border-line bg-surface-2' : 'hover:bg-surface-1',
      )}
    >
      <div className="flex items-start justify-between gap-1.5">
        <p className={cn('flex min-w-0 flex-1 items-center gap-1 text-sm', !note.title && 'text-ink-4')}>
          {note.pinned === 1 && (
            <span className="shrink-0 text-accent" title="已置顶">
              <Pin className="size-3 fill-current" />
            </span>
          )}
          <span className="truncate">{note.title || '(无标题)'}</span>
        </p>
        <button disabled={archiving} aria-label={`将${note.title || '无标题笔记'}纳入知识库`} onClick={(e) => { e.stopPropagation(); onArchive(); }} title="纳入知识库" className="shrink-0 rounded px-1 text-[10px] text-ink-4 opacity-40 transition-all hover:text-accent hover:opacity-100 group-hover:opacity-100">入库</button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="shrink-0 rounded p-0.5 text-ink-4 opacity-40 transition-all hover:text-danger hover:opacity-100 group-hover:opacity-100"
          title="删除"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {note.content && <p className="mt-0.5 truncate text-xs text-ink-4">{markdownSummary(note.content, 60)}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] text-ink-4">{relTime(note.updated_at)}</span>
        {images > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-4" title={`含 ${images} 张图片`}>
            <ImageIcon className="size-3" />
            {images}
          </span>
        )}
        {note.source_fragment_id != null && (
          <span className="inline-flex items-center gap-0.5 rounded-full bg-accent-dim px-1.5 py-px text-[10px] text-accent" title="来自助手分诊">
            <Sparkles className="size-2.5" />
            助手
          </span>
        )}
        {note.tags.slice(0, 3).map((t) => (
          <span key={t} className="rounded-full bg-surface-2 px-1.5 py-px text-[10px] text-ink-3">#{t}</span>
        ))}
        {extraTags > 0 && <span className="text-[10px] text-ink-4">+{extraTags}</span>}
      </div>
    </div>
  );
}
