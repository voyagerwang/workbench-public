import type { FastifyInstance } from 'fastify';
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { dataDir, db, now } from '../db.js';
import { contentHash, recordSkillUseByRef, requireSkill, scanRoots, scanSkills, usageFor, type SkillRecord } from '../services/skills.js';
import { registerSkillTrash } from './trash.js';


const promptShape = z.object({
  title: z.string().max(200).default(''),
  content: z.string().max(100_000).default(''),
  description: z.string().max(1000).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
  source: z.string().max(200).default(''),
});

function promptRow(row: Record<string, unknown>) {
  return { ...row, tags: JSON.parse(String(row.tags || '[]')) as string[], source: String(row.source ?? '') };
}

export default async function aiResourcesRoutes(app: FastifyInstance) {
  // Skill 内容含本机路径，编辑还会写入用户目录：未配置访问令牌时仅允许本机访问。
  app.addHook('preHandler', async (req) => {
    const local = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
    if (!local && !process.env.ACCESS_TOKEN) throw app.httpErrors.forbidden('AI 资源库仅允许本机访问；远程访问请先配置 ACCESS_TOKEN');
  });

  app.get('/api/ai-resources/skills', () => scanSkills(false));

  app.post('/api/ai-resources/skills/scan', () => {
    const skills = scanSkills(false);
    return { skills, scannedAt: now(), roots: scanRoots.filter((root) => existsSync(root.path)).map((root) => root.path) };
  });

  app.get('/api/ai-resources/skills/:id', (req) => {
    const { id } = z.object({ id: z.string().length(24) }).parse(req.params);
    return requireSkill(id);
  });

  app.put('/api/ai-resources/skills/:id', (req) => {
    const { id } = z.object({ id: z.string().length(24) }).parse(req.params);
    const { content } = z.object({ content: z.string().min(1).max(500_000) }).parse(req.body);
    const skill = requireSkill(id);
    if (!skill.editable) throw app.httpErrors.forbidden('内置或插件 Skill 只读；如需修改，请复制到个人 Skill 目录');
    const backupRoot = join(dataDir, 'skill-backups', basename(dirname(skill.path)));
    mkdirSync(backupRoot, { recursive: true });
    writeFileSync(join(backupRoot, `${Date.now()}-${skill.contentHash.slice(0, 10)}.md`), skill.content, 'utf8');
    const temporary = `${skill.path}.workbench-${Date.now()}.tmp`;
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, skill.path);
    return requireSkill(id);
  });

  app.delete('/api/ai-resources/skills/:id', (req) => {
    const { id } = z.object({ id: z.string().length(24) }).parse(req.params);
    const skill = requireSkill(id);
    if (!skill.editable) throw app.httpErrors.forbidden('内置或插件 Skill 不能在这里删除');
    const sourceDir = dirname(skill.path);
    const trashRoot = join(dataDir, 'skill-trash');
    mkdirSync(trashRoot, { recursive: true });
    const target = join(trashRoot, `${Date.now()}-${basename(sourceDir)}`);
    try { renameSync(sourceDir, target); } catch {
      cpSync(sourceDir, target, { recursive: true });
      throw app.httpErrors.internalServerError('Skill 已备份但原目录未能移除，请手动检查');
    }
    // 登记进回收站：删掉的 SKILL.md 能在回收站里看到内容，也能直接放回原位置
    const trashId = registerSkillTrash({
      name: skill.name,
      description: skill.description,
      originDir: sourceDir,
      trashDir: target,
    });
    return { ok: true, recoverable: true, trashPath: target, trashId };
  });

  app.post('/api/ai-resources/skills/:id/record-use', (req) => {
    const { id } = z.object({ id: z.string().length(24) }).parse(req.params);
    const body = z.object({ source: z.string().max(80).default('workspace') }).parse(req.body ?? {});
    const skill = requireSkill(id);
    db.prepare('INSERT INTO skill_usage_events (skill_path, source) VALUES (?, ?)').run(skill.path, body.source);
    return usageFor(skill.path);
  });

  // 按名称/路径上报使用（供 Claude Code hook 等外部编码工具调用，静默失败不影响调用方）
  app.post('/api/ai-resources/skills/record-use-by-ref', (req) => {
    const body = z.object({
      ref: z.string().min(1).max(400),
      source: z.string().max(80).default('claude-code'),
    }).parse(req.body ?? {});
    const result = recordSkillUseByRef(body.ref, body.source);
    return { ok: result != null, ...(result ?? {}) };
  });

  app.post('/api/ai-resources/skills/duplicates', () => {
    const skills = scanSkills(false);
    const exact = new Map<string, SkillRecord[]>();
    const names = new Map<string, SkillRecord[]>();
    for (const skill of skills) {
      exact.set(skill.contentHash, [...(exact.get(skill.contentHash) ?? []), skill]);
      const normalized = skill.name.toLocaleLowerCase().replace(/[\s_-]+/g, '');
      names.set(normalized, [...(names.get(normalized) ?? []), skill]);
    }
    return {
      exact: [...exact.values()].filter((group) => group.length > 1),
      possible: [...names.values()].filter((group) => group.length > 1 && new Set(group.map((item) => item.contentHash)).size > 1),
    };
  });

  app.get('/api/ai-resources/prompts', (req) => {
    const { q } = z.object({ q: z.string().max(200).default('') }).parse(req.query);
    const like = `%${q.trim()}%`;
    const rows = db.prepare(`SELECT * FROM prompts WHERE deleted_at IS NULL AND (? = '' OR title LIKE ? OR description LIKE ? OR content LIKE ?) ORDER BY updated_at DESC`)
      .all(q.trim(), like, like, like) as Array<Record<string, unknown>>;
    return rows.map(promptRow);
  });

  app.post('/api/ai-resources/prompts', (req) => {
    const body = promptShape.partial().parse(req.body ?? {});
    const result = db.prepare(`INSERT INTO prompts (id, title, content, description, tags, source) VALUES (sync_id(), ?, ?, ?, ?, ?)`)
      .run(body.title ?? '未命名提示词', body.content ?? '', body.description ?? '', JSON.stringify(body.tags ?? []), body.source ?? '');
    return promptRow(db.prepare('SELECT * FROM prompts WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>);
  });

  app.patch('/api/ai-resources/prompts/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = promptShape.partial().parse(req.body ?? {});
    const current = db.prepare('SELECT * FROM prompts WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!current) throw app.httpErrors.notFound('提示词不存在');
    db.prepare(`UPDATE prompts SET title=?, content=?, description=?, tags=?, source=?, updated_at=? WHERE id=?`).run(
      body.title ?? current.title,
      body.content ?? current.content,
      body.description ?? current.description,
      JSON.stringify(body.tags ?? JSON.parse(String(current.tags || '[]'))),
      body.source ?? (current.source ?? ''),
      now(), id,
    );
    return promptRow(db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as Record<string, unknown>);
  });

  app.delete('/api/ai-resources/prompts/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    // 软删除：进回收站，可在回收站里回显正文并恢复
    const info = db.prepare('UPDATE prompts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id);
    if (info.changes === 0) throw app.httpErrors.notFound('提示词不存在或已在回收站里');
    return { ok: true };
  });
}
