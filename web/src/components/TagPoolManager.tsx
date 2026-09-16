/**
 * [INPUT]: 统一标签池 API（列表/关联内容/重命名/删除/自动打标补跑）
 * [OUTPUT]: TagPoolManagerDialog——全池一览（资料/手记分侧计数）、全局重命名与删除、关联内容展开、存量补跑
 * [POS]: 知识库侧统一标签管理入口；操作波及资料与手记两个载体，删除前明确告知影响面
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileText, NotebookText, Pencil, Sparkles, Tags, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import type { KnowledgeTag } from '@/types';
import { Button } from '@/ui/button';
import { Dialog, DialogContent } from '@/ui/dialog';
import { Input } from '@/ui/form';
import { EmptyState } from '@/ui/primitives';
import { normalizeTag } from '@/lib/tags';

/** 一套缓存统一失效：池、资料列表、全部资料详情、手记 */
function useTagInvalidator() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.tags });
    void qc.invalidateQueries({ queryKey: ['knowledge', 'pool'] });
    void qc.invalidateQueries({ queryKey: ['knowledge', 'documents'] });
    void qc.invalidateQueries({ queryKey: ['notes'] });
  };
}

export function TagPoolManagerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const invalidate = useTagInvalidator();
  const pool = useQuery({ queryKey: qk.tags, queryFn: api.tagList, enabled: open });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<KnowledgeTag | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeTag | null>(null);
  const [backfilling, setBackfilling] = useState(false);

  const backfill = async () => {
    setBackfilling(true);
    try {
      const result = await api.tagAutoRun();
      toast.success(result.scheduled ? `已为 ${result.scheduled} 份资料排队自动打标` : '所有资料都已有标签，无需补跑');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBackfilling(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="标签池管理" className="max-w-xl">
      <div className="space-y-3 p-5">
        <div className="flex items-start justify-between gap-3 pr-6">
          <p className="text-xs leading-relaxed text-ink-3">
            自动打标和手动加的标签在同一个池子里。重命名、删除会同时作用到资料和随手记；
            从资料上移除过的标签，自动打标不会再加回去。
          </p>
          <Button size="sm" variant="secondary" disabled={backfilling} onClick={() => void backfill()} className="shrink-0">
            <Sparkles className="size-3.5" />{backfilling ? '排队中…' : '补跑自动打标'}
          </Button>
        </div>

        <div className="max-h-[420px] min-h-32 overflow-y-auto rounded-lg border border-line">
          {pool.isLoading && <p className="p-6 text-center text-xs text-ink-3">加载中…</p>}
          {pool.data?.tags.length === 0 && <EmptyState icon={<Tags />} title="还没有标签" desc="自动打标或手动给资料、随手记加标签后会出现在这里" />}
          {pool.data?.tags.map((tag) => <TagRow key={tag.name} tag={tag} expanded={expanded === tag.name}
            onToggleExpand={() => setExpanded((value) => (value === tag.name ? null : tag.name))}
            onRename={() => setRenaming(tag)} onDelete={() => setDeleting(tag)}
            onNavigate={() => onOpenChange(false)} />)}
        </div>
      </div>
    </DialogContent>
    {renaming && <TagRenameDialog tag={renaming} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); invalidate(); }} />}
    {deleting && <TagDeleteDialog tag={deleting} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); setExpanded(null); invalidate(); }} />}
  </Dialog>;
}

function TagRow({ tag, expanded, onToggleExpand, onRename, onDelete, onNavigate }: {
  tag: KnowledgeTag; expanded: boolean; onToggleExpand: () => void; onRename: () => void; onDelete: () => void; onNavigate: () => void;
}) {
  return <div className="border-b border-line last:border-b-0">
    <div className="group/tagrow flex items-center gap-2 px-3 py-2">
      <button onClick={onToggleExpand} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm hover:text-ink">
        {expanded ? <ChevronDown className="size-3.5 shrink-0 text-ink-4" /> : <ChevronRight className="size-3.5 shrink-0 text-ink-4" />}
        <span className="truncate font-medium">#{tag.name}</span>
        <span className="ml-1 inline-flex shrink-0 items-center gap-2 text-[11px] text-ink-4">
          <span className="inline-flex items-center gap-0.5"><FileText className="size-3" />{tag.document_count}</span>
          <span className="inline-flex items-center gap-0.5"><NotebookText className="size-3" />{tag.note_count}</span>
        </span>
      </button>
      <span className="shrink-0 text-[10px] text-ink-4">{tag.origin === 'ai' ? '自动' : ''}</span>
      <button title="重命名" className="shrink-0 rounded-md p-1 text-ink-4 opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover/tagrow:opacity-100" onClick={onRename}><Pencil className="size-3.5" /></button>
      <button title="删除标签" className="shrink-0 rounded-md p-1 text-ink-4 opacity-0 transition-opacity hover:bg-surface-2 hover:text-danger focus-visible:opacity-100 group-hover/tagrow:opacity-100" onClick={onDelete}><Trash2 className="size-3.5" /></button>
    </div>
    {expanded && <TagItems tag={tag.name} onNavigate={onNavigate} />}
  </div>;
}

