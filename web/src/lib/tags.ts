// 标签规范化：手动输入与助手写入共用同一套规则。
//
// 服务端有一份等价实现：server/src/services/tags.ts。
// 两边的关键规则（trim / 去开头 # / 连续空格归一 / 空标签丢弃 / 同名去重）必须保持一致，
// 改任一边都要同步另一边，否则会出现「页面显示一个名字、库里存另一个名字」。
//
// 第一版刻意只做确定性的文本清洗，不做中文分词、同义词合并或大小写无关的别名表：
// 那些规则一旦猜错就不可逆，宁可让用户自己挑。
import type { TagBatchOp } from '@/types';

/** 单个标签的规范化：去首尾空格 → 丢掉开头的 # → 内部连续空白压成一个空格 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 同名去重的比较键：先按 normalizeTag 清洗（去 # / 压空格）再转小写。
 * 大小写不敏感：中文没有大小写问题；英文里 "OKR" 与 "okr" 是同一个标签，
 * 分成两个只会让侧栏越来越脏。保留第一次出现的写法作为展示名。
 *
 * 必须先 normalizeTag 再小写 —— 否则 hasTag(['工作'], '#工作') 会判成两个标签，
 * 用户敲 # 前缀选中的其实是新标签，去重就白做了。
 */
export function tagKey(tag: string): string {
  return normalizeTag(tag).toLowerCase();
}

/** 规范化一组标签：清洗 → 丢空 → 同名去重（保留首次出现的写法）→ 保序 */
export function normalizeTags(list: readonly string[] | null | undefined): string[] {
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

/** 把新标签并进已有列表，返回规范化后的结果（已存在则不动，避免重复创建） */
export function mergeTags(existing: readonly string[], incoming: readonly string[]): string[] {
  return normalizeTags([...existing, ...incoming]);
}

/** 列表里是否已经存在这个名字的标签 */
export function hasTag(list: readonly string[], tag: string): boolean {
  const key = tagKey(tag);
  return list.some((t) => tagKey(t) === key);
}

/** 从列表里移除某个标签（大小写不敏感） */
export function removeTag(list: readonly string[], tag: string): string[] {
  const key = tagKey(tag);
  return list.filter((t) => tagKey(t) !== key);
}

/** 候选标签是否命中搜索词（大小写不敏感的子串匹配） */
export function tagMatches(tag: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return tag.toLowerCase().includes(q);
}

/** 输入词是否已经与某个已有标签完全同名（此时不该再「创建新标签」） */
export function exactTagMatch(list: readonly string[], input: string): string | null {
  const key = tagKey(normalizeTag(input));
  if (!key) return null;
  return list.find((t) => tagKey(t) === key) ?? null;
}

/**
 * 统计每个标签的使用次数，按「次数降序 → 名字升序」排。
 * 次数相等时按名字排，保证刷新前后顺序稳定，不会在眼前跳动。
 */
export function countTags(notes: readonly { tags?: readonly string[] }[]): Array<{ tag: string; count: number }> {
  const map = new Map<string, { tag: string; count: number }>();
  for (const note of notes) {
    // 先按笔记规范化一次：同一条里写了两遍的标签只该贡献 1 次
    for (const tag of normalizeTags((note.tags ?? []).map((t) => String(t)))) {
      const key = tagKey(tag);
      const hit = map.get(key);
      if (hit) hit.count += 1;
      else map.set(key, { tag, count: 1 });
    }
  }
  return [...map.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'),
  );
}

/**
 * 撤销一个标签操作 = 反向再来一次。
 * 改名就反向改回去；合并 / 删除都退化成「把标签 add 回受影响的那批笔记」；
 * add 本身就是撤销动作，不再反悔。
 *
 * 放在纯函数库里而不是组件里：它要能被 node 直接单测，不牵扯 React 运行时。
 */
export function invertTagOp(op: TagBatchOp, affected: number[]): TagBatchOp | null {
  switch (op.op) {
    case 'rename': return { op: 'rename', from: op.to, to: op.from };
    case 'merge': return { op: 'add', tag: op.from, ids: affected };
    case 'remove': return { op: 'add', tag: op.tag, ids: affected };
    case 'add': return null;
  }
}

/**
 * 标签被改名 / 合并 / 删除后，把左侧的筛选条件跟着迁过去。
 * 不迁的话用户会卡在「筛着一个已经不存在的标签 → 列表一片空白」，
 * 而清除按钮藏在折叠面板里，很容易以为笔记没了。
 *
 * 撤销（op = add）不处理：它只是把标签贴回去，动筛选反而更乱。
 */
export function remapFilters(filters: readonly string[], op: {
  op: 'rename' | 'merge' | 'remove';
  from?: string; to?: string; tag?: string;
}): string[] {
  if (op.op === 'remove') {
    const gone = tagKey(op.tag ?? '');
    return filters.filter((t) => tagKey(t) !== gone);
  }
  const from = tagKey(op.from ?? '');
  const to = normalizeTag(op.to ?? '');
  if (!from || !to) return [...filters];
  const out: string[] = [];
  for (const filter of filters) {
    out.push(tagKey(filter) === from ? to : filter);
  }
  return normalizeTags(out);
}
