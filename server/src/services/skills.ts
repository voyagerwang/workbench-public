import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { db, now } from '../db.js';

/**
 * 本机 Skill 扫描：以磁盘上的 SKILL.md 为唯一事实来源。
 * AI 资源库路由和云宝对话共用这一份实现；项目根按模块位置定位，不依赖常驻服务启动目录。
 * 文件后半是 Skill 安全写入（workbench_save_skill 两段式）：preview/approve/consume 状态机、
 * 落盘防线与读回验证——安全规则集中在 skills.ts，工具层只做适配（docs/social-link-skill-capture-plan.md）。
 */
export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  path: string;
  root: string;
  source: 'personal' | 'plugin' | 'shared' | 'claude';
  editable: boolean;
  modifiedAt: string;
  content: string;
  contentHash: string;
  usageCount: number;
  lastUsedAt: string | null;
  bySource: Array<{ source: string; count: number }>;
};

export const personalRoot = resolve(homedir(), '.codex', 'skills');
export const claudeRoot = resolve(homedir(), '.claude', 'skills');
export const scanRoots = [
  { path: fileURLToPath(new URL('../../../.agents/skills', import.meta.url)), source: 'shared' as const },
  { path: personalRoot, source: 'personal' as const },
  { path: claudeRoot, source: 'claude' as const },
  { path: resolve(homedir(), '.agents', 'skills'), source: 'shared' as const },
  { path: resolve(process.cwd(), '.agents', 'skills'), source: 'shared' as const },
  { path: resolve(process.cwd(), '..', '.agents', 'skills'), source: 'shared' as const },
  { path: resolve('/etc/codex/skills'), source: 'shared' as const },
  { path: resolve(homedir(), '.cola', 'skills'), source: 'shared' as const },
  { path: resolve(homedir(), '.codex', 'plugins', 'cache'), source: 'plugin' as const },
];

export const idFor = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 24);
export const contentHash = (content: string) => createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex');

export function frontmatter(content: string): { name?: string; description?: string } {
  const block = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!block) return {};
  const value = (key: string) => {
    const match = block[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  };
  return { name: value('name'), description: value('description') };
}

export function findSkillFiles(root: string, maxDepth = 9): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.name === 'SKILL.md') {
        if (entry.isFile()) { found.push(path); continue; }
        // 符号链接形式的 SKILL.md 也收录
        try { if (entry.isSymbolicLink() && statSync(path).isFile()) found.push(path); } catch { /* 悬空链接跳过 */ }
        continue;
      }
      // 目录与符号链接目录都递归：symlink 的 isDirectory() 为 false，需 statSync 确认解析后类型
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        try { if (statSync(path).isDirectory()) walk(path, depth + 1); } catch { /* 悬空链接跳过 */ }
      }
    }
  };
  walk(root, 0);
  return found;
}

export function usageFor(path: string): { usageCount: number; lastUsedAt: string | null; bySource: Array<{ source: string; count: number }> } {
  const total = db.prepare(`SELECT COUNT(*) AS usageCount, MAX(used_at) AS lastUsedAt FROM skill_usage_events WHERE skill_path = ?`)
    .get(path) as { usageCount: number; lastUsedAt: string | null };
  const bySource = db.prepare(`SELECT source, COUNT(*) AS count FROM skill_usage_events WHERE skill_path = ? GROUP BY source ORDER BY count DESC`)
    .all(path) as Array<{ source: string; count: number }>;
  return { ...total, bySource };
}

