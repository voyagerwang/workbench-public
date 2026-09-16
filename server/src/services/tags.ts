// 标签规范化（服务端侧）。
//
// 与前端 `web/src/lib/tags.ts` 是同一套规则的两份实现：手动创建与小精灵创建必须落到
// 完全一样的名字，否则左侧筛选与编辑器候选会对不上。改任一边都要同步另一边。
//
// 只做确定性清洗：trim、去开头 #、连续空白归一、空标签丢弃、同名去重。
// 不做分词、同义词合并或别名映射 —— 那些规则猜错就是不可逆的脏数据。

export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 同名去重的比较键：先按 normalizeTag 清洗（去 # / 压空格）再转小写。
 * 必须与 web/src/lib/tags.ts 的 tagKey 完全一致，否则 hasTag(['工作'], '#工作')
 * 会判成两个标签，去重失效。
 */
export function tagKey(tag: string): string {
  return normalizeTag(tag).toLowerCase();
}

export function normalizeTags(list: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const tag = normalizeTag(raw);
    if (!tag) continue;
    const key = tagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** 合并进已有标签（已存在的不重复写），返回规范化后的结果 */
export function mergeTags(existing: readonly string[], incoming: readonly unknown[]): string[] {
  return normalizeTags([...existing, ...incoming]);
}
