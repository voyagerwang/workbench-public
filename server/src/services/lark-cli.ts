/**
 * lark-cli 调用封装。
 *
 * 设计边界：
 * - 只通过 execFile 固定执行 lark-cli，禁止 shell、管道和任意可执行文件。
 * - 所有入参必须以 argv 数组传入，不做字符串拼接。
 * - 输出优先按 JSON 解析；失败时返回受限文本，不回显 token / appSecret。
 *
 * 守护进程启动时 PATH 里通常没有 nvm 的 bin 目录，所以这里必须主动扫描常见安装位置，
 * 不能只依赖 PATH。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants as fsConstants, mkdir, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting } from '../db.js';

const execFileAsync = promisify(execFile);

/**
 * chat_id → 群名 的记忆。
 *
 * 只有 chat_id 时没法反查群名：lark-cli 的 chat-list 只给第一页（20 个群），
 * 目标群常常不在里面。所以每次搜群就把 id→名称 记下来，后面按 id 定位时能叫出真名，
 * 免得对话和派单卡片上挂着一串 oc_ 开头的 id。
 */
const CHAT_NAMES_KEY = 'feishu_chat_names';
const CHAT_NAMES_MAX = 200;
const chatNameMemory = new Map<string, string>();

function loadChatNames(): void {
  if (chatNameMemory.size) return;
  try {
    const saved = getSetting<Record<string, string>>(CHAT_NAMES_KEY) ?? {};
    for (const [id, name] of Object.entries(saved)) {
      if (id && name) chatNameMemory.set(id, name);
    }
  } catch { /* 记忆坏了不影响主流程 */ }
}

function rememberChatName(chatId: string, name: string): void {
  if (!chatId || !name) return;
  loadChatNames();
  if (chatNameMemory.get(chatId) === name) return;
  chatNameMemory.set(chatId, name);
  try {
    const trimmed = [...chatNameMemory.entries()].slice(-CHAT_NAMES_MAX);
    setSetting(CHAT_NAMES_KEY, Object.fromEntries(trimmed));
  } catch { /* 存不下就只留内存里的 */ }
}

/**
 * 项目根目录。本文件位于 <root>/server/{src,dist}/services/ 下，往上三级即根。
 * 下载命令只接受相对路径且禁止 .. 穿越，所以必须把 cwd 固定到根目录再传相对路径。
 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOWNLOAD_DIR = 'data/feishu-downloads';

const CLI_NAME = 'lark-cli';
const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_LARK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type LarkIdentity = 'user' | 'bot';

export type LarkRunResult = {
  ok: boolean;
  exitCode: number | string;
  stdout: string;
  stderr: string;
  json: LarkEnvelope | null;
  durationMs: number;
  timedOut: boolean;
};

type LarkEnvelope = {
  ok?: boolean;
  identity?: string;
  data?: unknown;
  error?: { message?: string; type?: string; subtype?: string; hint?: string } | string;
  [key: string]: unknown;
};

let cachedPath: string | null = null;

function sanitize(text: string): string {
  return text
    .replace(/("(?:access|refresh|tenant|user)_token"|"app_?secret")\s*:\s*"[^"]*"/gi, '$1:"[REDACTED]"')
    .replace(/((?:access|refresh|tenant|user)_token|app_?secret)(\s*[=:]\s*)[^\s,"}]+/gi, '$1$2[REDACTED]')
    .replace(/(authorization\s*[=:]\s*bearer\s+)[^\s,"}]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|token|secret)=)[^&\s]+/gi, '$1[REDACTED]');
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** nvm 目录下的 lark-cli，按版本号倒序（新的优先）。 */
async function nvmCandidates(): Promise<string[]> {
  const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, 'bin', CLI_NAME))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function resolveLarkCli(): Promise<string | null> {
  if (cachedPath && (await isExecutable(cachedPath))) return cachedPath;

  const candidates: string[] = [];
  if (process.env.LARK_CLI_PATH) candidates.push(process.env.LARK_CLI_PATH);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, CLI_NAME));
  }
  candidates.push('/opt/homebrew/bin/lark-cli', '/usr/local/bin/lark-cli');
  candidates.push(...(await nvmCandidates()));

  for (const candidate of [...new Set(candidates)]) {
    if (!(await isExecutable(candidate))) continue;
    try {
      cachedPath = await realpath(candidate);
    } catch {
      cachedPath = path.resolve(candidate);
    }
    return cachedPath;
  }
  return null;
}

