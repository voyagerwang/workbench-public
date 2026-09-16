import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { initializeSupabaseSync, supabaseSyncStatus, syncNow } from '../services/supabase-sync.js';

export default async function syncRoutes(app: FastifyInstance) {
  app.get('/api/sync/status', () => supabaseSyncStatus());

  app.post('/api/sync/initialize', async (req, reply) => {
    const body = z.object({
      mode: z.enum(['seed', 'join', 'merge']),
      confirm: z.string().optional(),
    }).parse(req.body);
    if (body.mode === 'join' && body.confirm !== 'replace-local') {
      return reply.status(400).send({ error: '加入云端会替换本机同步数据，请传 confirm=replace-local' });
    }
    return initializeSupabaseSync(body.mode);
  });

  app.post('/api/sync/now', async () => syncNow());
}
