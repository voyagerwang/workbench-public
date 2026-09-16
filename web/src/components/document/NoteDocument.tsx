/**
 * [INPUT]: Note、标签目录与笔记 API；复用共享文档页和保存会话
 * [OUTPUT]: NoteDocument，仅提供笔记字段映射、标签、置顶与自动标题策略
 * [POS]: NotesView/全页路由到 document 的薄业务适配；正文与保存交互不在此复制
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Clock3, Tags } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import { markdownSummary } from '@/lib/markdown';
import { hasTag, normalizeTags, removeTag } from '@/lib/tags';
import { TagPicker } from '@/components/TagPicker';
import type { Note, NoteWrite } from '@/types';
import { DocumentDetail, DocumentProperty } from './DocumentDetail';
import { useDocumentSession, type DocumentDraft } from './use-document-session';
import type { DetailMode } from './DetailHost';

const AUTO_TITLE_KEY = 'workbench.notes.autoTitle';
function readAutoTitle() { try { return localStorage.getItem(AUTO_TITLE_KEY) !== 'off'; } catch { return true; } }
function localTitle(body: string) {
  for (const line of body.split('\n')) { const text = markdownSummary(line, 60).trim(); if (text) return text.slice(0, 40); }
  return '';
}
function notePatch(value: Partial<DocumentDraft>): NoteWrite {
  const { body, title, tags, pinned } = value;
  return { ...(body !== undefined ? { content: body } : {}), ...(title !== undefined ? { title } : {}),
    ...(tags !== undefined ? { tags: normalizeTags(tags) } : {}), ...(pinned !== undefined ? { pinned } : {}) };
}
export function NoteDocument({ note, allTags, tagCounts, recentTags, onTagUsed, onRegisterFlush, onClose, onDelete, onCreated, mode }: {
  note: Note; allTags: string[]; tagCounts: Record<string, number>; recentTags: string[];
  onTagUsed?: (tag: string) => void; onRegisterFlush?: (fn: (() => Promise<void>) | null) => void;
  onClose: () => void; onDelete?: () => Promise<unknown>; onCreated?: (id: number) => void; mode?: DetailMode;
}) {
  const qc = useQueryClient();
  const idRef = useRef(note.id);
  const [id, setId] = useState(note.id);
  const assistantKey = useRef<string | null>(null);
  const draftKey = useRef(`document:draft:${crypto.randomUUID()}`);
  const titleEdited = useRef(false);
  const titleRequested = useRef(false);
  // 自动标题的保存不刷新 updated_at：列表顺序只跟用户的编辑走
  const autoTitleSave = useRef(false);
  const [autoTitle, setAutoTitle] = useState(readAutoTitle);
  const autoTitleRef = useRef(autoTitle);
  autoTitleRef.current = autoTitle;
  const session = useDocumentSession({
    initial: { title: note.title, body: note.content, tags: normalizeTags(note.tags), pinned: note.pinned === 1 },
    storageKey: () => `note:${idRef.current || 'new'}`,
    persist: async (patch, value) => {
      if (!idRef.current && !value.body.trim()) return; // 空白入口不产生记录
      const creating = !idRef.current;
      // 自动标题是打开文档时系统代写的，不算用户的编辑；若与用户改动混在同一个 patch 里则照常计时
      const touchUpdatedAt = !(autoTitleSave.current && Object.keys(notePatch(patch)).length === 1 && patch.title !== undefined);
      autoTitleSave.current = false;
      const result = creating ? await api.createNote(notePatch(value)) : await api.updateNote(idRef.current, { ...notePatch(patch), touchUpdatedAt });
      idRef.current = result.id;
      setId(result.id);
      if (creating) onCreated?.(result.id);
      if (assistantKey.current?.startsWith('document:draft:')) {
        await api.noteAssistantSession({ noteId: result.id, draftKey: assistantKey.current, title: value.title });
      }
      void qc.invalidateQueries({ queryKey: ['notes'] });
      qc.setQueryData(['document', 'note', result.id], result);
    },
  });
  const flushRef = useRef(session.flush);
  flushRef.current = session.flush;
  useEffect(() => { onRegisterFlush?.(() => flushRef.current()); return () => onRegisterFlush?.(null); }, [onRegisterFlush]);

  useEffect(() => {
    if (!id || session.status !== 'saved' || session.value.title.trim() || !session.value.body.trim() || titleEdited.current || titleRequested.current || session.recovery) return;
    titleRequested.current = true;
    const body = session.value.body;
    void (async () => {
      let title = '';
      if (autoTitleRef.current) {
        try { title = (await api.conversationTitle(body)).title?.trim() ?? ''; } catch { /* 模型失败使用本地首行 */ }
      }
      if (!autoTitleRef.current) title = '';
      title ||= localTitle(body);
      if (session.alive.current && !titleEdited.current && !session.queue.getSnapshot().value.title.trim() && title) {
        autoTitleSave.current = true;
        session.change({ title });
      }
    })();
  }, [id, session]);

  const tags = session.value.tags ?? [];
  const applyTags = (next: string[]) => session.change({ tags: normalizeTags(next) });
  const toggleTag = (tag: string) => {
    if (hasTag(tags, tag)) applyTags(removeTag(tags, tag));
    else { onTagUsed?.(tag); applyTags([...tags, tag]); }
  };
  const actions = [
    { key: 'pin', label: session.value.pinned ? '取消置顶' : '置顶这篇', onSelect: () => session.change({ pinned: !session.value.pinned }) },
    { key: 'auto-title', label: `自动标题：${autoTitle ? '开' : '关'}`, hint: autoTitle ? '模型命名' : '本地首行', onSelect: () => {
      const next = !autoTitle; setAutoTitle(next);
      try { localStorage.setItem(AUTO_TITLE_KEY, next ? 'on' : 'off'); } catch { /* 偏好不能写入不阻碍正文 */ }
    } },
    ...(onDelete ? [{ key: 'delete', label: '删除随手记', tone: 'danger' as const, onSelect: () => {
      void (async () => { await session.flush(); await onDelete(); session.clearDraft(); })().catch((error) => toast.error(error.message));
    } }] : []),
  ];
  return <DocumentDetail session={session} mode={mode} label="随手记" onClose={onClose} actions={actions}
    onTitleEdited={() => { titleEdited.current = true; }} context={{ kind: 'document', ...(id ? { noteId: id } : {}) }}
    getAssistantIdentity={async () => {
      await session.flush();
      const result = await api.noteAssistantSession({
        ...(idRef.current ? { noteId: idRef.current } : { draftKey: draftKey.current }), title: session.value.title,
      });
      assistantKey.current = result.session.id;
      return { sessionKey: result.session.id, context: { kind: 'document', ...(idRef.current ? { noteId: idRef.current } : {}) } };
    }}
    getLink={() => idRef.current ? `/documents/note/${idRef.current}` : null}
    properties={<DocumentProperty icon={Tags} label="标签"><div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => <button key={tag} title="移除标签" className="rounded-full border border-line px-2 py-px text-[11px] hover:text-danger" onClick={() => toggleTag(tag)}>#{tag} ×</button>)}
      <TagPicker allTags={allTags} counts={tagCounts} selected={tags} recent={recentTags} onToggle={toggleTag}
        onCreate={(name) => { onTagUsed?.(name); applyTags([...tags, name]); }} />
    </div></DocumentProperty>}
    secondaryProperties={<>
      <DocumentProperty icon={Clock3} label="创建时间">{note.created_at ? fmtDateTime(note.created_at) : '创建后显示'}</DocumentProperty>
      <DocumentProperty icon={Clock3} label="更新时间">{note.updated_at ? fmtDateTime(note.updated_at) : '尚未保存'}</DocumentProperty>
      {note.source_fragment_id != null && <p className="px-2 text-xs text-ink-4">来自助手记录</p>}
    </>} />;
}