export function larkError(error: unknown): Error {
  const err = error as Error & { stderr?: string; stdout?: string; code?: string };
  const detail = sanitize((err.stderr || err.stdout || '').trim());
  if (err.code === 'ETIMEDOUT' || /timed out/i.test(err.message ?? '')) {
    return new Error(`lark-cli 执行超时：${detail || err.message}`);
  }
  return new Error(detail || err.message || 'lark-cli 执行失败');
}

async function run(argv: string[], timeoutMs = DEFAULT_TIMEOUT_MS, cwd?: string): Promise<LarkRunResult> {
  const cliPath = await resolveLarkCli();
  if (!cliPath) {
    throw new Error('未找到 lark-cli。请确认已安装，或设置环境变量 LARK_CLI_PATH 指向可执行文件。');
  }
  const startedAt = Date.now();
  const timeout = Math.min(Math.max(Math.trunc(timeoutMs) || DEFAULT_TIMEOUT_MS, 1), MAX_LARK_TIMEOUT_MS);
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, argv, {
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      cwd,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      },
    });
    // 解析必须基于原始输出：sanitize 的正则会吃掉 URL 参数后面的引号与花括号，
    // 把合法 JSON 改坏（表现为某个群突然读不出消息）。脱敏只在向外报错误文本时做。
    const out = stdout ?? '';
    return {
      ok: true,
      exitCode: 0,
      stdout: out,
      stderr: stderr ?? '',
      json: parseEnvelope(out),
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  } catch (error) {
    const err = error as Error & { code?: string | number; stderr?: string; stdout?: string; killed?: boolean };
    const out = err.stdout ?? '';
    const errOut = err.stderr ?? '';
    return {
      ok: false,
      exitCode: err.code ?? -1,
      stdout: out,
      stderr: errOut,
      json: parseEnvelope(out) ?? parseEnvelope(errOut),
      durationMs: Date.now() - startedAt,
      timedOut: err.killed === true,
    };
  }
}

/**
 * 把字符串字面量里的裸控制字符转义掉。
 *
 * 飞书正文（富文本、卡片 payload）里会出现 0x00–0x1F 的裸字节，标准 JSON 不允许，
 * 一个字节就能让整段 200KB+ 输出全部解析失败——表现为"某个群突然读不出消息"。
 * 只在字符串字面量内部做替换，token 之间的换行/制表符是合法空白，不能动。
 */
function escapeBareControlChars(text: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      out.push(ch);
      continue;
    }
    if (escaped) { out.push(ch); escaped = false; continue; }
    if (ch === '\\') { out.push(ch); escaped = true; continue; }
    if (ch === '"') { out.push(ch); inString = false; continue; }
    const code = text.charCodeAt(i);
    if (code >= 0x20) { out.push(ch); continue; }
    out.push(
      code === 0x08 ? '\\b'
        : code === 0x09 ? '\\t'
          : code === 0x0a ? '\\n'
            : code === 0x0c ? '\\f'
              : code === 0x0d ? '\\r'
                : `\\u${code.toString(16).padStart(4, '0')}`,
    );
  }
  return out.join('');
}

function parseEnvelope(text: string): LarkEnvelope | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates: string[] = [trimmed];
  // CLI 偶发在 JSON 前打印进度行（如 "[page 1] fetching..."），从第一个 { 起重试。
  const start = trimmed.indexOf('{');
  if (start > 0) candidates.push(trimmed.slice(start));
  // 正文里的裸控制字符会让整段 JSON 作废，转义后重试一次。
  candidates.push(escapeBareControlChars(trimmed));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as LarkEnvelope;
    } catch { /* 换下一种修法 */ }
  }
  return null;
}

