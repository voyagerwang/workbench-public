/**
 * [INPUT]: Markdown 正文、TipTap 扩展、统一图片/文件上传与编辑菜单；创建提醒 API（提醒事项入口）
 * [OUTPUT]: DocumentEditor，提供图片画廊、文档表格、格式编辑、文件阅读、上传排空回调与正文内提醒条目
 * [POS]: 清单、随手记与知识存档的唯一正文编辑器，Markdown 为持久化格式
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Extension, Mark, markInputRule, markPasteRule, mergeAttributes, type Extensions } from '@tiptap/core';
import { useQueryClient } from '@tanstack/react-query';
import StarterKit from '@tiptap/starter-kit';
import { AttachmentBlock } from '@/components/document/AttachmentBlock';
import { ResizableImage } from '@/components/document/ResizableImage';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import { Loader2, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import type { RepeatRule } from '@/types';
import { useEditorUploads } from '@/components/document/use-editor-uploads';
import { EditorMenus, type InsertAnchor } from '@/components/document/EditorMenus';
import { ReminderComposer } from '@/components/document/ReminderComposer';
import { cn, repeatLabel } from '@/lib/utils';
import { ImageLightbox } from '@/components/ImageLightbox';
import { filesFromTransfer, isInlineImage } from '@/lib/editor-images';
import { documentTableExtensions, TableMenu } from '@/components/document/DocumentTable';
import { ImageGallery } from '@/components/document/ImageGallery';

/** Tab / Shift-Tab 在列表内缩进 / 反缩进（多级列表） */
const ListIndent = Extension.create({
  name: 'listIndent',
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => (editor.can().sinkListItem('listItem') ? editor.commands.sinkListItem('listItem') : false),
      'Shift-Tab': ({ editor }) => (editor.can().liftListItem('listItem') ? editor.commands.liftListItem('listItem') : false),
    };
  },
});

const TRAILING_URL_PUNCTUATION = /[.,;:!?\]}））》】、。，；：！？]+$/;

function cleanUrl(value: string) {
  return value.trim().replace(TRAILING_URL_PUNCTUATION, '');
}

