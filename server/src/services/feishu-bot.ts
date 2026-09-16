/**
 * [INPUT]: 飞书应用机器人配置(feishuBot 设置项)、事件回调 webhook 报文、长连接 WS 事件
 *          (lark-cli event consume，经 feishu-chat-ingress 转发)、中继群/agent 私聊消息(经 lark-cli 用户身份拉取)
 * [OUTPUT]: 机器人配置与状态读写、应用机器人消息发送(webhook 时代走默认身份，现回复一律走 --as bot 应用身份)、
 *           事件报文校验与长连接事件入库(ingestFeishuChatEvent，message_id 幂等去重)与 feishu_bot_messages 落账、
 *           relayExperimentEnabled 实验开关判定与中继消息轮询入库(event_id='relay-poll')、
 *           入站状态机(pending→replying→sending→done，补偿扫描 compensatePendingFeishuChats，
 *           回复投递=至少一次：发送前 CAS 争抢，飞书无幂等键故崩溃窗口内可能重复)接统一 chatWithAssistant
 *           契约(编排 V3 阶段 1)，sender id 透传为 InboundRequest.userId（Skill 确认凭证的身份来源）；
 *           p2p 文件消息分支到 feishu-file-knowledge 入知识存档（同样至少一次，崩溃重试可能产生重复存档行）
 * [POS]: 服务端飞书机器人能力的统一入口与飞书来源接线点;中继轮询属编排 V3 阶段 0 已冻结实验链路,
 *        仅当 relayExperimentEnabled===true 才拉取,默认关闭;入站对话只处理机器人私聊的用户文本与文件;
 *        webhook 无公网入口形同停用，私聊入口以长连接为准（chatEnabled 显式 false 可整体关闭）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, getSetting, now, setSetting } from '../db.js';
import { resolveLarkCli } from './lark-cli.js';
import { chatWithAssistant } from './assistant.js';
import { normalizeFeishuInbound } from './inbound-context.js';
import { ingestFeishuFileToKnowledge, parseFileContent } from './feishu-file-knowledge.js';
const execFileAsync = promisify(execFile);
type Config = { appId?: string; appSecret?: string; verificationToken?: string; encryptKey?: string; relayChatId?: string; relayChatIds?: string[]; relayExperimentEnabled?: boolean; chatEnabled?: boolean };
let cache: { value: string; expires: number } | null = null;
const config = () => getSetting<Config>('feishuBot') ?? {};
export function feishuBotStatus() {
  const c = config();
  return {
    configured: Boolean(c.appId && c.appSecret), appId: c.appId ?? '', hasSecret: Boolean(c.appSecret),
    hasVerificationToken: Boolean(c.verificationToken), hasEncryptKey: Boolean(c.encryptKey),
    callbackPath: '/api/feishu/bot/events',
    chat: { enabled: isFeishuChatEnabled(), ...feishuChatIngressRuntime },
  };
}
/** 长连接私聊入口开关：显式 false 关闭，缺省开启（接线上即默认生效）。 */
export function isFeishuChatEnabled(): boolean { return config().chatEnabled !== false; }
/** 长连接入站运行态：由 feishu-chat-ingress 生命周期维护，状态接口只读展示。 */
export const feishuChatIngressRuntime = { running: false, startedAt: null as string | null, lastEventAt: null as string | null, lastError: null as string | null, restarts: 0 };
export function saveFeishuBot(patch: Config) { setSetting('feishuBot', { ...config(), ...patch }); cache = null; return feishuBotStatus(); }
async function token() { if (cache && cache.expires > Date.now() + 60000) return cache.value; const c = config(); if (!c.appId || !c.appSecret) throw new Error('请先配置飞书应用机器人 App ID 和 App Secret'); const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }) }); const b = await res.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }; if (!res.ok || b.code) throw new Error(b.msg || '飞书鉴权失败'); cache = { value: b.tenant_access_token!, expires: Date.now() + (b.expire ?? 7200) * 1000 }; return cache.value; }
export async function sendFeishuBotMessage(type: 'open_id'|'chat_id'|'email'|'user_id', id: string, text: string) {
  const payload = JSON.stringify({ receive_id: id, msg_type: 'text', content: JSON.stringify({ text }) });
  // 常驻服务的 PATH 里通常没有 nvm 的 bin 目录，必须复用统一的路径解析而不是直接写 'lark-cli'。
  const cliPath = process.env.LARK_CLI_PATH || await resolveLarkCli();
  if (!cliPath) throw new Error('未找到 lark-cli。请确认已安装，或设置环境变量 LARK_CLI_PATH 指向可执行文件。');
  try {
    const { stdout } = await execFileAsync(cliPath, ['api', 'POST', `/open-apis/im/v1/messages?receive_id_type=${type}`, '--data', payload, '--jq', '.data.message_id'], { timeout: 20_000, env: process.env, maxBuffer: 1024 * 1024 });
    return { messageId: stdout.trim() || null };
  } catch (error) {
    const e = error as Error & { stderr?: string; stdout?: string };
    throw new Error((e.stderr || e.stdout || e.message || '飞书发消息失败').trim().slice(0, 1000));
  }
}
export async function sendFeishuAppBotMessage(chatId: string, text: string) {
  const payload = JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) });
  const cliPath = process.env.LARK_CLI_PATH || await resolveLarkCli();
  if (!cliPath) throw new Error('未找到 lark-cli。请确认已安装，或设置环境变量 LARK_CLI_PATH 指向可执行文件。');
  try {
    const { stdout } = await execFileAsync(cliPath, [
      'api', 'POST', '/open-apis/im/v1/messages',
      '--params', JSON.stringify({ receive_id_type: 'chat_id' }),
      '--as', 'bot',
      '--data', payload,
      '--jq', '.data.message_id',
    ], { timeout: 20_000, env: process.env, maxBuffer: 1024 * 1024 });
    return { messageId: stdout.trim() || null };
  } catch (error) {
    const e = error as Error & { stderr?: string; stdout?: string };
    throw new Error((e.stderr || e.stdout || e.message || '飞书应用机器人发消息失败').trim().slice(0, 1000));
  }
}
export function verifyFeishuEvent(body: Record<string, unknown>) {
  const c = config();
  if (body.type === 'url_verification') return { challenge: body.challenge };
  if (c.verificationToken && body.token !== c.verificationToken) throw new Error('飞书事件 Token 校验失败');
  const event = body.event as Record<string, unknown> ?? {};
  const message = event.message as Record<string, unknown> ?? {};
  const messageId = message.message_id ?? null;
  // 幂等：webhook 可能对同一事件重推，同 message_id 只入账一次。
  // 去重只代表「已受理」：处理结果由 chat_status 持久化 + 补偿扫描保证至少一次（ORCH-S1-MAJ-001），
  // 模型超时/进程重启不会静默丢消息——行留在 pending，重跑由 agent_tasks.intent_key 幂等兜底。
  const existing = messageId
    ? db.prepare('SELECT id, chat_status FROM feishu_bot_messages WHERE message_id = ?').get(messageId) as { id: number; chat_status: string | null } | undefined
    : undefined;
  if (existing) return { received: true, duplicate: true, chat_status: existing.chat_status };
  const sender = event.sender as Record<string, unknown> ?? {};
  const shouldChat = message.chat_type === 'p2p' && message.message_type === 'text'
    && sender.sender_type !== 'app' && Boolean(messageId);
  const info = db.prepare(
    'INSERT INTO feishu_bot_messages (event_id, message_id, chat_id, content, received_at, chat_status, chat_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    (body.header as Record<string, unknown> | undefined)?.event_id ?? null,
    messageId,
    message.chat_id ?? null,
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? {}),
    now(),
    shouldChat ? 'pending' : null,
    shouldChat ? now() : null,
  );
  // 编排 V3 阶段 1：用户在机器人私聊（p2p）发的文本走统一小精灵契约。
  // fire-and-forget 不阻塞 webhook 应答；群消息、非文本、机器人自己发的消息不进对话。
  if (shouldChat) {
    void processFeishuChatById(Number(info.lastInsertRowid))
      .catch((error) => console.warn('[feishu-bot] 入站消息处理失败（等待补偿扫描）:', (error as Error).message.slice(0, 300)));
  }
  return { received: true };
}

