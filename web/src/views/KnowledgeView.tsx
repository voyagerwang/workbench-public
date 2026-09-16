/**
 * [INPUT]: 知识存档与连接器 API、共享 ArchiveDocument、资料/主题子路由
 * [OUTPUT]: KnowledgeLayout 与知识存档兼容工作区，目录保留专属阅读与接入能力
 * [POS]: 知识库导航和旧存档入口；普通正文依赖共享文档模块，选中路由受保存守卫保护
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Archive, CloudDownload, CopyPlus, ExternalLink, FileText, FolderInput, Image as ImageIcon, Link2, Loader2, Lock, MoreHorizontal, PlugZap, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import type { KnowledgeArchive, KnowledgeProvider, KnowledgeSyncJob, KnowledgeSyncScope } from '@/types';
import { SectionTabs } from '@/components/SectionTabs';
import { cn, relTime } from '@/lib/utils';
import { useAssistantName } from '@/lib/assistant-name';
import { notifyDeleted } from '@/lib/trash';
import { DocumentEditor } from '@/components/DocumentEditor';
import { countImages, markdownSummary, stripHtmlNoise } from '@/lib/markdown';
import { Button } from '@/ui/button';
import { Field, Input } from '@/ui/form';
import { EmptyState } from '@/ui/primitives';
import { Dialog, DialogContent } from '@/ui/dialog';
import { FeishuScopePicker as SharedFeishuScopePicker } from '@/components/KnowledgeScopePicker';
import { ArchiveDocument } from '@/components/document/ArchiveDocument';

// 提示词与 Skill 已迁到 /ai-resources（它们是工具资产，不是业务知识）；
// 阶段 1.5 反转：资料池是默认页（真相源），主题第二，存档降位为「存档导入」。
const TABS = [
  { to: '/knowledge/pool', label: '资料' },
  { to: '/knowledge/topics', label: '主题' },
];

/**
 * 目录存档的状态文案。
 *
 * 「仅标题可检索」不能写死：一旦真的存了正文，它就和「X 篇正文可检索」自相矛盾。
 * 分档依据是「此刻真正搜得到的篇数」= 检索通道可用 ? 已保存正文篇数 : 0 ——
 * 「存了几篇」和「现在能不能搜」是两件事，服务没起来时正文在盘上也搜不到，必须分开说。
 */
function catalogLabels(catalog: { total: number; saved_bodies: number; search_available: boolean }) {
  const reachable = catalog.search_available ? catalog.saved_bodies : 0;
  return {
    /** 仅标题可检索 / 部分正文可检索 / 正文已就绪 */
    state: reachable === 0 ? '仅标题可检索' : reachable < catalog.total ? '部分正文可检索' : '正文已就绪',
    offline: !catalog.search_available,
    reachable,
  };
}

export function KnowledgeLayout() {
  const { pathname } = useLocation();
  // 知识存档是「左列表 + 右正文」的工作区形态，吃掉 AppShell 的四周留白、撑满视口；
  // 提示词 / Skill 是随页面滚动的卡片网格，留白撤掉会顶到屏幕边，仍走常规内边距。
  const fullBleed = pathname.startsWith('/knowledge/archives') || pathname.startsWith('/knowledge/pool');
  return <div className={cn(fullBleed && '-mx-4 -my-6 flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col md:-mx-8 md:-my-8 md:h-[100vh]')}>
    <div className={cn('mb-5 flex flex-wrap items-center gap-3', fullBleed && 'mb-0 shrink-0 px-4 pt-4 md:px-6 md:pt-5')}><h1 className="text-2xl font-semibold tracking-tight">知识库</h1><SectionTabs items={TABS} /></div>
    <div className={cn(fullBleed && 'flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3 md:px-6 md:pb-5')}>
      <Outlet />
    </div>
  </div>;
}

