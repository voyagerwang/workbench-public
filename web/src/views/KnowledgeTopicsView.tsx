/**
 * [INPUT]: 主题范围/成员覆盖、自动组织、按需综合理解与版本化证据 API
 * [OUTPUT]: 主题列表、范围和关注问题编辑、综合理解、全资料成员维护及证据阅读
 * [POS]: 知识库第二入口；以人工范围和修正约束自动部分，具体判断始终回到引用版本
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { AlertTriangle, ArrowLeft, BookOpen, CheckCircle2, Copy, ExternalLink, FileWarning, Loader2, Plus, RefreshCw, ScrollText, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import type { DocumentEvidence, EvidenceDriftState, KnowledgeItemKind, KnowledgeOutput, SourceDocumentSummary } from '@/types';
import { cn, relTime } from '@/lib/utils';
import { DocumentEditor } from '@/components/DocumentEditor';
import { Button } from '@/ui/button';
import { Input } from '@/ui/form';
import { EmptyState } from '@/ui/primitives';
import { Dialog, DialogContent } from '@/ui/dialog';

const KIND_LABELS: Record<KnowledgeItemKind, string> = {
  conclusion: '结论', rule: '规则', decision: '决定', method: '方法', data: '数据', experience: '经验',
};

const BODY_STATUS_LABELS: Record<string, string> = {
  fetched: '正文已就绪', suspect: '正文可能不完整', failed: '抓取失败', pending: '待抓取',
};

function safeQuestions(value?: string): string[] {
  try { const parsed=JSON.parse(value??'[]'); return Array.isArray(parsed)?parsed.filter((item):item is string=>typeof item==='string'):[]; } catch { return []; }
}

/** 版本时间线按 V主.次 降序排 */
function versionRank(version: string): number {
  const match = version.match(/V(\d+)\.(\d+)/);
  if (!match) return -1;
  return Number(match[1]) * 1000 + Number(match[2]);
}

// ---------------------------------------------------------------------------
// 证据高亮：阅读器用装饰器标出命中区间，不改动文档内容
// ---------------------------------------------------------------------------

const evidenceHighlightKey = new PluginKey<DecorationSet>('evidenceHighlight');

const EvidenceHighlight = Extension.create({
  name: 'evidenceHighlight',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: evidenceHighlightKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, value) {
          const meta = tr.getMeta(evidenceHighlightKey) as DecorationSet | undefined;
          if (meta) return meta;
          return value.map(tr.mapping, tr.doc);
        },
      },
      props: { decorations(state) { return evidenceHighlightKey.getState(state); } },
    })];
  },
});

/** 把整个文档拼成纯文本并记录每个字符的 ProseMirror 位置；块级节点之间补 '\n'（与 textBetween(from,to,'\n') 语义一致） */
function buildTextIndex(doc: PMNode): { text: string; map: Array<number | null> } {
  let text = '';
  const map: Array<number | null> = [];
  const walk = (node: PMNode, pos: number): void => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i += 1) {
        text += node.text[i];
        map.push(pos + i);
      }
      return;
    }
    let childPos = pos + 1;
    let first = true;
    node.forEach((child) => {
      if (child.isBlock && !first) {
        text += '\n';
        map.push(null);
      }
      first = false;
      walk(child, childPos);
      childPos += child.nodeSize;
    });
  };
  walk(doc, 0);
  return { text, map };
}

/**
 * 引文定位（交接文档 7.2）：优先 prefix+quote+suffix，逐级回退；quote 命中必须唯一，否则放弃。
 * 返回 PM 位置区间。
 */
function locateQuote(doc: PMNode, quote: string, prefix: string, suffix: string): [number, number] | null {
  if (!quote.trim()) return null;
  const { text, map } = buildTextIndex(doc);
  const find = (needle: string): number | null => {
    const first = text.indexOf(needle);
    if (first < 0) return null;
    if (text.indexOf(needle, first + 1) >= 0) return null; // 命中多于一次 = 不唯一，放弃
    return first;
  };
  let startIdx = -1;
  let endIdx = -1;
  for (const [needle, offset] of [
    [`${prefix}${quote}${suffix}`, prefix.length],
    [`${quote}${suffix}`, 0],
    [`${prefix}${quote}`, prefix.length],
    [quote, 0],
  ] as Array<[string, number]>) {
    if (!needle) continue;
    const at = find(needle);
    if (at === null) continue; // 无命中或多命中都放弃这一级
    startIdx = at + offset;
    endIdx = startIdx + quote.length;
    break;
  }
  if (startIdx < 0 || endIdx > map.length) return null;
  const from = map[startIdx];
  const to = map[endIdx - 1];
  if (from == null || to == null) return null;
  return [from, to + 1];
}