/** 长连接事件（lark-cli event consume 的 NDJSON 展平字段）的入站形状；字段缺失按原样容忍。 */
export type FeishuChatEvent = {
  message_id?: string; chat_id?: string; chat_type?: string; message_type?: string;
  content?: string; sender_id?: string; sender_type?: string; event_id?: string;
};

/**
 * 长连接私聊入站（YZ工作台 聊天入口，编排 V3 契约）：与 verifyFeishuEvent 同一张台账、同一套状态机。
 * p2p 文本 → 对话；p2p 文件 → 知识存档；其余（群聊/非文本非文件/机器人自己）只落账不处理。
 * sender open_id 透传为 InboundRequest.userId。返回落账结果供 ingress 日志与测试断言。
 */
export function ingestFeishuChatEvent(event: FeishuChatEvent): { recorded: boolean; duplicate: boolean; chatted: boolean } {
  const messageId = event.message_id ?? null;
  if (!messageId) return { recorded: false, duplicate: false, chatted: false };
  const existing = db.prepare('SELECT id, chat_status FROM feishu_bot_messages WHERE message_id = ?').get(messageId) as { id: number; chat_status: string | null } | undefined;
  if (existing) return { recorded: true, duplicate: true, chatted: false };
  const isBotSelf = event.sender_type === 'app';
  const chatType = event.chat_type ?? null;
  const fileMeta = !isBotSelf && chatType === 'p2p' && event.message_type === 'file'
    ? parseFileContent(event.content ?? '')
    : null;
  const storedContent = fileMeta
    ? JSON.stringify({ file: fileMeta })
    : JSON.stringify({ text: event.content ?? '', userId: event.sender_id ?? null });
  const shouldChat = !isBotSelf && chatType === 'p2p'
    && (event.message_type === 'text' || (event.message_type === 'file' && Boolean(fileMeta)));
  const info = db.prepare(
    'INSERT INTO feishu_bot_messages (event_id, message_id, chat_id, content, received_at, chat_status, chat_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    event.event_id ?? null,
    messageId,
    event.chat_id ?? null,
    storedContent,
    now(),
    shouldChat ? 'pending' : null,
    shouldChat ? now() : null,
  );
  if (shouldChat) {
    void processFeishuChatById(Number(info.lastInsertRowid))
      .catch((error) => console.warn('[feishu-bot] 入站消息处理失败（等待补偿扫描）:', (error as Error).message.slice(0, 300)));
  }
  return { recorded: true, duplicate: false, chatted: shouldChat };
}

