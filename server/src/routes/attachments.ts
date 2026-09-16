/**
 * [INPUT]: Multipart 上传、附件存储/预览服务及全局访问令牌保护
 * [OUTPUT]: 附件上传/元信息/原件下载、PPT 预览启动和 PDF 读取 API
 * [POS]: 文档文件的 HTTP 边界；非预览原件强制下载，不在工作台域执行用户文件
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { ATTACHMENT_LIMIT, attachmentId, saveAttachment, readAttachment, originalPath, previewPath, attachmentInfo, preparePreview } from '../services/document-attachments.js';
const params = z.object({ id: attachmentId });
export default async function attachmentRoutes(app: FastifyInstance) {
  app.post('/api/attachments', async (req, reply) => {
    const part = await req.file({ limits: { fileSize: ATTACHMENT_LIMIT, files: 1 } });
    if (!part) return reply.status(400).send({ error: '请选择要导入的文件' });
    const bytes = await part.toBuffer();
    if (!bytes.length) return reply.status(400).send({ error: '不能导入空文件' });
    const file = await saveAttachment(part.filename, bytes);
    return attachmentInfo(file);
  });
  app.get('/api/attachments/:id', async (req, reply) => {
    const file = await readAttachment(params.parse(req.params).id);
    return file ? attachmentInfo(file) : reply.status(404).send({ error: '附件不存在或尚未同步' });
  });
  app.post('/api/attachments/:id/preview', async (req, reply) => {
    const file = await readAttachment(params.parse(req.params).id);
    if (!file) return reply.status(404).send({ error: '附件不存在或尚未同步' });
    await preparePreview(file, (error) => app.log.warn({ err: error, attachmentId: file.id }, 'PPT 预览转换失败'));
    return attachmentInfo(file);
  });
  app.get('/api/attachments/:id/download', async (req, reply) => {
    const file = await readAttachment(params.parse(req.params).id);
    const path = file && await originalPath(file.id);
    if (!path || !file) return reply.status(404).send({ error: '原文件不存在或尚未同步' });
    return reply.type('application/octet-stream').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="attachment${/^\.[a-z0-9]+$/.test(file.ext) ? file.ext : ''}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .send(createReadStream(path));
  });
  app.get('/api/attachments/:id/preview.pdf', async (req, reply) => {
    const file = await readAttachment(params.parse(req.params).id);
    const path = file && await previewPath(file);
    if (!path) return reply.status(404).send({ error: '预览尚未就绪' });
    return reply.type('application/pdf').header('X-Content-Type-Options', 'nosniff').header('Content-Disposition', 'inline; filename="preview.pdf"').send(createReadStream(path));
  });
}