function errorMessage(result: LarkRunResult): string {
  const envelope = result.json;
  const fromJson = envelope?.error;
  if (typeof fromJson === 'string' && fromJson.trim()) return fromJson.trim();
  if (fromJson && typeof fromJson === 'object' && fromJson.message) {
    return [fromJson.message, fromJson.hint].filter(Boolean).join('；');
  }
  // stdout/stderr 只在报错时外泄，脱敏放在这里——绝不在解析前改原文。
  return sanitize(result.stderr.trim()) || sanitize(result.stdout.trim()) || `lark-cli 退出码 ${String(result.exitCode)}`;
}

/** 执行并校验飞书返回信封，失败时抛出可直接展示给模型的错误。 */
async function runEnvelope(argv: string[], timeoutMs?: number, cwd?: string): Promise<LarkEnvelope> {
  const result = await run(argv, timeoutMs, cwd);
  const envelope = result.json;
  if (!result.ok || !envelope || envelope.ok === false) {
    throw new Error(errorMessage(result).slice(0, 800));
  }
  return envelope;
}

const asArray = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 数字字段在 CLI 输出里时而是 number 时而是字符串，统一收敛；缺失一律 null，不拿 0 冒充。 */
const num = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * 消息字段映射。读群消息与读话题回复共用同一份映射，
 * 否则两边字段会悄悄漂移——关联逻辑依赖的 sender_id / thread_id 一旦只在一侧解析就会漏判。
 */
function mapLarkMessages(items: Array<Record<string, unknown>>): LarkMessage[] {
  return items.map((message) => {
    const sender = (message.sender ?? {}) as Record<string, unknown>;
    const i18n = (sender.sender_i18n_names ?? {}) as Record<string, unknown>;
    const msgType = str(message.msg_type);
    const messageId = str(message.message_id);
    // 系统消息没有发送人，统一标记为「系统」，避免模型把空名字当成真人。
    const isSystem = msgType === 'system' || (!sender.name && !i18n.zh_cn && !sender.sender_type);
    return {
      message_id: messageId,
      create_time: str(message.create_time),
      msg_type: msgType,
      sender_name: isSystem ? '系统' : (str(sender.name) || str(i18n.zh_cn) || '(未知发送者)'),
      sender_type: isSystem ? 'system' : str(sender.sender_type),
      content: collapseContent(message.content, msgType),
      attachments: extractAttachments(message.content, messageId),
      sender_id: str(sender.id),
      sender_bot_id: str(sender.open_bot_id),
      thread_id: str(message.thread_id),
      mentions: asArray(message.mentions).map((mention) => ({
        id: str(mention.id) || str(mention.user_id) || str(mention.open_id),
        key: str(mention.key),
        name: str(mention.name),
      })).filter((mention) => mention.id || mention.name),
      message_position: num(message.message_position),
      deleted: message.deleted === true,
    };
  }).filter((message) => message.message_id);
}

export type LarkChatSummary = {
  chat_id: string;
  name: string;
  chat_mode: string;
  description: string;
};

export type LarkMember = {
  member_id: string;
  name: string;
  kind: 'user' | 'bot';
};

export type LarkAttachment = {
  /** 资源类型：file / image 等，对应下载命令的 --type。 */
  type: string;
  file_key: string;
  name: string;
  message_id: string;
};

export type LarkMention = { id: string; key: string; name: string };

export type LarkMessage = {
  message_id: string;
  create_time: string;
  msg_type: string;
  sender_name: string;
  sender_type: string;
  content: string;
  /** 附件类消息的资源定位信息；无附件时为空数组，便于模型判断能否下载。 */
  attachments: LarkAttachment[];
  /**
   * 发送者 ID。真人/机器人身份是 `ou_`，应用身份是 `cli_`。
   * 这是把「机器人回音」关联回「派单动作」的关键字段之一。
   */
  sender_id: string;
  /** 机器人发送者额外带的 `open_bot_id`（`ou_`），与群成员 member_id 同构，可直接比对。 */
  sender_bot_id: string;
  /** 话题 ID（`omt_xxx`）。飞书没有 parent_id/root_id，回复链靠它组织；未被回复时为空。 */
  thread_id: string;
  /** 本条艾特了谁，lark-cli 已解析成结构化数组。 */
  mentions: LarkMention[];
  /** 群内单调递增序号。create_time 只有分钟精度，不能当游标，排序与去重要用这个。 */
  message_position: number | null;
  /** 已撤回/已删除。撤回的消息不能当作执行结果，关联时必须跳过。 */
  deleted: boolean;
};