function applyHighlight(editor: Editor, from: number, to: number): void {
  const { state, view } = editor;
  const deco = DecorationSet.create(state.doc, [Decoration.inline(from, to, { class: 'kb-evidence-highlight' })]);
  view.dispatch(state.tr.setMeta(evidenceHighlightKey, deco));
  setTimeout(() => {
    document.querySelector('.kb-evidence-highlight')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 60);
}

// ---------------------------------------------------------------------------
// 主题列表 /knowledge/topics
// ---------------------------------------------------------------------------

export function KnowledgeTopicsListView() {
  const navigate = useNavigate();
  const qc=useQueryClient();
  const [createOpen,setCreateOpen]=useState(false);
  const [organizeOffset,setOrganizeOffset]=useState(0);
  const [hasMoreToOrganize,setHasMoreToOrganize]=useState(false);
  const { data, isLoading, isError } = useQuery({ queryKey: qk.knowledgeTopics, queryFn: api.topicList });
  const destination=useQuery({queryKey:['knowledge','model-destination'],queryFn:api.knowledgeModelDestination});
  const organize=useMutation({mutationFn:(offset:number)=>api.knowledgeAutoOrganize(offset),onSuccess:(result)=>{void qc.invalidateQueries({queryKey:qk.knowledgeTopics});const next=result.coverage?.next_offset??null;setHasMoreToOrganize(next!=null);if(next!=null)setOrganizeOffset(next);if(result.status==='published'||result.status==='completed')toast.success(`主题整理完成：新建 ${result.created_topics}，关联 ${result.associated}${next!=null?'；仍有资料可继续整理':''}`);else if(result.status==='stale')toast.warning('资料已变化，本次整理结果未发布');else toast.error(result.error||'主题整理失败');},onError:(e:Error)=>toast.error(e.message)});

  return <div className="mx-auto w-full max-w-3xl">
    <div className="mb-4 flex items-start justify-between gap-3"><p className="text-sm text-ink-3">主题围绕范围和关注问题组织资料。自动整理会保留你的纳入、排除和文字修正。{destination.data?.available?`需要模型判断时使用 ${destination.data.host} · ${destination.data.model}。`:'WorkBuddy 当前未就绪；本地规则关联仍可使用，需要分析的部分会明确失败。'}</p><div className="flex shrink-0 gap-2"><Button variant="secondary" size="sm" onClick={()=>setCreateOpen(true)}><Plus className="size-3.5"/>新建主题</Button><Button size="sm" onClick={()=>organize.mutate(organizeOffset)} disabled={organize.isPending}>{organize.isPending?<Loader2 className="size-3.5 animate-spin"/>:<Sparkles className="size-3.5"/>}{hasMoreToOrganize?'继续整理':'自动整理'}</Button></div></div>
    {isLoading && <div className="py-16 text-center text-sm text-ink-3"><Loader2 className="mr-2 inline size-4 animate-spin" />加载中…</div>}
    {isError && <EmptyState icon={<FileWarning />} title="主题列表加载失败" desc="请重试" />}
    {data && data.topics.length === 0 && (
      <EmptyState icon={<BookOpen />} title="还没有主题" desc="新建主题写下范围和关注问题，或先导入资料再自动整理" />
    )}
    <TopicCandidatesSection />
    <div className="grid gap-3">
      {data?.topics.map((topic) => (
        <button key={topic.id} onClick={() => navigate(`/knowledge/topics/${topic.id}`)}
          className="rounded-xl border border-line bg-surface p-4 text-left transition hover:border-ink-3/40">
          <div className="flex items-baseline justify-between gap-3">
            <div className="font-medium">{topic.name}</div>
            <div className="text-xs text-ink-3">{relTime(topic.updated_at)}</div>
          </div>
          {topic.summary && <div className="mt-1 text-sm text-ink-2">{topic.summary}</div>}
          <div className="mt-2 text-xs text-ink-3">{topic.document_count} 篇资料 · {topic.knowledge_count} 条知识</div>
        </button>
      ))}
    </div>
    <TopicCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={topic=>{void qc.invalidateQueries({queryKey:qk.knowledgeTopics});navigate(`/knowledge/topics/${topic.id}`);}}/>
  </div>;
}

// ---------------------------------------------------------------------------
// 主题候选（S08）：查看依据、排除个别资料、并入已有主题或新建主题、忽略
// ---------------------------------------------------------------------------

function isNoteSource(doc: { canonical_url: string | null; provider: string }): boolean {
  return (doc.canonical_url ?? '').startsWith('workbench:note:') || doc.provider === 'note';
}

function TopicCandidatesSection() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const candidates = useQuery({ queryKey: ['knowledge', 'topic-candidates'], queryFn: api.topicCandidates, enabled: open });
  const topics = useQuery({ queryKey: qk.knowledgeTopics, queryFn: api.topicList, enabled: open });
  const [activeId, setActiveId] = useState<number | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [mergeTopicId, setMergeTopicId] = useState<number | ''>('');
  const decide = useMutation({
    mutationFn: ({ id, action, excluded, mergeTopicId }: { id: number; action: 'accept' | 'ignore'; excluded?: string[]; mergeTopicId?: number }) =>
      api.topicCandidateDecision(id, action, excluded ?? [], mergeTopicId),
    onSuccess: (_result, variables) => {
      void qc.invalidateQueries({ queryKey: ['knowledge', 'topic-candidates'] });
      void qc.invalidateQueries({ queryKey: qk.knowledgeTopics });
      setActiveId(null); setExcluded([]); setMergeTopicId('');
      if (variables.action === 'ignore') toast.success('已忽略该候选');
      else toast.success('候选已采纳，主题成员已确认');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const pending = (candidates.data?.candidates ?? []).filter((c) => c.status === 'pending');
  const decided = (candidates.data?.candidates ?? []).filter((c) => c.status !== 'pending');

  const generate = async () => {
    setGenerating(true);
    try {
      const result = await api.topicCandidatesGenerate(0);
      void qc.invalidateQueries({ queryKey: ['knowledge', 'topic-candidates'] });
      setOpen(true);
      toast.success(result.reused ? '已展示上一次归纳的候选' : `归纳出 ${result.candidates.length} 组主题候选`);
    } catch (e) { toast.error((e as Error).message); } finally { setGenerating(false); }
  };

  return <section className="mb-4 rounded-xl border border-line bg-surface">
    <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between px-4 py-3 text-left">
      <span className="flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-ink-3" />主题候选建议{pending.length ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">{pending.length} 条待处理</span> : null}</span>
      <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); void generate(); }} disabled={generating}>
        {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}归纳候选
      </Button>
    </button>
    {open && <div className="space-y-3 border-t border-line p-4">
      {candidates.isPending && <div className="py-4 text-center text-xs text-ink-3"><Loader2 className="mr-2 inline size-3.5 animate-spin" />加载候选…</div>}
      {candidates.data && pending.length === 0 && decided.length === 0 && (
        <EmptyState icon={<Sparkles />} title="还没有主题候选" desc="点击「归纳候选」，从资料池（含随手记入库资料）归纳可组主题的建议" />
      )}
      {pending.map((candidate) => {
        const docs = candidate.member_documents ?? [];
        const active = activeId === candidate.id;
        return <div key={candidate.id} className="rounded-lg border border-line p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{candidate.name}</div>
              {candidate.reason && <div className="mt-1 text-xs text-ink-2">依据：{candidate.reason}</div>}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="secondary" onClick={() => { setActiveId(active ? null : candidate.id); setExcluded([]); setMergeTopicId(''); }}>{active ? '收起' : '处理'}</Button>
              <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: candidate.id, action: 'ignore' })} disabled={decide.isPending}>忽略</Button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {docs.map((doc) => (
              <button key={doc.source_key} onClick={() => navigate(`/knowledge/documents/${encodeURIComponent(doc.source_key)}`)}
                className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[11px] transition hover:border-ink-3/40" title="查看资料依据">
                {isNoteSource(doc) && <span className="rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">随手记</span>}
                {doc.title}
              </button>
            ))}
          </div>
          {active && <div className="mt-3 space-y-2 rounded-lg bg-surface-2 p-3">
            <div className="text-xs font-medium text-ink-2">纳入前可排除个别资料（保留人工排除）</div>
            {docs.map((doc) => (
              <label key={doc.source_key} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!excluded.includes(doc.source_key)} onChange={(e) => setExcluded((old) => e.target.checked ? old.filter((k) => k !== doc.source_key) : [...old, doc.source_key])} />
                <span className="truncate">{doc.title}</span>
              </label>
            ))}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <select value={mergeTopicId} onChange={(e) => setMergeTopicId(e.target.value ? Number(e.target.value) : '')}
                className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs">
                <option value="">新建主题「{candidate.name}」</option>
                {(topics.data?.topics ?? []).map((topic) => <option key={topic.id} value={topic.id}>并入已有主题：{topic.name}</option>)}
              </select>
              <Button size="sm" onClick={() => decide.mutate({ id: candidate.id, action: 'accept', excluded, mergeTopicId: mergeTopicId || undefined })}
                disabled={decide.isPending || docs.length - excluded.length === 0}>
                {decide.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                {docs.length - excluded.length === 0 ? '至少保留一份资料' : mergeTopicId ? '并入该主题' : '采纳为新主题'}
              </Button>
            </div>
          </div>}
        </div>;
      })}
      {decided.length > 0 && <details className="text-xs text-ink-3">
        <summary className="cursor-pointer">已处理 {decided.length} 条候选</summary>
        <div className="mt-2 space-y-1">{decided.map((c) => <div key={c.id}>{c.status === 'accepted' ? `已采纳：${c.name}` : `已忽略：${c.name}`}</div>)}</div>
      </details>}
    </div>}
  </section>;
}