export function KnowledgeArchivesView() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const folderRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [url, setUrl] = useState('');
  const [syncOpen, setSyncOpen] = useState(false);
  // 选中文档使用路由状态，切换时由共用保存守卫先排空当前编辑。
  const [params, setParams] = useSearchParams();
  const activeId = Number(params.get('archive')) || null;
  const setActiveId = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('archive', String(id)); else next.delete('archive');
    setParams(next);
  };
  const { data: archives = [], isPending } = useQuery({ queryKey: qk.knowledge, queryFn: () => api.knowledgeArchives() });
  const petName = useAssistantName();
  const activeSummary = archives.find((item) => item.id === activeId) ?? null;
  const { data: active } = useQuery({
    queryKey: [...qk.knowledge, activeId],
    queryFn: () => api.knowledgeArchive(activeId!),
    enabled: Boolean(activeId),
  });
  const filtered = archives.filter((item) => `${item.title} ${item.content} ${item.source_url ?? ''} ${item.file_name ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const confirmRemove = (item: KnowledgeArchive) => {
    if (window.confirm(`确定删除「${item.title}」吗？删掉会先进回收站，30 天内可恢复。`)) remove.mutate(item.id);
  };

  const create = useMutation({ mutationFn: () => api.createKnowledgeArchive({ title: '未命名文档', source_kind: 'manual' }), onSuccess: (item) => { qc.invalidateQueries({ queryKey: qk.knowledge }); setActiveId(item.id); } });
  const importUrl = useMutation({
    mutationFn: () => api.importKnowledgeUrl(url.trim()),
    onSuccess: (item) => { qc.invalidateQueries({ queryKey: qk.knowledge }); setActiveId(item.id); setUrl(''); if (item.status === 'indexed') toast.success('已导入'); else toast.warning('已记录，待授权'); },
    onError: (error) => toast.error((error as Error).message),
  });
  const importFiles = useMutation({
    mutationFn: api.importKnowledgeFiles,
    onSuccess: (result) => { qc.invalidateQueries({ queryKey: qk.knowledge }); setActiveId(result.items[0]?.id ?? null); toast.success(`已导入 ${result.imported} 个文档`); },
    onError: (error) => toast.error((error as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteKnowledgeArchive(id),
    onSuccess: (_result, id) => {
      setActiveId(null);
      notifyDeleted(qc, 'knowledge', id, archives.find((item) => item.id === id)?.title);
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const chooseFolder = async (list: FileList | null) => {
    const files = [...(list ?? [])];
    const textFiles = files.filter((file) => /\.(md|mdx|txt|text|csv|tsv|json|ya?ml|html?|xml|rtf|js|jsx|ts|tsx|css|sql)$/i.test(file.name));
    if (!textFiles.length) { toast.error('没有可读取的文件'); return; }
    const payload = await Promise.all(textFiles.slice(0, 300).map(async (file) => ({ path: file.webkitRelativePath || file.name, content: await file.text() })));
    importFiles.mutate(payload);
    if (folderRef.current) folderRef.current.value = '';
  };

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="card mb-4 flex shrink-0 flex-wrap items-center gap-2 p-3">
      <div className="relative min-w-48 flex-1"><Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-4" /><Input value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && url.trim() && importUrl.mutate()} placeholder="粘贴飞书、钉钉或公开文档地址…" className="pl-9" /></div>
      <Button variant="secondary" onClick={() => importUrl.mutate()} disabled={!url.trim() || importUrl.isPending}>{importUrl.isPending ? <Loader2 className="animate-spin" /> : <Link2 />}导入链接</Button>
      <input ref={folderRef} type="file" multiple className="hidden" onChange={(event) => void chooseFolder(event.target.files)} {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} />
      <Button onClick={() => create.mutate()}><Plus />新建文档</Button>
      <MoreMenu items={[
        { label: '同步知识空间', icon: <CloudDownload />, onClick: () => setSyncOpen(true) },
        { label: '导入文件夹', icon: <FolderInput />, onClick: () => folderRef.current?.click() },
        { label: '文档权限', icon: <ShieldCheck />, onClick: () => navigate('/settings#document-access') },
      ]} />
    </div>
    <SyncSpaceDialog
      open={syncOpen}
      onOpenChange={setSyncOpen}
      onDone={() => qc.invalidateQueries({ queryKey: qk.knowledge })}
    />
    <div className="flex min-h-0 flex-1 gap-4">
        <aside className={cn('card flex w-[340px] max-w-[calc(100vw-2rem)] shrink-0 flex-col', activeSummary && 'hidden lg:flex')}>
        <div className="border-b border-line p-3"><div className="relative"><Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-4" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、正文或来源…" className="h-8 pl-8 text-xs" /></div><p className="mt-2 text-[10px] text-ink-4">{isPending ? '正在载入…' : `${archives.length} 份知识存档 · 只有本地已保存的正文才参与检索 · 目录导入与管理；阅读/归纳/重试请用资料池`}</p></div>
        <div className="flex-1 overflow-y-auto p-2">{filtered.length ? filtered.map((item) => <ArchiveRow key={item.id} item={item} active={item.id === activeId} onClick={() => setActiveId(item.id)} />) : <EmptyState icon={<Archive />} title="还没有知识存档" desc="可从公开链接、本地文件夹或「云端拉取」导入；也可以直接让助手「搜一下我的飞书知识库」自动读取" />}</div>
      </aside>
      <main className={cn('min-w-0 flex-1', !activeSummary && 'hidden lg:block')}>{active ? (active.is_catalog
        ? <CatalogViewer key={active.id} item={active} onClose={() => setActiveId(null)} onDelete={() => confirmRemove(active)} onCopied={setActiveId} />
        : <ArchiveEditor key={active.id} item={active} onClose={() => setActiveId(null)} onDelete={() => confirmRemove(active)} />) : activeSummary ? <div className="card flex h-full items-center justify-center text-xs text-ink-3"><Loader2 className="mr-2 size-4 animate-spin text-accent" />正在读取完整文档…</div> : <EmptyState icon={<FileText />} title="选择一份知识存档" desc={`可以查看来源、编辑正文，${petName}对话时也能检索这些内容`} className="card h-full" />}</main>
    </div>
  </div>;
}

function ArchiveRow({ item, active, onClick }: { item: KnowledgeArchive; active: boolean; onClick: () => void }) {
  const source = { manual: '手动', feishu: '飞书', dingtalk: '钉钉', url: '网页', folder: '文件夹', conversation: '对话' }[item.source_kind];
  // 目录存档混在普通文档里标「已索引」，用户会以为两千多篇正文都能搜到 —— 这里必须区分开
  const statusLabel = item.is_catalog
    ? '目录'
    : { indexed: '已索引', needs_auth: '需要授权', failed: '导入失败', remote: '云端索引' }[item.status];
  const catalogNote = item.is_catalog && item.catalog
    ? `${item.catalog.total} 篇目录 · ${catalogLabels(item.catalog).state}${catalogLabels(item.catalog).offline ? ' · 检索服务未启动' : ''}`
    : null;
  // 摘要先剥掉 HTML 残留与 Markdown 标记，列表里看到的应该是句子而不是 `# 标题` 这种源码
  const body = stripHtmlNoise(item.content);
  const summary = markdownSummary(body);
  // 列表正文只取前 800 字符，图片数会偏小，所以这里只做「含图片」标记而不显示数量
  const hasImage = countImages(body) > 0;
  return <button onClick={onClick} className={cn('mb-1 w-full rounded-lg border px-3 py-2.5 text-left transition-colors', active ? 'border-accent/35 bg-accent-dim' : 'border-transparent hover:bg-surface-2')}>
    <div className="flex items-start gap-2"><FileText className={cn('mt-0.5 size-4 shrink-0', item.is_catalog || item.status === 'failed' || item.status === 'needs_auth' ? 'text-warn' : 'text-accent')} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.title || '未命名文档'}</p><p className="mt-1 line-clamp-2 text-xs text-ink-3">{catalogNote ?? (summary || item.error || (item.status === 'remote' ? '云端索引 · 打开时实时读取' : '空文档'))}</p><p className="mt-1.5 flex items-center gap-1.5 text-[10px] text-ink-4"><span className="truncate">{source} · {statusLabel} · {relTime(item.updated_at)}</span>{hasImage && <span className="flex shrink-0 items-center text-ink-3" title="文档内含图片"><ImageIcon className="size-3" /></span>}</p></div></div>
  </button>;
}

