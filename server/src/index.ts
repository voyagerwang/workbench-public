/**
 * [INPUT]: 环境变量（PORT/HOST/ACCESS_TOKEN/WORKBENCH_DEVICE_ROLE/ENABLE_* 等）、settings 配置、
 *          各业务路由（含文档附件）与全局插件（cors/sensible/multipart）
 * [OUTPUT]: Fastify 应用装配与启动监听（默认 127.0.0.1:8787）；统一错误边界（error-handler.ts，
 *           仅透传业务 publicCode）；访问令牌会话；Supabase 同步与调度器启动
 * [POS]: 服务端唯一装配入口：路由注册、全局中间件与错误契约在此收口；
 *        错误处理器必须在路由注册前安装（Fastify 按封装作用域继承，见 error-handler.ts）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { startScheduler } from './scheduler.js';
import { migrateMcpNotes } from './services/knowledge-connectors.js';
import { ensureDingtalkMcpConfig, ensureMyProfile } from './services/dingtalk-mcp.js';
import taskRoutes from './routes/tasks.js';
import inboxRoutes from './routes/inbox.js';
import timeRoutes from './routes/time.js';
import miscRoutes from './routes/misc.js';
import uploadRoutes from './routes/uploads.js';
import attachmentRoutes from './routes/attachments.js';
import trashRoutes from './routes/trash.js';
import clawbotRoutes from './routes/clawbot.js';
import moodRoutes from './routes/mood.js';
import assistantRoutes from './routes/assistant.js';
import aiResourcesRoutes from './routes/ai-resources.js';
import skillCaptureRoutes from './routes/skill-capture.js';
import knowledgeRoutes from './routes/knowledge.js';
import knowledgeTopicRoutes from './routes/knowledge-topics.js';
import knowledgeLifecycleRoutes from './routes/knowledge-lifecycle.js';
import tagRoutes from './routes/tags.js';
import searchRoutes from './routes/search.js';
import syncRoutes from './routes/sync.js';
import feishuBotRoutes from './routes/feishu-bot.js';
import { registerMcp } from './mcp/http.js';
import openaiCompatRoutes from './routes/openai-compat.js';
import { repairOrphanFragmentTasks } from './services/triage.js';
import { getSetting, setSetting } from './db.js';
import { httpErrorHandler } from './error-handler.js';
import { ZodError } from 'zod';
import { startSupabaseSync } from './services/supabase-sync.js';

const PORT = Number(process.env.PORT ?? 8787);
// 默认仅本机访问；需要局域网/公网访问时显式设置 HOST，并配合 ACCESS_TOKEN。
const HOST = process.env.HOST ?? '127.0.0.1';
const ENABLE_EXTERNAL_CONNECTORS = process.env.ENABLE_EXTERNAL_CONNECTORS === '1';
const ENABLE_SUPABASE_SYNC = process.env.ENABLE_SUPABASE_SYNC === '1';

// maxParamLength：Fastify 默认 100 字符，而 IM 桥的会话 key 是
// `im:<渠道>:user:<64位哈希>:conversation:<64位哈希>`（157 字符，URL 编码后更长），
// 超限时 find-my-way 直接抛 FST_ERR_MAX_PARAM_LENGTH(414)——
// 表现就是「微信/飞书对话读不出内容、也删不掉」。放宽到 512 兜住这一类长键。
const app = Fastify({ logger: false, maxParamLength: 512 });

// 错误处理器必须在注册路由插件之前设置：Fastify 按封装作用域继承，
// 后设置不会应用到已注册插件里的路由。
app.setErrorHandler(httpErrorHandler);

// Reject browser requests from unrelated sites, including simple requests.
const trustedOrigins = new Set([
  `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`,
  'http://127.0.0.1:5173', 'http://localhost:5173',
  ...(process.env.WORKBENCH_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
]);
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;
  // A local-only server must not accept a forged Host from DNS rebinding.
  if (['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
    if (!allowedHosts.has(req.headers.host ?? '')) return reply.code(403).send({ error: '不允许此主机访问工作台' });
  }
  if (origin && !trustedOrigins.has(origin)) return reply.code(403).send({ error: '不允许此网页访问工作台' });
  if (!origin && req.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: '不允许跨站访问工作台' });
});
await app.register(cors, { origin: (origin, cb) => cb(null, !origin || trustedOrigins.has(origin)) });
await app.register(sensible);
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

// 可选访问令牌：设置 ACCESS_TOKEN 后，所有请求需携带令牌。
// 安全模型：主令牌只在首次 ?token= 出现一次，验证通过后服务端签发随机会话令牌
// （sha256 后存 settings，Cookie 只放会话令牌本身，HttpOnly），主令牌不再进 Cookie；
// 会话一年过期、可整体吊销（清掉 authSessions 键）。程序化调用（ClawBot/MCP）可继续用 x-access-token。
const ACCESS_TOKEN = process.env.ACCESS_TOKEN?.trim();
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !ACCESS_TOKEN) {
  throw new Error('非本机监听必须配置 ACCESS_TOKEN');
}
if (ACCESS_TOKEN) {
  const { createHash, randomBytes, timingSafeEqual } = await import('node:crypto');
  const sha256 = (v: string) => createHash('sha256').update(v).digest();
  // 恒定时间比较，避免逐字符泄漏
  const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));
  type AuthSession = { token: string; expires: number }; // token 存 sha256 hex
  const loadSessions = () => getSetting<AuthSession[]>('authSessions') ?? [];
  const saveSessions = (list: AuthSession[]) => setSetting('authSessions', list.slice(-200)); // 上限 200 个会话
  const SESSION_TTL = 365 * 86_400_000;

  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    const q = url.match(/[?&]token=([^&]+)/);
    if (q && safeEqual(decodeURIComponent(q[1]), ACCESS_TOKEN)) {
      const session = randomBytes(32).toString('hex');
      const sessions = loadSessions().filter((s) => s.expires > Date.now());
      sessions.push({ token: sha256(session).toString('hex'), expires: Date.now() + SESSION_TTL });
      saveSessions(sessions);
      reply.header('set-cookie', `workbench_session=${session}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
      return; // 本次放行，会话 Cookie 已种下
    }
    const cookie = (req.headers.cookie ?? '').match(/(?:^|;\s*)workbench_session=([^;]+)/)?.[1];
    if (cookie) {
      const hash = sha256(cookie).toString('hex');
      if (loadSessions().some((s) => s.token === hash && s.expires > Date.now())) return;
    }
    if (req.headers['x-access-token'] && safeEqual(String(req.headers['x-access-token']), ACCESS_TOKEN)) return;
    await reply.status(401).send('需要访问令牌：在地址后加 ?token=你的令牌（仅需一次）');
  });
}

app.get('/api/health', () => ({ ok: true, name: 'workbench', time: new Date().toISOString() }));

await app.register(taskRoutes);
await app.register(inboxRoutes);
await app.register(timeRoutes);
await app.register(miscRoutes);
await app.register(trashRoutes);
await app.register(uploadRoutes);
await app.register(attachmentRoutes);
await app.register(clawbotRoutes);
await app.register(moodRoutes);
await app.register(assistantRoutes);
await app.register(aiResourcesRoutes);
await app.register(skillCaptureRoutes);
await app.register(knowledgeRoutes);
await app.register(knowledgeTopicRoutes);
await app.register(knowledgeLifecycleRoutes);
await app.register(tagRoutes);
await app.register(searchRoutes);
await app.register(syncRoutes);
await app.register(feishuBotRoutes);
await app.register(openaiCompatRoutes);
await registerMcp(app);

// 生产模式：托管 web 构建产物 + SPA 回退（开发模式走 Vite 代理，不受影响）
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api')) return reply.status(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}


// 一次性修复历史遗留：随手记建的清单项若缺 planned_date，会同时躲开今日清单与项目页；
// 函数内部用 settings 键保证只在首次启动真正执行
const repaired = repairOrphanFragmentTasks();
if (repaired > 0) console.log(`[triage] 已修复 ${repaired} 条未排期的随手记清单项`);

// 必须先成功占住端口再启动任何有外部副作用的后台任务；否则旧进程占端口时，
// 新进程虽然无法提供页面，却仍可能重复发提醒、同步日历。
await app.listen({ port: PORT, host: HOST });
if (ENABLE_SUPABASE_SYNC) startSupabaseSync();
startScheduler();

// 兜底：已经成功启动后的后台任务异常只记日志，不整崩服务。
process.on('unhandledRejection', (reason) => {
  console.error('[workbench-server] unhandledRejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[workbench-server] uncaughtException:', error);
});

if (ENABLE_EXTERNAL_CONNECTORS) {
  // 启用外部适配器后，才读取/接入外部 MCP 配置。
  void migrateMcpNotes().catch((error) => console.warn('[workbench-server] mcp 补名失败:', error));
  void ensureDingtalkMcpConfig()
    .then(() => ensureMyProfile())
    .catch((error) => console.warn('[workbench-server] 钉钉 MCP 自动接入失败:', error));
}

console.log(`[workbench-server] listening on :${PORT}`);
for (const nets of Object.values(os.networkInterfaces())) {
  for (const net of nets ?? []) {
    if (net.family === 'IPv4' && !net.internal) {
      console.log(`  局域网访问 → http://${net.address}:${PORT}`);
    }
  }
}
if (HOST !== '127.0.0.1') {
  console.log(`  公网/端口映射暴露时请加令牌：ACCESS_TOKEN=你的令牌 npm start`);
}
