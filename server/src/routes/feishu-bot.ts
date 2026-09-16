import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listFeishuBotMessages, verifyFeishuEvent } from '../services/feishu-bot.js';
export default async function feishuBotRoutes(app: FastifyInstance) { app.post('/api/feishu/bot/events', (req) => verifyFeishuEvent(z.record(z.unknown()).parse(req.body ?? {}))); app.get('/api/feishu/bot/messages', (req) => listFeishuBotMessages(Number((req.query as { limit?: string }).limit ?? 50))); }
