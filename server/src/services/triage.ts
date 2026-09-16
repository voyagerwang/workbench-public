// 随手记分诊：一句话 → 真正落到清单 / 笔记 / 提醒三个模块，并在改分类时同步迁移。
//
// 四条不变式：
// 1. 分诊出的清单项一定带 planned_date（缺省=捕获当天），否则它会同时躲开今日清单与项目页，等于没分发。
// 2. 「明天提醒我做 X」这类既有通知点又有交付物的内容 → 建清单项 + 挂一条联动提醒，两个模块都出现。
// 3. 改分类是迁移不是重建：能复用的行（尤其是提醒）只换归属，旧目标一律软删进回收站。
// 4. 周期任务保存 repeat_rule，完成后生成下一期任务。
import { db, now, today } from '../db.js';
import {
  actionableTitle, classifyDetailed, extractWhen, hasReminderIntent, reminderNeedsTask, splitConservative, tomorrowNine,
  type FragType, type TriageDraft,
} from './classify.js';
import { extractRecurringSchedule, stripRecurringPrefix, type RepeatRule } from './recurrence.js';
import { classifyWithAI, type AiTriageAnalysis, type AiTriageItem } from './ai-classify.js';
import { normalizeTags } from './tags.js';
import {
  attachReminder, detachReminder, resolveReminderChannel, softDeleteTaskTree, syncTaskReminder, taskOpenReminder,
} from './reminders.js';

/** fragments 表的一行 */
export type FragmentRow = {
  id: number;
  content: string;
  rich_content: string;
  triaged_type: FragType | null;
  triaged_id: number | null;
  created_at: string;
  triaged_at: string | null;
  deleted_at: string | null;
};

const TABLE: Record<FragType, string> = { task: 'tasks', note: 'notes', reminder: 'reminders' };

export type FragmentTarget = {
  module: FragType;
  id: number;
  title: string;
  /** 目标已不存在（被删/被清），看板据此提示重新分诊 */
  missing?: boolean;
  /** 目标已在回收站 */
  trashed?: boolean;
  planned_date?: string | null;
  remind_at?: string | null;
  trigger_at?: string | null;
  repeat_rule?: string | null;
  status?: string | null;
  project_name?: string | null;
};

export type CaptureItem = {
  fragmentId: number;
  type: FragType;
  content: string;
  /** 提醒语义顺带建了清单项（清单 + 提醒同时出现） */
  dual: boolean;
  needsReview: boolean;
  confidence: number;
  target: FragmentTarget | null;
};

/** 归一化模型给的时间：允许 YYYY-MM-DD / 到分 / 到秒，非法值当没有 */
export function normalizeIso(value?: string | null): string | null {
  if (!value) return null;
  const s = value.trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  return `${m[1]}T${m[2] ?? '09:00'}:${m[3] ?? '00'}`;
}

/** 只给到日期时，提醒默认落在 09:00，避免 00:00 半夜炸通知 */
function reminderTime(iso: string): string {
  return iso.endsWith('T00:00:00') ? `${iso.slice(0, 10)}T09:00:00` : iso;
}

// ---------- 各模块的落库 ----------

type TaskOpts = { plannedDate?: string | null; remindAt?: string | null; repeatRule?: RepeatRule; detail?: string; notes?: string };

function insertTask(content: string, opts: TaskOpts = {}): number {
  // 清单里要看到的是动作本身，“明天下午 3 点提醒我交材料”进清单就叫「交材料」，原文在随手记卡片上保留
  const title = actionableTitle(content).slice(0, 500) || content.trim();
  // 没解析到日期就落当天；周期任务由 repeatRule 提供下一次计划日期
  const planned = /^\d{4}-\d{2}-\d{2}$/.test(opts.plannedDate ?? '') ? opts.plannedDate! : today();
  const remindAt = normalizeIso(opts.remindAt);
  const nextSort = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS v FROM tasks').get() as { v: number }).v + 1;
  const id = Number(db.prepare(`
    INSERT INTO tasks (id, title, notes, detail, planned_date, remind_at, repeat_rule, sort_order)
    VALUES (sync_id(), ?, ?, ?, ?, ?, ?, ?)
  `).run(title, opts.notes ?? '', opts.detail ?? '', planned, remindAt, opts.repeatRule ?? 'none', nextSort).lastInsertRowid);
  if (remindAt) syncTaskReminder(id, title, remindAt);
  return id;
}

