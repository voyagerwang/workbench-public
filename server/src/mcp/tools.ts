// MCP 工具集：供微信 clawbot（OpenClaw）等外部 agent 调用
// 设计目标：随手记捕获 + 全量读写工作台数据 + 上下文简报，让外部 agent「了解我」
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { db, now, today } from '../db.js';
import { extractRecurringSchedule, repeatRuleSchema, stripRecurringPrefix } from '../services/recurrence.js';
import { extractWhen } from '../services/classify.js';

import { reminderChannelSchema } from '../services/reminder-channels.js';


import { reclassifyCapture, triageCapture, type CaptureItem } from '../services/triage.js';
import { createNextRecurringTask } from '../services/recurring-tasks.js';
import { resolveReminderChannel } from '../services/reminders.js';
import { getMoodPayload } from '../services/mood.js';
import {
  getChatById,
  listChatMembers,
  readChatMessages,
  resolveChatByName,
  searchChats,
  sendChatMessage,
  type LarkIdentity,
} from '../services/lark-cli.js';

// ---------- 工具注册辅助：结果统一序列化为 text content ----------

type Args<S extends ZodRawShape> = { [K in keyof S]: z.infer<S[K]> };

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function tool<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  meta: { title: string; description: string },
  inputSchema: S,
  execute: (args: Args<S>) => unknown,
): void {
  // SDK 的 registerTool 泛型回调与本地包装层类型不互通（ShapeOutput 与映射类型互不兼容），
  // 此处做受控断言：运行时行为与直接调用 registerTool 完全一致
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { title: string; description: string; inputSchema: S },
    cb: (args: Args<S>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ) => void;
  register(name, { title: meta.title, description: meta.description, inputSchema },
    async (args) => jsonResult(await execute(args)));
}

// ---------- 查询辅助 ----------

/** 捕获条目的落地描述：进了哪个模块、日期与提醒时间，让外部 agent 能原样复述 */
function describeCaptureItem(item: CaptureItem): string {
  const mod = item.type === 'task' ? '清单项' : item.type === 'note' ? '笔记' : '提醒';
  const t = item.target;
  if (!t || t.missing) return `${mod}（随手记#${item.fragmentId}，目标缺失，需在工作台重新分诊）`;
  const bits: string[] = [];
  if (t.planned_date) bits.push(`计划 ${t.planned_date}`);
  const at = t.remind_at ?? t.trigger_at;
  if (at) bits.push(`${item.type === 'task' ? '联动提醒' : '触发'} ${at.slice(0, 16).replace('T', ' ')}`);
  if (t.trashed) bits.push('目标在回收站');
  if (item.needsReview) bits.push('低置信度待复核');
  return `${mod}#${t.id}（随手记#${item.fragmentId}${bits.length ? `，${bits.join('，')}` : ''}）`;
}

const TASK_ROW = `
  SELECT t.id, t.title, t.notes, t.project_id, t.status, t.priority, t.due_at,
         t.planned_date, t.remind_at, t.repeat_rule, t.detail, t.completed_at, t.created_at, t.updated_at,
         p.name AS project_name, p.domain AS project_domain
  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id`;

type TaskRow = {
  id: number; title: string; notes: string; project_id: number | null; status: string;
  priority: number; due_at: string | null; planned_date: string | null; remind_at: string | null; repeat_rule: string;
  detail: string; completed_at: string | null; created_at: string; updated_at: string;
  project_name: string | null; project_domain: string | null;
};

function slimTask(t: TaskRow) {
  return {
    id: t.id, title: t.title, status: t.status, priority: t.priority,
    plannedDate: t.planned_date, dueAt: t.due_at, remindAt: t.remind_at, repeatRule: t.repeat_rule,
    project: t.project_name, domain: t.project_domain,
    notes: t.notes ? t.notes.slice(0, 300) : '',
    completedAt: t.completed_at,
  };
}