export type LarkStatus = {
  available: boolean;
  path: string | null;
  version: string | null;
  auth: { ok: boolean; identity: string | null; user: boolean; bot: boolean; message: string | null };
};

export async function larkStatus(): Promise<LarkStatus> {
  const cliPath = await resolveLarkCli();
  if (!cliPath) {
    return {
      available: false,
      path: null,
      version: null,
      auth: { ok: false, identity: null, user: false, bot: false, message: '未找到 lark-cli' },
    };
  }
  const [versionResult, authResult] = await Promise.all([
    run(['--version'], 15_000),
    run(['auth', 'status', '--json', '--verify'], 30_000),
  ]);
  const authJson = authResult.json;
  const identities = (authJson?.identities ?? {}) as Record<string, Record<string, unknown>>;
  const authOk = authResult.ok && authJson?.verified === true;
  return {
    available: versionResult.ok,
    path: cliPath,
    version: versionResult.stdout.trim().split('\n')[0] || null,
    auth: {
      ok: authOk,
      identity: str(authJson?.identity) || null,
      user: identities.user?.available === true,
      bot: identities.bot?.available === true,
      message: authOk ? null : errorMessage(authResult).slice(0, 400),
    },
  };
}

/** 按关键词搜索可见群聊；关键词为空时列出最近的群。 */
export async function searchChats(query: string, limit = 20): Promise<LarkChatSummary[]> {
  const trimmed = query.trim();
  const argv = trimmed
    ? ['im', '+chat-search', '--query', trimmed, '--as', 'user', '--format', 'json']
    : ['im', '+chat-list', '--as', 'user', '--format', 'json'];
  const envelope = await runEnvelope(argv);
  const chats = asArray((envelope.data as Record<string, unknown> | undefined)?.chats);
  return chats.slice(0, Math.max(1, Math.min(limit, 50))).map((chat) => {
    const chat_id = str(chat.chat_id);
    const name = str(chat.name);
    rememberChatName(chat_id, name);
    return {
      chat_id,
      name,
      chat_mode: str(chat.chat_mode),
      description: str(chat.description).slice(0, 120),
    };
  });
}

/**
 * 只知道 chat_id 时反查群名。对话、派单卡片里到处要展示群名，
 * 拿一串 oc_ 开头的 id 顶替会让人看不懂是哪个群。查不到就返回 null，调用方回落用 id。
 */
export async function getChatById(chatId: string): Promise<LarkChatSummary | null> {
  const trimmed = chatId.trim();
  if (!trimmed) return null;
  // 先查记忆：chat-list 只给第一页 20 个群，靠列全量反查经常查不到
  loadChatNames();
  const remembered = chatNameMemory.get(trimmed);
  if (remembered) return { chat_id: trimmed, name: remembered, chat_mode: '', description: '' };
  try {
    const chats = await searchChats('', 100);
    return chats.find((chat) => chat.chat_id === trimmed) ?? null;
  } catch {
    return null;
  }
}

/**
 * 按群名定位唯一群聊。命中多个时抛错并列出候选，绝不随便挑一个发。
 */
export async function resolveChatByName(name: string): Promise<LarkChatSummary> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('必须提供群名');
  const chats = await searchChats(trimmed, 20);
  if (!chats.length) throw new Error(`没有找到名字包含“${trimmed}”的飞书群`);

  const exact = chats.filter((chat) => chat.name.trim() === trimmed);
  if (exact.length === 1) return exact[0];

  const lower = trimmed.toLocaleLowerCase();
  const contains = chats.filter((chat) => chat.name.toLocaleLowerCase().includes(lower));
  if (contains.length === 1) return contains[0];

  const pool = exact.length ? exact : contains.length ? contains : chats;
  const preview = pool.slice(0, 10).map((chat, index) => `${index + 1}. ${chat.name}（${chat.chat_id}）`).join('；');
  throw new Error(`“${trimmed}”匹配到 ${pool.length} 个群，请说清是哪一个：${preview}`);
}