function TopicCreateDialog({open,onOpenChange,onCreated}:{open:boolean;onOpenChange:(open:boolean)=>void;onCreated:(topic:{id:number})=>void}){
  const [name,setName]=useState('');const [scope,setScope]=useState('');const [questions,setQuestions]=useState('');
  const create=useMutation({mutationFn:()=>api.topicCreate(name.trim(),'',scope.trim(),questions.split('\n').map(x=>x.trim()).filter(Boolean)),onSuccess:({topic})=>{setName('');setScope('');setQuestions('');onOpenChange(false);onCreated(topic);},onError:(e:Error)=>toast.error(e.message)});
  const dirty=!!(name||scope||questions);const close=(next:boolean)=>{if(!next&&dirty&&!window.confirm('有未保存修改，确定离开吗？'))return;onOpenChange(next);};
  return <Dialog open={open} onOpenChange={close}><DialogContent className="max-w-lg"><div className="space-y-3 p-5"><h2 className="font-semibold">新建主题</h2><Input value={name} onChange={e=>setName(e.target.value)} placeholder="主题名称" maxLength={60}/><textarea value={scope} onChange={e=>setScope(e.target.value)} rows={3} className="w-full rounded-lg border border-line bg-surface p-3 text-sm" placeholder="范围（可选）：包含什么，不包含什么"/><textarea value={questions} onChange={e=>setQuestions(e.target.value)} rows={3} className="w-full rounded-lg border border-line bg-surface p-3 text-sm" placeholder="关注问题（可选），每行一个"/><div className="flex justify-end gap-2"><Button variant="secondary" onClick={()=>close(false)}>取消</Button><Button onClick={()=>create.mutate()} disabled={!name.trim()||create.isPending}>{create.isPending&&<Loader2 className="size-3.5 animate-spin"/>}创建</Button></div></div></DialogContent></Dialog>;
}

// ---------------------------------------------------------------------------
// 主题页 /knowledge/topics/:topicId
// ---------------------------------------------------------------------------

function DriftBadge({ state }: { state: EvidenceDriftState }) {
  if (state === 'changed') return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600"><AlertTriangle className="size-3" />引用位置已变化</span>;
  if (state === 'missing') return <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] text-red-600"><FileWarning className="size-3" />原文当前不可用</span>;
  return null;
}

function StatusBadge({ status }: { status: string }) {
  const style = status === 'fetched' ? 'bg-emerald-500/10 text-emerald-600'
    : status === 'suspect' ? 'bg-amber-500/10 text-amber-600'
    : status === 'failed' ? 'bg-red-500/10 text-red-600'
    : 'bg-ink-3/10 text-ink-3';
  return <span className={cn('rounded-full px-2 py-0.5 text-[11px]', style)}>{BODY_STATUS_LABELS[status] ?? status}</span>;
}