function localDateStr(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function safeParseTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

type McpChatTarget = { chat_id: string; name: string };

/** MCP 外部 agent 共用的群目标解析：优先使用 chat_id，否则按群名唯一匹配。 */
async function resolveMcpChatTarget(chatId?: string, chatName?: string): Promise<McpChatTarget> {
  const id = chatId?.trim();
  if (id) {
    const known = chatName?.trim() || (await getChatById(id))?.name || id;
    return { chat_id: id, name: known };
  }
  const name = chatName?.trim();
  if (!name) throw new Error('必须提供 chatName 或 chatId');
  const chat = await resolveChatByName(name);
  return { chat_id: chat.chat_id, name: chat.name };
}

function mcpIdentity(value?: string, fallback: LarkIdentity = 'user'): LarkIdentity {
  return value === 'bot' ? 'bot' : value === 'user' ? 'user' : fallback;
}

// ---------- 注册工具 ----------

export function registerTools(server: McpServer): void {
  // ---------- 飞书群（供微信 OpenClaw 经工作台 MCP 调用） ----------
  // 这些工具必须走工作台已授权的 lark-cli；不要让外部 agent 自己执行本地 shell 命令。
  tool(server, 'feishu_chat_search', {
    title: '搜索飞书群',
    description: '按群名或关键词搜索用户可见的飞书群。用户提到群名但没有 chat_id 时必须先调用本工具定位；不要执行本地 lark-cli shell 命令。',
  }, {
    query: z.string().optional().describe('群名或关键词；留空列出最近群聊'),
    limit: z.number().int().min(1).max(50).default(20).optional(),
  }, async ({ query, limit }) => ({
    query: query?.trim() ?? '',
    chats: await searchChats(query ?? '', limit ?? 20),
  }));

  tool(server, 'feishu_chat_members', {
    title: '查询飞书群成员',
    description: '列出飞书群中的用户和机器人，返回可用于艾特的准确显示名。艾特前必须调用本工具确认名称。',
  }, {
    chatName: z.string().optional().describe('飞书群名称；不传 chatId 时使用'),
    chatId: z.string().optional().describe('飞书群 chat_id（oc_ 开头）'),
    as: z.enum(['user', 'bot']).default('user').optional().describe('读取身份，默认 user'),
  }, async ({ chatName, chatId, as }) => {
    const chat = await resolveMcpChatTarget(chatId, chatName);
    const members = await listChatMembers(chat.chat_id, mcpIdentity(as));
    return {
      chat,
      count: members.length,
      users: members.filter((member) => member.kind === 'user'),
      bots: members.filter((member) => member.kind === 'bot'),
    };
  });

  tool(server, 'feishu_chat_messages', {
    title: '读取飞书群消息',
    description: '读取飞书群最近消息，用于查找链接、确认机器人回复和归纳群内进展。',
  }, {
    chatName: z.string().optional().describe('飞书群名称；不传 chatId 时使用'),
    chatId: z.string().optional().describe('飞书群 chat_id（oc_ 开头）'),
    limit: z.number().int().min(1).max(50).default(20).optional(),
    order: z.enum(['asc', 'desc']).default('desc').optional(),
    as: z.enum(['user', 'bot']).default('user').optional().describe('读取身份，默认 user'),
  }, async ({ chatName, chatId, limit, order, as }) => {
    const chat = await resolveMcpChatTarget(chatId, chatName);
    const messages = await readChatMessages(chat.chat_id, {
      limit: limit ?? 20,
      order: order ?? 'desc',
      as: mcpIdentity(as),
    });
    return { chat, count: messages.length, order: order ?? 'desc', messages };
  });

  tool(server, 'feishu_chat_send', {
    title: '发送飞书群消息',
    description: '向指定飞书群发送文字或 Markdown，可按群内准确显示名艾特成员/机器人。仅在用户明确要求发送时调用；先用 feishu_chat_members 确认艾特名称。默认以用户身份发送，避免机器人艾特不触发响应。',
  }, {
    chatName: z.string().optional().describe('飞书群名称；不传 chatId 时使用'),
    chatId: z.string().optional().describe('飞书群 chat_id（oc_ 开头）'),
    text: z.string().min(1).max(20000),
    mentionNames: z.array(z.string().min(1).max(100)).max(20).optional().describe('群内准确显示名，不要自行猜测'),
    format: z.enum(['text', 'markdown']).default('text').optional(),
    as: z.enum(['user', 'bot']).default('user').optional(),
    dryRun: z.boolean().default(false).optional().describe('true 只预览，不实际发送'),
  }, async ({ chatName, chatId, text, mentionNames, format, as, dryRun }) => {
    const chat = await resolveMcpChatTarget(chatId, chatName);
    const result = await sendChatMessage({
      chatId: chat.chat_id,
      text,
      mentionNames: mentionNames ?? [],
      format: format ?? 'text',
      as: mcpIdentity(as),
      dryRun: dryRun === true,
    });
    return { ...result, chat };
  });

  tool(server, 'capture', {
    title: '小精灵快速记录',
    description: '把用户随口说的一句/一段话交给小精灵，自动分发成任务/笔记/提醒（可拆分成多条）。这是最常用的工具：用户说“记一下…”“帮我记…”“待会儿要做…”时调用。原话会保留为后台捕获记录。',
  }, {
    text: z.string().min(1).max(4000).describe('要记录的原始内容，保留原意'),
  }, async ({ text }) => {
    // 与 POST /api/fragments 共用 triageCapture：清单项必带计划日期，「明天提醒我做 X」会同时挂联动提醒
    const { aiUsed, split, analysis, items } = await triageCapture(text);
    return {
      ok: true,
      aiUsed,
      split,
      analysis,
      items,
      hint: `已${aiUsed ? '按模型' : '按本地规则'}分诊${split ? `并拆成 ${items.length} 条` : ''}：`
        + `${items.map(describeCaptureItem).join('；')}。用户说分类不对时用 reclassify_capture（传 fragmentId）改`,
    };
  });

  tool(server, 'reclassify_capture', {
    title: '调整分发类型',
    description: '用户在微信里说分类错了、要改到清单/笔记/提醒时调用；旧条目会软删进回收站，提醒优先复用同一行（提醒模块里不会多出一条）。',
  }, {
    id: z.number().int().describe('捕获记录 id（capture 返回的 fragmentId）'),
    to: z.enum(['task', 'note', 'reminder']).describe('目标模块：清单 / 笔记 / 提醒'),
    remindAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional()
      .describe('提醒时间 YYYY-MM-DDTHH:mm（本地时间）；缺省时沿用原条目时间或按内容推算'),
  }, ({ id, to, remindAt }) => {
    const r = reclassifyCapture(id, to, { remindAt });
    const mod = to === 'task' ? '清单' : to === 'note' ? '笔记' : '提醒';
    if (!r.changed) return { ...r, hint: `捕获记录#${id} 本来就分在${mod}，未做改动` };
    const bits: string[] = [];
    if (r.target?.planned_date) bits.push(`计划 ${r.target.planned_date}`);
    const at = r.target?.remind_at ?? r.target?.trigger_at;
    if (at) bits.push(`提醒 ${at.slice(0, 16).replace('T', ' ')}`);
    if (r.note) bits.push(r.note);
    return { ...r, hint: `捕获记录#${id} 已迁移到${mod}（${mod}#${r.id}${bits.length ? `，${bits.join('，')}` : ''}）` };
  });

  tool(server, 'daily_briefing', {
    title: '今日简报',
    description: '获取某天的完整简报：计划任务、逾期任务、日程、待触发提醒、本周完成节奏、活跃项目进展、近期随手记。用于“今天怎么样”“我现在该干嘛”之类的总览提问，以及对话前建立上下文。',
  }, {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD，默认今天'),
  }, async ({ date }) => {
    const d = date ?? today();
    const plannedTasks = (db.prepare(
      `${TASK_ROW} WHERE t.deleted_at IS NULL AND t.planned_date = ? ORDER BY t.priority DESC, t.status = 'done'`,
    ).all(d) as TaskRow[]).map(slimTask);
    const overdue = (db.prepare(
      `${TASK_ROW} WHERE t.deleted_at IS NULL AND t.status != 'done' AND t.planned_date IS NOT NULL AND t.planned_date < ? AND (t.due_at IS NULL OR t.due_at < ?) ORDER BY t.planned_date ASC`,
    ).all(d, now()) as TaskRow[]).map(slimTask).slice(0, 20);
    const events = db.prepare(
      `SELECT title, start_at, end_at, is_all_day, location, organizer FROM events
       WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC`,
    ).all(`${d}T00:00:00`, `${d}T23:59:59`);
    const reminders = db.prepare(
      `SELECT id, message, trigger_at FROM reminders
       WHERE deleted_at IS NULL AND status = 'pending' AND trigger_at LIKE ? ORDER BY trigger_at ASC`,
    ).all(`${d}%`);
    // 本周完成节奏（习惯画像）
    const week = new Date(`${d}T00:00:00`);
    const mon = new Date(week); mon.setDate(mon.getDate() - (mon.getDay() + 6) % 7);
    const nextMon = new Date(mon); nextMon.setDate(nextMon.getDate() + 7);
    const perDay = db.prepare(
      `SELECT substr(completed_at, 1, 10) AS d, COUNT(*) AS n FROM tasks
       WHERE status='done' AND deleted_at IS NULL AND completed_at >= ? AND completed_at < ? GROUP BY d`,
    ).all(`${localDateStr(mon)}T00:00:00`, `${localDateStr(nextMon)}T00:00:00`);
    const projects = db.prepare(`
      SELECT p.name, p.domain,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status != 'done') AS open_tasks,
        (SELECT MAX(t.completed_at) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'done') AS last_done
      FROM projects p WHERE p.status = 'active' AND p.deleted_at IS NULL
      ORDER BY p.updated_at DESC LIMIT 20`).all();
    const recentFragments = db.prepare(
      'SELECT content, triaged_type, created_at FROM fragments WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 10',
    ).all();
    return { date: d, plannedTasks, overdue, events, reminders, weekCompletion: perDay, activeProjects: projects, recentFragments };
  });

  tool(server, 'list_tasks', {
    title: '查询任务',
    description: '按条件查询任务清单：状态、所属项目、关键词、计划日期。',
  }, {
    status: z.enum(['todo', 'doing', 'done']).optional().describe('默认返回未完成'),
    projectId: z.number().optional(),
    keyword: z.string().optional().describe('标题/备注关键词'),
    plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.number().int().min(1).max(200).default(50).optional(),
  }, async (q) => {
    const status = q.status ?? 'todo';
    const limit = q.limit ?? 50;
    let rows: TaskRow[];
    if (q.keyword) {
      rows = db.prepare(
        `${TASK_ROW} WHERE t.deleted_at IS NULL AND t.status = ? AND (t.title LIKE ? OR t.notes LIKE ?) ORDER BY t.planned_date IS NULL, t.planned_date ASC, t.priority DESC LIMIT ?`,
      ).all(status, `%${q.keyword}%`, `%${q.keyword}%`, limit) as TaskRow[];
    } else if (q.plannedDate) {
      rows = db.prepare(
        `${TASK_ROW} WHERE t.deleted_at IS NULL AND t.status = ? AND t.planned_date = ? ORDER BY t.priority DESC LIMIT ?`,
      ).all(status, q.plannedDate, limit) as TaskRow[];
    } else if (q.projectId !== undefined) {
      rows = db.prepare(
        `${TASK_ROW} WHERE t.deleted_at IS NULL AND t.status = ? AND t.project_id = ? ORDER BY t.created_at DESC LIMIT ?`,
      ).all(status, q.projectId, limit) as TaskRow[];
    } else {
      rows = db.prepare(
        `${TASK_ROW} WHERE t.deleted_at IS NULL AND t.status = ? ORDER BY t.planned_date IS NULL, t.planned_date ASC, t.priority DESC LIMIT ?`,
      ).all(status, limit) as TaskRow[];
    }
    return { count: rows.length, tasks: rows.map(slimTask) };
  });

  tool(server, 'create_task', {
    title: '新建任务',
    description: '在工作台新建一条任务。小精灵已自动分发时不必重复建；需要带项目、截止时间、优先级或重复规则等结构化信息时用这个。',
  }, {
    title: z.string().min(1),
    notes: z.string().optional(),
    projectId: z.number().nullable().optional(),
    plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('计划日期 YYYY-MM-DD'),
    dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).nullable().optional().describe('截止时间 ISO 本地'),
    remindAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).nullable().optional().describe('到点提醒'),
    repeatRule: repeatRuleSchema.optional().describe('重复规则；每周五等周期任务用 weekly，并把 plannedDate 填下一次周五；每月X号用 monthly，每N天用 ndays:N'),
    priority: z.number().int().min(0).max(2).optional().describe('0 普通 / 1 重要 / 2 紧急重要'),
    channel: reminderChannelSchema.optional().describe('送达渠道：auto 跟随设置；inapp/system/feishu/dingtalk/weixin，支持逗号分隔多选，如 feishu,dingtalk；不传则跟随默认设置'),
  }, async (b) => {
    const recurring = extractRecurringSchedule(b.title);
    const title = recurring ? stripRecurringPrefix(b.title) : b.title;
    const plannedDate = recurring?.plannedDate ?? b.plannedDate ?? extractWhen(b.title)?.slice(0, 10) ?? null;
    const repeatRule = recurring?.repeatRule ?? b.repeatRule ?? 'none';
    const nextSort = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS v FROM tasks').get() as { v: number }).v + 1;
    const info = db.prepare(
      'INSERT INTO tasks (id, title, notes, project_id, priority, due_at, planned_date, remind_at, repeat_rule, sort_order) VALUES (sync_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(title, b.notes ?? '', b.projectId ?? null, b.priority ?? 0, b.dueAt ?? null, plannedDate, b.remindAt ?? null, repeatRule, nextSort);

    const id = Number(info.lastInsertRowid);
    if (b.remindAt) {
      db.prepare('INSERT INTO reminders (id, message, trigger_at, repeat_rule, channel, status, linked_task_id) VALUES (sync_id(), ?, ?, ?, ?, ?, ?)')
        .run(`任务 · ${title}`, b.remindAt, 'none', resolveReminderChannel(b.channel), 'pending', id);
    }
    return slimTask(db.prepare(`${TASK_ROW} WHERE t.id = ?`).get(id) as TaskRow);
  });

  tool(server, 'update_task', {
    title: '更新任务',
    description: '修改任务字段：改计划日期、挂到项目、调整优先级、补备注等。',
  }, {
    id: z.number().int(),
    title: z.string().optional(),
    notes: z.string().optional(),
    projectId: z.number().nullable().optional(),
    status: z.enum(['todo', 'doing', 'done']).optional(),
    plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).nullable().optional(),
    remindAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).nullable().optional(),
    repeatRule: repeatRuleSchema.optional().describe('重复规则；完成后自动生成下一期任务'),
    priority: z.number().int().min(0).max(2).optional(),
    channel: reminderChannelSchema.optional().describe('送达渠道：auto 跟随设置；inapp/system/feishu/dingtalk/weixin，支持逗号分隔多选，如 feishu,dingtalk；不传则跟随默认设置'),
  }, async (b) => {
    const cur = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(b.id) as Record<string, unknown> | undefined;
    if (!cur) throw new Error(`任务 #${b.id} 不存在`);
    const next: Record<string, unknown> = {
      title: b.title ?? cur.title,
      notes: b.notes ?? cur.notes,
      project_id: b.projectId !== undefined ? b.projectId : cur.project_id,
      status: b.status ?? cur.status,
      priority: b.priority !== undefined ? b.priority : cur.priority,
      due_at: b.dueAt !== undefined ? b.dueAt : cur.due_at,
      planned_date: b.plannedDate !== undefined ? b.plannedDate : cur.planned_date,
      remind_at: b.remindAt !== undefined ? b.remindAt : cur.remind_at,
      repeat_rule: b.repeatRule !== undefined ? b.repeatRule : cur.repeat_rule,
      completed_at: cur.completed_at,
      updated_at: now(),
      id: b.id,
    };
    if (b.status === 'done' && cur.status !== 'done') next.completed_at = now();
    if (b.status && b.status !== 'done') next.completed_at = null;
    db.prepare(`UPDATE tasks SET title=@title, notes=@notes, project_id=@project_id, status=@status,
      priority=@priority, due_at=@due_at, planned_date=@planned_date, remind_at=@remind_at,
      repeat_rule=@repeat_rule, completed_at=@completed_at, updated_at=@updated_at WHERE id=@id`).run(next);

    // 提醒生命周期联动（与 PATCH /api/tasks/:id 一致）。
    // 已响但没处置的提醒也要一起失效：任务都做完了，再挂着一条「到点了」是自相矛盾。
    if (b.status === 'done' && cur.status !== 'done') {
      db.prepare("UPDATE reminders SET status = 'done' WHERE linked_task_id = ? AND status IN ('pending', 'fired')").run(b.id);
      createNextRecurringTask(b.id);
    } else if (b.remindAt !== undefined) {
      db.prepare("DELETE FROM reminders WHERE linked_task_id = ? AND status != 'done'").run(b.id);
      if (b.remindAt) {
        db.prepare('INSERT INTO reminders (id, message, trigger_at, repeat_rule, channel, status, linked_task_id) VALUES (sync_id(), ?, ?, ?, ?, ?, ?)')
          .run(`任务 · ${next.title}`, b.remindAt, 'none', resolveReminderChannel(b.channel), 'pending', b.id);
      }
    }
    return slimTask(db.prepare(`${TASK_ROW} WHERE t.id = ?`).get(b.id) as TaskRow);
  });

  tool(server, 'complete_task', {
    title: '完成任务',
    description: '把任务标记为完成（连带关掉它的提醒）。用户说“搞定了”“做完了”时调用。',
  }, {
    id: z.number().int(),
  }, async ({ id }) => {
    const cur = db.prepare('SELECT id, status FROM tasks WHERE id = ? AND deleted_at IS NULL').get(id) as { status: string } | undefined;
    if (!cur) throw new Error(`任务 #${id} 不存在`);
    if (cur.status === 'done') return { ok: true, id, alreadyDone: true, nextTaskId: null };
    db.prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
    db.prepare("UPDATE reminders SET status = 'done' WHERE linked_task_id = ? AND status = 'pending'").run(id);
    const nextId = createNextRecurringTask(id);
    return { ok: true, id, completedAt: now(), nextTaskId: nextId };
  });

  tool(server, 'list_projects', {
    title: '项目列表',
    description: '列出全部项目及进度（未完成/已完成任务数、最近完成时间），工作/生活两个域。',
  }, {}, async () => {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.description, p.domain, p.status,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status != 'done') AS open_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'done') AS done_tasks,
        (SELECT MAX(t.completed_at) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'done') AS last_done_at
      FROM projects p WHERE p.deleted_at IS NULL
      ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, p.updated_at DESC`).all();
    return { projects: rows };
  });

  tool(server, 'search_notes', {
    title: '搜索笔记',
    description: '按关键词或标签搜索知识笔记全文。',
  }, {
    keyword: z.string().optional(),
    tag: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20).optional(),
  }, async (q) => {
    const limit = q.limit ?? 20;
    let rows: Array<Record<string, unknown>>;
    if (q.keyword) {
      rows = db.prepare(
        'SELECT id, title, tags, substr(content, 1, 500) AS excerpt, updated_at FROM notes WHERE deleted_at IS NULL AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT ?',
      ).all(`%${q.keyword}%`, `%${q.keyword}%`, limit) as never;
    } else if (q.tag) {
      rows = db.prepare(
        'SELECT id, title, tags, substr(content, 1, 500) AS excerpt, updated_at FROM notes WHERE deleted_at IS NULL AND tags LIKE ? ORDER BY updated_at DESC LIMIT ?',
      ).all(`%"${q.tag}"%`, limit) as never;
    } else {
      rows = db.prepare(
        'SELECT id, title, tags, substr(content, 1, 500) AS excerpt, updated_at FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?',
      ).all(limit) as never;
    }
    return { notes: rows.map((r) => ({ ...r, tags: safeParseTags(r.tags) })) };
  });

  tool(server, 'read_note', {
    title: '读笔记全文',
    description: '按 id 读取一条笔记的完整内容（Markdown）。',
  }, {
    id: z.number().int(),
  }, async ({ id }) => {
    const row = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`笔记 #${id} 不存在`);
    return { ...row, tags: safeParseTags(row.tags) };
  });

  tool(server, 'save_note', {
    title: '保存笔记',
    description: '新建笔记，或按 id 更新已有笔记。用户口述的知识、想法、模板、复盘整理成笔记时用。',
  }, {
    id: z.number().int().optional().describe('给 id 则更新该笔记，不给则新建'),
    title: z.string().optional().describe('默认取内容首行前 40 字'),
    content: z.string().min(1).describe('Markdown 正文'),
    tags: z.array(z.string()).optional(),
  }, async (b) => {
    if (b.id) {
      const cur = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(b.id) as Record<string, unknown> | undefined;
      if (!cur) throw new Error(`笔记 #${b.id} 不存在`);
      db.prepare('UPDATE notes SET title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?').run(
        b.title ?? cur.title, b.content, JSON.stringify(b.tags ?? safeParseTags(cur.tags)), now(), b.id,
      );
      return { ok: true, id: b.id, action: 'updated' };
    }
    const title = b.title?.trim() || b.content.split('\n')[0].slice(0, 40);
    const info = db.prepare('INSERT INTO notes (id, title, content, tags) VALUES (sync_id(), ?, ?, ?)')
      .run(title, b.content, JSON.stringify(b.tags ?? []));
    return { ok: true, id: Number(info.lastInsertRowid), action: 'created', title };
  });

  tool(server, 'list_reminders', {
    title: '查询提醒',
    description: '查询待触发（或全部）提醒。',
  }, {
    scope: z.enum(['upcoming', 'all']).default('upcoming').optional(),
    limit: z.number().int().min(1).max(200).default(30).optional(),
  }, async (q) => {
    const scope = q.scope ?? 'upcoming';
    const limit = q.limit ?? 30;
    const rows = scope === 'upcoming'
      ? db.prepare("SELECT id, message, trigger_at, repeat_rule, status, linked_task_id FROM reminders WHERE deleted_at IS NULL AND status = 'pending' ORDER BY trigger_at ASC LIMIT ?").all(limit)
      : db.prepare('SELECT id, message, trigger_at, repeat_rule, status, linked_task_id FROM reminders WHERE deleted_at IS NULL ORDER BY trigger_at DESC LIMIT ?').all(limit);
    return { scope, reminders: rows };
  });

  tool(server, 'create_reminder', {
    title: '新建提醒',
    description: '在某时刻提醒用户（触发后走工作台通知）。用户说“X点提醒我”“别忘了…”时调用。',
  }, {
    message: z.string().min(1).max(500),
    triggerAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).describe('触发时间 YYYY-MM-DDTHH:mm（本地时间）'),
    repeatRule: repeatRuleSchema.default('none').optional(),
    channel: reminderChannelSchema.optional().describe('送达渠道：auto 跟随设置；inapp/system/feishu/dingtalk/weixin；多选用逗号分隔，不传则跟随默认设置'),
  }, async (b) => {
    const info = db.prepare('INSERT INTO reminders (id, message, trigger_at, repeat_rule, channel) VALUES (sync_id(), ?, ?, ?, ?)')
      .run(b.message.trim(), b.triggerAt, b.repeatRule ?? 'none', resolveReminderChannel(b.channel));
    return { ok: true, id: Number(info.lastInsertRowid), message: b.message, triggerAt: b.triggerAt };
  });

  tool(server, 'complete_reminder', {
    title: '完成提醒',
    description: '把一条提醒标记完成/关闭。',
  }, {
    id: z.number().int(),
  }, async ({ id }) => {
    const cur = db.prepare('SELECT id FROM reminders WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cur) throw new Error(`提醒 #${id} 不存在`);
    db.prepare("UPDATE reminders SET status = 'done' WHERE id = ?").run(id);
    return { ok: true, id };
  });

  tool(server, 'list_events', {
    title: '查询日程',
    description: '查询日历日程（已自动从钉钉/ICS/CalDAV 同步进库）。默认未来 7 天。',
  }, {
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('默认今天'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('默认 from + 7 天'),
  }, async (q) => {
    const from = q.from ?? today();
    const to = q.to ?? (() => { const d = new Date(`${from}T00:00:00`); d.setDate(d.getDate() + 7); return localDateStr(d); })();
    const rows = db.prepare('SELECT title, start_at, end_at, is_all_day, location, organizer FROM events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC')
      .all(`${from}T00:00:00`, `${to}T23:59:59`);
    return { from, to, events: rows };
  });

  tool(server, 'weekly_review', {
    title: '周回顾',
    description: '本周（或往前 N 周）的完成节奏、停滞项目、即将到来的提醒。用于复盘和“我这周干了啥”的提问。',
  }, {
    offset: z.number().int().min(0).max(52).default(0).optional().describe('0=本周，1=上周'),
  }, async ({ offset }) => {
    const off = offset ?? 0;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (start.getDay() + 6) % 7 - off * 7);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const s = localDateStr(start), e = localDateStr(end);
    const completed = db.prepare(
      `SELECT t.title, t.completed_at, p.name AS project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.status='done' AND t.deleted_at IS NULL AND t.completed_at >= ? AND t.completed_at < ? ORDER BY t.completed_at DESC`,
    ).all(`${s}T00:00:00`, `${e}T00:00:00`);
    const perDay = db.prepare(
      `SELECT substr(completed_at, 1, 10) AS d, COUNT(*) AS n FROM tasks
       WHERE status='done' AND deleted_at IS NULL AND completed_at >= ? AND completed_at < ? GROUP BY d`,
    ).all(`${s}T00:00:00`, `${e}T00:00:00`);
    const stagnant = db.prepare(`
      SELECT p.name, p.domain,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status != 'done') AS open_tasks,
        (SELECT MAX(t.completed_at) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status='done') AS last_done
      FROM projects p WHERE p.status = 'active' AND p.deleted_at IS NULL
        AND open_tasks > 0 AND (last_done IS NULL OR last_done < ?)`,
    ).all(`${s}T00:00:00`);
    return { weekStart: s, completedCount: completed.length, perDay, recentCompleted: completed.slice(0, 30), stagnantProjects: stagnant };
  });

  tool(server, 'mood_check', {
    title: '今日脸色',
    description: '读工作台此刻的「情绪球」：由天光、天气、日程与清单压力算出的心情和一句话。用于回答「今天怎么样」「我状态还好吗」这类问题。',
  }, {}, async () => {
    const m = await getMoodPayload({});
    return {
      kind: m.kind,
      label: m.label,
      line: m.line,
      valence: m.valence,
      arousal: m.arousal,
      quiet: m.quiet,
      weather: m.weather ? `${m.weather.label} ${Math.round(m.weather.feelsC)}°` : null,
      daylight: m.solar.daylight,
      term: m.solar.termToday,
      moon: m.solar.moon.name,
      summary: {
        open: m.signals.open, done: m.signals.done, overdue: m.signals.overdue,
        events: m.signals.events, nextInMin: m.signals.nextInMin, streak: m.signals.streak,
      },
      // 给外部 agent 的用法：把 line 原样转述即可，别加感叹号、别补鼓励
      howToUse: '直接转述 line；需要解释时再引用 summary 里的数字，不要自创情绪。',
    };
  });
}
