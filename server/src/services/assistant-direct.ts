/**
 * [INPUT]: 最新一条完整用户命令与可信消息身份
 * [OUTPUT]: 明确单链接收藏的零模型写入与真实凭证；复合、否定、问句交回语义层
 * [POS]: 只识别完整句法，不从资料或标题中执行指令，不抓取链接正文
 * [PROTOCOL]: 变更时检查 server/CLAUDE.md
 */
import { createHash } from 'node:crypto';
import { db, now } from '../db.js';
import { acceptAssistantDrafts, type CaptureOutcome } from './triage.js';
import type { InboundRequest } from './inbound-context.js';
export function parseLinkCapture(raw: string): { title: string; url: string } | null {
  const text = raw.trim().replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[+-]\d+\]\s*/, '');
  const command = '(?:请)?(?:帮我)?(?:把)?(?:这个)?(?:链接)?(?:记到|存到|保存到|收藏到)(?:随手记|笔记)(?:里边|里面|里)?';
  const title = '(?:[，,；;\\s]*标题(?:是|为|[：:])[ \\t]*(.{1,40}?))?';
  // 链接与命令之间支持分享链接常见的 # 分隔；完整真实片段仍保留在链接中。
  const url = '(https?://[^\\s<>"，,。]+?)';
  const a = new RegExp('^' + url + '[# \\t\\n]*' + command + title + '[。！!]*$').exec(text);
  const b = new RegExp('^' + command + title + '[：: \\t\\n]+' + url + '[。！!]*$').exec(text);
  if (!a && !b) return null;
  const link = a ? a[1] : b![2]; const explicitTitle = a ? a[2] : b![1];
  if (!link || /[\s]/.test(link) || (link.match(/https?:\/\//g) ?? []).length !== 1) return null;
  // 标题不能悄悄吞下额外动作或问句。
  if (explicitTitle && /[\n?？]|(?:然后|并且|同时|再帮|再把|顺便|不要|别保存|总结|转写|翻译|提炼|标签)/.test(explicitTitle)) return null;
  try { const u = new URL(link); if (u.username || u.password) return null;
    return { url: link, title: explicitTitle?.trim().replace(/^[「“]|[」”]$/g, '') || u.hostname };
  } catch { return null; }
}
export function captureLink(raw: string, inbound?: InboundRequest): CaptureOutcome | null {
  const parsed = parseLinkCapture(raw); if (!parsed) return null;
  const key = inbound ? createHash('sha256').update(JSON.stringify([inbound.source, inbound.sourceUserId, inbound.sourceConversationId, inbound.sourceMessageId, parsed])).digest('hex') : null;
  return db.transaction(() => {
    if (key) {
      const old = db.prepare('SELECT receipt_json FROM assistant_direct_receipts WHERE request_key = ?').get(key) as { receipt_json: string } | undefined;
      if (old) {
        const receipt = JSON.parse(old.receipt_json) as CaptureOutcome;
        const id = receipt.items[0]?.target?.id;
        if (!id || !db.prepare('SELECT id FROM notes WHERE id=? AND deleted_at IS NULL').get(id)) throw new Error('此消息原来保存的笔记已删除；如需重新保存，请发送一条新的保存指令');
        return receipt;
      }
    }
    const result = acceptAssistantDrafts([{ type: 'note', content: parsed.title + '\n' + parsed.url }]);
    const target = result.items[0]?.target;
    if (!target || target.module !== 'note') throw new Error('链接保存没有返回笔记凭证');
    db.prepare('UPDATE notes SET title=? WHERE id=? AND deleted_at IS NULL').run(parsed.title,target.id);
    const saved = db.prepare('SELECT title,content FROM notes WHERE id=? AND deleted_at IS NULL').get(target.id) as {title:string;content:string}|undefined;
    if (!saved || saved.title !== parsed.title || saved.content !== parsed.title + '\n' + parsed.url) throw new Error('链接保存后读回校验失败');
    target.title = saved.title;
    result.aiUsed = false;
    if (key) db.prepare('INSERT INTO assistant_direct_receipts VALUES (?,?,?)').run(key, JSON.stringify(result), now());
    return result;
  })();
}
