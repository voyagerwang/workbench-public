/**
 * 目录存档的文案常量（旧文案 → 新文案）。
 *
 * 单独成文件的原因：db.ts 一 import 就开库跑迁移，验证脚本绝不能 import 它；
 * 但「修数据」和「验证修数据」两边必须引用同一份常量，否则修的和验的会漂移。
 * 这个模块没有任何 import，也没有副作用，两边都能安全引用。
 */

export type CatalogNoteFix = { sourceUrl: string; from: string; to: string };

/**
 * 只建索引的同步会在目录正文里写死「全文已建本地快照（data/kb/dingtalk）」，
 * 而快照目录压根不存在 —— 这是一句假话。上下两行分别是旧文案原文与替换后的诚实文案。
 *
 * 匹配条件刻意收得很紧：必须同时命中「特定 source_url + 旧文案原文」，
 * 用户手写的笔记里出现同样字句也不会被动到。
 */
export const CATALOG_NOTE_FIXES: CatalogNoteFix[] = [
  {
    sourceUrl: 'dingtalk://wiki-catalog',
    from: '> 全文已建本地快照（data/kb/dingtalk）；打开单篇走云端实时读取。',
    to: '> 本次只建索引，正文尚未抓取，检索只能命中目录标题；打开单篇走云端实时读取。',
  },
  {
    sourceUrl: 'feishu://wiki-catalog',
    from: '> 正文检索走 feishu-kb 本地快照；打开单篇走云端实时读取。',
    to: '> 正文检索依赖本地快照服务（:8792），离线时只能命中目录标题；打开单篇走云端实时读取。',
  },
];
