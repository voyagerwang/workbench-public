/**
 * [INPUT]: 当前编辑器、稳定会话键和业务上下文；复用 AssistantConversation
 * [OUTPUT]: DocumentAssistant 光标浮层与明确插入结果
 * [POS]: 清单和随手记共用的助手呈现；不直接持久化正文
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import type { AssistantContext } from '@/types';
import { AssistantConversation } from '@/components/AssistantConversation';

export type AssistantAnchor = { below: number; top: number; left: number; width: number };
export function editorAnchor(editor: Editor): AssistantAnchor {
  const coords = editor.view.coordsAtPos(editor.state.selection.from);
  const width = Math.min(520, window.innerWidth - 32);
  return { below: coords.bottom + 8, top: coords.top, left: Math.max(16, Math.min(coords.left, window.innerWidth - width - 16)), width };
}
export function DocumentAssistant({ anchor, editor, context, sessionKey, onClose }: {
  anchor: AssistantAnchor; editor: Editor; context: AssistantContext; sessionKey: string; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.below);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = () => {
      const height = el.offsetHeight;
      setTop(Math.max(12, Math.min(anchor.below + height > window.innerHeight - 12 ? anchor.top - height - 8 : anchor.below, window.innerHeight - height - 12)));
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    return () => observer.disconnect();
  }, [anchor]);
  return createPortal(
    <div ref={ref} data-document-assistant className="pop-panel fixed z-[95] max-h-[80vh] overflow-y-auto rounded-xl border border-line shadow-2xl"
      style={{ top, left: anchor.left, width: anchor.width }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); onClose(); }
      }}>
      <AssistantConversation compact autoFocus context={context} sessionKey={sessionKey}
        onClose={onClose}
        onInsert={(content) => {
          if (editor.isDestroyed) return;
          editor.chain().focus().insertContent(content).run();
          onClose();
        }} />
    </div>, document.body,
  );
}