export async function listChatMembers(chatId: string, as: LarkIdentity = 'user'): Promise<LarkMember[]> {
  const envelope = await runEnvelope([
    'im', '+chat-members-list',
    '--chat-id', chatId,
    '--member-types', 'user,bot',
    '--page-all',
    '--page-limit', '10',
    '--as', as,
    '--format', 'json',
  ]);
  const data = (envelope.data ?? {}) as Record<string, unknown>;
  return [
    ...asArray(data.users).map((member) => ({ member_id: str(member.member_id), name: str(member.name), kind: 'user' as const })),
    ...asArray(data.bots).map((member) => ({ member_id: str(member.member_id), name: str(member.name), kind: 'bot' as const })),
  ].filter((member) => member.member_id);
}

export type ReadMessagesOptions = {
  limit?: number;
  order?: 'asc' | 'desc';
  as?: LarkIdentity;
};

export async function readChatMessages(chatId: string, options: ReadMessagesOptions = {}): Promise<LarkMessage[]> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 20), 50));
  const order = options.order === 'asc' ? 'asc' : 'desc';
  const as = options.as === 'bot' ? 'bot' : 'user';
  // 服务端一页实际只回约 20 条且会再过滤一次，单靠 --page-size 拿不满，
  // 所以固定按 50 请求并自动翻页凑够 limit 条数。
  const pages = Math.min(5, Math.max(1, Math.ceil(limit / 20)));
  const envelope = await runEnvelope([
    'im', '+chat-messages-list',
    '--chat-id', chatId,
    '--page-size', '50',
    '--page-all',
    '--page-limit', String(pages),
    '--order', order,
    '--no-reactions',
    '--as', as,
    '--format', 'json',
  ], 45_000);
  const data = (envelope.data ?? {}) as Record<string, unknown>;
  // CLI 返回的条数可能多于请求值，这里按请求值收敛。
  return mapLarkMessages(asArray(data.messages)).slice(0, limit);
}

export type ThreadReplies = {
  /** 解析后的话题 ID；尚未产生回复时可能为空。 */
  thread_id: string;
  total: number;
  messages: LarkMessage[];
};

/**
 * 读取某条消息的话题回复（飞书的「回复」机制）。
 *
 * 这是把机器人回音关联回派单动作的主路径：一条消息被回复后才会有 thread，
 * 所以「没有 thread」与「有 thread 但没人回」都表现为 total=0，调用方要按「尚未收到回复」处理，
 * 不能当成错误。命令接受 `om_` 或 `omt_` 输入，内部自动解析。
 */
export async function readThreadReplies(
  messageIdOrThreadId: string,
  as: LarkIdentity = 'user',
): Promise<ThreadReplies> {
  const id = messageIdOrThreadId.trim();
  if (!/^(om_|omt_)/.test(id)) {
    throw new Error(`不是合法的飞书消息/话题 ID：${messageIdOrThreadId}`);
  }
  const envelope = await runEnvelope([
    'im', '+threads-messages-list',
    '--thread', id,
    '--order', 'asc',
    '--no-reactions',
    '--as', as,
    '--format', 'json',
  ], 45_000);
  const data = (envelope.data ?? {}) as Record<string, unknown>;
  const messages = mapLarkMessages(asArray(data.messages).length ? asArray(data.messages) : asArray(data.items));
  return {
    thread_id: str(data.thread_id) || (id.startsWith('omt_') ? id : ''),
    total: num(data.total) ?? messages.length,
    messages,
  };
}

/** 飞书系统消息是英文占位模板，翻成中文再交给模型，避免模型原样念给用户。 */
const SYSTEM_MESSAGE_HINTS: Array<[RegExp, string]> = [
  [/\{GroupOwner\}\s*added\s*\{NewGroupAdministrators\}/i, '群主添加了新的群管理员'],
  [/\{GroupOwner\}\s*removed\s*\{RemovedGroupAdministrators\}/i, '群主移除了群管理员'],
  [/\{?JoinUser\}?\s*joined/i, '新成员加入了群聊'],
  [/\{?LeaveUser\}?\s*(left|exited)/i, '有成员退出了群聊'],
  [/\{?PinnedMessage\}?/i, '群公告已更新'],
];

