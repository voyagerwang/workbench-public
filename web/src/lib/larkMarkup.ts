/**
 * 前端版的飞书 XML 标记清洗：把 `<at user_id="ou_xxx">名字</at>` 等
 * 翻译成可读中文。规则与 server/src/services/lark-cli.ts::sanitizeLarkMarkup 一致。
 *
 * 为什么前后端各一份：派单卡的 summary 是服务端写入时清洗的，但 resultText
 * 是抓取时的快照（旧记录在改预算前可能带截断尾巴），还有用户输入 / 模型
 * 输出 / 历史 session 等其他来源的文本也都得在渲染前再过一遍保险。
 */
export function sanitizeLarkMarkup(text: string): string {
  return text
    .replace(/<at\b[^>]*>([^<]*)<\/at>/gi, '@$1')
    .replace(/<card[^>]*>/g, '')
    .replace(/<\/card>/g, '')
    .replace(/<file\b[^>]*\bname="([^"]*)"[^>]*\/?>/gi, (_, name: string) => `[文件] ${name}`)
    .replace(/<(image|img|audio|media|video|sticker|folder|todo)\b[^>]*\/?>/gi, (_m: string, tag: string) => {
      const labels: Record<string, string> = {
        image: '图片', img: '图片', audio: '语音', video: '视频',
        media: '视频', sticker: '表情', folder: '文件夹', todo: '任务',
      };
      return `[${labels[String(tag).toLowerCase()] ?? tag}]`;
    })
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/🖼️\s*Image\([^)]*\)/g, '[图片]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