/**
 * tags 只在用户明确说过「加标签 / 标记为 / 标签是」时才会有值；
 * AI 猜的标签一律不落库（见 ai-classify.ts 的抽取规则）。
 * 写入前统一过 normalizeTags，与页面手动打标签共用同一套名字。
 */
function insertNote(content: string, sourceFragmentId: number | null, titleHint?: string, tags?: readonly string[]): number {
  const title = (titleHint?.trim() || content.split('\n')[0] || '').slice(0, 40);
  return Number(db.prepare('INSERT INTO notes (id, title, content, tags, source_fragment_id) VALUES (sync_id(), ?, ?, ?, ?)')
    .run(title, content, JSON.stringify(normalizeTags(tags ?? [])), sourceFragmentId).lastInsertRowid);
}

function insertReminder(message: string, triggerAt: string, channel?: string | null): number {
  // 分诊入口同样吃设置里的默认渠道，否则「默认送达渠道」对从随手记分出来的提醒无效
  return Number(db.prepare("INSERT INTO reminders (id, message, trigger_at, repeat_rule, channel) VALUES (sync_id(), ?, ?, 'none', ?)")
    .run(message.slice(0, 200), triggerAt, resolveReminderChannel(channel)).lastInsertRowid);
}

// ---------- 读回目标 ----------

function readTarget(type: FragType, id: number | null | undefined): FragmentTarget | null {
  if (!id) return null;
  if (type === 'task') {
    const row = db.prepare(`
      SELECT t.id, t.title, t.planned_date, t.remind_at, t.repeat_rule, t.status, t.deleted_at, p.name AS project_name
      FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?
    `).get(id) as Record<string, string | number | null> | undefined;
    if (!row) return { module: type, id, title: '', missing: true };
    return {
      module: type, id, title: String(row.title),
      planned_date: row.planned_date as string | null,
      remind_at: row.remind_at as string | null,
      repeat_rule: row.repeat_rule as string | null,
      status: row.status as string | null,
      project_name: row.project_name as string | null,
      trashed: Boolean(row.deleted_at),
    };
  }
  if (type === 'note') {
    const row = db.prepare('SELECT id, title, deleted_at FROM notes WHERE id = ?').get(id) as
      | { id: number; title: string; deleted_at: string | null } | undefined;
    if (!row) return { module: type, id, title: '', missing: true };
    return { module: type, id, title: row.title, trashed: Boolean(row.deleted_at) };
  }
  const row = db.prepare('SELECT id, message, trigger_at, repeat_rule, status, deleted_at FROM reminders WHERE id = ?').get(id) as
    | Record<string, string | number | null> | undefined;
  if (!row) return { module: type, id, title: '', missing: true };
  return {
    module: type, id, title: String(row.message),
    trigger_at: row.trigger_at as string | null,
    repeat_rule: row.repeat_rule as string | null,
    status: row.status as string | null,
    trashed: Boolean(row.deleted_at),
  };
}

/** 给碎片列表补上「落到了哪个模块、什么时候」，看板与首页共用 */
export function withTargets<T extends { triaged_type: FragType | null; triaged_id: number | null }>(rows: T[]): Array<T & { target: FragmentTarget | null }> {
  // triaged_type 为空 = 未分诊，没有目标可读；顺手让 TS 把 type 收窄到 FragType
  return rows.map((row) => ({ ...row, target: row.triaged_type ? readTarget(row.triaged_type, row.triaged_id) : null }));
}

// ---------- 捕获：分诊 + 落库 ----------

/** 一条待落库的分诊结果（模型输出与规则输出都先收敛成它） */
type Draft = TriageDraft & {
  content: string;
  richContent?: string;
  detail?: string | null;
  repeatRule?: RepeatRule;
  needsReview?: boolean;
  confidence?: number;
  /** 仅随手记使用，且只接受用户明确指定的标签 */
  tags?: string[];
};

