/**
 * [INPUT]: 资料分页/搜索/版本/标签筛选、导入、导出与失败恢复 API；复用 KnowledgeDocument 与标签池管理
 * [OUTPUT]: 原知识存档式左列表右文档资料工作区，当前正文统一自动保存
 * [POS]: 知识库默认入口；低频生命周期操作与统一标签池管理收纳，阅读编辑占据主工作区
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus2, FileText, FileWarning, Inbox, Loader2, MoreHorizontal, Search, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import type { KnowledgePoolDocument } from '@/types';
import { cn, relTime } from '@/lib/utils';
import { markdownSummary, stripHtmlNoise } from '@/lib/markdown';
import { Button } from '@/ui/button';
import { Input } from '@/ui/form';
import { EmptyState } from '@/ui/primitives';
import { MenuButton } from '@/ui/menu';
import { KnowledgeBatchPanel, KnowledgeImportDialog } from '@/components/KnowledgeLifecyclePanels';
import { TagPoolManagerDialog } from '@/components/TagPoolManager';
import { KnowledgeDocument } from '@/components/document/KnowledgeDocument';

type PoolFilter = 'all' | 'failed' | 'untopic';
const STATUS: Record<string, string> = { fetched: '正文可用', suspect: '可能不完整', failed: '抓取失败', pending: '待补正文' };

export function KnowledgePoolView() {
  const [params, setParams] = useSearchParams();
  const activeKey = params.get('doc') ?? '';
  const versionId = Number(params.get('version')) || null;
  const [filter, setFilter] = useState<PoolFilter>('all');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [topicId, setTopicId] = useState<number>();
  const [tag, setTag] = useState('');
  const [offset, setOffset] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [showBatches, setShowBatches] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const pool = useQuery({ queryKey: [...qk.knowledgePool(filter), query, offset, provider, topicId, tag], queryFn: () => api.knowledgePool(filter, query, offset, provider, topicId, tag || undefined) });
  const topics = useQuery({ queryKey: qk.knowledgeTopics, queryFn: api.topicList });
  const tagPool = useQuery({ queryKey: qk.tags, queryFn: api.tagList });
  const search = useQuery({ queryKey: ['knowledge', 'search', query], queryFn: () => api.knowledgeSearch(query), enabled: query.trim().length > 0 });
  const detail = useQuery({ queryKey: qk.knowledgeDocument(activeKey), queryFn: () => api.knowledgeDocument(activeKey), enabled: !!activeKey });
  const versions = useQuery({ queryKey: ['knowledge', 'versions', activeKey], queryFn: () => api.knowledgeDocumentVersions(activeKey), enabled: !!activeKey });
  const historic = useQuery({ queryKey: ['knowledge', 'versions', activeKey, versionId], queryFn: () => api.knowledgeDocumentVersion(activeKey, versionId!), enabled: !!activeKey && versionId != null });
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['knowledge', 'pool'] }); void qc.invalidateQueries({ queryKey: qk.knowledgeTopics }); };
  const open = (key: string, version?: number, from?: number, to?: number) => {
    if (key !== activeKey) setShowVersions(false);
    const next = new URLSearchParams(params); next.set('doc', key);
    if (version) next.set('version', String(version)); else next.delete('version');
    if (from != null) next.set('from', String(from)); else next.delete('from');
    if (to != null) next.set('to', String(to)); else next.delete('to');
    setParams(next);
  };
  const close = () => { const next = new URLSearchParams(params); next.delete('doc'); next.delete('version'); next.delete('from'); next.delete('to'); setParams(next); };
  const create = useMutation({ mutationFn: () => api.knowledgeManualCreate('未命名文档', ''), onSuccess: ({ document }) => { invalidate(); open(document.source_key); }, onError: (error: Error) => toast.error(error.message) });
  const localImport = useMutation({ mutationFn: async (files: File[]) => Promise.all(files.map(async (file) => {
    if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error(`${file.name} 不是 TXT 或 Markdown 文件`);
    return api.knowledgeManualCreate(file.name.replace(/\.(md|markdown|txt)$/i, ''), await file.text(), 'other');
  })), onSuccess: (rows) => { invalidate(); if (rows[0]) open(rows[0].document.source_key); toast.success(`已导入 ${rows.length} 份资料`); }, onError: (error: Error) => toast.error(error.message) });
  const retryAll = useMutation({ mutationFn: api.knowledgeRetryFailed, onSuccess: ({ results }) => { invalidate(); toast.success(`已完成 ${results.length} 份资料的重试`); }, onError: (error: Error) => toast.error(error.message) });
  const summary = pool.data?.summary;
  const activeSummary = pool.data?.documents.find((item) => item.source_key === activeKey);
  const selectedVersion = historic.data?.version;
  const content = selectedVersion?.content ?? detail.data?.document.content ?? '';
  const from = Math.max(0, Number(params.get('from')) || 0); const to = Math.max(from, Number(params.get('to')) || 0);

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="mb-3 flex shrink-0 items-center gap-2">
      <Button onClick={() => create.mutate()} disabled={create.isPending}><FilePlus2 />新建资料</Button>
      <Button variant="secondary" onClick={() => setImportOpen(true)}><Upload />接入云文档</Button>
      <input ref={fileRef} className="hidden" type="file" multiple accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={(event) => { const files = [...(event.target.files ?? [])]; if (files.length) localImport.mutate(files); event.target.value = ''; }} />
      <MenuButton title="资料库操作" items={[
        { key: 'files', label: '导入本地文件', onSelect: () => fileRef.current?.click() },
        { key: 'batches', label: showBatches ? '收起导入批次' : '查看导入批次', onSelect: () => setShowBatches((value) => !value) },
        { key: 'tags', label: '标签池管理', onSelect: () => setTagsOpen(true) },
        { key: 'markdown', label: '导出 Markdown', onSelect: () => void api.knowledgeExport('markdown').catch((e: Error) => toast.error(e.message)) },
        { key: 'json', label: '导出 JSON', onSelect: () => void api.knowledgeExport('json').catch((e: Error) => toast.error(e.message)) },
        ...(summary?.failed ? [{ key: 'retry', label: `重试失败资料 (${summary.failed})`, onSelect: () => retryAll.mutate() }] : []),
      ]} className="rounded-lg border border-line p-2 text-ink-3 hover:bg-surface-2"><MoreHorizontal className="size-4" /></MenuButton>
    </div>
    {showBatches && <div className="mb-3 max-h-64 shrink-0 overflow-y-auto"><KnowledgeBatchPanel /></div>}
    <div className="flex min-h-0 flex-1 gap-4">
      <aside className={cn('card flex w-[340px] max-w-[calc(100vw-2rem)] shrink-0 flex-col', activeKey && 'hidden lg:flex')}>
        <div className="space-y-2 border-b border-line p-3">
          <div className="relative"><Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-4" /><Input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder="搜索标题或正文…" className="h-8 pl-8 text-xs" /></div>
          <div className="flex flex-wrap gap-1">{([['all', `全部 ${summary?.total ?? ''}`], ['failed', `失败 ${summary?.failed ?? ''}`], ['untopic', `未归主题 ${summary?.untopic ?? ''}`]] as const).map(([key, label]) => <button key={key} onClick={() => { setFilter(key); setOffset(0); }} className={cn('rounded-full px-2 py-1 text-[11px]', filter === key ? 'bg-accent-dim text-accent' : 'text-ink-3 hover:bg-surface-2')}>{label}</button>)}</div>
          {/* 来源 / 主题 / 标签三个筛选同一行（cm 2026-09-14） */}
          <div className="flex gap-1.5">
            <select value={provider} onChange={(event) => { setProvider(event.target.value); setOffset(0); }} className="min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 py-1 text-xs" title="来源"><option value="">全部来源</option><option value="feishu">飞书</option><option value="dingtalk">钉钉</option><option value="local">本地/存档</option></select>
            <select value={topicId ?? ''} onChange={(event) => { setTopicId(event.target.value ? Number(event.target.value) : undefined); setOffset(0); }} className="min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 py-1 text-xs" title="主题"><option value="">全部主题</option>{topics.data?.topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select>
            <select value={tag} onChange={(event) => { setTag(event.target.value); setOffset(0); }} className="min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 py-1 text-xs" title="标签"><option value="">全部标签</option>{tagPool.data?.tags.map((item) => <option key={item.name} value={item.name}>#{item.name}（{item.document_count}）</option>)}</select>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {query.trim() && search.data?.results.map((hit) => <button key={`${hit.version_id}-${hit.chunk_index}`} onClick={() => open(hit.document_key, hit.version_id, hit.anchor_from, hit.anchor_to)} className="mb-1 w-full rounded-lg bg-primary/5 px-3 py-2 text-left"><p className="truncate text-xs font-medium text-primary">{hit.title} · 版本 {hit.version_no}</p><p className="mt-1 line-clamp-2 text-[11px] text-ink-3">{hit.snippet}</p></button>)}
          {pool.isLoading && <p className="py-10 text-center text-xs text-ink-3"><Loader2 className="mr-1 inline size-3 animate-spin" />加载中…</p>}
          {pool.isError && <EmptyState icon={<FileWarning />} title="资料加载失败" />}
          {pool.data?.documents.map((doc) => <PoolRow key={doc.source_key} doc={doc} active={doc.source_key === activeKey} onOpen={() => open(doc.source_key)} />)}
          {pool.data?.documents.length === 0 && <EmptyState icon={<Inbox />} title="还没有资料" desc="新建、导入文件或接入云文档后会出现在这里" />}
        </div>
        {pool.data && pool.data.page.total > pool.data.page.limit && <div className="flex items-center justify-between border-t border-line p-2"><Button size="sm" variant="ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</Button><span className="text-[10px] text-ink-4">{offset + 1}–{Math.min(offset + 50, pool.data.page.total)}</span><Button size="sm" variant="ghost" disabled={offset + 50 >= pool.data.page.total} onClick={() => setOffset(offset + 50)}>下一页</Button></div>}
      </aside>
      <main className={cn('min-w-0 flex-1', !activeKey && 'hidden lg:block')}>
        {detail.isLoading || (versionId && historic.isLoading) ? <div className="card flex h-full items-center justify-center text-xs text-ink-3"><Loader2 className="mr-2 size-4 animate-spin" />正在读取文档…</div>
          : versionId && (historic.isError || !historic.data?.version) ? <div className="card flex h-full flex-col items-center justify-center gap-3 text-sm text-danger"><p>历史版本读取失败。</p><Button variant="secondary" onClick={() => open(activeKey)}>返回当前版本</Button></div>
          : detail.data ? <div className="flex h-full min-h-0 flex-col">
            {showVersions && !!versions.data?.versions.length && <div className="mb-2 flex shrink-0 items-center gap-1 overflow-x-auto text-xs"><button onClick={() => open(activeKey)} className={cn('rounded-full border px-2.5 py-1', !versionId ? 'border-primary text-primary' : 'border-line text-ink-3')}>当前</button>{versions.data.versions.map((version) => <button key={version.id} onClick={() => open(activeKey, version.id)} className={cn('shrink-0 rounded-full border px-2.5 py-1', version.id === versionId ? 'border-primary text-primary' : 'border-line text-ink-3')}>版本 {version.version_no}</button>)}</div>}
            {to > from && content && <div className="mb-2 shrink-0 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs"><span className="mr-2 text-primary">搜索命中</span>{content.slice(from, to)}</div>}
            <div className="min-h-0 flex-1"><KnowledgeDocument key={`${activeKey}:${versionId ?? 'current'}`} document={{ ...detail.data.document, derived_from: activeSummary?.derived_from ?? detail.data.document.derived_from ?? versions.data?.current?.derived_from }} topicNames={activeSummary?.topic_names} version={selectedVersion} onClose={close} onVersionHistory={() => setShowVersions((value) => !value)} /></div>
          </div> : activeSummary ? <div className="card flex h-full items-center justify-center text-xs text-danger">资料读取失败，请重试</div>
            : <EmptyState icon={<FileText />} title="选择一份资料" desc="在右侧阅读、编辑正文，或叫来助手一起处理" className="card h-full" />}
      </main>
    </div>
    <KnowledgeImportDialog open={importOpen} onOpenChange={setImportOpen} onStarted={() => { void qc.invalidateQueries({ queryKey: ['knowledge', 'batches'] }); setShowBatches(true); }} />
    <TagPoolManagerDialog open={tagsOpen} onOpenChange={setTagsOpen} />
  </div>;
}

function PoolRow({ doc, active, onOpen }: { doc: KnowledgePoolDocument; active: boolean; onOpen: () => void }) {
  const source = { feishu: '飞书', dingtalk: '钉钉', local: '本地' }[doc.provider] ?? doc.provider;
  const summary = markdownSummary(stripHtmlNoise(doc.content_preview ?? ''));
  return <button onClick={onOpen} className={cn('mb-1 w-full rounded-lg border px-3 py-2.5 text-left transition-colors', active ? 'border-accent/35 bg-accent-dim' : 'border-transparent hover:bg-surface-2')}>
    <div className="flex items-start gap-2"><FileText className={cn('mt-0.5 size-4 shrink-0', doc.body_status === 'failed' ? 'text-danger' : 'text-accent')} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{doc.title || '未命名文档'}</p><p className="mt-1 line-clamp-2 text-xs text-ink-3">{summary || doc.fetch_error || '空文档'}</p><p className="mt-1.5 truncate text-[10px] text-ink-4">{source} · {STATUS[doc.body_status] ?? doc.body_status} · {doc.topic_names || '未归主题'} · {relTime(doc.updated_at)}</p></div></div>
  </button>;
}
