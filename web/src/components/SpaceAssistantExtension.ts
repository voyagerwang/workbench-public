/**
 * [INPUT]: TipTap 空段落按键与宿主唤起回调
 * [OUTPUT]: createSpaceAssistantExtension，过滤输入法组合态后识别助手意图
 * [POS]: 共享正文交互扩展，不拥有助手 UI 或业务上下文
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Extension, type Editor } from '@tiptap/core';

/**
 * 在空的普通段落按 Space 唤起 AI。扩展只负责识别意图，具体 UI 由宿主提供，
 * 因而待办详情、知识库文档和提示词编辑器都能复用。
 */
export function createSpaceAssistantExtension(onOpen: (editor: Editor) => void) {
  return Extension.create({
    name: 'spaceAssistant',
    addKeyboardShortcuts() {
      return {
        Space: ({ editor }) => {
          if (editor.view.composing) return false;
          const { selection } = editor.state;
          const { $from, empty } = selection;
          const isEmptyParagraph = empty
            && $from.parent.type.name === 'paragraph'
            && $from.parent.content.size === 0
            && $from.parentOffset === 0;
          if (!isEmptyParagraph) return false;
          onOpen(editor);
          return true;
        },
      };
    },
  });
}