/** 飞书消息 content JSON（{"text":"..."})里的纯文本；解析失败返回空串。 */
function extractFeishuText(content: unknown): string {
  if (typeof content !== 'string') return '';
  try { return (JSON.parse(content) as { text?: string }).text ?? ''; } catch { return ''; }
}

const CHAT_MAX_ATTEMPTS = 3;
/** 失败补偿的静默期：刚入账的行留给首处理，避免补偿扫描和 fire-and-forget 双跑。 */
const CHAT_RETRY_GRACE_MS = 2 * 60_000;
/** 进程内单飞守卫：同一行不允许并发处理（fire-and-forget 与补偿扫描可能同时触发）。 */
const chatInFlight = new Set<number>();
/** 回复发送的进程内单飞守卫：与数据库 CAS 争抢叠加，防同进程并发双发。 */
const sendInFlight = new Set<number>();

/**
 * 按 feishu_bot_messages 行 id 处理一条 pending 私聊入站（状态机见 schema 注释）。
 * pending → 对话 → replying（暂存回复）→ sending（CAS 争抢发送权）→ done；对话失败留 pending 供补偿扫描，
 * 重试耗尽置 failed 转人工。重跑安全：任务侧 intent_key 幂等，恰好一条任务；
 * 回复投递=至少一次（见 sendPendingFeishuChatReply）：replying/sending 阶段的恢复重发可能产生重复消息，
 * 契约不承诺恰好一次。
 */