/**
 * 附件消息把 key 藏在 content 的 XML 里（如 <file key="file_v3_x" name="a.html"/>），
 * 必须在压平成可读文本之前抽出来，否则下载时已经拿不到 key 了。
 */
function extractAttachments(content: unknown, messageId: string): LarkAttachment[] {
  const text = typeof content === 'string' ? content : '';
  if (!text.includes('<')) return [];
  const found: LarkAttachment[] = [];
  const pattern = /<(file|image|img|audio|media|video)\b([^>]*)\/?>/gi;
  for (const match of text.matchAll(pattern)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] ?? '';
    const key = /key\s*=\s*"([^"]+)"/i.exec(attrs)?.[1]
      ?? /key\s*=\s*'([^']+)'/i.exec(attrs)?.[1]
      ?? '';
    if (!key) continue;
    const name = /name\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]
      ?? /name\s*=\s*'([^']*)'/i.exec(attrs)?.[1]
      ?? '';
    found.push({
      type: tag === 'img' ? 'image' : tag,
      file_key: key,
      name: name || key,
      message_id: messageId,
    });
  }
  return found;
}

const MEDIA_LABELS: Record<string, string> = {
  image: '图片', img: '图片', audio: '语音', media: '视频',
  video: '视频', sticker: '表情', folder: '文件夹', todo: '任务',
};

/**
 * 单条消息压平后保留的最大字符数。
 * 2026-09-02：从 1200 上调到 3000 —— 实测 7号 的总结回复长 1213 字被腰斩，
 * 最后一条 commit 说明正好被切在中间，模型据此判断会漏信息。
 */
export const MESSAGE_TEXT_LIMIT = 3000;

function collapseContent(content: unknown, msgType = ''): string {
  let text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  // 飞书侧无法解析的消息类型，CLI 会原样返回占位串。
  if (text.trim() === '[nonsupport]') return '[飞书暂不支持解析该消息类型]';
  if (msgType === 'system') {
    const hit = SYSTEM_MESSAGE_HINTS.find(([pattern]) => pattern.test(text));
    return hit ? hit[1] : text.trim();
  }
  const flattened = sanitizeLarkMarkup(text);
  return flattened.length > MESSAGE_TEXT_LIMIT
    ? `${flattened.slice(0, MESSAGE_TEXT_LIMIT)}…（内容过长已截断）`
    : flattened;
}

/**
 * 把飞书侧 XML 标记（@提及 / 卡片 / 文件 / 图片等）翻译成人能读的中文。
 * 不做长度截断——这是供「展示原文 / 入库前清洗」共用的中间步骤。
 * 调用方拿到结果后再按需截断。
 *
 * 顺序不能动：at 必须最先被解析，否则它会被 card/file 规则吃掉，
 * 再还原不回来，用户自己写的「@7号」就会在派单卡片上裸着一长串 XML。
 */
export function sanitizeLarkMarkup(text: string): string {
  return text
    .replace(/<at\b[^>]*>([^<]*)<\/at>/gi, '@$1')
    .replace(/<card[^>]*>/g, '')
    .replace(/<\/card>/g, '')
    .replace(/<file\b[^>]*\bname="([^"]*)"[^>]*\/?>/gi, (_, name: string) => `[文件] ${name}`)
    .replace(/<(image|img|audio|media|video|sticker|folder|todo)\b[^>]*\/?>/gi, (_m, tag: string) => `[${MEDIA_LABELS[String(tag).toLowerCase()] ?? tag}]`)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/🖼️\s*Image\([^)]*\)/g, '[图片]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type DownloadResult = {
  ok: boolean;
  /** 绝对路径，可直接用于展示给用户。 */
  path: string;
  /** 相对项目根目录的路径。 */
  relative_path: string;
  name: string;
  size_bytes: number;
};

/**
 * 文件名消毒：剥掉路径分隔符与 ..，去掉控制字符。
 * 下载命令本身还会再做一次穿越校验，这里是第一道防线。
 */
