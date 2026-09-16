/**
 * [INPUT]: 附件节点身份、附件 API、PDF 预览组件
 * [OUTPUT]: AttachmentBlock 扩展，普通附件下载及 PDF/PPT 内嵌阅读
 * [POS]: 共用编辑器文件块；正文只存标准附件链接，元信息与转换状态从服务器读取
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MarkdownNodeSpec } from 'tiptap-markdown';
import { Download, FileText, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
const PdfPreview = lazy(() => import('./PdfPreview'));
const linkPattern = /^\/api\/attachments\/([a-z0-9]+-[a-f0-9]{12})\/download$/;
function AttachmentView({ node, editor, deleteNode }: NodeViewProps) {
  const id = String(node.attrs.id);
  const client = useQueryClient();
  const [open, setOpen] = useState(true);
  const [failure, setFailure] = useState('');
  const [starting, setStarting] = useState(false);
  const queryKey = ['document-attachment', id];
  const query = useQuery({ queryKey, queryFn: () => api.attachment(id), retry: 1,
    refetchInterval: (value) => value.state.data?.previewStatus === 'pending' ? 1200 : false });
  const file = query.data;
  const prepare = async () => {
    setStarting(true); setFailure('');
    try { client.setQueryData(queryKey, await api.prepareAttachmentPreview(id)); }
    catch (error) { setFailure((error as Error).message); }
    finally { setStarting(false); }
  };
  useEffect(() => {
    if (open && file?.previewStatus === 'idle' && !starting && !failure) void prepare();
    // 服务端按文件合并并发转换，idle 只在初次或服务重启后出现。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file?.previewStatus]);
  const canPreview = file?.kind === 'pdf' || file?.kind === 'slides';
  return <NodeViewWrapper contentEditable={false} data-document-attachment className="my-4 max-w-full overflow-hidden rounded-xl border border-line bg-surface-1">
    <div className="flex min-w-0 items-center gap-2 p-3">
      <FileText className="size-5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium" title={file?.name || node.attrs.name}>{file?.name || node.attrs.name || '附件'}</div>
        {file && <div className="text-xs text-ink-3">{file.ext.slice(1).toUpperCase() || '文件'} · {file.size >= 1048576 ? `${(file.size / 1048576).toFixed(1)} MB` : `${Math.ceil(file.size / 1024)} KB`}</div>}</div>
      {canPreview && <button type="button" aria-label={open ? '收起文件预览' : '展开文件预览'} className="rounded p-2 hover:bg-surface-2" onClick={() => setOpen((value) => !value)}>{open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</button>}
      <a aria-label="下载原文件" title="下载原文件" href={`/api/attachments/${id}/download`} download className="rounded p-2 text-ink-2 hover:bg-surface-2"><Download className="size-4" /></a>
      {editor.isEditable && <button type="button" aria-label="移除附件" title="移除附件" className="rounded p-2 text-ink-3 hover:bg-surface-2 hover:text-danger" onClick={deleteNode}><Trash2 className="size-4" /></button>}
    </div>
    {query.isError && <div role="alert" className="p-3 text-xs text-danger">附件暂时无法读取 <button className="underline" onClick={() => void query.refetch()}>重试读取</button></div>}
    {open && canPreview && <>
      {(starting || file?.previewStatus === 'pending') && <p role="status" className="p-3 text-xs text-ink-3">正在生成翻页预览，可继续编辑文档…</p>}
      {(failure || file?.previewStatus === 'error') && <div role="alert" className="p-3 text-xs text-danger">{failure || '预览生成失败，原文件已保留'} <button className="underline" disabled={starting} onClick={() => void prepare()}>重试生成预览</button></div>}
      {file?.previewUrl && <Suspense fallback={<p className="p-3 text-xs text-ink-3">正在加载预览组件…</p>}><PdfPreview url={file.previewUrl} name={file.name} /></Suspense>}
    </>}
  </NodeViewWrapper>;
}
const markdown: MarkdownNodeSpec = {
  serialize(state, node) { state.write(`[${state.esc(node.attrs.name || '附件')}](/api/attachments/${node.attrs.id}/download)`); state.closeBlock(node); },
};
export const AttachmentBlock = Node.create({
  name: 'attachment', group: 'block', atom: true, draggable: true,
  addAttributes() { return {
    id: { default: null, parseHTML: (element) => linkPattern.exec(element.getAttribute('href') || '')?.[1] || null },
    name: { default: '附件', parseHTML: (element) => element.textContent || '附件' },
  }; },
  parseHTML() { return [{ tag: 'a[href^="/api/attachments/"]', priority: 1000, getAttrs: (element) => {
    const match = linkPattern.exec(element.getAttribute('href') || '');
    return match ? { id: match[1], name: element.textContent || '附件' } : false;
  } }]; },
  renderHTML({ node, HTMLAttributes }) { return ['a', mergeAttributes(HTMLAttributes, { href: `/api/attachments/${node.attrs.id}/download` }), node.attrs.name]; },
  addStorage() { return { markdown }; },
  addNodeView() { return ReactNodeViewRenderer(AttachmentView); },
});