function TagItems({ tag, onNavigate }: { tag: string; onNavigate: () => void }) {
  const items = useQuery({ queryKey: ['tags', 'items', tag], queryFn: () => api.tagItems(tag) });
  if (items.isLoading) return <p className="px-9 pb-3 text-xs text-ink-4">加载关联内容…</p>;
  const documents = items.data?.documents ?? [];
  const notes = items.data?.notes ?? [];
  if (!documents.length && !notes.length) return <p className="px-9 pb-3 text-xs text-ink-4">没有内容在使用这个标签</p>;
  return <div className="space-y-1 px-9 pb-3 text-xs">
    {documents.map((doc) => <Link key={doc.source_key} to={`/knowledge/documents/${encodeURIComponent(doc.source_key)}`}
      className="block truncate text-primary hover:underline" onClick={onNavigate}>
      <FileText className="mr-1 inline size-3" />{doc.title || '未命名资料'}</Link>)}
    {notes.map((note) => <span key={note.id} className="block truncate text-ink-2"><NotebookText className="mr-1 inline size-3 text-ink-4" />{note.title || '未命名手记'}</span>)}
  </div>;
}

function TagRenameDialog({ tag, onClose, onDone }: { tag: KnowledgeTag; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(tag.name);
  const [busy, setBusy] = useState(false);
  const cleaned = normalizeTag(name);
  // 大小写差异也算有效改名（服务端 NOCASE 唯一索引会统一写法）；完全没改就不允许提交
  const same = !cleaned || cleaned.toLowerCase() === tag.name.toLowerCase();
  const submit = async () => {
    if (!cleaned || same) return;
    setBusy(true);
    try {
      const result = await api.tagRename(tag.name, cleaned);
      toast.success(`已改名为「${cleaned}」`, { description: `资料 ${result.documents} 篇、手记 ${result.notes} 条同步更新` });
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open onOpenChange={(value) => { if (!value) onClose(); }}>
    <DialogContent title="重命名标签" className="max-w-md">
      <div className="space-y-4 p-5">
        <p className="text-xs leading-relaxed text-ink-3">所有带「#{tag.name}」的资料和随手记会一起改用新名字。</p>
        <Input autoFocus value={name} onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && cleaned && !same && !busy) void submit(); }} placeholder="新的标签名" />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>取消</Button>
          <Button size="sm" disabled={!cleaned || same || busy} onClick={() => void submit()}>{busy ? '处理中…' : '重命名'}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

function TagDeleteDialog({ tag, onClose, onDone }: { tag: KnowledgeTag; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const result = await api.tagDelete(tag.name);
      toast.success(`已删除标签「${tag.name}」`, { description: `从 ${result.documents} 篇资料和 ${result.notes} 条手记上摘除；自动打标不会再使用它` });
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open onOpenChange={(value) => { if (!value) onClose(); }}>
    <DialogContent title="删除标签" className="max-w-md">
      <div className="space-y-4 p-5">
        <p className="text-xs leading-relaxed text-ink-3">
          「#{tag.name}」会从所有资料和随手记上摘掉（内容本身不会丢），标签从池子里消失，自动打标也不再使用这个名字。
        </p>
        <p className="text-xs text-ink-4">当前资料 {tag.document_count} 篇、手记 {tag.note_count} 条在用。</p>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="dangerGhost" size="sm" disabled={busy} onClick={() => void submit()}>{busy ? '处理中…' : '删除标签'}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