/** 台账 content 还原：长连接行是 {"file":{key,name}} 或 {"text","userId"}；webhook 旧行是原始 message.content JSON。 */
function parseStoredInbound(content: string): { file: { key: string; name: string } | null; text: string; userId: string | null } {
  try {
    const parsed = JSON.parse(content) as { file?: { key?: string; name?: string } | null; text?: unknown; userId?: unknown };
    const file = parsed.file?.key && parsed.file?.name ? { key: parsed.file.key, name: parsed.file.name } : null;
    return {
      file,
      text: typeof parsed.text === 'string' ? parsed.text : '',
      userId: typeof parsed.userId === 'string' && parsed.userId ? parsed.userId : null,
    };
  } catch {
    return { file: null, text: '', userId: null };
  }
}

/** 一条 pending 行的回复内容：文件行走「下载→提取→入知识存档」，文本行走小精灵对话。 */
async function chatReplyForInboundRow(row: { id: number; message_id: string | null; chat_id: string | null; content: string }): Promise<string> {
  const inbound = parseStoredInbound(row.content);
  if (inbound.file && row.message_id) {
    const result = await ingestFeishuFileToKnowledge({ messageId: row.message_id, fileKey: inbound.file.key, fileName: inbound.file.name });
    return `已存入资料池：《${result.title}》，正文约 ${result.chars} 字（${result.kind}）。要打标签或转成 Skill 的话直接跟我说。`;
  }
  return chatWithAssistantForInbound({
    messageId: row.message_id ?? `row-${row.id}`,
    chatId: row.chat_id,
    text: inbound.text,
    userId: inbound.userId,
  });
}

export async function processFeishuChatById(id: number): Promise<void> {
  if (chatInFlight.has(id)) return;
  const row = db.prepare('SELECT * FROM feishu_bot_messages WHERE id = ?').get(id) as
    | { id: number; message_id: string | null; chat_id: string | null; content: string; chat_status: string | null; chat_attempts: number }
    | undefined;
  if (!row || row.chat_status !== 'pending') return;
  chatInFlight.add(id);
  try {
    db.prepare('UPDATE feishu_bot_messages SET chat_attempts = chat_attempts + 1, chat_updated_at = ? WHERE id = ?').run(now(), id);
    const attempts = row.chat_attempts + 1;
    try {
      const reply = await chatReplyForInboundRow(row);
      db.prepare("UPDATE feishu_bot_messages SET chat_status = 'replying', chat_reply = ?, chat_updated_at = ? WHERE id = ?")
        .run(reply, now(), id);
    } catch (error) {
      console.warn(`[feishu-bot] 入站对话第 ${attempts} 次失败:`, (error as Error).message.slice(0, 300));
      if (attempts >= CHAT_MAX_ATTEMPTS) {
        db.prepare("UPDATE feishu_bot_messages SET chat_status = 'failed', chat_updated_at = ? WHERE id = ?").run(now(), id);
        console.warn(`[feishu-bot] 入站消息 row=${id} 重试耗尽，转人工处理`);
      }
      return;
    }
    await sendPendingFeishuChatReply(id);
  } finally {
    chatInFlight.delete(id);
  }
}

/**
 * replying/sending 状态的收尾：把暂存回复发出去。
 *
 * 投递语义（ORCH-S1-MAJ-001 R1 定稿）＝**至少一次**：
 * - 发送前先做数据库原子争抢（replying→sending / sending 宽限期后重认领），并发补偿只有争抢到的那个会发送；
 * - 发送成功 → done；发送失败 → 留在 sending，宽限期后由补偿重发；
 * - 发送成功后、done 落库前崩溃 → 恢复后会再发一次（飞书发送接口无幂等键，这是已接受的残余重复风险）；
 *   契约层面不承诺"恰好一次"，产品侧（气泡去重由用户可见重复兜底）已知悉。
 */
