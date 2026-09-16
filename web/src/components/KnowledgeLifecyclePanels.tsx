/**
 * [INPUT]: 依赖知识库持久批次 API、飞书范围选择器与通用对话框
 * [OUTPUT]: 对外提供批量接入对话框和可回访的逐项进度面板
 * [POS]: 资料页的接入流程组件；区分已处理、正文可用与待补全数量
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, FileWarning, Loader2, Pause, Play, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { KnowledgeImportBatch, KnowledgeImportBatchDetail, KnowledgeImportItem, KnowledgeSyncScope } from '@/types';
import { relTime } from '@/lib/utils';
import { FeishuScopePicker } from '@/components/KnowledgeScopePicker';
import { Button } from '@/ui/button';
import { Input } from '@/ui/form';
import { Dialog, DialogContent } from '@/ui/dialog';

const BATCH_LABEL: Record<string, string> = { draft: '待确认', running: '处理中', paused: '已暂停', completed: '已完成', partial: '部分完成', failed: '失败' };
const ITEM_LABEL: Record<string, string> = { queued: '等待处理', running: '处理中', succeeded: '已处理', failed: '处理失败', skipped: '已跳过' };

export function KnowledgeImportDialog({ open, onOpenChange, onStarted }: { open: boolean; onOpenChange: (open: boolean) => void; onStarted: () => void }) {
  const [provider, setProvider] = useState<'feishu' | 'dingtalk'>('feishu');
  const [scope, setScope] = useState<KnowledgeSyncScope>({ wiki: [], drive: [] });
  const [spaceUrl, setSpaceUrl] = useState('');
  const [preview, setPreview] = useState<KnowledgeImportBatchDetail | null>(null);
  const previewMutation = useMutation({
    mutationFn: () => provider === 'feishu'
      ? api.knowledgeBatchPreview({ provider, wiki: (scope.wiki ?? []).map((item) => ({ ...item, spaceName: item.spaceName ?? item.spaceId })), drive: scope.drive ?? [] })
      : api.knowledgeBatchPreview({ provider, spaceUrl: spaceUrl.trim() }),
    onSuccess: setPreview,
    onError: (error: Error) => toast.error(error.message),
  });
  const start = useMutation({
    mutationFn: () => api.knowledgeBatchStart(preview!.batch.id),
    onSuccess: () => { toast.success('已开始处理，离开页面后仍会继续'); onStarted(); onOpenChange(false); setPreview(null); },
    onError: (error: Error) => toast.error(error.message),
  });
  const close = (next: boolean) => { if (!next && preview && !window.confirm('当前预览批次尚未开始，确定关闭吗？')) return; onOpenChange(next); if (!next) setPreview(null); };
  const valid = provider === 'feishu' ? !!(scope.wiki?.length || scope.drive?.length) : /^https?:\/\//.test(spaceUrl.trim());
  return <Dialog open={open} onOpenChange={close}><DialogContent className="max-w-2xl">
    <div className="space-y-4 p-5">
      <div><h2 className="font-semibold">批量接入云端资料</h2><p className="mt-1 text-xs text-ink-3">先选范围并读取目录清单，确认后才开始抓取正文。</p></div>
      {!preview ? <>
        <div className="flex gap-2">{(['feishu', 'dingtalk'] as const).map((item) => <button key={item} onClick={() => setProvider(item)} className={`rounded-full border px-3 py-1 text-xs ${provider === item ? 'border-primary bg-primary/10 text-primary' : 'border-line text-ink-3'}`}>{item === 'feishu' ? '飞书' : '钉钉'}</button>)}</div>
        {provider === 'feishu' ? <FeishuScopePicker scope={scope} onChange={setScope} disabled={previewMutation.isPending} containersOnly /> : <div><Input value={spaceUrl} onChange={(event) => setSpaceUrl(event.target.value)} placeholder="粘贴钉钉知识库分享链接" /><p className="mt-2 text-[11px] text-ink-4">使用知识库分享链接识别范围，无需填写 token 或 JSON。</p></div>}
        <div className="flex justify-end"><Button onClick={() => previewMutation.mutate()} disabled={!valid || previewMutation.isPending}>{previewMutation.isPending && <Loader2 className="size-4 animate-spin" />}读取并预览</Button></div>
      </> : <>
        <div className="rounded-xl border border-line bg-surface-2 p-3"><div className="text-sm font-medium">发现 {preview.batch.discovered_count} 项</div><p className="mt-1 text-xs text-ink-3">这是目录枚举数；正文尚未处理。</p></div>
        <div className="max-h-72 space-y-1 overflow-y-auto">{preview.items.map((item) => <ImportItemRow key={item.id} item={item} preview />)}</div>
        <div className="flex justify-between"><Button variant="secondary" onClick={() => setPreview(null)}>返回修改范围</Button><Button onClick={() => start.mutate()} disabled={!preview.items.length || start.isPending}>{start.isPending && <Loader2 className="size-4 animate-spin" />}确认并开始</Button></div>
      </>}
    </div>
  </DialogContent></Dialog>;
}

export function KnowledgeBatchPanel() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const qc = useQueryClient();
  const batches = useQuery({ queryKey: ['knowledge', 'batches'], queryFn: api.knowledgeBatches, refetchInterval: (query) => query.state.data?.batches.some((batch) => batch.status === 'running') ? 2000 : false });
  const active = useQuery({ queryKey: ['knowledge', 'batches', activeId], queryFn: () => api.knowledgeBatch(activeId!), enabled: !!activeId, refetchInterval: (query) => query.state.data?.batch.status === 'running' ? 1500 : false });
  const action = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start'|'pause' | 'resume' | 'retry' }) => action==='start'?api.knowledgeBatchStart(id):api.knowledgeBatchAction(id, action),
    onSuccess: (detail) => { void qc.invalidateQueries({ queryKey: ['knowledge', 'batches'] }); void qc.setQueryData(['knowledge', 'batches', detail.batch.id], detail); },
    onError: (error: Error) => toast.error(error.message),
  });
  useEffect(()=>{const status=active.data?.batch.status;if(status&&status!=='running'&&status!=='draft'){void qc.invalidateQueries({queryKey:['knowledge','pool']});void qc.invalidateQueries({queryKey:['knowledge','topics']});}},[active.data?.batch.status,qc]);
  if (!batches.data?.batches.length) return null;
  return <section className="mb-4 rounded-xl border border-line bg-surface p-3">
    <div className="mb-2 text-sm font-medium">接入记录</div>
    <div className="space-y-2">{batches.data.batches.slice(0, 8).map((batch) => <BatchRow key={batch.id} batch={batch} selected={batch.id === activeId} onSelect={() => setActiveId(batch.id === activeId ? null : batch.id)} onAction={(kind) => action.mutate({ id: batch.id, action: kind })} />)}</div>
    {activeId && <div className="mt-3 border-t border-line pt-3">{active.isPending ? <div className="text-xs text-ink-3"><Loader2 className="mr-2 inline size-3.5 animate-spin" />读取逐项进度…</div> : active.isError ? <div className="text-xs text-red-500">批次详情加载失败，可稍后重试。</div> : <div className="max-h-72 space-y-1 overflow-y-auto">{active.data?.items.map((item) => <ImportItemRow key={item.id} item={item} />)}</div>}</div>}
  </section>;
}

function BatchRow({ batch, selected, onSelect, onAction }: { batch: KnowledgeImportBatch; selected: boolean; onSelect: () => void; onAction: (action: 'start'|'pause' | 'resume' | 'retry') => void }) {
  return <div className={`rounded-lg border px-3 py-2 text-xs ${selected ? 'border-primary/40 bg-primary/5' : 'border-line'}`}>
    <div className="flex flex-wrap items-center gap-2"><button className="font-medium hover:underline" onClick={onSelect}>{batch.provider === 'feishu' ? '飞书' : '钉钉'} · {BATCH_LABEL[batch.status]}</button><span className="text-ink-3">已处理 {batch.completed_count}/{batch.discovered_count} · 正文可用 {batch.usable_count ?? 0} · 待补全 {batch.incomplete_count ?? 0} · 失败 {batch.failed_count} · 跳过 {batch.skipped_count}</span><span className="ml-auto text-ink-4">{relTime(batch.updated_at)}</span></div>
    {batch.auto_organization_status&&<div className={`mt-1 text-[11px] ${batch.auto_organization_status==='failed'?'text-red-600':batch.auto_organization_status==='partial'?'text-amber-600':'text-ink-3'}`}>主题整理：{batch.auto_organization_authorized?({pending:'等待模型整理',running:'模型整理中',completed:'整理完成',partial:'部分资料待继续整理',failed:'整理失败'}[batch.auto_organization_status]):'本地关联完成'}{batch.auto_organization_error?` · ${batch.auto_organization_error}`:''}</div>}
    <div className="mt-2 flex gap-2">{batch.status==='draft'&&<Button variant="secondary" size="sm" onClick={()=>onAction('start')}><Play className="size-3"/>开始处理</Button>}{batch.status === 'running' && <Button variant="secondary" size="sm" onClick={() => onAction('pause')}><Pause className="size-3" />暂停</Button>}{['paused', 'partial'].includes(batch.status) && <Button variant="secondary" size="sm" onClick={() => onAction('resume')}><Play className="size-3" />恢复</Button>}{batch.failed_count > 0 && <Button variant="secondary" size="sm" onClick={() => onAction('retry')}><RotateCcw className="size-3" />仅重试可重试失败</Button>}<Button variant="ghost" size="sm" onClick={onSelect}>{selected ? '收起详情' : '查看逐项详情'}</Button></div>
  </div>;
}

function ImportItemRow({ item, preview = false }: { item: KnowledgeImportItem; preview?: boolean }) {
  const incomplete=item.status==='succeeded'&&item.body_status==='suspect';
  const state = preview ? '待确认' : incomplete?'待补全正文':item.status==='succeeded'&&item.body_status==='fetched'?'正文可用':ITEM_LABEL[item.status] ?? item.status;
  return <div className="flex items-start gap-2 rounded-lg bg-surface-2 px-2.5 py-2 text-xs">{item.status === 'succeeded' ? incomplete?<FileWarning className="mt-0.5 size-3.5 text-amber-600"/>:<CheckCircle2 className="mt-0.5 size-3.5 text-emerald-600" /> : item.status === 'failed' ? <FileWarning className="mt-0.5 size-3.5 text-red-500" /> : item.status === 'running' ? <Loader2 className="mt-0.5 size-3.5 animate-spin" /> : <span className="mt-1 size-2 rounded-full bg-ink-3/30" />}<div className="min-w-0 flex-1"><div className="truncate text-ink">{item.title}</div><div className="mt-0.5 flex flex-wrap gap-2 text-[10px] text-ink-4"><span className={incomplete?'text-amber-600':''}>{state}</span>{item.source_path && <span>{item.source_path}</span>}{item.source_type && <span>{item.source_type}</span>}{item.retryable === 1 && <span>可重试</span>}</div>{item.error_message && <div className="mt-1 text-[10px] text-red-500">{item.error_message}</div>}</div>{item.canonical_url && <a href={item.canonical_url} target="_blank" rel="noreferrer" title="打开来源"><ExternalLink className="size-3.5 text-ink-3" /></a>}</div>;
}