function sanitizeFileName(raw: string, fallback: string): string {
  const base = path.basename((raw || '').trim()).replace(/[\u0000-\u001f\u007f]/g, '');
  const cleaned = base.replace(/^\.+/, '').replace(/[\\/:*?"<>|]/g, '_').trim();
  const stem = (cleaned || fallback).slice(0, 120);
  // 去掉扩展名交给 CLI 从 Content-Disposition 推断，避免出现 .html.html
  return stem.replace(/\.[A-Za-z0-9]{1,8}$/, '') || fallback;
}

/** 下载消息中的文件/图片资源到本地 data/feishu-downloads/。 */
export async function downloadMessageResource(options: {
  messageId: string;
  fileKey: string;
  type?: string;
  name?: string;
  as?: LarkIdentity;
}): Promise<DownloadResult> {
  const messageId = options.messageId.trim();
  const fileKey = options.fileKey.trim();
  if (!messageId.startsWith('om_')) throw new Error('messageId 不合法，应以 om_ 开头');
  if (!/^(file|img)_[A-Za-z0-9_-]+$/.test(fileKey)) throw new Error('fileKey 不合法');

  const type = options.type === 'image' || options.type === 'img' ? 'image' : 'file';
  const as = options.as === 'bot' ? 'bot' : 'user';
  const stem = sanitizeFileName(options.name ?? '', fileKey.replace(/[^A-Za-z0-9_-]/g, ''));
  await mkdir(path.join(PROJECT_ROOT, DOWNLOAD_DIR), { recursive: true });

  const envelope = await runEnvelope([
    'im', '+messages-resources-download',
    '--message-id', messageId,
    '--file-key', fileKey,
    '--type', type,
    '--output', `${DOWNLOAD_DIR}/${stem}`,
    '--as', as,
    '--format', 'json',
  ], 60_000, PROJECT_ROOT);

  const data = (envelope.data ?? {}) as Record<string, unknown>;
  const saved = str(data.saved_path).trim();
  // CLI 可能返回相对路径或绝对路径，统一解析成项目根下的绝对路径。
  const absolute = saved ? path.resolve(PROJECT_ROOT, saved) : path.join(PROJECT_ROOT, DOWNLOAD_DIR, stem);
  return {
    ok: true,
    path: absolute,
    relative_path: path.relative(PROJECT_ROOT, absolute),
    name: path.basename(absolute),
    size_bytes: typeof data.size_bytes === 'number' ? data.size_bytes : 0,
  };
}

/** 去掉正文开头已有的「@某某」手写艾特，支持 @ 与全角＠，以及中英文冒号/逗号分隔。 */
function stripLeadingMentions(text: string, names: string[]): string {
  let result = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of names) {
      if (!name) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`^\\s*[@＠]\\s*${escaped}\\s*[:：,，、]*\\s*`, 'i');
      const next = result.replace(pattern, '');
      if (next !== result) {
        result = next;
        changed = true;
      }
    }
  }
  return result.trim();
}

export type DeleteMessageOptions = {
  /** 待撤回的 om_ 消息 ID。 */
  messageId: string;
  /** 必须用「发送时的那个身份」撤回，见下方 deleteChatMessage 注释。 */
  as: LarkIdentity;
  dryRun?: boolean;
};

export type DeleteMessageResult = {
  ok: boolean;
  identity: string;
  dry_run: boolean;
};

/**
 * 撤回一条已发送的消息。
 *
 * 两个硬约束，来自 `lark-cli im messages delete --help`：
 *
 * 1. **身份必须跟发送时一致**。帮助原文：撤回群消息时 bot 必须在群里；
 *    撤回**另一个用户**的群消息，bot 必须是 owner、admin 或 creator。
 *    也就是说用 bot 身份去撤 user 身份发的消息，在 bot 不是管理员的群里必然失败。
 *    所以这里不做身份兜底或降级——调用方必须把 Item 冻结的 sender_identity 原样传进来。
 *
 * 2. **这是 high-risk-write，需要 `--yes`**。CLI 帮助明确要求：
 *    agent 不得自行加 `--yes`，只能在用户确认后传。
 *    这里的 `--yes` 只代表一件事：**用户在界面上点了这个条目的撤回按钮**。
 *    因此本函数绝不能被自动流程调用——没有自动撤回、没有模型触发、没有失败自动回滚重试。
 *    `dryRun` 时不传 `--yes`，因为压根不会执行。
 */