export function KnowledgeTopicDetailView() {
  const { topicId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editTopicOpen, setEditTopicOpen] = useState(false);
  const [editItem, setEditItem] = useState<{ id: number; statement: string } | null>(null);
  const [analysis,setAnalysis]=useState<KnowledgeOutput|null>(null);
  const [analysisSaveKey,setAnalysisSaveKey]=useState('');
  const id = Number(topicId);
  const { data, isLoading, isError } = useQuery({ queryKey: qk.knowledgeTopic(id), queryFn: () => api.topicDetail(id), enabled: Number.isFinite(id) });
  const removeItem = useMutation({
    mutationFn: api.knowledgeItemDelete,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.knowledgeTopic(id) });
      toast.success('知识已删除（可在回收站恢复）');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const updateItem=useMutation({mutationFn:({itemId,status}:{itemId:number;status:'active'|'deprecated'})=>api.knowledgeItemUpdate(itemId,{status}),onSuccess:()=>void qc.invalidateQueries({queryKey:qk.knowledgeTopic(id)}),onError:(e:Error)=>toast.error(e.message)});
  const restoreItem=useMutation({mutationFn:api.knowledgeItemRestore,onSuccess:()=>void qc.invalidateQueries({queryKey:qk.knowledgeTopic(id)}),onError:(e:Error)=>toast.error(e.message)});
  const understanding=useQuery({queryKey:['knowledge','topics',id,'understanding'],queryFn:()=>api.topicUnderstanding(id),enabled:Number.isFinite(id)});
  const destination=useQuery({queryKey:['knowledge','model-destination'],queryFn:api.knowledgeModelDestination});
  const analyze=useMutation({mutationFn:()=>api.generateTopicUnderstanding(id),onSuccess:(run)=>{qc.setQueryData(['knowledge','topics',id,'understanding'],run);if(run.status==='published')toast.success('综合理解已更新');else if(run.status==='stale')toast.warning('资料已变化，本次结果未发布');},onError:(e:Error)=>toast.error(e.message)});
  const generateAnalysis=useMutation({mutationFn:()=>api.topicBriefGenerate(id),onSuccess:({output})=>{setAnalysis(output);setAnalysisSaveKey(`topic-brief-${id}`);},onError:(e:Error)=>toast.error(e.message)});

  const versions = useMemo(() => {
    const groups = new Map<string, SourceDocumentSummary[]>();
    for (const doc of data?.documents ?? []) {
      const version = doc.source_version ?? (doc.title.match(/\bV\d+\.\d+\b/)?.[0] ?? null);
      if (!version) continue;
      if (!groups.has(version)) groups.set(version, []);
      groups.get(version)!.push(doc);
    }
    return [...groups.entries()]
      .sort((a, b) => versionRank(b[0]) - versionRank(a[0]))
      .map(([version, docs]) => ({ version, docs: docs.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans')) }));
  }, [data]);

  if (isLoading) return <div className="py-16 text-center text-sm text-ink-3"><Loader2 className="mr-2 inline size-4 animate-spin" />加载中…</div>;
  if (isError || !data) return <EmptyState icon={<FileWarning />} title="主题加载失败" desc="请返回重试" />;
  const { topic } = data;

  return <div className="mx-auto w-full max-w-4xl space-y-8">
    <div>
      <button onClick={() => navigate('/knowledge/topics')} className="mb-2 inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink"><ArrowLeft className="size-4" />全部主题</button>
      <h2 className="text-xl font-semibold">{topic.name}</h2>
      {(topic.scope_text||topic.summary) && <p className="mt-1 text-sm text-ink-2">{topic.scope_text||topic.summary}</p>}
      {!!topic.focus_questions_json&&<div className="mt-2 text-xs text-ink-3">关注问题：{safeQuestions(topic.focus_questions_json).join(' · ')}</div>}
      {!!topic.manual_notes&&<div className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2"><span className="font-medium">我的说明：</span>{topic.manual_notes}</div>}
      <p className="mt-1 text-xs text-ink-3">{topic.document_count} 篇资料 · {topic.knowledge_count} 条知识 · 更新于 {relTime(topic.updated_at)}</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" onClick={()=>analyze.mutate()} disabled={analyze.isPending}>{analyze.isPending?<Loader2 className="size-3.5 animate-spin"/>:<Sparkles className="size-3.5"/>}更新综合理解</Button><Button variant="secondary" size="sm" onClick={()=>generateAnalysis.mutate()} disabled={generateAnalysis.isPending}>{generateAnalysis.isPending&&<Loader2 className="size-3.5 animate-spin"/>}生成带引用分析</Button><Button variant="secondary" size="sm" onClick={() => setEditTopicOpen(true)}>编辑范围与资料</Button><Button variant="secondary" size="sm" onClick={() => void api.knowledgeExport('markdown',id).catch((e:Error)=>toast.error(e.message))}>导出 Markdown</Button><Button variant="secondary" size="sm" onClick={() => void api.knowledgeExport('json',id).catch((e:Error)=>toast.error(e.message))}>导出 JSON</Button></div>
      <p className="mt-2 text-[11px] text-ink-4">{destination.data?.available?`综合理解与分析会把本主题实际选中的资料片段发送到 ${destination.data.host} · ${destination.data.model}。`:'WorkBuddy 当前未就绪；资料阅读和人工整理仍可使用。'}</p>
    </div>

    {(understanding.data?.status!=='empty'||topic.auto_overview)&&<section className="rounded-xl border border-line bg-surface p-4">{understanding.data&&understanding.data.status!=='published'&&<div className={`mb-3 rounded-lg px-3 py-2 text-xs ${understanding.data.status==='failed'?'bg-red-500/10 text-red-600':'bg-amber-500/10 text-amber-700'}`}>{understanding.data.status==='stale'?'资料或范围已变化，下面是上一次理解，请更新后再使用。':understanding.data.status==='running'?'综合理解仍在处理中。':understanding.data.status==='failed'?`综合理解更新失败：${understanding.data.error||'请重试'}`:'还没有生成综合理解。'}</div>}<div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-medium">综合理解{understanding.data?.status!=='published'&&topic.auto_overview?'（上一次）':''}</h3>{understanding.data?.coverage&&<span className="text-[11px] text-ink-3">覆盖 {understanding.data.coverage.covered_count}/{understanding.data.coverage.candidate_count}{understanding.data.coverage.partial?' · 部分资料':''}</span>}</div><div className="text-sm leading-6 text-ink-2">{understanding.data?.status==='published'?understanding.data.overview:topic.auto_overview}</div>{understanding.data?.status==='published'&&!!understanding.data.citations?.length&&<div className="mt-3 space-y-1 border-t border-line pt-3">{understanding.data.citations.map((citation,index)=><button key={`${citation.document_key}-${citation.version_id}-${index}`} onClick={()=>navigate(`/knowledge/documents/${encodeURIComponent(citation.document_key)}?version=${citation.version_id}`)} className="block text-left text-xs text-primary hover:underline">[{index+1}] {citation.claim} · 查看引用版本</button>)}</div>}</section>}

    {data.knowledge.length > 0 && (
      <section>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-ink-2"><ScrollText className="size-4" />关键知识</h3>
        <div className="grid gap-2">
          {data.knowledge.map((item) => {
            const evidence = data.evidence.find((e) => e.knowledge_id === item.id);
            return (
              <div key={item.id} className="rounded-xl border border-line bg-surface p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm">{item.statement}</div>
                  <button onClick={() => removeItem.mutate(item.id)} className="shrink-0 text-ink-3 opacity-0 transition hover:text-red-500 group-hover:opacity-100 [&:hover]:opacity-100" title="删除">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                  <span className="rounded-full bg-ink-3/10 px-2 py-0.5">{KIND_LABELS[item.kind]}</span>
                  {evidence && (
                    <button
                      onClick={() => navigate(`/knowledge/topics/${topic.id}/documents/${encodeURIComponent(evidence.document_key)}?evidence=${evidence.id}`)}
                      className="inline-flex items-center gap-1 text-primary hover:underline">
                      <ExternalLink className="size-3" />{evidence.source_title ?? '查看原文'}
                    </button>
                  )}
                  <DriftBadge state={evidence?.drift_state ?? 'ok'} />
                  <span>{relTime(item.updated_at)}</span>
                  <button className="inline-flex items-center gap-1 hover:text-ink" onClick={()=>void navigator.clipboard.writeText(`${item.statement}${evidence?`\n出处：${evidence.source_title??evidence.document_key}\n内部阅读：${location.origin}/knowledge/topics/${topic.id}/documents/${encodeURIComponent(evidence.document_key)}?evidence=${evidence.id}`:''}`).then(()=>toast.success('已复制结论与可跳转出处')).catch(()=>toast.error('复制失败，请检查剪贴板权限'))}><Copy className="size-3"/>复制</button>
                  <button className="hover:text-ink" onClick={()=>setEditItem({id:item.id,statement:item.statement})}>编辑</button>
                  <button className="hover:text-amber-600" onClick={()=>updateItem.mutate({itemId:item.id,status:'deprecated'})}>废止</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    )}
    {data.inactiveKnowledge.length>0&&<section><h3 className="mb-2 text-sm font-medium text-ink-2">已废止或有争议</h3><div className="space-y-2">{data.inactiveKnowledge.map(item=><div key={item.id} className="flex items-start justify-between gap-3 rounded-lg border border-line p-3 text-xs"><div><div>{item.statement}</div><span className="mt-1 inline-block text-ink-4">{item.status==='deprecated'?'已废止':'有争议'}</span></div><Button variant="secondary" size="sm" onClick={()=>api.knowledgeItemUpdate(item.id,{status:'active'}).then(()=>qc.invalidateQueries({queryKey:qk.knowledgeTopic(id)})).catch((error:Error)=>toast.error(error.message))}>恢复为有效</Button></div>)}</div></section>}
    {data.deletedKnowledge.length>0&&<section><h3 className="mb-2 text-sm font-medium text-ink-2">已删除知识</h3>{data.deletedKnowledge.map(item=><div key={item.id} className="flex items-center justify-between rounded-lg border border-line p-2 text-xs"><span>{item.statement}</span><Button variant="secondary" size="sm" onClick={()=>restoreItem.mutate(item.id)}>恢复</Button></div>)}</section>}

    {versions.length > 0 && (
      <section>
        <h3 className="mb-2 text-sm font-medium text-ink-2">版本时间线</h3>
        <div className="space-y-3">
          {versions.map(({ version, docs }) => (
            <div key={version}>
              <div className="text-xs font-medium text-ink-3">{version}</div>
              <div className="mt-1 flex flex-wrap gap-2">
                {docs.map((doc) => (
                  <button key={doc.source_key} onClick={() => navigate(`/knowledge/topics/${topic.id}/documents/${encodeURIComponent(doc.source_key)}`)}
                    className="rounded-lg border border-line px-2.5 py-1 text-xs transition hover:border-ink-3/40">{doc.title}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    )}

    <section>
      <h3 className="mb-2 text-sm font-medium text-ink-2">资料</h3>
      {data.documents.length === 0
        ? <EmptyState icon={<BookOpen />} title="还没有相关资料" desc="编辑范围与资料，可以搜索并加入资料；也可以先回资料页导入" />
        : <div className="grid gap-2">
          {data.documents.map((doc) => <DocumentRow key={doc.source_key} doc={doc} topicId={topic.id} onOpen={() => navigate(`/knowledge/topics/${topic.id}/documents/${encodeURIComponent(doc.source_key)}`)} />)}
        </div>}
    </section>
    <TopicEditDialog open={editTopicOpen} onOpenChange={setEditTopicOpen} topic={topic} documents={data.documents} onSaved={() => void qc.invalidateQueries({ queryKey: qk.knowledgeTopic(id) })} />
    <KnowledgeEditDialog item={editItem} onOpenChange={(open) => !open && setEditItem(null)} onSaved={() => void qc.invalidateQueries({ queryKey: qk.knowledgeTopic(id) })} />
    <AnalysisDialog output={analysis} saveKey={analysisSaveKey} onClose={()=>setAnalysis(null)} onSaved={(key)=>{setAnalysis(null);navigate(`/knowledge/documents/${encodeURIComponent(key)}`);}} />
  </div>;
}

function AnalysisDialog({output,saveKey,onClose,onSaved}:{output:KnowledgeOutput|null;saveKey:string;onClose:()=>void;onSaved:(sourceKey:string)=>void}){
  const qc=useQueryClient();
  const coverage=output?.coverage_json?safeJson<{candidate_count:number;covered_count:number;partial:boolean;missing?:Array<{document_key:string;title:string;reason:string}>;drifted_knowledge?:Array<{statement:string;drift_state:string}>}>(output.coverage_json):null;
  const versions=output?.source_versions_json?safeJson<Array<{document_key:string;version_id:number;version_no:number;chars:number}>>(output.source_versions_json)??[]:[];
  const save=useMutation({mutationFn:(overwriteManual?:boolean)=>api.saveKnowledgeOutputAsDocument(output!.id,saveKey,overwriteManual),onSuccess:(result)=>{void qc.invalidateQueries({queryKey:['knowledge','pool']});void qc.invalidateQueries({queryKey:qk.knowledgeTopics});toast.success(result.updated?'分析已更新到已保存资料（旧版本保留）':result.reused?'这份分析已经保存':'分析已保存为资料');onSaved(result.document_key);},onError:(e:Error)=>{if(/人工整理/.test(e.message)&&window.confirm('已保存资料的当前版本是人工整理。用本次分析覆盖吗？（人工版本仍保留在历史中）')){save.mutate(true);}else{toast.error(e.message);}}});
  return <Dialog open={!!output} onOpenChange={open=>!open&&onClose()}><DialogContent className="max-w-3xl"><div className="max-h-[80vh] overflow-y-auto p-5">{output&&<><div className="mb-4 flex items-start justify-between gap-3"><div><h2 className="font-semibold">{output.title}</h2><p className="mt-1 text-xs text-ink-3">实际覆盖 {coverage?.covered_count??versions.length}/{coverage?.candidate_count??versions.length} 份资料{coverage?.partial?'，内容或资料仅部分纳入':''}{coverage?.missing?.length?`；未纳入 ${coverage.missing.length} 份`:''}{coverage?.drifted_knowledge?.length?`；${coverage.drifted_knowledge.length} 条知识证据需复核`:''}</p></div><Button size="sm" onClick={()=>save.mutate()} disabled={save.isPending}>{save.isPending&&<Loader2 className="size-3.5 animate-spin"/>}保存为资料</Button></div>{(coverage?.missing?.length||coverage?.drifted_knowledge?.length)?<div className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">{coverage?.missing?.length?<div>未纳入资料：{coverage.missing.map(m=>`${m.title}（${m.reason}）`).join('；')}</div>:null}{coverage?.drifted_knowledge?.length?<div className="mt-1">需复核知识：{coverage.drifted_knowledge.length} 条证据已变化或不可用，未作为事实纳入。</div>:null}</div>:null}<div className="rounded-xl border border-line p-4"><DocumentEditor value={output.content} editable={false}/></div>{versions.length>0&&<div className="mt-3 flex flex-wrap gap-2">{versions.map(version=><button key={`${version.document_key}-${version.version_id}`} onClick={()=>location.assign(`/knowledge/documents/${encodeURIComponent(version.document_key)}?version=${version.version_id}`)} className="rounded-full border border-line px-2.5 py-1 text-[11px] text-primary">版本 {version.version_no} · {version.chars} 字</button>)}</div>}</>}</div></DialogContent></Dialog>;
}

function safeJson<T>(value:string):T|null{try{return JSON.parse(value) as T;}catch{return null;}}

function TopicEditDialog({ open, onOpenChange, topic, documents, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; topic: { id:number; name:string; summary:string; scope_text?:string; focus_questions_json?:string; manual_notes?:string }; documents: SourceDocumentSummary[]; onSaved: () => void }) {
  const [name, setName] = useState(topic.name);
  const [notes, setNotes] = useState(topic.manual_notes??topic.summary);
  const [scope,setScope]=useState(topic.scope_text??'');
  const [questions,setQuestions]=useState(safeQuestions(topic.focus_questions_json).join('\n'));
  const [memberQuery,setMemberQuery]=useState('');
  const [memberOffset,setMemberOffset]=useState(0);
  const [selected, setSelected] = useState<string[]>(documents.map((doc) => doc.source_key));
  const pool = useQuery({ queryKey: ['knowledge','pool','topic-members',memberQuery,memberOffset], queryFn: () => api.knowledgePool('all',memberQuery,memberOffset) , enabled: open });
  useEffect(() => { if (open) { setName(topic.name); setNotes(topic.manual_notes??topic.summary); setScope(topic.scope_text??'');setQuestions(safeQuestions(topic.focus_questions_json).join('\n'));setSelected(documents.map((doc) => doc.source_key));setMemberOffset(0); } }, [open, topic.name, topic.summary,topic.manual_notes, topic.scope_text,topic.focus_questions_json,documents]);
  const save = useMutation({ mutationFn: async () => {
    await api.topicUpdate(topic.id,{name:name.trim(),scope,focusQuestions:questions.split('\n').map(x=>x.trim()).filter(Boolean),manualNotes:notes});
    const current = new Set(documents.map((doc) => doc.source_key)); const next = new Set(selected);
    const add = selected.filter((key) => !current.has(key)); await Promise.all(add.map(key=>api.topicMemberOverride(topic.id,key,'include')));
    await Promise.all(documents.filter((doc) => !next.has(doc.source_key)).map((doc) => api.topicMemberOverride(topic.id,doc.source_key,'exclude')));
  }, onSuccess: () => { onSaved();void qc.invalidateQueries({queryKey:qk.knowledgeTopics});void qc.invalidateQueries({queryKey:['knowledge','topics',topic.id,'understanding']}); onOpenChange(false); toast.success('主题已更新'); }, onError: (error:Error) => toast.error(error.message) });
  const qc=useQueryClient();
  const original=documents.map(doc=>doc.source_key).sort().join('|'); const dirty=name!==topic.name||notes!==(topic.manual_notes??topic.summary)||scope!==(topic.scope_text??'')||questions!==safeQuestions(topic.focus_questions_json).join('\n')||[...selected].sort().join('|')!==original;
  const close=(next:boolean)=>{if(!next&&dirty&&!window.confirm('有未保存修改，确定离开吗？'))return;onOpenChange(next);};
  return <Dialog open={open} onOpenChange={close}><DialogContent className="max-w-2xl"><div className="space-y-4 p-5"><h2 className="font-semibold">编辑主题</h2><Input value={name} onChange={(event)=>setName(event.target.value)} maxLength={60} placeholder="主题名称"/><textarea value={scope} onChange={(event)=>setScope(event.target.value)} rows={3} maxLength={2000} className="w-full rounded-lg border border-line bg-surface p-3 text-sm" placeholder="范围：这个主题包含什么，不包含什么"/><textarea value={questions} onChange={(event)=>setQuestions(event.target.value)} rows={3} className="w-full rounded-lg border border-line bg-surface p-3 text-sm" placeholder="关注问题，每行一个"/><textarea value={notes} onChange={(event)=>setNotes(event.target.value)} rows={3} maxLength={2000} className="w-full rounded-lg border border-line bg-surface p-3 text-sm" placeholder="我的说明（不会被自动理解覆盖）"/><div><div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium"><span>相关资料 · 已选 {selected.length}</span><Input value={memberQuery} onChange={e=>{setMemberQuery(e.target.value);setMemberOffset(0);}} className="h-8 w-56" placeholder="搜索全部资料"/></div><div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-line p-2">{pool.isPending?<div className="p-3 text-xs text-ink-3">加载资料…</div>:pool.data?.documents.map((doc)=><label key={doc.source_key} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-surface-2"><input type="checkbox" checked={selected.includes(doc.source_key)} onChange={(event)=>setSelected((old)=>event.target.checked?Array.from(new Set([...old,doc.source_key])):old.filter((key)=>key!==doc.source_key))}/><span className="truncate">{doc.title}</span></label>)}</div>{pool.data&&pool.data.page.total>pool.data.page.limit&&<div className="mt-2 flex items-center justify-center gap-2"><Button variant="ghost" size="sm" disabled={!memberOffset} onClick={()=>setMemberOffset(Math.max(0,memberOffset-50))}>上一页</Button><span className="text-[11px] text-ink-3">{memberOffset+1}–{Math.min(memberOffset+50,pool.data.page.total)} / {pool.data.page.total}</span><Button variant="ghost" size="sm" disabled={memberOffset+50>=pool.data.page.total} onClick={()=>setMemberOffset(memberOffset+50)}>下一页</Button></div>}</div><div className="flex justify-end gap-2"><Button variant="secondary" onClick={()=>close(false)}>取消</Button><Button onClick={()=>save.mutate()} disabled={!name.trim()||save.isPending}>{save.isPending&&<Loader2 className="size-3.5 animate-spin"/>}保存</Button></div></div></DialogContent></Dialog>;
}

function KnowledgeEditDialog({ item, onOpenChange, onSaved }: { item:{id:number;statement:string}|null; onOpenChange:(open:boolean)=>void; onSaved:()=>void }) {
  const [statement,setStatement]=useState(''); useEffect(()=>setStatement(item?.statement??''),[item]);
  const save=useMutation({mutationFn:()=>api.knowledgeItemUpdate(item!.id,{statement:statement.trim()}),onSuccess:()=>{onSaved();onOpenChange(false);toast.success('知识已更新');},onError:(error:Error)=>toast.error(error.message)});
  const close=(open:boolean)=>{if(!open&&item&&statement!==item.statement&&!window.confirm('有未保存修改，确定离开吗？'))return;onOpenChange(open);};
  return <Dialog open={!!item} onOpenChange={close}><DialogContent><div className="space-y-4 p-5"><h2 className="font-semibold">编辑知识</h2><textarea value={statement} onChange={(event)=>setStatement(event.target.value)} rows={7} className="w-full rounded-lg border border-line bg-surface p-3 text-sm"/><div className="flex justify-end gap-2"><Button variant="secondary" onClick={()=>close(false)}>取消</Button><Button onClick={()=>save.mutate()} disabled={!statement.trim()||save.isPending}>{save.isPending&&<Loader2 className="size-3.5 animate-spin"/>}保存</Button></div></div></DialogContent></Dialog>;
}

function DocumentRow({ doc, onOpen, topicId }: { doc: SourceDocumentSummary; onOpen: () => void; topicId: number }) {
  const qc = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => api.knowledgeDocumentRefresh(doc.source_key),
    // 3.6 缓存失效修正：失效当前主题（原来是 topic(0)，刷完页面不变）+ 资料池
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.knowledgeTopic(topicId) });
      void qc.invalidateQueries({ queryKey: ['knowledge', 'pool'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  return <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
    <button onClick={onOpen} className="min-w-0 flex-1 text-left">
      <div className="truncate text-sm">{doc.title}</div>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-3">
        <StatusBadge status={doc.body_status} />
        <span>{doc.document_type}</span>
        {doc.source_version && <span>{doc.source_version}</span>}
        {doc.body_status === 'fetched' && doc.fetched_at && <span>抓取于 {relTime(doc.fetched_at)}</span>}
        {doc.fetch_error && <span className="text-red-500">{doc.fetch_error}</span>}
      </div>
    </button>
    {(doc.body_status === 'failed' || doc.body_status === 'suspect') && (
      <Button variant="secondary" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
        {refresh.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}重试
      </Button>
    )}
  </div>;
}

// ---------------------------------------------------------------------------
// 资料阅读器 /knowledge/topics/:topicId/documents/:sourceKey
// ---------------------------------------------------------------------------

const KIND_OPTIONS: KnowledgeItemKind[] = ['conclusion', 'rule', 'decision', 'method', 'data', 'experience'];

export function KnowledgeTopicDocumentView() {
  const { topicId, sourceKey } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const evidenceId = Number(searchParams.get('evidence')) || null;
  const id = Number(topicId);
  const key = decodeURIComponent(sourceKey ?? '');

  const { data, isLoading, isError } = useQuery({
    queryKey: qk.knowledgeDocument(key),
    queryFn: () => api.knowledgeDocument(key),
    enabled: !!key,
  });
  const editorRef = useRef<Editor | null>(null);
  // editor 必须进 state：ref 变化不触发渲染，依赖它的证据定位 / 选区跟踪 effect 就不会在编辑器就绪后重跑
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [statement, setStatement] = useState('');
  const [kind, setKind] = useState<KnowledgeItemKind>('conclusion');
  const highlightDone = useRef<number | null>(null);

  const doc = data?.document;
  const refresh = useMutation({
    mutationFn: () => api.knowledgeDocumentRefresh(key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.knowledgeDocument(key) });
      void qc.invalidateQueries({ queryKey: qk.knowledgeTopic(id) });
      toast.success('已刷新');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // 选区跟踪：只读编辑器同样产生 ProseMirror 选区
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const { from, to, empty } = editor.state.selection;
      if (empty || from === to) { setSelection(null); return; }
      const text = editor.state.doc.textBetween(from, to, '\n');
      if (!text.trim()) { setSelection(null); return; }
      setSelection({ from, to, text });
    };
    editor.on('selectionUpdate', update);
    return () => { editor.off('selectionUpdate', update); };
  }, [editor]);

  // 证据定位（交接文档 7.2）：哈希一致直接用锚点；否则按引文重定位并回写
  useEffect(() => {
    if (!editor || !data || highlightDone.current === evidenceId) return;
    const evidence: DocumentEvidence | undefined = evidenceId
      ? data.evidence.find((e) => e.id === evidenceId)
      : undefined;
    if (!evidence) return;
    highlightDone.current = evidenceId;

    if (evidence.doc_hash_at_ref === data.document.content_hash && evidence.anchor_from < evidence.anchor_to) {
      applyHighlight(editor, evidence.anchor_from, evidence.anchor_to);
      return;
    }
    const located = locateQuote(editor.state.doc, evidence.quote_text, evidence.quote_prefix, evidence.quote_suffix);
    if (located) {
      applyHighlight(editor, located[0], located[1]);
      // 重定位成功回写锚点，让下一次直接命中
      void api.evidenceRelocate(evidence.id, located[0], located[1], data.document.content_hash ?? '')
        .then(() => qc.invalidateQueries({ queryKey: qk.knowledgeDocument(key) }))
        .catch(() => { /* 回写失败不影响本次高亮 */ });
    } else {
      toast.message('引用位置已变化', { description: '无法在当前正文里唯一定位这段引文，已展示保存的原文。' });
    }
  }, [data, evidenceId, editor]);

  const openDialog = () => {
    if (!selection) return;
    setStatement(selection.text);
    setDialogOpen(true);
  };

  const create = useMutation({
    mutationFn: () => {
      if (!selection || !doc) throw new Error('选区已失效');
      const editor = editorRef.current;
      if (!editor) throw new Error('编辑器未就绪');
      const { from, to } = selection;
      const size = editor.state.doc.content.size;
      const quotePrefix = editor.state.doc.textBetween(Math.max(0, from - 40), from, '\n').slice(-32);
      const quoteSuffix = editor.state.doc.textBetween(to, Math.min(size, to + 40), '\n').slice(0, 32);
      return api.topicItemCreate(id, {
        statement: statement.trim(),
        kind,
        evidence: {
          document_key: doc.source_key,
          quote_text: selection.text.trim(),
          quote_prefix: quotePrefix,
          quote_suffix: quoteSuffix,
          anchor_from: from,
          anchor_to: to,
          anchor_basis: 'tiptap-pm-v1',
          doc_hash_at_ref: doc.content_hash ?? '',
        },
      });
    },
    onSuccess: () => {
      setDialogOpen(false);
      setSelection(null);
      void qc.invalidateQueries({ queryKey: qk.knowledgeTopic(id) });
      toast.success('已保存为知识');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading) return <div className="py-16 text-center text-sm text-ink-3"><Loader2 className="mr-2 inline size-4 animate-spin" />加载中…</div>;
  if (isError || !data) return <EmptyState icon={<FileWarning />} title="资料加载失败" desc="请返回重试" />;

  return <div className="mx-auto w-full max-w-3xl">
    <div className="mb-3">
      <button onClick={() => navigate(`/knowledge/topics/${id}`)} className="mb-2 inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink"><ArrowLeft className="size-4" />{data.evidence.length ? '返回主题' : '返回主题'}</button>
      <h2 className="text-xl font-semibold">{doc!.title}</h2>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
        <StatusBadge status={doc!.body_status} />
        {doc!.source_version && <span>{doc!.source_version}</span>}
        {doc!.fetched_at && <span>抓取于 {relTime(doc!.fetched_at)}</span>}
        <span>更新于 {relTime(doc!.updated_at)}</span>
        {doc!.canonical_url && <a href={doc!.canonical_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-ink"><ExternalLink className="size-3" />原文</a>}
        <button onClick={()=>navigate(`/knowledge/documents/${encodeURIComponent(doc!.source_key)}`)} className="hover:text-ink">查看版本历史</button>
        <button onClick={() => refresh.mutate()} disabled={refresh.isPending} className="inline-flex items-center gap-1 hover:text-ink"><RefreshCw className={cn('size-3', refresh.isPending && 'animate-spin')} />刷新</button>
      </div>
      {doc!.body_status === 'suspect' && <div className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600">正文可能不完整，可以阅读，但不能从它生成知识。</div>}
      {doc!.body_status === 'failed' && <div className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">抓取失败：{doc!.fetch_error ?? '未知原因'}</div>}
    </div>

    {selection && doc!.body_status === 'fetched' && (
      <div className="sticky top-2 z-10 mb-2 flex justify-center">
        <Button size="sm" onClick={openDialog}><Plus className="size-3.5" />存为知识</Button>
      </div>
    )}

    <div className="rounded-xl border border-line bg-surface p-4 md:p-6">
      <DocumentEditor
        value={doc!.content}
        editable={false}
        placeholder=""
        extraExtensions={[EvidenceHighlight]}
        onEditorReady={(readyEditor) => { editorRef.current = readyEditor; setEditor(readyEditor); }}
      />
    </div>

    <Dialog open={dialogOpen} onOpenChange={(open)=>{if(!open&&statement.trim()&&!window.confirm('有未保存修改，确定离开吗？'))return;setDialogOpen(open);if(!open)setStatement('');}}>
      <DialogContent className="max-w-lg">
        <div className="space-y-3">
          <h3 className="font-medium">存为知识</h3>
          <div className="max-h-28 overflow-auto rounded-lg bg-surface-2 p-2 text-xs text-ink-2">
            <div className="mb-1 text-[11px] text-ink-3">证据原文（只读）</div>
            {selection?.text}
          </div>
          <textarea value={statement} onChange={(e) => setStatement(e.target.value)} maxLength={2000} rows={3}
            className="w-full resize-none rounded-lg border border-line bg-surface p-2 text-sm outline-none focus:border-ink-3/50"
            placeholder="把这段原文提炼成一句可复用的结论 / 规则…" />
          <div className="flex flex-wrap gap-1.5">
            {KIND_OPTIONS.map((option) => (
              <button key={option} onClick={() => setKind(option)}
                className={cn('rounded-full border px-3 py-1 text-xs transition',
                  kind === option ? 'border-primary bg-primary/10 text-primary' : 'border-line text-ink-3 hover:border-ink-3/40')}>
                {KIND_LABELS[option]}
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => {if(statement.trim()&&!window.confirm('有未保存修改，确定离开吗？'))return;setDialogOpen(false);setStatement('');}}>取消</Button>
            <Button size="sm" onClick={() => create.mutate()} disabled={!statement.trim() || create.isPending}>
              {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
