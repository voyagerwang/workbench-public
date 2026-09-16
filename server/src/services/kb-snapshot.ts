// 统一的「本地知识库快照」存储：与 feishu-kb 同一套布局（全文 MD 文件 + kb_manifest.jsonl 清单）。
// feishu 的快照由外部管道维护（~/Documents/feishu-kb）；这里给钉钉等提供工作台内置的快照能力，
// 存放于 <dataDir>/kb/<provider>/。检索走 SQLite FTS（kb_snapshot_fts），读正文直接读本地 MD。
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db, now } from '../db.js';

export type SnapshotEntry = {
  reference: string;
  url: string | null;
  title: string;
  space: string | null;
  file: string; // 相对 root 的路径
  chars: number;
  hash: string;
  synced_at: string;
};

/** macOS/通用文件名安全化：去非法字符、压长度，配合 hash 后缀保证唯一 */
function safeName(input: string, fallback: string): string {
  const cleaned = (input.trim() || fallback).replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 80);
}

export class KbSnapshot {
  readonly root: string;
  private entries = new Map<string, SnapshotEntry>(); // reference → entry
  private loaded = false;

  constructor(root: string) {
    this.root = root;
  }

  private manifestPath(): string {
    return path.join(this.root, 'index', 'kb_manifest.jsonl');
  }

  /** reference / url → 条目（懒加载，进程内缓存） */
  private ensureLoaded(): Map<string, SnapshotEntry> {
    if (this.loaded) return this.entries;
    this.loaded = true;
    try {
      const raw = readFileSync(this.manifestPath(), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as SnapshotEntry;
          if (entry.reference) {
            this.entries.set(entry.reference, entry);
            if (entry.url) this.entries.set(entry.url, entry);
          }
        } catch { /* 跳过坏行 */ }
      }
    } catch { /* 快照目录还不存在 */ }
    return this.entries;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.manifestPath()), { recursive: true });
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const entry of this.entries.values()) {
      if (seen.has(entry.reference)) continue;
      seen.add(entry.reference);
      lines.push(JSON.stringify(entry));
    }
    const tmp = `${this.manifestPath()}.tmp`;
    await writeFile(tmp, `${lines.join('\n')}\n`, 'utf8');
    await rename(tmp, this.manifestPath());
  }

  /** 写入/更新一篇快照文档；内容没变（hash 相同）时跳过。返回是否真的写入了 */
  async upsertDoc(input: { reference: string; url?: string | null; title: string; space?: string | null; content: string }): Promise<boolean> {
    const entries = this.ensureLoaded();
    const hash = createHash('sha256').update(input.content).digest('hex').slice(0, 16);
    const existing = entries.get(input.reference);
    if (existing?.hash === hash) return false;

    const dirRelative = path.join('data', safeName(input.space ?? '未分组', '未分组'));
    const fileName = `${safeName(input.title, '未命名文档')}-${hash.slice(0, 8)}.md`;
    const fileRelative = path.join(dirRelative, fileName);
    await mkdir(path.join(this.root, dirRelative), { recursive: true });
    const body = [
      `# ${input.title}`,
      '',
      `> 来源：${input.url ?? input.reference}`,
      `> 分组：${input.space ?? '未分组'} · 同步于 ${now()}`,
      '',
      input.content,
    ].join('\n');
    await writeFile(path.join(this.root, fileRelative), body, 'utf8');
    // 内容变化会换文件名（hash 后缀），清掉旧文件避免垃圾堆积
    if (existing && existing.file !== fileRelative) {
      await rm(path.join(this.root, existing.file), { force: true });
    }
    const entry: SnapshotEntry = {
      reference: input.reference,
      url: input.url ?? null,
      title: input.title,
      space: input.space ?? null,
      file: fileRelative,
      chars: input.content.length,
      hash,
      synced_at: now(),
    };
    entries.set(input.reference, entry);
    if (input.url) entries.set(input.url, entry);
    return true;
  }

  /** 全量重建该 provider 的 FTS 索引（从本地 MD 读回正文）；同步结束时调用一次 */
  async rebuildFts(provider: string): Promise<void> {
    const entries = this.ensureLoaded();
    db.prepare('DELETE FROM kb_snapshot_fts WHERE provider = ?').run(provider);
    const seen = new Set<string>();
    for (const entry of entries.values()) {
      if (seen.has(entry.reference) || entry.space === undefined) continue;
      seen.add(entry.reference);
      try {
        const content = await readFile(path.join(this.root, entry.file), 'utf8');
        db.prepare('INSERT INTO kb_snapshot_fts (title, content, space, url, provider) VALUES (?, ?, ?, ?, ?)')
          .run(entry.title, content, entry.space ?? '', entry.url ?? '', provider);
      } catch { /* 文件丢失就跳过 */ }
    }
  }

  /** FTS 全文检索（带 bm25 排序与摘要）；表还没建好或查询失败时返回空 */
  search(provider: string, query: string, limit = 6): Array<{ title: string; space: string | null; url: string | null; snippet: string }> {
    const q = query.trim();
    if (!q) return [];
    const tokens = q.split(/\s+/).filter((t) => t.length >= 2).map((t) => `"${t.replace(/"/g, '""')}"`);
    if (!tokens.length) return [];
    try {
      return db.prepare(`
        SELECT title, space, url, snippet(kb_snapshot_fts, 1, '', '', '…', 100) AS snippet
        FROM kb_snapshot_fts WHERE kb_snapshot_fts MATCH ? AND provider = ?
        ORDER BY bm25(kb_snapshot_fts) LIMIT ?
      `).all(tokens.join(' OR '), provider, limit) as Array<{ title: string; space: string; url: string; snippet: string }>;
    } catch {
      return [];
    }
  }

  /** 按链接或 reference 读本地快照正文；没有这篇返回 null（调用方回落云端） */
  async readDoc(reference: string): Promise<{ title: string; content: string; file: string } | null> {
    const key = reference.trim();
    if (!key) return null;
    const entry = this.ensureLoaded().get(key);
    if (!entry) return null;
    try {
      const raw = await readFile(path.join(this.root, entry.file), 'utf8');
      // 正文 = 去掉文件头的「# 标题 + 元信息」块（前 6 行）
      const content = raw.split('\n').slice(6).join('\n').trim();
      return { title: entry.title, content, file: path.join(this.root, entry.file) };
    } catch {
      return null;
    }
  }

  async saveManifest(): Promise<void> {
    await this.persist();
  }
}

let dingtalkKb: KbSnapshot | null = null;

/** 钉钉本地快照（单例），存放于 data/kb/dingtalk */
export function getDingtalkKb(): KbSnapshot {
  if (!dingtalkKb) dingtalkKb = new KbSnapshot(path.resolve('data', 'kb', 'dingtalk'));
  return dingtalkKb;
}