export type AssistantAcceptedDraft = {
  type: FragType;
  content: string;
  detail?: string | null;
  plannedDate?: string | null;
  remindAt?: string | null;
  repeatRule?: RepeatRule;
  /** 随手记标签：小精灵只在用户明确指定时才会带上，AI 猜的不走这条链路 */
  tags?: string[];
};

function draftFromAi(item: AiTriageItem): Draft {
  return {
    content: item.content,
    type: item.type,
    plannedDate: item.plannedDate ?? null,
    remindAt: normalizeIso(item.remindAt),
    repeatRule: item.repeatRule ?? 'none',
    dual: item.dual ?? false,
    needsReview: item.needsReview,
    confidence: item.confidence,
    tags: item.tags,
  };
}

function createFragment(draft: Draft): CaptureItem {
  const ts = now();
  const richContent = draft.richContent?.trim() ?? '';
  const fragmentId = Number(db.prepare('INSERT INTO fragments (id, content, rich_content, created_at) VALUES (sync_id(), ?, ?, ?)')
    .run(draft.content, richContent, ts).lastInsertRowid);

  const type = draft.type;
  let targetId: number;
  const recurring = type === 'task' ? extractRecurringSchedule(draft.content) : null;
  const when = type === 'task' ? extractWhen(draft.content) : null;
  const plannedDate = recurring?.plannedDate ?? draft.plannedDate ?? when?.slice(0, 10);
  const titleContent = recurring ? stripRecurringPrefix(draft.content) : draft.content;
  if (type === 'task') {
    targetId = insertTask(titleContent, {
      plannedDate,
      remindAt: draft.remindAt,
      repeatRule: recurring?.repeatRule ?? draft.repeatRule ?? 'none',
      detail: draft.detail?.trim() || richContent,
    });
  } else if (type === 'note') {
    targetId = insertNote(richContent || draft.content, fragmentId, draft.content, draft.tags);
  } else {
    const at = normalizeIso(draft.remindAt) ?? extractWhen(draft.content) ?? tomorrowNine();
    targetId = insertReminder(draft.content, reminderTime(at));
  }
  db.prepare('UPDATE fragments SET triaged_type = ?, triaged_id = ?, triaged_at = ? WHERE id = ?')
    .run(type, targetId, ts, fragmentId);

  const target = readTarget(type, targetId);
  return {
    fragmentId, type, content: draft.content,
    dual: Boolean(draft.dual) || Boolean(target?.remind_at && type === 'task'),
    needsReview: draft.needsReview ?? false,
    confidence: draft.confidence ?? 0.8,
    target,
  };
}

export type CaptureOutcome = {
  aiUsed: boolean;
  split: boolean;
  analysis: AiTriageAnalysis | null;
  items: CaptureItem[];
};

/** 捕获即分诊：优先模型，失败/未配置时退回本地规则；整个过程在一个事务里落库 */
export async function triageCapture(raw: string, richRaw?: string): Promise<CaptureOutcome> {
  const richContent = richRaw?.trim() ?? '';
  // 纯图片也是一条有效的随手记；用一个稳定的纯文本标识供分诊、搜索与回收站展示。
  const content = raw.trim() || (richContent ? '[图片]' : '');
  let aiUsed = false;
  let analysis: AiTriageAnalysis | null = null;
  let drafts: Draft[] = [];

  // 纯图片没有可供语义分类的文本，直接收进笔记最稳妥。
  if (content !== '[图片]') {
    try {
      const result = await classifyWithAI(content);
      if (result?.items.length) {
        drafts = result.items.map(draftFromAi);
        analysis = result.analysis;
        aiUsed = true;
      }
    } catch (error) {
      // 捕获不能因模型超时/限流失败，退回规则分诊
      console.warn('[triage] AI 不可用，回退本地规则:', (error as Error).message);
    }
  }
  if (!drafts.length) {
    drafts = content === '[图片]'
      ? [{ content, type: 'note', plannedDate: null, remindAt: null, dual: false }]
      : splitConservative(content).map((part) => {
        const local = classifyDetailed(part);
        const recurring = local.type === 'task' ? extractRecurringSchedule(part) : null;
        return {
          ...local,
          content: part,
          plannedDate: recurring?.plannedDate ?? local.plannedDate ?? null,
          repeatRule: recurring?.repeatRule ?? 'none',
        };
      });
  }

  // 一次捕获可被分拆成多个去向；图片/富文本只挂到第一条，避免在多个模块里复制同一批附件。
  drafts = drafts.map((draft, index) => ({ ...draft, richContent: index === 0 ? richContent : '' }));

  const items = db.transaction(() => drafts.slice(0, 8).map(createFragment))();
  return { aiUsed, split: items.length > 1, analysis, items };
}

