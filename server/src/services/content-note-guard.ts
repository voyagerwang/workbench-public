/**
 * [INPUT]: 模型笔记草稿、用户原始内容处理意图与服务端视频任务凭证
 * [OUTPUT]: 过滤尚未交付的视频任务占位笔记；保留独立的用户备忘
 * [POS]: 助手落库前的确定性边界，不能用任务说明替代内容成果
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
type Task = { id: string; objective: string; status: string };
function urls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s（()）。，；：、<>"'「」【】]+/g) ?? []).map((url) => url.replace(/\/$/, ''));
}
export function isPendingVideoNote(content: string, tasks: readonly Task[], request = ''): boolean {
  const links = urls(content);
  // 漏调工具时，同源链接草稿仍交给成果通道；“没有任务凭证”不能等于“内容已就绪”。
  const requestedVideos = urls(request).filter((url) => /\b(?:douyin\.com|bilibili\.com|b23\.tv|youtube\.com|youtu\.be|xiaohongshu\.com|xhslink\.com)\b/.test(url));
  if (/转写|逐字稿|提取|总结/.test(request) && requestedVideos.length
    && !tasks.some((task) => ['completed', 'approved'].includes(task.status) && urls(task.objective).some((url) => requestedVideos.includes(url)))
    && (/待转写|转写任务|转写后|等待转写/.test(content) || requestedVideos.some((url) => links.includes(url)))) return true;
  return tasks.some((task) => {
    if (['completed', 'approved', 'cancelled'].includes(task.status)) return false;
    if (!/转写|逐字稿|视频.*(?:总结|提取|笔记)/.test(task.objective)) return false;
    return content.includes(task.id)
      || urls(task.objective).some((url) => links.includes(url))
      || /待转写|转写任务|转写后|等待转写/.test(content);
  });
}