/**
 * 目录存档的只读视图。
 *
 * 以前它和普通文档共用编辑器，标题正文都能改。但正文头部的「共 N 篇文档」是篇数解析的唯一依据，
 * 改一个字篇数就算错；而且下次同步会整体覆盖，改了也白改，属于典型的「能操作但没意义」。
 * 真要留一份能编辑的，走「转为普通文档副本」—— 服务端也同步挡住了目录的 PATCH，双保险。
 */
function CatalogViewer({ item, onClose, onDelete, onCopied }: {
  item: KnowledgeArchive;
  onClose: () => void;
  onDelete: () => void;
  onCopied: (id: number) => void;
}) {
  const qc = useQueryClient();
  const copy = useMutation({
    mutationFn: () => api.copyArchiveAsNote(item.id),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: qk.knowledge });
      toast.success('已复制为普通文档，可以随意编辑');
      onCopied(created.id);
    },
    onError: (error) => toast.error(`复制失败：${(error as Error).message}`),
  });
  const label = item.catalog ? catalogLabels(item.catalog) : null;
  return <div className="card relative flex h-full flex-col overflow-hidden">
    <div className="flex items-center gap-2 border-b border-line px-4 py-3"><p className="min-w-0 flex-1 truncate text-lg font-semibold">{item.title || '未命名目录'}</p><Button size="sm" onClick={() => copy.mutate()} disabled={copy.isPending}>{copy.isPending ? <Loader2 className="animate-spin" /> : <CopyPlus />}转为普通文档副本</Button><Button variant="dangerGhost" size="icon" onClick={onDelete}><Trash2 /></Button><Button variant="ghost" size="icon" className="lg:hidden" onClick={onClose}>×</Button></div>
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-[10px] text-ink-3">{item.catalog && label && <><span className={cn('rounded-full px-2 py-0.5', label.reachable === 0 ? 'bg-warn/10 text-warn' : 'bg-accent-dim text-accent')}>目录清单 · {label.state}</span><span>{item.catalog.total} 篇目录 · 已保存正文 {item.catalog.saved_bodies} 篇{label.offline ? ' · 检索服务未启动' : ''}</span></>}<span>{relTime(item.updated_at)}同步</span></div>
    <div className="flex items-start gap-2 border-b border-warn/20 bg-warn/10 px-4 py-2 text-xs text-ink-2"><Lock className="mt-0.5 size-3.5 shrink-0 text-warn" /><span className="min-w-0 break-words">这是同步生成的目录清单，只读。改动不会被保存，下次同步也会整体覆盖；需要编辑请先「转为普通文档副本」。</span></div>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full px-4 py-5">
        <DocumentEditor value={stripHtmlNoise(item.content)} editable={false} className="min-h-[260px]" />
      </div>
    </div>
  </div>;
}

/** 编辑态：与清单详情同一套所见即所得编辑器，正文仍以 Markdown 落库，自动保存 */
function ArchiveEditor({ item, onClose, onDelete }: { item: KnowledgeArchive; onClose: () => void; onDelete: () => void }) {
  if (item.status === 'remote') return <RemoteViewer item={item} onClose={onClose} onDelete={onDelete} />;
  return <ArchiveDocument item={item} onClose={onClose} onDelete={onDelete}
    authorization={item.status === 'needs_auth' && (item.source_kind === 'feishu' || item.source_kind === 'dingtalk') ? <DocumentAuthorization item={item} /> : undefined} />;
}

