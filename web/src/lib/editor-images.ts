/**
 * [INPUT]: 浏览器剪贴板/拖放 DataTransfer 与文件 MIME
 * [OUTPUT]: 单一文件视图的文件/图片提取、正文位图判定与图片事件地址
 * [POS]: 编辑器输入归一化，优先 files、空列表回退 items，图片和普通文件共享提取路径
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
export function filesFromTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];

  // files 与 items 是同一批文件的两个视图；剪贴板临时文件的时间戳可能不同。
  // 优先使用完整文件列表，避免跨视图合并，也不误删元信息相同的独立文件。
  if (data.files.length) return Array.from(data.files);

  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

export const isInlineImage = (file: File) => /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(file.type);
export const imageFilesFromTransfer = (data: DataTransfer | null | undefined) => filesFromTransfer(data).filter((file) => file.type.startsWith('image/'));

export function imageSrcFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLImageElement)) return null;
  return target.currentSrc || target.src || null;
}
