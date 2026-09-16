/**
 * [INPUT]: 标签池请求——池列表、关联内容、全局重命名/删除、自动打标触发与单篇资料标签增删
 * [OUTPUT]: /api/tags 系列与 /api/knowledge/documents/:sourceKey/tags 端点
 * [POS]: 统一标签池的接口层；只做校验与状态码，业务口径在 tag-pool / tag-auto 服务
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addDocumentTag,
  deleteTagEverywhere,
  documentTags,
  listTagPool,
  removeDocumentTag,
  renameTag,
  tagItems,
} from '../services/tag-pool.js';
import { autoTagDocuments } from '../services/tag-auto.js';

const nameParam = z.object({ name: z.string().min(1).max(100) });

export default async function tagRoutes(app: FastifyInstance) {
  /** 池列表：自动与手动同池，带资料/手记两侧使用计数 */
  app.get('/api/tags', async () => ({ tags: listTagPool() }));

  /** 关联视图：一个标签同时挂着哪些资料与手记 */
  app.get('/api/tags/:name/items', async (req) => {
    const { name } = nameParam.parse(req.params);
    return tagItems(name);
  });

  /** 全局重命名（资料 + 手记一起改）；撞名 409，合并功能留给 V2 */
  app.post('/api/tags/rename', async (req) => {
    const body = z.object({ from: z.string().min(1).max(100), to: z.string().min(1).max(100) }).parse(req.body ?? {});
    return renameTag(body.from, body.to);
  });

  /** 全局删除：资料关联置 rejected（自动不再加回）、手记摘除、登记行软删留档 */
  app.delete('/api/tags/:name', async (req) => {
    const { name } = nameParam.parse(req.params);
    return deleteTagEverywhere(name);
  });

  /** 自动打标：不传 sourceKeys = 给全部「正文可用且无标签」的资料排队；force = 忽略已有标签重跑 */
  app.post('/api/tags/auto-tag', async (req) => {
    const body = z.object({
      sourceKeys: z.array(z.string().min(1).max(400)).max(2000).optional(),
      force: z.boolean().optional(),
    }).parse(req.body ?? {});
    return autoTagDocuments(body.sourceKeys, Boolean(body.force));
  });

  // ---------------- 单篇资料的标签（挂在 /api/knowledge/documents 语义域下） ----------------

  app.get('/api/knowledge/documents/:sourceKey/tags', async (req) => {
    const { sourceKey } = z.object({ sourceKey: z.string().min(1) }).parse(req.params);
    return { tags: documentTags(sourceKey) };
  });

  app.post('/api/knowledge/documents/:sourceKey/tags', async (req) => {
    const { sourceKey } = z.object({ sourceKey: z.string().min(1) }).parse(req.params);
    const body = z.object({ name: z.string().min(1).max(100) }).parse(req.body ?? {});
    return { tag: addDocumentTag(sourceKey, body.name) };
  });

  app.delete('/api/knowledge/documents/:sourceKey/tags/:name', async (req) => {
    const { sourceKey, name } = z.object({ sourceKey: z.string().min(1), name: z.string().min(1).max(100) }).parse(req.params);
    return removeDocumentTag(sourceKey, name);
  });
}