/** 云端索引条目：不存本地，打开时按权限实时去云端读；想留底可一键导入全文 */
function RemoteViewer({ item, onClose, onDelete }: { item: KnowledgeArchive; onClose: () => void; onDelete: () => void }) {
  const qc = useQueryClient();
  const live = useQuery({
    queryKey: ['archive-remote', item.id],
    queryFn: () => api.fetchArchiveRemote(item.id),
    staleTime: 60_000,
    retry: false,
  });
  const importFull = useMutation({
    mutationFn: async () => {
      const fetched = live.data ?? await api.fetchArchiveRemote(item.id);
      return api.updateKnowledgeArchive(item.id, { title: fetched.title || item.title, content: fetched.content });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.knowledge });
      toast.success('已导入全文');
    },
    onError: (error) => toast.error('导入失败', { description: (error as Error).message }),
  });
  return <div className="card flex h-full flex-col overflow-hidden">
    <div className="flex items-center gap-2 border-b border-line px-4 py-3">
      <p className="min-w-0 flex-1 truncate text-lg font-semibold">{item.title || '未命名文档'}</p>
      <Button variant="dangerGhost" size="icon" onClick={onDelete}><Trash2 /></Button>
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onClose}>×</Button>
    </div>
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-[10px] text-ink-3">
      <span className="rounded-full bg-accent-dim px-2 py-0.5 text-accent">云端索引 · 不占本地空间</span>
      {item.source_url && <a href={item.source_url} target="_blank" rel="noreferrer" className="max-w-[60%] truncate hover:text-accent">{item.source_url}</a>}
      <span className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => live.refetch()} disabled={live.isFetching}><RefreshCw className={cn(live.isFetching && 'animate-spin')} />重新读取</Button>
      <Button size="sm" variant="secondary" onClick={() => importFull.mutate()} disabled={importFull.isPending || live.isPending}>{importFull.isPending ? <Loader2 className="animate-spin" /> : <CloudDownload />}导入全文</Button>
    </div>
    {live.isPending && <div className="flex flex-1 items-center justify-center text-xs text-ink-3"><Loader2 className="mr-2 size-4 animate-spin text-accent" />正在按你的权限从云端读取全文…</div>}
    {live.isError && <div className="flex items-start gap-2 border-b border-warn/20 bg-warn/10 px-4 py-3 text-xs leading-relaxed text-ink-2"><AlertCircle className="mt-0.5 size-3.5 shrink-0 text-warn" /><span className="min-w-0 break-words">云端读取失败：{(live.error as Error).message}。可以先「重新读取」，或到「设置 → 文档权限」检查连接。</span></div>}
    {live.isSuccess && <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full px-4 py-5">
        <DocumentEditor value={stripHtmlNoise(live.data.content)} editable={false} placeholder="" className="min-h-[260px]" />
      </div>
    </div>}
  </div>;
}

function DocumentAuthorization({ item }: { item: KnowledgeArchive }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const provider = item.source_kind as KnowledgeProvider;
  const label = provider === 'feishu' ? '飞书' : '钉钉';
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const retriedJob = useRef<string | null>(null);
  const { data: connectors, isPending } = useQuery({
    queryKey: qk.knowledgeConnectors,
    queryFn: api.knowledgeConnectors,
  });
  const enabledServers = connectors?.servers.filter((server) => server.enabled) ?? [];
  const suggested = enabledServers.filter((server) => server.suggestedFor === provider);
  const boundServers = connectors?.selections[provider] ?? [];
  const effectiveServer = selected || boundServers[0] || suggested[0]?.name || '';
  const cliAuthorized = connectors?.cli?.[provider]?.authenticated === true;
  const { data: authJob } = useQuery({
    queryKey: ['knowledge', 'authorization', jobId],
    queryFn: () => api.knowledgeAuthorizationJob(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => query.state.data?.status === 'waiting' ? 1000 : false,
  });
  const retry = useMutation({
    mutationFn: (serverName?: string) => api.retryKnowledgeImport(item.id, serverName),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.knowledge });
      setDialogOpen(false);
      toast.success(`${label}文档已读取`);
    },
    onError: (error) => { toast.error((error as Error).message); setDialogOpen(true); },
  });
  const select = useMutation({
    mutationFn: (serverName: string) => api.selectKnowledgeConnector(provider, serverName),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.knowledgeConnectors }),
  });
  const authorize = useMutation({
    mutationFn: (serverName: string) => api.authorizeKnowledgeConnector(provider, serverName),
    onSuccess: (job) => { setJobId(job.id); setDialogOpen(true); },
    onError: (error) => toast.error((error as Error).message),
  });

  useEffect(() => {
    if (authJob?.status !== 'authorized' || retriedJob.current === authJob.id) return;
    retriedJob.current = authJob.id;
    retry.mutate(authJob.serverName);
  }, [authJob]); // eslint-disable-line react-hooks/exhaustive-deps

  const useServer = (serverName: string) => {
    setSelected(serverName);
    select.mutate(serverName);
    retry.mutate(serverName);
  };

  return <>
    <div className="border-b border-line bg-surface-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" />
          <div><p className="text-xs font-medium text-ink">授权后继续导入</p><p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">使用你已连接的 CLI 或 MCP 权限读取私有{label}文档；不需要把链接改为公开。</p></div>
        </div>
        <div className="flex shrink-0 gap-2">
          {(cliAuthorized || effectiveServer) && <Button size="sm" onClick={() => cliAuthorized ? retry.mutate(undefined) : useServer(effectiveServer)} disabled={retry.isPending || isPending}>{retry.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}{cliAuthorized ? '用已授权 CLI 重试' : `用 ${effectiveServer} 重试`}</Button>}
          <Button size="sm" variant={(cliAuthorized || effectiveServer) ? 'secondary' : 'primary'} onClick={() => navigate('/settings#document-access')}><PlugZap />文档权限设置</Button>
        </div>
      </div>
    </div>
    <ConnectorDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      provider={provider}
      servers={enabledServers}
      selected={effectiveServer}
      onSelect={useServer}
      onAuthorize={(serverName) => { setSelected(serverName); select.mutate(serverName); authorize.mutate(serverName); }}
      authorizing={authorize.isPending}
      retrying={retry.isPending}
      job={authJob ?? null}
      onConfigured={(serverName) => {
        setSelected(serverName);
        qc.invalidateQueries({ queryKey: qk.knowledgeConnectors });
        authorize.mutate(serverName);
      }}
    />
  </>;
}

