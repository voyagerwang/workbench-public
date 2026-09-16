/**
 * [INPUT]: 依赖知识库目录浏览接口、BrowseNode/KnowledgeSyncScope 契约与基础 UI
 * [OUTPUT]: 对外提供 FeishuScopePicker，在空间与云文档目录树中选择可枚举范围
 * [POS]: 知识库接入流程的共享范围选择器，被存档同步和资料池批次导入共同消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, ChevronRight, FileText, Folder, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { BrowseBranch, BrowseNode, KnowledgeSyncScope } from '@/types';
import { cn, relTime } from '@/lib/utils';

export function FeishuScopePicker({ scope, onChange, disabled, containersOnly = false }: {
  scope: KnowledgeSyncScope;
  onChange: (scope: KnowledgeSyncScope) => void;
  disabled?: boolean;
  containersOnly?: boolean;
}) {
  const [dimension, setDimension] = useState<'wiki' | 'drive'>('wiki');
  const wiki = scope.wiki ?? [];
  const drive = scope.drive ?? [];
  const docs = scope.docs ?? [];
  const isSelected = (node: BrowseNode) => {
    if (node.kind === 'space') return wiki.some((item) => item.spaceId === node.key && !item.parentNodeToken);
    if (node.kind === 'folder') return node.branch?.root === 'drive'
      ? drive.includes(node.key)
      : wiki.some((item) => item.spaceId === node.branch?.spaceId && item.parentNodeToken === node.key);
    return docs.some((item) => item.reference === node.key);
  };
  const toggle = (node: BrowseNode, spaceName?: string) => {
    if (node.kind === 'space') {
      const exists = wiki.some((item) => item.spaceId === node.key && !item.parentNodeToken);
      onChange({ ...scope, wiki: exists ? wiki.filter((item) => !(item.spaceId === node.key && !item.parentNodeToken)) : [...wiki, { spaceId: node.key, spaceName: node.title }] });
    } else if (node.kind === 'folder' && node.branch?.root === 'drive') {
      onChange({ ...scope, drive: drive.includes(node.key) ? drive.filter((key) => key !== node.key) : [...drive, node.key] });
    } else if (node.kind === 'folder' && node.branch?.spaceId && spaceName) {
      const exists = wiki.some((item) => item.spaceId === node.branch?.spaceId && item.parentNodeToken === node.key);
      onChange({ ...scope, wiki: exists ? wiki.filter((item) => !(item.spaceId === node.branch?.spaceId && item.parentNodeToken === node.key)) : [...wiki, { spaceId: node.branch.spaceId, spaceName, parentNodeToken: node.key }] });
    } else if (!containersOnly) {
      const exists = docs.some((item) => item.reference === node.key);
      onChange({ ...scope, docs: exists ? docs.filter((item) => item.reference !== node.key) : [...docs, { reference: node.key, title: node.title }] });
    }
  };
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2">
      <div className="flex gap-2">{(['wiki', 'drive'] as const).map((item) => <button key={item} type="button" disabled={disabled} onClick={() => setDimension(item)} className={cn('rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40', dimension === item ? 'border-accent/40 bg-accent-dim text-ink' : 'border-line text-ink-3')}>{item === 'wiki' ? '知识空间' : '云文档文件夹'}</button>)}</div>
      <SelectAllButton dimension={dimension} scope={scope} onChange={onChange} disabled={disabled} containersOnly={containersOnly} />
    </div>
    <div className="max-h-72 overflow-y-auto rounded-xl border border-line bg-surface-2"><TreeNodeList branch={dimension === 'wiki' ? null : { root: 'drive' }} isSelected={isSelected} onToggle={toggle} disabled={disabled} containersOnly={containersOnly} /></div>
    <p className="text-[11px] text-ink-4">勾选空间或文件夹后，服务端会先枚举范围并给出清单；不会自动扫描未选择的目录。</p>
  </div>;
}

function SelectAllButton({ dimension, scope, onChange, disabled, containersOnly }: { dimension: 'wiki' | 'drive'; scope: KnowledgeSyncScope; onChange: (scope: KnowledgeSyncScope) => void; disabled?: boolean; containersOnly: boolean }) {
  const branch = dimension === 'wiki' ? null : ({ root: 'drive' } as BrowseBranch);
  const { data: nodes } = useQuery({ queryKey: ['knowledge-browse', branch], queryFn: () => api.browseKnowledge(branch), retry: false });
  if (!nodes?.length) return null;
  const selectable = nodes.filter((node) => !containersOnly || node.kind !== 'doc');
  const selected = (node: BrowseNode) => node.kind === 'space'
    ? (scope.wiki ?? []).some((item) => item.spaceId === node.key && !item.parentNodeToken)
    : node.kind === 'folder' ? (scope.drive ?? []).includes(node.key) : (scope.docs ?? []).some((item) => item.reference === node.key);
  const allSelected = selectable.length > 0 && selectable.every(selected);
  const toggleAll = () => {
    const rootKeys = new Set(selectable.map((node) => node.key));
    if (dimension === 'wiki') {
      const retained = (scope.wiki ?? []).filter((item) => item.parentNodeToken || !rootKeys.has(item.spaceId));
      onChange({ ...scope, wiki: allSelected ? retained : [...retained, ...selectable.filter((node) => node.kind === 'space').map((node) => ({ spaceId: node.key, spaceName: node.title }))] });
    } else {
      const folders = (scope.drive ?? []).filter((key) => !rootKeys.has(key));
      const docs = (scope.docs ?? []).filter((item) => !rootKeys.has(item.reference));
      onChange({ ...scope, drive: allSelected ? folders : [...folders, ...selectable.filter((node) => node.kind === 'folder').map((node) => node.key)], docs: allSelected ? docs : [...docs, ...selectable.filter((node) => node.kind === 'doc').map((node) => ({ reference: node.key, title: node.title }))] });
    }
  };
  return <button type="button" disabled={disabled || !selectable.length} onClick={toggleAll} className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-3 disabled:opacity-40">{allSelected ? '取消' : '全选'}</button>;
}

function TreeNodeList({ branch, spaceName, isSelected, onToggle, disabled, containersOnly, depth = 0 }: { branch: BrowseBranch | null; spaceName?: string; isSelected: (node: BrowseNode) => boolean; onToggle: (node: BrowseNode, spaceName?: string) => void; disabled?: boolean; containersOnly: boolean; depth?: number }) {
  const nodes = useQuery({ queryKey: ['knowledge-browse', branch], queryFn: () => api.browseKnowledge(branch), retry: false });
  if (nodes.isPending) return <div className="flex items-center gap-2 p-4 text-xs text-ink-3"><Loader2 className="size-4 animate-spin" />正在读取目录…</div>;
  if (nodes.isError) return <div className="flex items-start gap-2 p-4 text-xs text-warn"><AlertCircle className="size-4" />{(nodes.error as Error).message}</div>;
  if (!nodes.data?.length) return <div className="p-4 text-xs text-ink-4">这一层没有可接入的内容</div>;
  return <div className="divide-y divide-line">{nodes.data.map((node) => <TreeRow key={node.key} node={node} spaceName={spaceName} isSelected={isSelected} onToggle={onToggle} disabled={disabled} containersOnly={containersOnly} depth={depth} />)}</div>;
}

function TreeRow({ node, spaceName, isSelected, onToggle, disabled, containersOnly, depth }: { node: BrowseNode; spaceName?: string; isSelected: (node: BrowseNode) => boolean; onToggle: (node: BrowseNode, spaceName?: string) => void; disabled?: boolean; containersOnly: boolean; depth: number }) {
  const [open, setOpen] = useState(false);
  const expandable = node.hasChild && node.branch != null;
  const canSelect = !containersOnly || node.kind !== 'doc';
  return <div>
    <div className={cn('flex items-center gap-2 py-1.5 pr-3 text-xs hover:bg-surface-2', disabled && 'opacity-60')} style={{ paddingLeft: 10 + depth * 16 }}>
      {expandable ? <button type="button" onClick={() => setOpen((value) => !value)} className="flex size-4 items-center justify-center">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button> : <span className="size-4" />}
      {canSelect ? <input type="checkbox" disabled={disabled} checked={isSelected(node)} onChange={() => onToggle(node, spaceName)} className="size-3.5" /> : <span className="size-3.5" />}
      {node.kind === 'doc' ? <FileText className="size-3.5 text-ink-4" /> : <Folder className="size-3.5 text-accent" />}
      <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => expandable && setOpen((value) => !value)}>{node.title}</button>
      {node.kind === 'doc' && node.indexed && <span className="text-[9px] text-accent">已索引</span>}
      {node.kind !== 'doc' && node.syncedAt && <span className="text-[9px] text-accent">已同步 · {relTime(node.syncedAt)}</span>}
      <span className="text-[9px] text-ink-4">{node.kind === 'space' ? '空间' : node.kind === 'folder' ? '文件夹' : node.type ?? '文档'}</span>
    </div>
    {open && expandable && <TreeNodeList branch={node.branch!} spaceName={node.kind === 'space' ? node.title : spaceName} isSelected={isSelected} onToggle={onToggle} disabled={disabled} containersOnly={containersOnly} depth={depth + 1} />}
  </div>;
}