/** AI 对话里确认过的整理草稿：尊重用户最终选择的类型，不再二次自动改分类。 */
export function acceptAssistantDrafts(input: AssistantAcceptedDraft[]): CaptureOutcome {
  const drafts: Draft[] = input.slice(0, 8).map((item) => ({
    type: item.type,
    content: item.content.trim(),
    detail: item.detail ?? null,
    plannedDate: item.plannedDate ?? null,
    remindAt: normalizeIso(item.remindAt),
    repeatRule: item.repeatRule ?? 'none',
    dual: item.type === 'task' && Boolean(item.remindAt),
    needsReview: false,
    confidence: 1,
    // 只有随手记吃标签；清单与提醒没有标签字段，传了也忽略
    tags: item.type === 'note' ? normalizeTags(item.tags ?? []) : undefined,
  }));
  const items = db.transaction(() => drafts.map(createFragment))();
  return { aiUsed: true, split: items.length > 1, analysis: null, items };
}

// ---------- 改分类：迁移而非重建 ----------

export type ReclassifyResult = {
  ok: true;
  changed: boolean;
  type: FragType;
  id: number;
  target: FragmentTarget | null;
  /** 给用户看的说明：旧条目怎么处理的 */
  note: string | null;
};

function getFragment(id: number) {
  return db.prepare('SELECT * FROM fragments WHERE id = ? AND deleted_at IS NULL').get(id) as FragmentRow | undefined;
}

/** 清单项的正文搬进笔记：标题 + 备注 + 详情文档，别把用户后来补的内容丢掉 */
function taskBodyAsNote(row: { title: string; notes: string; detail: string }): string {
  return [row.title, row.notes?.trim(), row.detail?.trim()].filter(Boolean).join('\n\n');
}

/**
 * 改分类 = 迁移。返回体给前端直接用：
 * - 旧目标软删进回收站（可找回），不做硬删除
 * - 提醒优先复用同一行（换归属而非新建），避免提醒模块里出现双胞胎
 * - task 永远带 planned_date，保证进清单后在今日/次日清单里看得见
 */
