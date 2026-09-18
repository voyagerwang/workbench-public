/**
 * [INPUT]: 文档会话、业务属性/操作插槽和助手身份；沿用 DocumentEditor
 * [OUTPUT]: DocumentDetail 完整详情页、可选的一键复制 Markdown、DocumentProperty 属性行
 * [POS]: 随手记、清单与知识资料唯一页面实现；正文随容器铺满宽度，业务差异由适配组件注入
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { Check, Copy, Loader2, Maximize2, Minimize2, MoreHorizontal, RotateCw, Sparkles, X, Link2, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { DocumentEditor } from '@/components/DocumentEditor';
import { createSpaceAssistantExtension } from '@/components/SpaceAssistantExtension';
import { useAssistantName } from '@/lib/assistant-name';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { MenuButton, type MenuItem } from '@/ui/menu';
import type { AssistantContext } from '@/types';
import type { DocumentSession } from './use-document-session';
import { DetailHost, type DetailMode } from './DetailHost';
import { DocumentAssistant, editorAnchor, type AssistantAnchor } from './DocumentAssistant';

export function DocumentProperty({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return <div className="flex min-h-9 items-center rounded-md hover:bg-surface-1/70">
    <span className="flex w-[104px] shrink-0 items-center gap-2 px-2 py-1 text-xs text-ink-4"><Icon className="size-3.5" />{label}</span>
    <div className="min-w-0 flex-1 text-sm text-ink-2">{children}</div>
  </div>;
}
export function DocumentDetail({ session, mode = 'embedded', label, properties, secondaryProperties, actions = [],
  onClose, titleRequired = false, editable = true, context, getAssistantIdentity, getLink, onTitleEdited, copyMarkdown = false,
}: {
  session: DocumentSession; mode?: DetailMode; label: string; properties?: ReactNode; secondaryProperties?: ReactNode;
  actions?: MenuItem[]; onClose: () => void; titleRequired?: boolean; editable?: boolean;
  context: AssistantContext; getAssistantIdentity: () => Promise<{ sessionKey: string; context: AssistantContext }>;
  getLink?: () => string | null; onTitleEdited?: () => void; copyMarkdown?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState<AssistantAnchor | null>(null);
  const [identity, setIdentity] = useState<{ sessionKey: string; context: AssistantContext } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const editor = useRef<Editor | null>(null);
  const openRef = useRef<(value: Editor) => void>(() => {});
  const extensions = useMemo(() => [createSpaceAssistantExtension((value) => openRef.current(value))], []);
  const petName = useAssistantName();
  openRef.current = (value) => {
    const position = editorAnchor(value);
    void getAssistantIdentity().then((next) => {
      if (!value.isDestroyed && session.alive.current) { setIdentity(next); setAnchor(position); }
    }).catch((error) => toast.error(error.message));
  };
  const closeAssistant = () => { setAnchor(null); if (editor.current && !editor.current.isDestroyed) editor.current.view.focus(); };
  const close = async () => {
    if (anchor) { closeAssistant(); return; }
    if (expanded) { setExpanded(false); return; }
    if (leaving) return;
    setLeaving(true);
    try { await session.flush(); onClose(); }
    catch (error) { toast.error(`暂未关闭：${(error as Error).message}`); }
    finally { setLeaving(false); }
  };
  const status = !editable ? '只读' : session.uploading ? '上传文件…' : session.status === 'error' ? '保存失败' : session.status === 'saving' ? '保存中…' : session.status === 'editing' ? '编辑中…' : '已保存';
  const blocked = Boolean(session.recovery);
  return <DetailHost mode={mode} expanded={expanded} onClose={() => void close()}>
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2">
      <span className="text-xs text-ink-3">{label}</span>
      <div className="flex items-center gap-1">
        <span role="status" className={cn('mr-2 flex items-center gap-1 text-[11px]', session.status === 'error' ? 'text-danger' : 'text-ink-4')}>
          {editable && (session.status === 'saving' || session.uploading) ? <Loader2 className="size-3 animate-spin" /> : editable && session.status === 'saved' ? <Check className="size-3" /> : null}{status}
        </span>
        {session.status === 'error' && <Button title="重试保存" variant="ghost" size="xsIcon" onClick={() => void session.flush().catch((error) => toast.error(error.message))}><RotateCw /></Button>}
        {editable && <Button title={`叫来${petName}`} variant="ghost" size="xsIcon" disabled={blocked} onClick={() => { if (editor.current) openRef.current(editor.current); }}><Sparkles /></Button>}
        {copyMarkdown && <Button title="复制 MD 文档" aria-label="复制 MD 文档" variant="ghost" size="xsIcon" disabled={session.uploading} onClick={() => void (async () => {
          const body = editor.current && !editor.current.isDestroyed ? editor.current.storage.markdown.getMarkdown() : session.value.body;
          const title = session.value.title.trim().replace(/\s*\n\s*/g, ' ').replace(/([\\`*_{}\[\]<>])/g, '\\$1');
          const markdown = [title ? `# ${title}` : '', body].filter(Boolean).join('\n\n');
          if (!navigator.clipboard?.writeText) throw new Error('当前环境无法访问剪贴板，请使用 localhost 或 HTTPS 打开');
          await navigator.clipboard.writeText(markdown);
          toast.success('已复制 MD 文档');
        })().catch((error) => toast.error(`复制失败：${error instanceof Error ? error.message : '请检查剪贴板权限'}`))}><Copy /></Button>}
        {getLink && <Button title="复制文档链接" variant="ghost" size="xsIcon" onClick={() => void (async () => {
          await session.flush(); const link = getLink(); if (!link) throw new Error('写下正文后再复制链接');
          await navigator.clipboard.writeText(new URL(link, window.location.origin).href); toast.success('已复制文档链接');
        })().catch((error) => toast.error(error.message))}><Link2 /></Button>}
        {mode !== 'page' && <Button title={expanded ? '收起全页' : '展开全页'} variant="ghost" size="xsIcon" onClick={() => setExpanded((value) => !value)}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button>}
        {actions.length > 0 && <MenuButton title="文档操作" items={actions} className="rounded-md p-1 text-ink-3 hover:bg-surface-2"><MoreHorizontal className="size-4" /></MenuButton>}
        <Button title="关闭" aria-label="关闭" variant="ghost" size="xsIcon" disabled={leaving} onClick={() => void close()}><X /></Button>
      </div>
    </div>
    {session.recovery && <div className="border-b border-line bg-surface-2 px-5 py-3 text-xs">发现上次未保存的草稿。
      <Button size="sm" onClick={session.restore}>恢复草稿</Button> <Button size="sm" variant="ghost" onClick={session.discardRecovery}>丢弃草稿</Button></div>}
    {session.external && <div className="border-b border-line bg-surface-2 px-5 py-3 text-xs">文档有外部更新，本地输入已保留。
      <Button size="sm" onClick={session.keepLocal}>保留我的编辑</Button> <Button size="sm" variant="ghost" onClick={() => void session.useExternal().catch((error) => toast.error(error.message))}>使用外部版本</Button></div>}
    {session.draftWarning && <p className="px-5 py-2 text-xs text-danger">本机草稿无法写入，关闭浏览器前请确认已保存。</p>}
    {session.error && <p role="alert" className="px-5 py-2 text-xs text-danger">{session.error}，内容仍保留在编辑区。</p>}
    <div className="min-h-0 flex-1 overflow-y-auto" data-document-scroll>
      <div className="w-full px-4 py-7 sm:px-8">
        <input aria-label="文档标题" placeholder="标题…" value={session.value.title} disabled={blocked || !editable}
          onChange={(event) => { onTitleEdited?.(); session.change({ title: event.target.value }); }}
          onBlur={() => {
            if (titleRequired && !session.value.title.trim()) {
              session.change({ title: session.queue.savedValue.title }); toast.error('文档标题不能为空，已保留原标题');
            }
          }}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) editor.current?.commands.focus(); }}
          className={cn('w-full bg-transparent text-[26px] font-semibold leading-tight tracking-tight outline-none placeholder:text-ink-4 sm:text-[30px]', session.value.status === 'done' && 'text-ink-3 line-through')} />
        <fieldset disabled={blocked} className="mt-6 space-y-0.5">{properties}
          {secondaryProperties && <details className="pt-1"><summary className="cursor-pointer px-2 py-1 text-xs text-ink-4">更多属性</summary>{secondaryProperties}</details>}
        </fieldset>
        <div className="mt-7 border-t border-line pt-7">
          <DocumentEditor value={session.value.body} editable={editable && !blocked} extraExtensions={editable ? extensions : []}
            placeholder={`写点什么… 空行按 Space 叫来${petName}，输入 / 插入内容`}
            className="min-h-[300px]" onChange={(body) => session.change({ body })}
            onEditorReady={(value) => { editor.current = value; }}
            onUploadingChange={session.onUploadingChange} onRegisterUploadFlush={session.registerUploadFlush} />
        </div>
      </div>
    </div>
    {anchor && identity && editor.current && <DocumentAssistant anchor={anchor} editor={editor.current}
      context={{ ...context, ...identity.context, title: session.value.title, content: session.value.body }}
      sessionKey={identity.sessionKey} onClose={closeAssistant} />}
  </DetailHost>;
}