async function sendPendingFeishuChatReply(id: number): Promise<void> {
  const row = db.prepare('SELECT chat_id, chat_reply, chat_status, chat_updated_at FROM feishu_bot_messages WHERE id = ?').get(id) as
    | { chat_id: string | null; chat_reply: string | null; chat_status: string | null; chat_updated_at: string | null }
    | undefined;
  if (!row || (row.chat_status !== 'replying' && row.chat_status !== 'sending')) return;
  // 原子争抢发送权：replying → sending 只有第一个 UPDATE 生效；sending 的重认领必须在宽限期之后，
  // 这样并发补偿扫描里只有争抢成功者发送，其余调用看到 changes=0 直接退出。
  const graceCutoff = new Date(Date.now() - CHAT_RETRY_GRACE_MS).toISOString();
  const claimed = row.chat_status === 'replying'
    ? db.prepare("UPDATE feishu_bot_messages SET chat_status = 'sending', chat_updated_at = ? WHERE id = ? AND chat_status = 'replying'").run(now(), id)
    : db.prepare("UPDATE feishu_bot_messages SET chat_updated_at = ? WHERE id = ? AND chat_status = 'sending' AND chat_updated_at < ?").run(now(), id, graceCutoff);
  if (claimed.changes === 0) return;
  if (!row.chat_id || !row.chat_reply) {
    db.prepare("UPDATE feishu_bot_messages SET chat_status = 'done', chat_updated_at = ? WHERE id = ?").run(now(), id);
    return;
  }
  if (sendInFlight.has(id)) return;
  sendInFlight.add(id);
  try {
    await sendFeishuAppBotMessage(row.chat_id, row.chat_reply);
    db.prepare("UPDATE feishu_bot_messages SET chat_status = 'done', chat_updated_at = ? WHERE id = ?").run(now(), id);
  } catch (error) {
    console.warn(`[feishu-bot] 入站回复发送失败（row=${id}，宽限期后补偿重发）:`, (error as Error).message.slice(0, 200));
    // 留在 sending：宽限期后由补偿重发（至少一次）。永不置 failed——回复内容已定，重发直到成功。
  } finally {
    sendInFlight.delete(id);
  }
}

/** 补偿扫描：把滞留在 pending / replying / sending 的入站行推进到终态。调度器 30s 调一次 + 启动时调一次。 */
export async function compensatePendingFeishuChats(): Promise<{ rescanned: number; done: number; failed: number }> {
  const cutoff = new Date(Date.now() - CHAT_RETRY_GRACE_MS).toISOString();
  const graceCutoff = cutoff;
  const pending = db.prepare(`
    SELECT id FROM feishu_bot_messages
    WHERE chat_status = 'pending' AND chat_updated_at < ? AND chat_attempts < ${CHAT_MAX_ATTEMPTS}
    ORDER BY id ASC LIMIT 20
  `).all(cutoff) as Array<{ id: number }>;
  // replying/sending = 对话已完成、回复待发/发送结果未知：CAS 争抢后只重发暂存回复，不重跑对话（避免重复回复）
  const replying = db.prepare(`
    SELECT id FROM feishu_bot_messages
    WHERE chat_status = 'replying' OR (chat_status = 'sending' AND chat_updated_at < ?)
    ORDER BY id ASC LIMIT 20
  `).all(graceCutoff) as Array<{ id: number }>;
  let done = 0;
  let failed = 0;
  for (const { id } of pending) {
    try { await processFeishuChatById(id); } catch (error) { console.warn('[feishu-bot] 补偿处理异常:', (error as Error).message.slice(0, 200)); }
  }
  for (const { id } of replying) {
    await sendPendingFeishuChatReply(id);
    const after = db.prepare('SELECT chat_status FROM feishu_bot_messages WHERE id = ?').get(id) as { chat_status: string };
    // 未到 done 的行：要么被别的扫描争抢（单飞让位），要么发送失败留在 sending 等宽限期后重发——都不是本轮失败
    if (after.chat_status === 'done') done += 1;
  }
  return { rescanned: pending.length + replying.length, done, failed };
}

/**
 * 飞书私聊入站 → 统一 chatWithAssistant 契约（编排 V3 阶段 1）。
 * 来源元数据全程携带，agent_delegate 建的任务能回溯到这条消息；
 * 返回回复文本（持久化由 processFeishuChatById 状态机负责，本函数不做状态迁移）。
 */