export function scanSkills(includeContent = false): SkillRecord[] {
  // 第一遍：canonical 真实路径 -> 归属根。同一 skill 可能通过符号链接出现在多个扫描根，
  // 归属优先取「真实宿主根」（canonical 就在该根之下），否则取扫描顺序里首次出现的根。
  const firstSeen = new Map<string, { source: SkillRecord['source']; rootPath: string }>();
  const owner = new Map<string, { source: SkillRecord['source']; rootPath: string }>();
  for (const root of scanRoots) {
    let rootReal: string;
    try { rootReal = realpathSync(root.path); } catch { continue; }
    for (const path of findSkillFiles(root.path)) {
      let canonical: string;
      try { canonical = realpathSync(path); } catch { continue; }
      if (!firstSeen.has(canonical)) firstSeen.set(canonical, { source: root.source, rootPath: root.path });
      if (!owner.has(canonical) && canonical.startsWith(`${rootReal}${sep}`)) {
        owner.set(canonical, { source: root.source, rootPath: root.path });
      }
    }
  }
  const attributed = new Map([...firstSeen, ...owner]); // owner 覆盖 firstSeen

  // 第二遍：按归属根构建记录
  const records: SkillRecord[] = [];
  for (const [canonical, attr] of attributed) {
    let content = '';
    try { content = readFileSync(canonical, 'utf8'); } catch { continue; }
    const meta = frontmatter(content);
    const usage = usageFor(canonical);
    const insidePersonal = canonical.startsWith(`${personalRoot}${sep}`);
    const insideClaude = canonical.startsWith(`${claudeRoot}${sep}`);
    const editable = (insidePersonal && !canonical.includes(`${sep}.system${sep}`)) || insideClaude;
    records.push({
      id: idFor(canonical),
      name: meta.name || basename(dirname(canonical)),
      description: meta.description || '',
      path: canonical,
      root: relative(attr.rootPath, dirname(canonical)) || '.',
      source: attr.source,
      editable,
      modifiedAt: statSync(canonical).mtime.toISOString(),
      content: includeContent ? content : '',
      contentHash: contentHash(content),
      usageCount: usage.usageCount,
      lastUsedAt: usage.lastUsedAt,
      bySource: usage.bySource,
    });
  }
  return records.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

export function requireSkill(id: string): SkillRecord {
  const skill = scanSkills(true).find((item) => item.id === id);
  if (!skill) throw Object.assign(new Error('Skill 不存在，可能已被移动或删除'), { statusCode: 404 });
  return skill;
}

export function recordSkillUse(id: string, source: string): void {
  const skill = scanSkills(false).find((item) => item.id === id);
  if (!skill) return;
  db.prepare('INSERT INTO skill_usage_events (skill_path, source) VALUES (?, ?)').run(skill.path, source);
}

/**
 * 按名称或路径上报一次使用（供 Claude Code hook 等外部工具调用）。
 * 名称匹配目录名或 SKILL.md frontmatter 的 name；重名时优先 personal，其次 claude。
 */
export function recordSkillUseByRef(ref: string, source: string): { usageCount: number; lastUsedAt: string | null; bySource: Array<{ source: string; count: number }> } | null {
  const clean = ref.trim();
  if (!clean) return null;
  const skills = scanSkills(false);
  const order: SkillRecord['source'][] = ['personal', 'claude', 'shared', 'plugin'];
  const matches = skills.filter((s) =>
    s.path === clean
    || basename(dirname(s.path)) === clean
    || s.name === clean
    || s.path === resolve(clean));
  if (!matches.length) return null;
  matches.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  const target = matches[0];
  db.prepare('INSERT INTO skill_usage_events (skill_path, source) VALUES (?, ?)').run(target.path, source);
  return usageFor(target.path);
}

export function recordSkillUses(paths: string[], source: string): void {
  if (!paths.length) return;
  const insert = db.prepare('INSERT INTO skill_usage_events (skill_path, source) VALUES (?, ?)');
  db.transaction(() => paths.forEach((path) => insert.run(path, source)))();
}

const stripFrontmatter = (content: string) => content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();

/**
 * 把用户手动挂载的 Skill 正文拼成一段可注入提示词的说明书，一次扫盘解决多个 id。
 * 只给 SKILL.md：Skill 引用的脚本和参考文件云宝读不到，所以明确要求它按方法直接产出。
 */
export function mountedSkills(ids: string[], perSkill = 20_000): { block: string; names: string[]; paths: string[] } {
  const unique = [...new Set(ids)].slice(0, 3);
  if (!unique.length) return { block: '', names: [], paths: [] };
  const found = scanSkills(true).filter((skill) => unique.includes(skill.id));
  if (!found.length) return { block: '', names: [], paths: [] };
  const parts = found.map((skill) => {
    const body = stripFrontmatter(skill.content).slice(0, perSkill);
    return `【Skill：${skill.name}｜${skill.description || '无说明'}】\n${body}`;
  });
  return {
    block: `用户本轮手动挂载了本机 Skill（来自 ${found.length} 个 SKILL.md）。把它当作方法论与流程说明书执行：\n· 遵循其中的步骤、产出结构与质量标准；\n· 你不能运行 shell、读写任意文件或安装东西，SKILL.md 里要求跑脚本/命令的部分，改成在回复中写清用户要自己执行的步骤；\n· Skill 引用的其它文件你看不到，不要假装读过；\n· 与工作台工具冲突时，以工作台工具的真实数据为准。\n\n${parts.join('\n\n')}`,
    names: found.map((skill) => skill.name),
    paths: found.map((skill) => skill.path),
  };
}

// ---------------------------------------------------------------------------
// Skill 写入（workbench_save_skill 两段式）
//
// docs/social-link-skill-capture-plan.md P2，Codex 五审 APPROVED 的三条不变量：
// 1. 识别结果可信：外部内容（网页/视频转写）按不可信代码处理，未经用户过目不得持久化；
// 2. 写入行为可授权：确认状态机 pending_preview → user_approved → consumed，
//    user_approved 只能由服务端处理真实用户入站消息触发；consume 是单条原子 UPDATE，
//    绑定 token/状态/有效期/payload/name/会话/请求者/批准者，影响行数为 0 一律拒绝。
//    模型同轮「preview→token→write」自证无法落盘——授权真实性来自入站事件，不来自模型参数。
// 3. 落盘安全：固定写根、路径穿越/符号链接/保留名/控制字符拒绝、限长、YAML 转义、
//    同目录临时文件 + 原子 rename、覆盖留 .bak、写后 scanSkills/requireSkill 读回验证。
// ---------------------------------------------------------------------------

/** 写入根：scanRoots 里的 shared 根，三端（codex/claude/工作台）都能扫到。测试可注入临时目录。 */
export const skillSaveRoot = resolve(homedir(), '.agents', 'skills');

/** 实际生效的写入根：verify 脚本经 SKILL_SAVE_ROOT_OVERRIDE 注入临时目录；生产恒为 skillSaveRoot。 */
function activeSkillSaveRoot(): string {
  return process.env.SKILL_SAVE_ROOT_OVERRIDE ? resolve(process.env.SKILL_SAVE_ROOT_OVERRIDE) : skillSaveRoot;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const RESERVED_SKILL_NAMES = new Set(['assets', 'scripts', 'references', 'examples', 'templates', 'node_modules', 'skills']);
const SKILL_CONTENT_MAX_BYTES = 200_000;
const SKILL_DESCRIPTION_MAX_BYTES = 500;
const CONFIRM_TTL_MS = 15 * 60 * 1000;

/** 用户入站确认/拒绝词的确定性分类（服务端在 chat 入口调用，见 processSkillConfirmations）。 */
const SKILL_CONFIRM_RE = /(确认|同意|没问题|覆盖吧|替换吧|保存吧|存吧|就这样(吧|定)?|可以保存)/;
const SKILL_REJECT_RE = /(不要了?|算了|取消|放弃|不行|先不|别存)/;

export type SkillSavePreviewInput = {
  name: string;
  description: string;
  content: string;
  conversationKey: string | null;
  requesterUserId: string;
};

export type SkillSavePreview = {
  stage: 'preview';
  token: string;
  name: string;
  action: 'create' | 'update';
  expiresAt: string;
  existingDescription: string | null;
  preview: string;
};

/** 规范化确认载荷：内容变化（哪怕一个字符）都会改变 payload_hash，旧凭证随之失效。 */
function savePayloadHash(name: string, description: string, content: string): string {
  return createHash('sha256').update(JSON.stringify([name, description, content]), 'utf8').digest('hex');
}

function yamlSafe(text: string): string {
  // 单引号样式 + doubling 转义；控制字符直接剥掉，防止把 frontmatter 撑破
  const clean = text.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return `'${clean.replace(/'/g, "''")}'`;
}

/** 正文里若带了 frontmatter（模型没听话）就剥掉：frontmatter 由服务端生成，不信任外部内容 */
function stripFrontmatterBlock(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
}

function existingSkillFile(root: string, name: string): string | null {
  const file = join(root, name, 'SKILL.md');
  try {
    if (lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) return file;
  } catch { /* 不存在 */ }
  return null;
}

/**
 * 第一段：生成候选稿预览与确认凭证，不写盘。
 * conversationKey 为空（无会话的一次性调用）直接拒绝——没有会话绑定就没有可审计的确认边界。
 */
export function previewSkillSave(input: SkillSavePreviewInput): SkillSavePreview {
  const name = input.name.trim();
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error('Skill 名称不合法：只允许小写字母、数字和连字符，2-64 个字符（如 design-review-flow）');
  }
  if (RESERVED_SKILL_NAMES.has(name)) throw new Error(`「${name}」是保留名，不能用作 Skill 名称`);
  const description = input.description.trim();
  if (!description) throw new Error('缺少 description：候选稿预览需要一句话说明这个 Skill 什么时候用');
  if (Buffer.byteLength(description, 'utf8') > SKILL_DESCRIPTION_MAX_BYTES) {
    throw new Error(`description 超过 ${SKILL_DESCRIPTION_MAX_BYTES} 字节上限`);
  }
  const content = stripFrontmatterBlock(input.content ?? '');
  if (!content) throw new Error('缺少 content：SKILL.md 正文不能为空');
  if (Buffer.byteLength(content, 'utf8') > SKILL_CONTENT_MAX_BYTES) {
    throw new Error(`content 超过 ${SKILL_CONTENT_MAX_BYTES} 字节上限`);
  }
  const conversationKey = input.conversationKey?.trim();
  if (!conversationKey) throw new Error('当前会话无法建立确认凭证：请在有会话的对话里保存 Skill');
  const requesterUserId = input.requesterUserId?.trim();
  if (!requesterUserId) throw new Error('无法确定请求者身份，已拒绝创建确认凭证');

  const root = activeSkillSaveRoot();
  const existing = existingSkillFile(root, name);
  const action: 'create' | 'update' = existing ? 'update' : 'create';
  const token = randomBytes(32).toString('hex');
  // 与 now() 同一本地时刻格式（无时区后缀）：expires_at 的比较全靠字符串序，混用 UTC ISO 会差 8 小时
  const expiresAt = new Date(Date.now() + CONFIRM_TTL_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  const expiresAtText = `${expiresAt.getFullYear()}-${p(expiresAt.getMonth() + 1)}-${p(expiresAt.getDate())}T${p(expiresAt.getHours())}:${p(expiresAt.getMinutes())}:${p(expiresAt.getSeconds())}`;
  db.prepare(`
    INSERT INTO skill_confirmations (token, payload_hash, name, description, content, action, conversation_key, requester_user_id, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_preview', ?)
  `).run(token, savePayloadHash(name, description, content), name, description, content, action,
    conversationKey, requesterUserId, expiresAtText);

  let existingDescription: string | null = null;
  if (existing) {
    try { existingDescription = frontmatter(readFileSync(existing, 'utf8')).description ?? ''; } catch { /* 读不到就当没有 */ }
  }
  const preview = [
    `候选 Skill（${action === 'create' ? '新建' : '覆盖已有'}）：${name}`,
    `说明：${description}`,
    existing ? `⚠️ 已存在同名 Skill${existingDescription ? `（现为：${existingDescription}）` : ''}，确认后旧版会备份为 .bak 再覆盖` : '',
    '--- 正文预览（前 1200 字）---',
    content.slice(0, 1200) + (content.length > 1200 ? '…（已截断）' : ''),
    '---',
    `请确认内容无误后回复「确认」${action === 'update' ? '（覆盖）' : ''}；回复「取消」放弃。凭证 15 分钟内有效。`,
  ].filter(Boolean).join('\n');
  return { stage: 'preview', token, name, action, expiresAt: expiresAtText, existingDescription, preview };
}

/**
 * chat 入口的确认事件处理（唯一能把 pending_preview 推到 user_approved 的路径）。
 * 用最新用户入站消息原文做确定性分类：命中确认词 → user_approved（记录批准者与消息 id 审计）；
 * 命中拒绝词 → cancelled；其余不动。同会话多个 pending 时不猜，等过期或用户指名。
 */
export function processSkillConfirmations(
  conversationKey: string | null,
  approverUserId: string,
  userText: string,
  messageId: string | null = null,
): { approved: number; cancelled: number } {
  if (!conversationKey) return { approved: 0, cancelled: 0 };
  const pending = db.prepare(`
    SELECT id FROM skill_confirmations
    WHERE conversation_key = ? AND status = 'pending_preview' AND expires_at > ?
    ORDER BY id DESC
  `).all(conversationKey, now()) as Array<{ id: number }>;
  if (!pending.length) return { approved: 0, cancelled: 0 };
  const text = userText.trim();
  const approving = text.length <= 30 && SKILL_CONFIRM_RE.test(text) && !SKILL_REJECT_RE.test(text);
  const rejecting = SKILL_REJECT_RE.test(text) && text.length <= 30;
  if (!approving && !rejecting) return { approved: 0, cancelled: 0 };
  if (pending.length > 1) return { approved: 0, cancelled: 0 }; // 多候选不猜，让用户指名或等过期
  if (rejecting) {
    db.prepare(`UPDATE skill_confirmations SET status = 'cancelled' WHERE id = ?`).run(pending[0].id);
    return { approved: 0, cancelled: 1 };
  }
  db.prepare(`
    UPDATE skill_confirmations SET status = 'user_approved', approver_user_id = ?, approve_message_id = ?
    WHERE id = ? AND status = 'pending_preview'
  `).run(approverUserId, messageId, pending[0].id);
  return { approved: 1, cancelled: 0 };
}

export type SkillSaveConsumeInput = {
  token: string;
  name: string;
  description: string;
  content: string;
  conversationKey: string | null;
  requesterUserId: string;
};

export type SkillSaveResult = {
  stage: 'saved';
  id: string;
  name: string;
  path: string;
  action: 'create' | 'update';
  backup: string | null;
  hint: string;
};

/**
 * 第二段：消费凭证并落盘。全程同步执行（校验 → 事务消费 → 原子 rename → 读回验证），
 * 中间没有 await，不存在「验证过了又被别人改」的窗口。
 * 测试注入写根：consume 内部读取 process.env.SKILL_SAVE_ROOT_OVERRIDE（verify 脚本设置），
 * 生产路径固定 skillSaveRoot，模型无法影响写入位置。
 */
export function consumeSkillSave(input: SkillSaveConsumeInput): SkillSaveResult {
  const token = input.token?.trim() ?? '';
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('确认凭证格式不正确：请先调用不带 token 的保存请求生成候选稿预览');
  const conversationKey = input.conversationKey?.trim();
  if (!conversationKey) throw new Error('当前会话无法消费确认凭证：请在有会话的对话里完成保存');
  const requesterUserId = input.requesterUserId?.trim();
  if (!requesterUserId) throw new Error('无法确定请求者身份，已拒绝写入');

  const root = activeSkillSaveRoot();
  const name = input.name.trim();
  if (!SKILL_NAME_RE.test(name) || RESERVED_SKILL_NAMES.has(name)) {
    throw new Error('Skill 名称不合法或是保留名，已拒绝写入');
  }
  const description = input.description.trim();
  const content = stripFrontmatterBlock(input.content ?? '');
  if (!content) throw new Error('SKILL.md 正文不能为空');

  const skillDir = join(root, name);
  const finalFile = join(skillDir, 'SKILL.md');
  // 写根就绪与符号链接防线：目录本体必须是真实目录，不能是链接
  mkdirSync(root, { recursive: true });
  const rootReal = realpathSync(root);
  let existingFile: string | null = null;
  try {
    const dirStat = lstatSync(skillDir);
    if (dirStat.isSymbolicLink()) throw new Error('目标 Skill 目录是符号链接，出于安全考虑拒绝写入');
    existingFile = existingSkillFile(root, name);
    if (existingFile && lstatSync(existingFile).isSymbolicLink()) {
      throw new Error('已有 SKILL.md 是符号链接，出于安全考虑拒绝覆盖');
    }
    if (!realpathSync(skillDir).startsWith(`${rootReal}${sep}`)) {
      throw new Error('目标路径越出了 Skill 写入根，已拒绝');
    }
  } catch (error) {
    if ((error as Error).message.includes('安全考虑') || (error as Error).message.includes('越出')) throw error;
    // skillDir 不存在 = create，正常路径
  }

  // 覆盖前备份（含时间戳与 token 前缀，防同秒冲突）
  let backup: string | null = null;
  if (existingFile) {
    backup = `${finalFile}.bak-${Date.now()}-${token.slice(0, 8)}`;
    copyFileSync(existingFile, backup);
  }

  // 同目录临时文件，rename 是同文件系统原子操作
  const tempFile = join(skillDir, `.SKILL.md.tmp-${token.slice(0, 8)}`);
  const fileBody = `---\nname: ${name}\ndescription: ${yamlSafe(description)}\n---\n\n${content}\n`;
  const action: 'create' | 'update' = existingFile ? 'update' : 'create';
  // create 且目录是本次新建时，消费被拒/写盘失败要连目录一起清掉，不给 Skill 库留空壳
  const dirExistedBefore = existsSync(skillDir);
  const createdDir = action === 'create' && !dirExistedBefore;
  let tempWritten = false;
  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(tempFile, fileBody, 'utf8');
    tempWritten = true;

    // 原子消费：六条件全绑定，影响行数=0 一律拒绝（同轮自证/跨会话/跨用户/重放/过期/篡改全落这里）
    const consume = db.prepare(`
      UPDATE skill_confirmations SET status = 'consumed', consumed_at = ?
      WHERE token = ? AND status = 'user_approved' AND expires_at > ?
        AND payload_hash = ? AND name = ? AND action = ?
        AND conversation_key = ? AND requester_user_id = ? AND approver_user_id = ?
    `);
    const commit = db.transaction(() => {
      const result = consume.run(now(), token, now(), savePayloadHash(name, description, content), name, action,
        conversationKey, requesterUserId, requesterUserId);
      if (result.changes === 0) throw new Error(consumeRejectionReason(token));
      renameSync(tempFile, finalFile);
    });
    commit();
  } catch (error) {
    if (tempWritten) { try { rmSync(tempFile, { force: true }); } catch { /* 清理失败不影响报错 */ } }
    if (createdDir) {
      try { rmSync(skillDir, { recursive: true, force: true }); } catch { /* 清理失败不影响报错 */ }
    }
    throw error;
  }

  // 读回验证：写根内必须能重新发现这个 SKILL.md（生产根在 scanRoots 里，测试根用 findSkillFiles
  // 同一发现逻辑），frontmatter name 与内容哈希都要对得上；失败清理半成品
  const written = readFileSync(finalFile, 'utf8');
  const skillId = idFor(realpathSync(finalFile));
  const discovered = findSkillFiles(root).some((file) => {
    try { return realpathSync(file) === realpathSync(finalFile); } catch { return false; }
  });
  const meta = frontmatter(written);
  if (!discovered || meta.name !== name || contentHash(written) !== contentHash(fileBody)) {
    try {
      if (backup) { copyFileSync(backup, finalFile); }
      else { rmSync(skillDir, { recursive: true, force: true }); }
    } catch { /* 回滚失败也要如实报错 */ }
    throw new Error('Skill 写入后读回验证失败，已回滚；请重试或检查磁盘');
  }
  return {
    stage: 'saved', id: skillId, name, path: finalFile, action, backup,
    hint: action === 'create'
      ? `已创建 Skill「${name}」并可在 Skill 库中被发现。`
      : `已覆盖更新 Skill「${name}」，旧版备份在 ${backup}。`,
  };
}

/** 消费被拒时的可诊断原因：按当前凭证状态给出准确解释，而不是笼统的「拒绝」。 */
function consumeRejectionReason(token: string): string {
  const row = db.prepare('SELECT status, expires_at, requester_user_id, approver_user_id FROM skill_confirmations WHERE token = ?')
    .get(token) as { status: string; expires_at: string; requester_user_id: string; approver_user_id: string | null } | undefined;
  if (!row) return '确认凭证不存在或已被清理，请重新生成候选稿预览';
  if (row.status === 'pending_preview') return '这个候选稿还没有得到用户确认：请先把预览给用户看，等用户明确回复确认后再写入';
  if (row.status === 'consumed') return '确认凭证已被使用过（一次性），请重新生成候选稿预览';
  if (row.status === 'cancelled') return '用户已取消这个候选稿，请重新生成候选稿预览';
  if (row.expires_at <= now()) return '确认凭证已过期（15 分钟），请重新生成候选稿预览';
  return '确认凭证与当前内容、会话或用户不匹配，写入被拒绝；请重新生成候选稿预览';
}

/** 工具层的统一入口：不带 token = 出预览，带 token = 消费写入。 */
export function saveSkill(args: {
  name?: unknown; description?: unknown; content?: unknown; token?: unknown;
  conversationKey: string | null;
  requesterUserId: string;
}): SkillSavePreview | SkillSaveResult {
  const token = typeof args.token === 'string' ? args.token.trim() : '';
  if (!token) {
    return previewSkillSave({
      name: String(args.name ?? ''),
      description: String(args.description ?? ''),
      content: String(args.content ?? ''),
      conversationKey: args.conversationKey,
      requesterUserId: args.requesterUserId,
    });
  }
  return consumeSkillSave({
    token,
    name: String(args.name ?? ''),
    description: String(args.description ?? ''),
    content: String(args.content ?? ''),
    conversationKey: args.conversationKey,
    requesterUserId: args.requesterUserId,
  });
}