/** 知识空间同步：飞书按范围（空间 / 云文档 / 单篇）或全量建立索引，钉钉粘贴知识库链接 */
function SyncSpaceDialog({ open, onOpenChange, onDone }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [provider, setProvider] = useState<KnowledgeProvider>('feishu');
  const [mode, setMode] = useState<'index' | 'full'>('index');
  const [spaceUrl, setSpaceUrl] = useState('');
  const [scope, setScope] = useState<KnowledgeSyncScope>({ wiki: [], drive: [], docs: [] });
  const [jobId, setJobId] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const selectedCount = (scope.wiki?.length ?? 0) + (scope.drive?.length ?? 0) + (scope.docs?.length ?? 0);

  const start = useMutation({
    // 变量可覆盖输入：钉钉「增量更新」直接沿用上次链接，不依赖 setState 时序
    mutationFn: (override?: { spaceUrl?: string; mode?: 'index' | 'full' }) => api.syncSpace({
      provider,
      spaceUrl: provider === 'dingtalk' ? (override?.spaceUrl ?? spaceUrl.trim()) : undefined,
      mode: override?.mode ?? mode,
      scope: provider === 'feishu' ? scope : undefined,
    }),
    onSuccess: (job) => { setJobId(job.id); setFinished(false); },
    onError: (error) => toast.error('同步启动失败', { description: (error as Error).message }),
  });
  // 失败任务一键重试：沿用上次的渠道/模式/范围，成功后接上进度轮询
  const retry = useMutation({
    mutationFn: (id: string) => api.retrySyncSpace(id),
    onSuccess: (job) => { setJobId(job.id); setFinished(false); toast.success('已开始同步'); },
    onError: (error) => toast.error('重试失败', { description: (error as Error).message }),
  });
  // 删除一条历史记录（失败记录不再留着碍眼；后台任务不受影响）
  const removeJob = useMutation({
    mutationFn: (id: string) => api.deleteSyncSpaceJob(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge-sync-jobs'] }); toast.success('已删除'); },
    onError: (error) => toast.error('删除失败', { description: (error as Error).message }),
  });
  // 历史行的人类可读标题：钉钉空间名拿不到时把裸链接缩成「钉钉知识库 · 空间ID」
  const jobLabel = (item: KnowledgeSyncJob): string => {
    if (item.title) return item.title;
    const match = item.spaceHint?.match(/\/spaces\/([A-Za-z0-9]+)/);
    if (match) return `钉钉知识库 · ${match[1].slice(0, 10)}…`;
    return item.spaceHint ?? '';
  };

  const job = useQuery({
    queryKey: ['knowledge-sync', jobId],
    queryFn: () => api.syncSpaceJob(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false),
  });
  const current = job.data;

  // 弹窗重开时自动接上后台还在跑的同步任务（页面关掉也不影响服务端继续同步）；
  // 只接一次，用户切渠道后不再自动挂回
  const attachedJob = useRef<string | null>(null);
  const recentJobs = useQuery({
    queryKey: ['knowledge-sync-jobs'],
    queryFn: () => api.syncSpaceJobs(),
    enabled: open && !jobId,
  });
  // 钉钉最近一次成功同步的分享链接（增量更新直接沿用）
  const lastDingtalkLink = recentJobs.data?.find((item) => item.provider === 'dingtalk' && item.status === 'done' && /^https?:\/\//i.test(item.spaceHint ?? '')) ?? null;
  const qc = useQueryClient();
  const baseline = useQuery({ queryKey: ['knowledge-baseline'], queryFn: () => api.knowledgeBaseline(), enabled: open });
  const refreshBaseline = useMutation({
    mutationFn: () => api.refreshKnowledgeBaseline(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['knowledge-baseline'] });
      qc.invalidateQueries({ queryKey: qk.knowledge });
    },
  });
  const incrementalBusy = refreshBaseline.isPending || start.isPending;
  // 一键刷新所有云端知识源：飞书快照 + 钉钉上次空间（各自失败互不影响，失败会单独 toast）
  const runIncremental = async () => {
    const tasks: Array<Promise<unknown>> = [
      refreshBaseline.mutateAsync().catch((error: unknown) => toast.error('飞书快照更新失败', { description: (error as Error).message })),
    ];
    if (lastDingtalkLink) {
      tasks.push(start.mutateAsync({ spaceUrl: lastDingtalkLink.spaceHint!, mode: lastDingtalkLink.mode }).catch((error: unknown) => toast.error('钉钉增量更新失败', { description: (error as Error).message })));
    }
    await Promise.allSettled(tasks);
  };
  useEffect(() => {
    if (!open) attachedJob.current = null;
  }, [open]);
  useEffect(() => {
    if (jobId || !open) return;
    const running = recentJobs.data?.find((item) => item.status === 'running');
    if (running && attachedJob.current !== running.id) {
      attachedJob.current = running.id;
      setJobId(running.id);
    }
  }, [recentJobs.data, jobId, open]);

  useEffect(() => {
    if (current?.status === 'done' || current?.status === 'failed') setFinished(true);
  }, [current?.status]);

  const running = Boolean(jobId) && !finished;
  const reset = () => { setJobId(null); setFinished(false); setSpaceUrl(''); setScope({ wiki: [], drive: [], docs: [] }); };
  const switchProvider = (p: KnowledgeProvider) => { setProvider(p); reset(); };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="同步知识空间" className="max-w-xl overflow-hidden">
      <div className="border-b border-line px-5 py-4"><div className="flex items-center gap-2"><CloudDownload className="size-4 text-accent" /><h2 className="text-sm font-semibold">把云端知识库建立索引</h2></div><p className="mt-1 text-xs leading-relaxed text-ink-3">为云端文档建本地索引，助手按索引实时读取原文。</p></div>
      <div className="max-h-[62vh] space-y-4 overflow-y-auto p-5">
        {!jobId && (
          <>
            {/* 增量更新：一行汇总所有云端知识源（飞书快照 + 钉钉上次空间），一个按钮全部刷新 */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line px-3 py-2 text-[11px] text-ink-3">
              <span className="font-medium text-ink">增量更新</span>
              {baseline.data && (
                <span className="flex items-center gap-1">
                  <span className={cn('size-1.5 rounded-full', baseline.data.snapshot.available ? 'bg-green-500' : 'bg-ink-4')} />
                  飞书快照 {baseline.data.snapshot.available ? `${baseline.data.snapshot.docs ?? '—'} 篇 · ${baseline.data.lastSync ? relTime(baseline.data.lastSync.finishedAt ?? '') : '未同步过'}` : '服务未启动'}
                </span>
              )}
              <span className="flex items-center gap-1">
                <span className={cn('size-1.5 rounded-full', lastDingtalkLink ? 'bg-green-500' : 'bg-ink-4')} />
                钉钉{lastDingtalkLink ? ` · 上次 ${relTime(lastDingtalkLink.finishedAt ?? '')}` : ' · 还没同步过'}
              </span>
              <span className="ml-auto" />
              <button
                type="button"
                onClick={() => { void runIncremental(); }}
                disabled={incrementalBusy}
                className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-3 transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
              >{incrementalBusy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}全部刷新</button>
              <span className="text-[10px] text-ink-4">只拉变动，每日也自动更新</span>
            </div>
          </>
        )}

        <div className="flex items-center gap-2">
          {(['feishu', 'dingtalk'] as const).map((p) => (
            <button key={p} type="button" onClick={() => switchProvider(p)}
              className={cn('rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:opacity-40', provider === p ? 'border-accent/40 bg-accent-dim text-ink' : 'border-line text-ink-3 hover:bg-surface-2')}>
              {p === 'feishu' ? '飞书 · 选择范围' : '钉钉 · 粘贴链接'}
            </button>
          ))}
        </div>

        {!jobId && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setMode('index')} className={cn('rounded-lg border px-3 py-1.5 text-xs', mode === 'index' ? 'border-accent/40 bg-accent-dim text-ink' : 'border-line text-ink-3 hover:bg-surface-2')}>只建索引（推荐，不占空间）</button>
              <button type="button" onClick={() => setMode('full')} className={cn('rounded-lg border px-3 py-1.5 text-xs', mode === 'full' ? 'border-accent/40 bg-accent-dim text-ink' : 'border-line text-ink-3 hover:bg-surface-2')}>同时读全文（占用本地空间）</button>
            </div>

            {provider === 'feishu' ? (
              <SharedFeishuScopePicker scope={scope} onChange={setScope} disabled={running} />
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs text-ink-3">粘贴钉钉知识库的分享链接，自动枚举全部文档。</p>
                <Input value={spaceUrl} onChange={(event) => setSpaceUrl(event.target.value)} placeholder="粘贴钉钉知识库分享链接…" className="h-8 text-xs" />
              </div>
            )}

            {recentJobs.data?.filter((item) => item.status !== 'running' && item.provider === provider).slice(0, 2).map((item) => (
              <div key={item.id} className="flex items-start justify-between gap-2 text-[11px] text-ink-4">
                {item.status === 'done'
                  ? <span>上次同步：{jobLabel(item)} · 新增 {item.indexed} 条 · {relTime(item.finishedAt ?? '')}</span>
                  : <span className="flex items-start gap-1 text-warn"><AlertCircle className="mt-0.5 size-3 shrink-0" />上次同步失败（{jobLabel(item)}）：{item.error}</span>}
                {item.status === 'failed' && (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => retry.mutate(item.id)}
                      disabled={retry.isPending}
                      className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-3 transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
                    >重试</button>
                    <button
                      type="button"
                      onClick={() => removeJob.mutate(item.id)}
                      disabled={removeJob.isPending}
                      title="删除这条同步记录"
                      className="rounded-md border border-line p-1 text-ink-4 transition-colors hover:border-warn/40 hover:text-warn disabled:opacity-50"
                    ><Trash2 className="size-3" /></button>
                  </span>
                )}
              </div>
            ))}

            <Button className="w-full" onClick={() => start.mutate()} disabled={start.isPending || (provider === 'feishu' ? selectedCount === 0 : !spaceUrl.trim())}>
              {start.isPending ? <Loader2 className="animate-spin" /> : <CloudDownload />}{provider === 'feishu' ? `开始同步（已选 ${selectedCount} 项）` : '开始同步'}
            </Button>
            <p className="text-[11px] leading-relaxed text-ink-4">再次同步即<b>增量更新</b>，只补新文档、不重复导入。</p>
          </>
        )}

        {current && (
          <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-4">
            {current.status === 'running' && <>
              <div className="flex items-center gap-2 text-xs text-ink-2"><Loader2 className="size-3.5 animate-spin text-accent" />{current.total > 0 ? `正在建索引：${current.indexed} / ${current.total} 份` : '正在枚举知识库文档…'}</div>
              {current.current && <p className="truncate text-[10px] text-ink-4">当前：{current.current}</p>}
              <p className="text-[11px] leading-relaxed text-ink-4">同步在后台进行，<b>关窗不影响</b>；重新打开可查看进度。</p>
            </>}
            {current.status === 'done' && <>
              <p className="text-xs text-ink">同步完成：新增 {current.indexed} 份{current.failed > 0 ? `，失败 ${current.failed} 份` : ''}。</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => { onDone(); onOpenChange(false); }}>完成</Button>
                <Button size="sm" variant="ghost" onClick={reset}>再同步一次</Button>
              </div>
            </>}
            {current.status === 'failed' && <>
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-2"><AlertCircle className="mt-0.5 size-3.5 shrink-0 text-warn" /><span className="break-words">{current.error}</span></p>
              <Button size="sm" variant="ghost" onClick={reset}>重试</Button>
            </>}
          </div>
        )}
      </div>
    </DialogContent>
  </Dialog>;
}

