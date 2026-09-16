/**
 * [INPUT]: TipTap Editor、图片节点的文档位置与四向投放意图
 * [OUTPUT]: IMAGE_DRAG_MIME、ImageDragPayload、moveDocumentImage，统一完成单图/画廊间编排
 * [POS]: 文档图片拖放的数据变换层；NodeView 只判断落点，不直接拼装 ProseMirror 事务
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { Editor } from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

export const IMAGE_DRAG_MIME = 'application/x-workbench-document-image';
export type ImageDropPlacement = 'left' | 'right' | 'before' | 'after';
export type ImageDragPayload = { pos: number };

function galleryAt(doc: ProseMirrorNode, imagePos: number) {
  const resolved = doc.resolve(imagePos);
  if (resolved.parent.type.name !== 'imageGallery') return null;
  return {
    node: resolved.parent,
    pos: imagePos - resolved.parentOffset - 1,
    index: resolved.index(),
  };
}

function removeSource(tr: Transaction, sourcePos: number, source: ProseMirrorNode) {
  const gallery = galleryAt(tr.doc, sourcePos);
  if (!gallery) {
    tr.delete(sourcePos, sourcePos + source.nodeSize);
    return;
  }
  const remaining = gallery.node.content.content.filter((_, index) => index !== gallery.index);
  if (remaining.length === 1) tr.replaceWith(gallery.pos, gallery.pos + gallery.node.nodeSize, remaining[0]);
  else tr.replaceWith(gallery.pos, gallery.pos + gallery.node.nodeSize, gallery.node.type.create({ ...gallery.node.attrs, widths: '' }, remaining));
}

export function moveDocumentImage(editor: Editor, sourcePos: number, targetPos: number, placement: ImageDropPlacement) {
  if (sourcePos === targetPos) return false;
  const { state } = editor;
  const source = state.doc.nodeAt(sourcePos);
  const target = state.doc.nodeAt(targetPos);
  if (!source || !target || source.type.name !== 'image' || target.type.name !== 'image') return false;
  const sourceGallery = galleryAt(state.doc, sourcePos);
  const targetGallery = galleryAt(state.doc, targetPos);

  if ((placement === 'left' || placement === 'right') && sourceGallery && targetGallery && sourceGallery.pos === targetGallery.pos) {
    const images = sourceGallery.node.content.content.slice();
    const [moved] = images.splice(sourceGallery.index, 1);
    let index = targetGallery.index + (placement === 'right' ? 1 : 0);
    if (sourceGallery.index < index) index -= 1;
    images.splice(index, 0, moved);
    editor.view.dispatch(state.tr.replaceWith(sourceGallery.pos, sourceGallery.pos + sourceGallery.node.nodeSize,
      sourceGallery.node.type.create({ ...sourceGallery.node.attrs, widths: '' }, images)));
    return true;
  }

  if ((placement === 'left' || placement === 'right') && targetGallery && targetGallery.node.childCount >= 4) return false;
  const tr = state.tr;
  removeSource(tr, sourcePos, source);
  const mappedTargetPos = tr.mapping.map(targetPos);
  const mappedTarget = tr.doc.nodeAt(mappedTargetPos);
  if (!mappedTarget || mappedTarget.type.name !== 'image') return false;
  const mappedGallery = galleryAt(tr.doc, mappedTargetPos);

  if (placement === 'before' || placement === 'after') {
    const blockPos = mappedGallery ? mappedGallery.pos : mappedTargetPos;
    const blockSize = mappedGallery ? mappedGallery.node.nodeSize : mappedTarget.nodeSize;
    tr.insert(placement === 'before' ? blockPos : blockPos + blockSize, source);
  } else if (mappedGallery) {
    const images = mappedGallery.node.content.content.slice();
    images.splice(mappedGallery.index + (placement === 'right' ? 1 : 0), 0, source);
    tr.replaceWith(mappedGallery.pos, mappedGallery.pos + mappedGallery.node.nodeSize,
      mappedGallery.node.type.create({ ...mappedGallery.node.attrs, widths: '' }, images));
  } else {
    const images = placement === 'left' ? [source, mappedTarget] : [mappedTarget, source];
    const galleryType = state.schema.nodes.imageGallery;
    tr.replaceWith(mappedTargetPos, mappedTargetPos + mappedTarget.nodeSize, galleryType.create({ caption: '', widths: '' }, images));
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