export async function deleteChatMessage(options: DeleteMessageOptions): Promise<DeleteMessageResult> {
  const messageId = (options.messageId ?? '').trim();
  if (!messageId) throw new Error('缺少消息 ID，无法撤回');
  const as = options.as === 'bot' ? 'bot' : 'user';

  const argv = ['im', 'messages', 'delete', '--message-id', messageId, '--as', as, '--format', 'json'];
  if (options.dryRun) argv.push('--dry-run');
  else argv.push('--yes'); // 见上方注释：仅代表用户已显式确认撤回这一条

  const envelope = await runEnvelope(argv);
  return {
    ok: true,
    identity: str(envelope.identity) || as,
    dry_run: options.dryRun === true,
  };
}

export type SendMessageOptions = {
  chatId: string;
  text: string;
  mentionNames?: string[];
  as?: LarkIdentity;
  format?: 'text' | 'markdown';
  dryRun?: boolean;
};

export type SendMessageResult = {
  ok: boolean;
  message_id: string | null;
  identity: string;
  mentioned: Array<{ name: string; member_id: string }>;
  /** 拼装后的最终正文（含 <at> 标签），便于发送前人工预览。 */
  body: string;
  dry_run: boolean;
};

export async function sendChatMessage(options: SendMessageOptions): Promise<SendMessageResult> {
  const text = options.text.trim();
  if (!text) throw new Error('消息内容不能为空');
  if (text.length > 20_000) throw new Error('消息内容超过 20000 字上限');

  // 默认用本人身份发：群里的机器人普遍忽略来自其他机器人的艾特（防互踢循环），
  // 只有真人身份的消息才会被响应。仅当用户显式要求时才退回 bot 身份。
  const as = options.as === 'bot' ? 'bot' : 'user';
  const mentionNames = (options.mentionNames ?? []).map((name) => name.trim()).filter(Boolean);
  let mentioned: Array<{ name: string; member_id: string }> = [];

  if (mentionNames.length) {
    // 成员名解析是读操作，固定用 user 身份：机器人应用通常没有成员读取权限。
    const members = await listChatMembers(options.chatId, 'user');
    mentioned = mentionNames.map((name) => {
      const matches = members.filter((member) => member.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
      if (!matches.length) {
        const pool = members.slice(0, 30).map((member) => member.name).filter(Boolean).join('、');
        throw new Error(`群里没有名为“${name}”的成员。可用成员：${pool || '（读取为空）'}`);
      }
      // 同名优先取机器人，艾特机器人派活是主场景。
      const target = matches.find((member) => member.kind === 'bot') ?? matches[0];
      return { name: target.name, member_id: target.member_id };
    });
  }

  const mentionText = mentioned.map((member) => `<at user_id="${member.member_id}">${member.name}</at>`).join(' ');
  // 用户正文里常已手写「@7号」，剥离开头的同名艾特，避免出现“@7号 @7号”重复。
  const cleaned = stripLeadingMentions(text, mentioned.map((member) => member.name));
  const body = mentionText ? (cleaned ? `${mentionText} ${cleaned}` : mentionText) : text;
  const contentFlag = options.format === 'markdown' ? '--markdown' : '--text';

  const argv = ['im', '+messages-send', '--chat-id', options.chatId, contentFlag, body, '--as', as, '--format', 'json'];
  if (options.dryRun) argv.push('--dry-run');

  let envelope: LarkEnvelope;
  try {
    envelope = await runEnvelope(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 机器人不在群里是最常见的失败原因，直接给出可操作的下一步。
    if (/out of the chat|not in the chat|NOT be out/i.test(message)) {
      throw new Error(`${message}（当前以 ${as} 身份发送；可尝试改用 as=user 用自己的账号发送）`);
    }
    throw error;
  }
  const data = (envelope.data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    message_id: str(data.message_id) || null,
    identity: str(envelope.identity) || as,
    mentioned,
    body,
    dry_run: options.dryRun === true,
  };
}