/** 工具栏溢出菜单：把低频操作收进「更多」，保持主工具栏清爽 */
function MoreMenu({ items }: { items: Array<{ label: string; icon: ReactNode; onClick: () => void }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);
  return <div ref={ref} className="relative">
    <Button variant="secondary" onClick={() => setOpen((value) => !value)} aria-label="更多操作"><MoreHorizontal />更多</Button>
    {open && <div className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-xl border border-line bg-surface-1 py-1 shadow-lg">
      {items.map((item) => (
        <button key={item.label} type="button" onClick={() => { setOpen(false); item.onClick(); }}
          className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
          {item.icon}{item.label}
        </button>
      ))}
    </div>}
  </div>;
}

function ConnectorDialog({ open, onOpenChange, provider, servers, selected, onSelect, onAuthorize, onConfigured, authorizing, retrying, job }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: KnowledgeProvider;
  servers: Array<{ name: string; note?: string | null; transport: string; authStatus: string; suggestedFor: KnowledgeProvider | null }>;
  selected: string;
  onSelect: (serverName: string) => void;
  onAuthorize: (serverName: string) => void;
  onConfigured: (serverName: string) => void;
  authorizing: boolean;
  retrying: boolean;
  job: { status: 'waiting' | 'authorized' | 'failed'; authorizationUrl: string | null; error: string | null } | null;
}) {
  const label = provider === 'feishu' ? '飞书' : '钉钉';
  const [serverNote, setServerNote] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [tokenEnv, setTokenEnv] = useState('');
  const [showAllServers, setShowAllServers] = useState(false);
  const matchingServers = servers.filter((server) => server.suggestedFor === provider || server.name === selected);
  const visibleServers = showAllServers ? servers : matchingServers;
  const configure = useMutation({
    // 内部名全自动生成，用户只填「这是干什么的」；重名后台会自动加后缀
    mutationFn: () => api.configureKnowledgeMcp({ provider, name: `${provider}_${Math.random().toString(36).slice(2, 8)}`, url: serverUrl.trim(), note: serverNote.trim() || undefined, bearerTokenEnvVar: tokenEnv.trim() || undefined }),
    onSuccess: ({ serverName: name }) => { toast.success('MCP 已写入 Codex CLI 配置'); onConfigured(name); },
    onError: (error) => toast.error((error as Error).message),
  });

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title={`授权${label}文档`} className="max-w-xl overflow-hidden">
      <div className="border-b border-line px-5 py-4"><div className="flex items-center gap-2"><PlugZap className="size-4 text-accent" /><h2 className="text-sm font-semibold">连接{label}文档权限</h2></div><p className="mt-1 text-xs leading-relaxed text-ink-3">优先复用已有 Codex MCP；没有时可在这里添加远程 MCP，并由 Codex CLI 发起 OAuth。</p></div>
      <div className="max-h-[70vh] space-y-5 overflow-y-auto p-5">
        {visibleServers.length > 0 && <section className="space-y-2">
          <p className="text-xs font-medium text-ink-2">已配置的文档 MCP</p>
          <div className="space-y-2">{visibleServers.map((server) => <div key={server.name} className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 p-3">
            <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{server.note?.trim() || server.name}{server.suggestedFor === provider && <span className="ml-2 rounded bg-accent-dim px-1.5 py-0.5 text-[9px] text-accent">推荐</span>}</p><p className="mt-1 truncate text-[10px] text-ink-4">{server.note?.trim() ? `${server.name} · ` : ''}{server.transport} · {server.authStatus}</p></div>
            <Button size="sm" variant={selected === server.name ? 'primary' : 'secondary'} onClick={() => onSelect(server.name)} disabled={retrying}>{retrying && selected === server.name ? <Loader2 className="animate-spin" /> : <RefreshCw />}读取文档</Button>
            <Button size="sm" variant="ghost" onClick={() => onAuthorize(server.name)} disabled={authorizing}>{authorizing && selected === server.name ? <Loader2 className="animate-spin" /> : <ShieldCheck />}授权</Button>
          </div>)}</div>
        </section>}

        {matchingServers.length === 0 && <div className="rounded-xl border border-line bg-surface-2 p-3 text-xs"><p className="font-medium text-ink">尚未发现{label}文档 MCP</p><p className="mt-1 leading-relaxed text-ink-3">可在下方添加团队提供的 MCP 地址；如果现有 MCP 名称里没有“{provider === 'feishu' ? 'feishu / lark' : 'dingtalk / alidocs'}”，也可以手动从其他连接中选择。</p>{servers.length > 0 && <Button className="mt-2" size="sm" variant="ghost" onClick={() => setShowAllServers((value) => !value)}>{showAllServers ? '收起其他 MCP' : `查看其他 ${servers.length} 个 MCP`}</Button>}</div>}

        {job && <section className={`rounded-xl border p-3 text-xs ${job.status === 'failed' ? 'border-danger/25 bg-danger/5' : 'border-accent/25 bg-accent-dim'}`}>
          {job.status === 'waiting' && <><p className="font-medium text-ink">正在等待你完成授权…</p><p className="mt-1 text-ink-3">Codex CLI 会在浏览器打开 OAuth 页面；完成后这里会自动重试文档导入。</p>{job.authorizationUrl && <a href={job.authorizationUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-accent hover:underline">打开授权页面 <ExternalLink className="size-3" /></a>}</>}
          {job.status === 'authorized' && <p className="flex items-center gap-2 font-medium text-accent"><Loader2 className="size-3.5 animate-spin" />授权成功，正在读取文档…</p>}
          {job.status === 'failed' && <><p className="font-medium text-danger">授权没有完成</p><p className="mt-1 break-words text-ink-3">{job.error}</p><p className="mt-2 text-ink-4">如果该 MCP 使用 Bearer Token 而不是 OAuth，请配置下面的环境变量后直接点“读取文档”。</p></>}
        </section>}

        <section className="space-y-3 border-t border-line pt-4">
          <div><p className="text-xs font-medium text-ink-2">添加远程 MCP</p><p className="mt-1 text-[11px] leading-relaxed text-ink-4">需要服务商或团队提供的 Streamable HTTP MCP 地址。保存动作等同于执行 <code className="rounded bg-surface-3 px-1">codex mcp add</code>，只有你点击后才会修改配置。</p></div>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="备注（列表里显示的名字）"><Input value={serverNote} onChange={(event) => setServerNote(event.target.value)} maxLength={40} placeholder="例如：部门知识库、产品文档" /></Field><Field label="Bearer Token 环境变量（可选）"><Input value={tokenEnv} onChange={(event) => setTokenEnv(event.target.value.toUpperCase())} placeholder={provider === 'feishu' ? 'FEISHU_MCP_TOKEN' : 'DINGTALK_MCP_TOKEN'} /></Field></div>
          <Field label="MCP 服务地址"><Input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://your-mcp.example.com/mcp" /></Field>
          <div className="flex items-center justify-between gap-3"><p className="text-[10px] text-ink-4">OAuth 登录由 Codex CLI 管理，本应用不接触你的账号密码。</p><Button onClick={() => configure.mutate()} disabled={!serverUrl.trim() || configure.isPending}>{configure.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}保存并授权</Button></div>
        </section>
      </div>
    </DialogContent>
  </Dialog>;
}
