/**
 * [INPUT]: 业务文档初值、保存适配和稳定身份；复用 SaveQueue
 * [OUTPUT]: useDocumentSession，提供共享草稿、保存状态、恢复与离开保护
 * [POS]: 文档 UI 与持久化之间的会话层，正文和属性的唯一可编辑状态
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SaveQueue } from './save-queue';
import { registerDocumentGuard } from './navigation';

export type DocumentDraft = {
  title: string; body: string; tags?: string[]; pinned?: boolean;
  status?: 'todo' | 'doing' | 'done'; plannedDate?: string | null;
};
const PREFIX = 'workbench.document.draft:';
function readDraft(key: string): DocumentDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + key) ?? 'null');
    if (!value || typeof value.title !== 'string' || typeof value.body !== 'string') return null;
    if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag: unknown) => typeof tag !== 'string'))) return null;
    return value;
  } catch { return null; }
}
export function useDocumentSession({ initial, storageKey, persist }: {
  initial: DocumentDraft; storageKey: () => string;
  persist: (patch: Partial<DocumentDraft>, value: DocumentDraft) => Promise<void>;
}) {
  const latest = useRef({ persist, storageKey });
  latest.current = { persist, storageKey };
  const [queue] = useState(() => new SaveQueue(initial, (patch, value) => latest.current.persist(patch, value)));
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [recovery, setRecovery] = useState(() => readDraft(storageKey()));
  const [uploading, setUploading] = useState(false);
  const uploadFlush = useRef<(() => Promise<void>) | null>(null);
  const uploadBusy = useRef(false);
  const alive = useRef(true);
  const [external, setExternal] = useState<DocumentDraft | null>(null);
  const initialVersion = useRef(JSON.stringify(initial));
  const storageError = useRef(false);
  const previousKey = useRef(storageKey());
  const [draftWarning, setDraftWarning] = useState(false);
  const saveLocal = () => {
    const key = latest.current.storageKey();
    try {
      if (queue.dirty) localStorage.setItem(PREFIX + key, JSON.stringify(queue.getSnapshot().value));
      else if (!recovery) localStorage.removeItem(PREFIX + key);
      if (key !== previousKey.current) localStorage.removeItem(PREFIX + previousKey.current);
      previousKey.current = key;
      storageError.current = false;
    } catch { storageError.current = true; }
  };
  const localRef = useRef(saveLocal);
  localRef.current = saveLocal;
  const flush = async () => {
    if (recovery) throw new Error('请先恢复或丢弃上次未保存的草稿');
    await uploadFlush.current?.();
    await queue.flush();
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    alive.current = true;
    const unsubscribe = queue.subscribe(() => {
      localRef.current();
      if (alive.current) setDraftWarning(storageError.current);
    });
    const unregister = registerDocumentGuard({
      dirty: () => queue.dirty || uploadBusy.current,
      flush: () => flushRef.current(),
    });
    const hide = () => { localRef.current(); void flushRef.current().catch(() => {}); };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!queue.dirty && !uploadBusy.current) return;
      localRef.current(); event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      alive.current = false;
      localRef.current(); queue.pause(); unsubscribe(); unregister();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [queue]);

  useEffect(() => {
    const version = JSON.stringify(initial);
    if (version === initialVersion.current) return;
    initialVersion.current = version;
    // 保存响应是自己的确认，不向编辑器回灌。外部字段变化单独合并。
    if (queue.isOwnVersion(initial)) return;
    if (queue.dirty) { queue.hold(); setExternal(initial); return; }
    queue.reset(initial);
  }, [initial, queue]);

  return {
    ...snapshot, queue, uploading, recovery, external, draftWarning, alive,
    change: (patch: Partial<DocumentDraft>) => queue.change(patch),
    flush,
    onUploadingChange: (busy: boolean) => { uploadBusy.current = busy; setUploading(busy); },
    registerUploadFlush: (fn: (() => Promise<void>) | null) => { uploadFlush.current = fn; },
    restore: () => { if (recovery) { queue.change(recovery); setRecovery(null); } },
    discardRecovery: () => { localStorage.removeItem(PREFIX + storageKey()); setRecovery(null); },
    keepLocal: () => { queue.release(); setExternal(null); queue.change(queue.getSnapshot().value); },
    useExternal: async () => { await queue.settle(); if (external) queue.reset(external); queue.release(); setExternal(null); },
    clearDraft: () => { queue.stop(); localStorage.removeItem(PREFIX + storageKey()); },
  };
}
export type DocumentSession = ReturnType<typeof useDocumentSession>;
