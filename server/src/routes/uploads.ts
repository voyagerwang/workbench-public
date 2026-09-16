// 详情图片：上传与读取（存 data/uploads，文件名随机，仅图片格式）
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataDir } from '../db.js';
import { downloadSyncFile, queueSyncFile } from '../services/supabase-sync.js';

const uploadsDir = join(dataDir, 'uploads');
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

// 只收位图；svg 可携带脚本，不放行
export const UPLOAD_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};
const EXT_BY_MIME = Object.fromEntries(Object.entries(UPLOAD_MIME).map(([ext, mime]) => [mime, ext])) as Record<string, string>;
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export default async function uploadRoutes(app: FastifyInstance) {
  app.post('/api/uploads', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.status(400).send({ error: '缺少文件' });
    const filenameExt = extname(file.filename).toLowerCase();
    // 剪贴板截图在某些浏览器里没有文件名，可从可信的图片 MIME 补出后缀。
    const ext = UPLOAD_MIME[filenameExt] === file.mimetype ? filenameExt : EXT_BY_MIME[file.mimetype];
    if (!ext) return reply.status(400).send({ error: '仅支持图片：png/jpg/gif/webp/avif/bmp' });
    const buf = await file.toBuffer();
    if (buf.length > MAX_SIZE) return reply.status(400).send({ error: '图片不能超过 10MB' });
    const name = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}${ext}`;
    writeFileSync(join(uploadsDir, name), buf);
    queueSyncFile(name);
    return { url: `/api/files/${name}`, size: buf.length };
  });

  app.get('/api/files/:name', async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const ext = extname(name).toLowerCase();
    if (!UPLOAD_MIME[ext] || !/^[a-z0-9]+-[a-f0-9]{12}\.[a-z0-9]+$/i.test(name)) {
      return reply.status(400).send({ error: 'bad name' });
    }
    const p = join(uploadsDir, name);
    if (!existsSync(p)) {
      const remote = await downloadSyncFile(name);
      if (!remote) return reply.status(404).send({ error: 'not found' });
      writeFileSync(p, remote);
    }
    return reply.type(UPLOAD_MIME[ext]).send(createReadStream(p));
  });
}