export function reclassifyCapture(id: number, to: FragType, opts: { remindAt?: string | null } = {}): ReclassifyResult {
  const frag = getFragment(id);
  if (!frag) throw new Error('随手记条目不存在');

  const from = frag.triaged_type;
  const oldTarget = from && frag.triaged_id ? readTarget(from, frag.triaged_id) : null;
  const oldUsable = Boolean(oldTarget && !oldTarget.missing && !oldTarget.trashed);

  // oldUsable 成立时 triaged_id 必非空，显式判一下让 TS 能收窄
  if (from === to && oldUsable && frag.triaged_id) {
    return { ok: true, changed: false, type: to, id: frag.triaged_id, target: oldTarget, note: null };
  }

  const result = db.transaction((): { targetId: number; note: string | null } => {
    let note: string | null = null;
    let reusedReminderId: number | undefined;
    let targetId: number;

    if (to === 'task') {
      const explicit = normalizeIso(opts.remindAt);
      const reuseRow = from === 'reminder' && oldUsable ? oldTarget!.id : null;
      const inherited = reuseRow ? normalizeIso(oldTarget!.trigger_at) : null;
      const remindAt = explicit ?? inherited
        ?? (hasReminderIntent(frag.content) && reminderNeedsTask(frag.content) ? normalizeIso(extractWhen(frag.content)) : null);
      const planned = remindAt?.slice(0, 10)
        ?? (extractWhen(frag.content)?.slice(0, 10) ?? null);
      const detail = from === 'note' && oldUsable
        ? (db.prepare('SELECT content FROM notes WHERE id = ?').get(oldTarget!.id) as { content: string } | undefined)?.content ?? ''
        : frag.rich_content;
      const title = from === 'note' && oldUsable ? (oldTarget!.title.trim() || frag.content) : frag.content;
      // 能复用原有那一行提醒时，insertTask 就不要再建一条，否则提醒模块里会出现双胞胎
      targetId = insertTask(title, { plannedDate: planned, remindAt: reuseRow ? null : remindAt, detail });
      if (reuseRow) {
        // 复用原来那条提醒：换归属而不新建，时间不丢，提醒模块里不会凭空多一条
        attachReminder(reuseRow, targetId, actionableTitle(title));
        if (explicit) db.prepare('UPDATE reminders SET trigger_at = ? WHERE id = ?').run(reminderTime(explicit), reuseRow);
        db.prepare('UPDATE tasks SET remind_at = ? WHERE id = ?').run(inherited ?? explicit, targetId);
        reusedReminderId = reuseRow;
        note = '提醒已跟着这条清单项走，时间没变';
      } else if (remindAt) {
        note = '同时建了一条提醒';
      }
    } else if (to === 'note') {
      let body = frag.rich_content || frag.content;
      if (from === 'task' && oldUsable) {
        const task = db.prepare('SELECT title, notes, detail FROM tasks WHERE id = ?')
          .get(oldTarget!.id) as { title: string; notes: string; detail: string } | undefined;
        if (task) body = taskBodyAsNote(task);
        note = '清单项的备注与详情已并入笔记';
      } else if (from === 'reminder') {
        note = '提醒已取消';
      }
      targetId = insertNote(body, frag.id, from === 'note' && oldUsable ? oldTarget!.title : undefined);
    } else {
      const explicit = normalizeIso(opts.remindAt);
      const inherited = from === 'reminder' && oldUsable ? oldTarget!.trigger_at : null;
      const at = explicit ?? inherited ?? extractWhen(frag.content) ?? tomorrowNine();
      if (from === 'task' && oldUsable) {
        const open = taskOpenReminder(oldTarget!.id);
        if (open) {
          detachReminder(open.id);
          // 独立提醒不再背「任务 ·」前缀，文案回到随手记原文
          db.prepare('UPDATE reminders SET message = ?, trigger_at = ?, status = ?, fired_at = NULL WHERE id = ?')
            .run(frag.content.slice(0, 200), reminderTime(at), 'pending', open.id);
          reusedReminderId = open.id;
          targetId = open.id;
          note = '沿用了清单项上原来的提醒时间';
        } else {
          targetId = insertReminder(frag.content, reminderTime(at));
          note = '这条清单项没有设过提醒，按内容时间新建了一个';
        }
      } else {
        targetId = insertReminder(frag.content, reminderTime(at));
        if (from === 'reminder') note = '已按新的时间重排提醒';
      }
    }

    // 旧目标清理：软删进回收站；被复用的提醒不参与删除
    if (oldUsable && from !== to) {
      if (from === 'task') softDeleteTaskTree(oldTarget!.id, reusedReminderId);
      else if (from === 'note') {
        db.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), oldTarget!.id);
      } else if (reusedReminderId !== oldTarget!.id) {
        db.prepare('UPDATE reminders SET deleted_at = ? WHERE id = ?').run(now(), oldTarget!.id);
      }
    }

    db.prepare('UPDATE fragments SET triaged_type = ?, triaged_id = ?, triaged_at = ? WHERE id = ?')
      .run(to, targetId, now(), id);
    return { targetId, note };
  })();

  return { ok: true, changed: true, type: to, id: result.targetId, target: readTarget(to, result.targetId), note: result.note };
}

// ---------- 删随手记：连带收掉分发出去的那条（改过的不擅自删） ----------

export type TrashRef = { module: FragType; id: number; title: string };