/** 不依赖额外包的链接 mark：Markdown 可读写，纯文本 URL 输入/粘贴会自动变成可点击链接。 */
const AutoLink = Mark.create({
  name: 'link',
  inclusive: false,
  addAttributes() {
    return {
      href: { default: null },
      target: { default: '_blank' },
      rel: { default: 'noreferrer noopener' },
    };
  },
  parseHTML() {
    return [{ tag: 'a[href]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['a', mergeAttributes(HTMLAttributes, { target: '_blank', rel: 'noreferrer noopener' }), 0];
  },
  addInputRules() {
    return [markInputRule({
      find: /(^|\s)(https?:\/\/[^\s<]+)$/i,
      type: this.type,
      getAttributes: (match) => ({ href: cleanUrl(match[2]) }),
    })];
  },
  addPasteRules() {
    return [markPasteRule({
      find: /https?:\/\/[^\s<]+/gi,
      type: this.type,
      getAttributes: (match) => ({ href: cleanUrl(match[0]) }),
    })];
  },
});

export function DocumentEditor({ value, onChange, editable = true, placeholder = '写点什么…', className, extraExtensions, onEditorReady, onUploadingChange, onRegisterUploadFlush }: {
  /** Markdown 源码（落库格式） */
  value: string;
  onChange?: (markdown: string) => void;
  editable?: boolean;
  placeholder?: string;
  className?: string;
  /** 额外的 TipTap 扩展，例如清单详情里的内嵌助手 */
  extraExtensions?: Extensions;
  onEditorReady?: (editor: Editor | null) => void;
  /** 文件上传中状态，供外层显示「上传文件…」 */
  onUploadingChange?: (busy: boolean) => void;
  onRegisterUploadFlush?: (flush: (() => Promise<void>) | null) => void;
}) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [insertAnchor, setInsertAnchor] = useState<InsertAnchor | null>(null);
  const [reminderOpen, setReminderOpen] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const uploads = useEditorUploads(editorRef, onUploadingChange);
  const uploadRef = useRef(uploads); uploadRef.current = uploads;
  const qc = useQueryClient();
  const syncedRef = useRef(value);
  useEffect(() => {
    onRegisterUploadFlush?.(() => uploadRef.current.flush());
    return () => onRegisterUploadFlush?.(null);
  }, [onRegisterUploadFlush]);

  const editor = useEditor({
    extensions: [
      // transformPastedText：粘贴进来的 Markdown 源码直接变成排版结果（不是源码文本）
      // linkify：导入的网页 / 飞书正文里常有裸写的 https://…，不开这个它们永远是纯文本
      Markdown.configure({ html: false, breaks: true, linkify: true, transformPastedText: true }),
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      AutoLink,
      ResizableImage.configure({ onPreview: setPreviewSrc }),
      ImageGallery,
      AttachmentBlock,
      ...documentTableExtensions,
      ListIndent,
      TaskList,
      // 待办清单：单独的内容块，仅作为正文的一部分在详情里展示，
      // 不写入「清单」任务系统、也不作为独立清单实体。nested 允许子级勾选与 Tab 缩进。
      TaskItem.configure({ nested: true }),
      ...(extraExtensions ?? []),
      Placeholder.configure({ placeholder }),
    ],
    content: value || '',
    editable,
    editorProps: {
      attributes: { class: 'outline-none', 'aria-label': '文档正文' },
      handleKeyDown: (view, event) => {
        if (event.isComposing || !view.editable || (event.key !== '/' && event.key !== '\\')) return false;
        const { $from, empty } = view.state.selection;
        if (!empty || $from.parent.type.name !== 'paragraph' || $from.parent.content.size !== 0) return false;
        event.preventDefault();
        const position = view.coordsAtPos(view.state.selection.from);
        setInsertAnchor({ left: position.left, top: position.bottom + 6 });
        return true;
      },
      // 可编辑的 ProseMirror 会吞掉 <a> 的原生跳转（点一下只是把光标放进去），
      // 知识存档这类以阅读为主的文档等于「链接全变成了纯文本」。这里接管左键点击，
      // 一律新标签页打开；⌘/Ctrl 同理（浏览器默认行为也被拦下来统一走这里）。
      handleClickOn: (_view, _pos, _node, _nodePos, event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
        const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        const href = anchor?.getAttribute('href');
        if (!href) return false;
        event.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
        return true;
      },
      handlePaste: (_view, event) => {
        if (!editorRef.current?.isEditable) return false;
        const files = filesFromTransfer(event.clipboardData);
        if (!files.length) return false;
        event.preventDefault();
        uploadRef.current.upload(files);
        return true;
      },
      handleDrop: (view, event) => {
        if (!editorRef.current?.isEditable) return false;
        const files = filesFromTransfer(event.dataTransfer);
        if (!files.length) return false;
        event.preventDefault();
        const drop = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (drop) editorRef.current.commands.setTextSelection(drop.pos);
        uploadRef.current.upload(files);
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      const markdown = current.storage.markdown.getMarkdown();
      syncedRef.current = markdown;
      onChangeRef.current?.(markdown);
    },
  });

  useEffect(() => {
    editorRef.current = editor ?? null;
    onEditorReady?.(editor ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // 外部换了文档（不是编辑器自己产出的改动）才回写，避免把光标重置掉
  useEffect(() => {
    if (!editor || value === syncedRef.current) return;
    // Query invalidation after autosave can deliver the just-saved Markdown back
    // while the user is still typing. Re-parsing it at that point normalizes
    // empty paragraphs and makes intermediate blank lines disappear. The editor
    // is authoritative while focused; the next blur/reopen will pick up any
    // genuinely external change.
    if (editor.isFocused) return;
    syncedRef.current = value;
    editor.commands.setContent(value || '', false);
  }, [value, editor]);

  // If an external update arrived while editing, apply it once the editor is
  // no longer focused instead of interrupting the current typing session.
  useEffect(() => {
    if (!editor) return;
    const syncOnBlur = () => {
      if (value === syncedRef.current) return;
      syncedRef.current = value;
      editor.commands.setContent(value || '', false);
    };
    editor.on('blur', syncOnBlur);
    return () => { editor.off('blur', syncOnBlur); };
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  /**
   * 正文里加一条提醒。
   *
   * 顺序必须是「先落库、再写正文」：反过来的话，模型/网络一失败，正文里就留下一条
   * 「写着设了提醒、实际什么都没设」的假记录，而这行字看起来跟真的一样。
   */
  const saveReminder = async ({ message, triggerAt, repeatRule }: { message: string; triggerAt: string; repeatRule: RepeatRule }) => {
    try {
      const created = await api.createReminder({ message, triggerAt, repeatRule });
      const target = editorRef.current;
      if (!target || target.isDestroyed) throw new Error('编辑器未就绪，正文没写上，请到提醒页确认这条');
      const label = `⏰ ${created.message} · ${created.trigger_at.replace('T', ' ')}`
        + (created.repeat_rule && created.repeat_rule !== 'none' ? `（${repeatLabel(created.repeat_rule)}）` : '');
      // 光标此刻停在那个空段落上（/ 菜单的触发前提）：整段换成「引用块 + 空段落」，
      // 光标落到引用块下方，接着写不会粘在提醒条目上。
      const { $from } = target.state.selection;
      if ($from.depth === 1) {
        target.chain().focus().insertContentAt({ from: $from.before(1), to: $from.after(1) }, [
          { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }] },
          { type: 'paragraph' },
        ]).run();
      } else {
        // 嵌套场景（列表项/引用里的空段落）退回最小动作，能用就行
        target.chain().focus().toggleBlockquote().insertContent(label).run();
      }
      void qc.invalidateQueries({ queryKey: qk.reminders });
      toast.success('提醒已添加，正文里留下了条目');
    } catch (error) {
      toast.error('提醒没建上', { description: (error as Error).message });
      throw error;
    }
  };

  return <div className={cn('md-body tiptap relative flex flex-col text-sm', className)}>
    {editor && editable && <EditorMenus editor={editor} anchor={insertAnchor} onClose={() => setInsertAnchor(null)}
      onImportFile={() => fileInput.current?.click()} onInsertReminder={() => setReminderOpen(true)} />}
    <ReminderComposer open={reminderOpen} onClose={() => setReminderOpen(false)} onSave={saveReminder} />
    {editor && editable && <TableMenu editor={editor} />}
    {editable && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-3">
      <button type="button" className="flex items-center gap-1 rounded px-2 py-1 hover:bg-surface-2 hover:text-ink" onMouseDown={(event) => event.preventDefault()} onClick={() => fileInput.current?.click()}><Paperclip className="size-3.5" />导入文件</button>
      <span className="text-[11px] text-ink-4">PDF / PPT 可翻页 · 文件 ≤50MB，图片 ≤10MB</span>
      <input ref={fileInput} type="file" multiple className="hidden" aria-label="导入文档文件" onChange={(event) => {
        uploads.upload(Array.from(event.target.files || [])); event.target.value = '';
      }} />
    </div>}
    <EditorContent editor={editor} />
    {uploads.count > 0 && <div className="pointer-events-none sticky bottom-2 left-0 flex items-center gap-1.5 self-start rounded-full border border-line bg-surface-2/90 px-2.5 py-1 text-[11px] text-ink-3 shadow-sm"><Loader2 className="size-3 animate-spin" />正在上传文件…</div>}
    {uploads.failed.length > 0 && <div role="alert" className="mt-2 rounded-lg border border-danger/30 p-2 text-xs text-danger">
      {uploads.failed.every(isInlineImage) ? `${uploads.failed.length} 张图片上传失败，尚未写入正文。` : `${uploads.failed.length} 个文件上传失败，尚未写入正文。`}
      <button className="ml-2 underline" onClick={uploads.retry}>{uploads.failed.every(isInlineImage) ? '重试图片上传' : '重试文件上传'}</button>
      <button className="ml-2 underline" onClick={uploads.discard}>{uploads.failed.every(isInlineImage) ? '移除失败图片' : '移除失败文件'}</button>
      <ul className="mt-1">{uploads.failureMessages.map((message, index) => <li key={index}>{message}</li>)}</ul>
    </div>}
    <ImageLightbox src={previewSrc} alt="文档图片" onOpenChange={(open) => !open && setPreviewSrc(null)} />
  </div>;
}
