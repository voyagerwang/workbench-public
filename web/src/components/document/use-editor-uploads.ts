/**
 * [INPUT]: 当前 TipTap 实例、上传 API 与宿主状态回调
 * [OUTPUT]: 图片/附件批量上传、2–4 图画廊分组、部分失败重试与等待上传完成的 flush
 * [POS]: DocumentEditor 的上传生命周期；绑定原编辑器和映射后的插入位置，上传完成后再建立画廊结构
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { api } from '@/lib/api';
import { isInlineImage } from '@/lib/editor-images';
import type { JSONContent } from '@tiptap/core';
function groupImages(nodes: JSONContent[]) {
  const grouped: JSONContent[] = [];
  let images: JSONContent[] = [];
  const flush = () => {
    while (images.length) {
      const batch = images.splice(0, 4);
      grouped.push(batch.length === 1 ? batch[0] : { type: 'imageGallery', content: batch });
    }
  };
  for (const node of nodes) {
    if (node.type === 'image') images.push(node);
    else { flush(); grouped.push(node); }
  }
  flush();
  return grouped;
}
export function useEditorUploads(editorRef: RefObject<Editor | null>, onBusy?: (busy: boolean) => void) {
  const [count, setCount] = useState(0);
  const [failed, setFailed] = useState<File[]>([]);
  const [failureMessages, setFailureMessages] = useState<string[]>([]);
  const reasons = useRef(new Map<File, string>());
  const failedRef = useRef<File[]>([]);
  const pending = useRef(new Set<Promise<void>>());
  const busyRef = useRef(onBusy); busyRef.current = onBusy;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = () => {
    if (!alive.current) return;
    setCount(pending.current.size); setFailed([...failedRef.current]);
    setFailureMessages(failedRef.current.map((file) => `${file.name}：${reasons.current.get(file) || '上传失败'}`));
    busyRef.current?.(pending.current.size > 0 || failedRef.current.length > 0);
  };
  const upload = (files: File[]) => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || !files.length) return;
    let bookmark = editor.state.selection.getBookmark();
    const map = ({ transaction }: { transaction: Transaction }) => { bookmark = bookmark.map(transaction.mapping); };
    editor.on('transaction', map);
    const work = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(files.map(async (file): Promise<JSONContent> => {
        if (file.size > 50 * 1024 * 1024) throw new Error('单个文件不能超过 50MB');
        if (isInlineImage(file)) {
          const uploaded = await api.uploadFile(file);
          return { type: 'image', attrs: { src: uploaded.url } };
        }
        const uploaded = await api.uploadAttachment(file);
        return { type: 'attachment', attrs: { id: uploaded.id, name: uploaded.name } };
      }));
      if (editor.isDestroyed || !alive.current) return;
      const nodes = results.flatMap((result, index) => {
        if (result.status === 'rejected') { failedRef.current.push(files[index]); reasons.current.set(files[index], result.reason instanceof Error ? result.reason.message : '上传失败'); return []; }
        return [result.value];
      });
      if (nodes.length) {
        const position = bookmark.resolve(editor.state.doc).from;
        editor.chain().insertContentAt(position, groupImages(nodes)).run();
      }
    }).finally(() => { editor.off('transaction', map); pending.current.delete(work); refresh(); });
    pending.current.add(work); refresh();
  };
  const flush = async () => {
    while (pending.current.size) await Promise.all([...pending.current]);
    if (failedRef.current.length) throw new Error('文件上传失败，请重试或移除失败文件');
  };
  return { count, failed, failureMessages, upload, flush,
    retry: () => { const files = failedRef.current; failedRef.current = []; reasons.current.clear(); upload(files); },
    discard: () => { failedRef.current = []; reasons.current.clear(); refresh(); },
  };
}