/** 分诊落库后用户又动过它？动过就不跟随删除，避免把真正的劳动成果当碎片扫掉 */
function touchedReason(
  type: FragType,
  row: Record<string, string | number | null>,
  fragContent: string,
  fragRichContent: string,
): string | null {
  if (type === 'task') {
    if (row.status === 'done') return '已经完成过，删了会影响周回顾';
    if (String(row.notes ?? '').trim()) return '有补充的备注或详情';
    if (String(row.detail ?? '').trim() !== fragRichContent.trim()) return '有补充的备注或详情';
    if (row.project_id) return '已挂到项目里';
    if (row.due_at) return '设了截止日';
    if (String(row.title ?? '').trim() !== actionableTitle(fragContent).trim()) return '标题被改过';
  }
  if (type === 'note') {
    if (String(row.content ?? '').trim() !== (fragRichContent.trim() || fragContent.trim())) return '正文被改过';
    if (String(row.tags ?? '[]').trim() !== '[]') return '加了标签';
  }
  if (type === 'reminder' && row.status === 'done') return '已经确认过';
  return null;
}

/**
 * 删随手记卡片：默认连它分出来的那条一起进回收站（auto）；
 * 目标条目已被用户改过时 auto 会停下来，确认要一错到底就传 both。
 */
export function deleteFragment(id: number, mode: 'auto' | 'both' = 'auto'): { ok: true; removed: TrashRef[]; kept: Array<TrashRef & { reason: string }> } {
  // 不过滤 deleted_at：卡片已在回收站时也要能补刀（前端「一起删掉」就是这条路径）
  const frag = db.prepare('SELECT * FROM fragments WHERE id = ?').get(id) as FragmentRow | undefined;
  if (!frag) throw new Error('随手记条目不存在');

  return db.transaction(() => {
    const removed: TrashRef[] = [];
    const kept: Array<TrashRef & { reason: string }> = [];
    const type = frag.triaged_type;
    const targetId = frag.triaged_id;

    if (type && targetId) {
      const row = db.prepare(`SELECT * FROM ${TABLE[type]} WHERE id = ? AND deleted_at IS NULL`)
        .get(targetId) as Record<string, string | number | null> | undefined;
      if (row) {
        const reason = mode === 'auto' ? touchedReason(type, row, frag.content, frag.rich_content) : null;
        const title = String(row.title ?? row.message ?? frag.content).slice(0, 40);
        if (reason) {
          kept.push({ module: type, id: targetId, title, reason });
        } else {
          // 清单项走任务树删除，挂在它上的联动提醒一起进，否则提醒会孤儿地留在提醒页
          if (type === 'task') softDeleteTaskTree(targetId);
          else if (type === 'note') db.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), targetId);
          else db.prepare('UPDATE reminders SET deleted_at = ? WHERE id = ?').run(now(), targetId);
          removed.push({ module: type, id: targetId, title });
        }
      }
    }

    if (frag.deleted_at === null) db.prepare('UPDATE fragments SET deleted_at = ? WHERE id = ?').run(now(), id);
    return { ok: true as const, removed, kept };
  })();
}

// ---------- 一次性修复：把历史上没落日期的随手记清单项排进当天 ----------

const REPAIR_KEY = 'triage_orphan_repair_v1';

/** 老数据里随手记建的清单项 planned_date 为空 → 任何模块都看不到。按分诊当天补上，只补一次。 */
export function repairOrphanFragmentTasks(): number {
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(REPAIR_KEY) as { value: string } | undefined;
  if (done) return 0;
  const rows = db.prepare(`
    SELECT t.id AS id, COALESCE(SUBSTR(f.triaged_at, 1, 10), SUBSTR(f.created_at, 1, 10)) AS d
    FROM fragments f JOIN tasks t ON t.id = f.triaged_id
    WHERE f.triaged_type = 'task' AND f.deleted_at IS NULL
      AND t.deleted_at IS NULL AND t.planned_date IS NULL AND t.due_at IS NULL
      AND t.status != 'done' AND COALESCE(t.notes, '') = '' AND COALESCE(t.detail, '') = ''
  `).all() as Array<{ id: number; d: string | null }>;
  const upd = db.prepare('UPDATE tasks SET planned_date = ? WHERE id = ?');
  for (const r of rows) upd.run(r.d ?? today(), r.id);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(REPAIR_KEY, JSON.stringify({ at: now(), fixed: rows.length }));
  return rows.length;
}