export async function chatWithAssistantForInbound(input: { messageId: string; chatId: string | null; text: string; userId?: string | null }): Promise<string> {
  const text = input.text.trim();
  if (!text) return '';
  const inbound = normalizeFeishuInbound({
    messageId: input.messageId,
    chatId: input.chatId,
    userId: input.userId ?? null,
    text,
  });
  const result = await chatWithAssistant(
    [{ role: 'user', content: text }],
    { kind: 'global' },
    { sessionId: null, sourceMessageId: null },
    inbound,
  );
  return result.reply;
}

/**
 * 直连入口（保留给测试与脚本）：对话 + 立即回复，不走持久化状态机。
 * 生产链路一律走 verifyFeishuEvent → processFeishuChatById。
 */
export async function runFeishuInboundChat(input: { messageId: string; chatId: string | null; text: string; userId?: string | null }): Promise<void> {
  const reply = await chatWithAssistantForInbound(input);
  if (input.chatId && reply) await sendFeishuAppBotMessage(input.chatId, reply);
}
export function listFeishuBotMessages(limit = 50) { return db.prepare('SELECT * FROM feishu_bot_messages ORDER BY id DESC LIMIT ?').all(Math.min(limit, 200)); }

// 编排 V3 阶段 0:实验 relay 默认冻结,只有显式置 true 才恢复轮询与回执匹配
export function isRelayExperimentEnabled(): boolean { return config().relayExperimentEnabled === true; }

// 中继收件兜底：工作台只监听 127.0.0.1，飞书云的 webhook 够不着本机，事件推送收不到。
// 改用用户身份轮询中继群消息，与 verifyFeishuEvent 落同一张表；message_id 查重保证同一条只入账一次。
export async function pollRelayMessages(): Promise<{ scanned: number; inserted: number; error?: string }> {
  // 阶段 0 冻结:闸门设在收件入口本身,而不只是调度器调用方,防止未来新调用方绕过开关
  if (!isRelayExperimentEnabled()) return { scanned: 0, inserted: 0 };
  // 指挥部群 + 各执行 agent 的私聊会话(如 zcode bot 的 P2P)都算中继收件箱
  const chats = [...new Set([config().relayChatId, ...(config().relayChatIds ?? [])].filter((c): c is string => Boolean(c)))];
  if (chats.length === 0) return { scanned: 0, inserted: 0 };
  const cliPath = process.env.LARK_CLI_PATH || await resolveLarkCli();
  if (!cliPath) return { scanned: 0, inserted: 0, error: '未找到 lark-cli' };
  let scanned = 0;
  let inserted = 0;
  let firstError: string | undefined;
  for (const chatId of chats) {
    try {
      const { stdout } = await execFileAsync(cliPath, ['im', '+chat-messages-list', '--chat-id', chatId, '--as', 'user', '--json'], { timeout: 20_000, env: process.env, maxBuffer: 4 * 1024 * 1024 });
      const parsed = JSON.parse(stdout) as { ok?: boolean; data?: { messages?: Array<{ message_id?: string; msg_type?: string; sender?: { id?: string; id_type?: string; name?: string; sender_type?: string }; content?: string }> } };
      const messages = parsed.data?.messages ?? [];
      scanned += messages.length;
      for (const m of messages) {
        if (!m.message_id || m.msg_type === 'system') continue;
        const seen = db.prepare('SELECT 1 FROM feishu_bot_messages WHERE message_id = ?').get(m.message_id);
        if (seen) continue;
        const content = JSON.stringify({ msg_type: m.msg_type ?? '', sender: m.sender ?? {}, content: m.content ?? '' });
        db.prepare('INSERT INTO feishu_bot_messages (event_id, message_id, chat_id, content, received_at) VALUES (?, ?, ?, ?, ?)').run('relay-poll', m.message_id, chatId, content, now());
        inserted += 1;
      }
    } catch (error) {
      firstError ??= (error as Error).message.slice(0, 300);
    }
  }
  return { scanned, inserted, error: firstError };
}
