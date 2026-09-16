// 提醒、日历事件路由
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, getSetting, newId, now, setSetting } from '../db.js';
import { getConfiguredFlag, syncEvents } from '../services/dingtalk.js';
import { createDingtalkEvent, getMcpFlag, queryAvailableRooms, queryBusyStatus, searchColleagues, suggestEventTimes } from '../services/dingtalk-mcp.js';
import { fetchCaldavEvents, getCaldavConfig, getCaldavFlag, type CaldavConfig } from '../services/caldav.js';
import { fetchIcs, parseICS } from '../services/ics.js';
import { repeatRuleSchema } from '../services/recurrence.js';
import { createNextRecurringTask } from '../services/recurring-tasks.js';
import { resolveReminderChannel } from '../services/reminders.js';
import { resendReminder } from '../services/reminder-delivery.js';

const upsertEvent = db.prepare(`
  INSERT INTO events (id, external_id, title, start_at, end_at, is_all_day, location, organizer, synced_at)
  VALUES (sync_id(), @externalId, @title, @startAt, @endAt, @isAllDay, @location, @organizer, @syncedAt)
  ON CONFLICT(external_id) DO UPDATE SET
    title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at,
    is_all_day = excluded.is_all_day, location = excluded.location, organizer = excluded.organizer, synced_at = excluded.synced_at
`);

const deleteByPrefix = db.prepare("DELETE FROM events WHERE external_id LIKE ? || '%'");

/** 提醒时间格式约束：POST 与 PATCH 共用同一条，避免两条路径校验不一致 */
const TRIGGER_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function upsertIcsEvents(list: Array<{ uid: string; title: string; startAt: string; endAt: string | null; isAllDay: boolean; location: string | null; organizer: string | null }>, prefix: string): number {
  let n = 0;
  const tx = db.transaction(() => {
    // 同前缀整体重建：展开后的实例 uid 各不相同，旧条目（含被取消的重复实例）一并清掉
    deleteByPrefix.run(prefix);
    for (const e of list) {
      if (!e.startAt || !e.uid) continue;
      upsertEvent.run({
        externalId: `${prefix}${e.uid}`,
        title: e.title,
        startAt: e.startAt,
        endAt: e.endAt,
        isAllDay: e.isAllDay ? 1 : 0,
        location: e.location,
        organizer: e.organizer,
        syncedAt: now(),
      });
      n++;
    }
  });
  tx();
  return n;
}

export function getIcsUrl(): string | undefined {
  const ics = getSetting<{ url?: string }>('ics');
  return ics?.url?.trim() || undefined;
}

export async function syncCaldav(): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const cfg = getCaldavConfig();
  if (!cfg) return { ok: false, error: 'CalDAV 未配置' };
  try {
    const list = await fetchCaldavEvents(cfg);
    const count = upsertIcsEvents(list, 'caldav:');
    console.log(`[caldav] 同步完成：${count} 条日程`);
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function syncIcs(): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const url = getIcsUrl();
  if (!url) return { ok: false, error: 'ICS 未配置' };
  try {
    const list = await fetchIcs(url);
    const count = upsertIcsEvents(list, 'ics:');
    console.log(`[ics] 同步完成：${count} 条日程`);
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function timeRoutes(app: FastifyInstance) {
  // ---------- 提醒 ----------
  // 带出联动任务的标题：提醒页要显示「来自清单：xxx」，不然用户不知道这条提醒从哪来
  app.get('/api/reminders', () => db.prepare(
    `SELECT r.*, t.title AS task_title
       FROM reminders r
       LEFT JOIN tasks t ON t.id = r.linked_task_id
      WHERE r.deleted_at IS NULL
      ORDER BY r.status = 'pending' DESC, r.trigger_at ASC LIMIT 500`,
  ).all());

  const reminderChannelSchema = z.enum(['auto', 'inapp', 'system', 'feishu', 'dingtalk']);

  app.post('/api/reminders', (req) => {
    const b = z.object({
      message: z.string().trim().min(1).max(500),
      triggerAt: z.string().regex(TRIGGER_AT_RE, '提醒时间格式应为 YYYY-MM-DDTHH:mm'),
      repeatRule: repeatRuleSchema.default('none'),
      channel: reminderChannelSchema.optional(),
    }).parse(req.body);
    // 没显式选渠道就用设置里的「默认送达渠道」，否则那条设置对所有自动创建的入口都不生效
    const channel = resolveReminderChannel(b.channel);
    // 重复提醒分配系列标识：同一系列的各期共享（下一期由调度器继承），前端据此归组
    const seriesId = b.repeatRule !== 'none' ? String(newId()) : null;
    const info = db.prepare('INSERT INTO reminders (id, message, trigger_at, repeat_rule, channel, series_id) VALUES (sync_id(), ?, ?, ?, ?, ?)')
      .run(b.message, b.triggerAt, b.repeatRule, channel, seriesId);
    return db.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid);
  });

  app.patch('/api/reminders/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const b = z.object({
      message: z.string().trim().min(1).max(500).optional(),
      triggerAt: z.string().regex(TRIGGER_AT_RE, '提醒时间格式应为 YYYY-MM-DDTHH:mm').optional(),
      status: z.enum(['pending', 'fired', 'done']).optional(),
      repeatRule: repeatRuleSchema.optional(),
      channel: reminderChannelSchema.optional(),
      completeLinkedTask: z.boolean().optional(),
    }).parse(req.body);

    const cur = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    // 已软删的一律当作不存在：否则回收站里的记录还能被改回来
    if (!cur || cur.deleted_at) throw app.httpErrors.notFound('提醒不存在或已删除');

    // 延后 / 重新武装：显式回到 pending，或改了时间且当前是已触发——都要清掉本次触发痕迹，
    // 否则界面上它仍挂着「已响」，而状态其实已经回到待触发。
    const timeChanged = b.triggerAt !== undefined && b.triggerAt !== cur.trigger_at;
    const rearm = b.status === 'pending' || (timeChanged && cur.status === 'fired');
    const nextStatus = rearm ? 'pending' : (b.status ?? cur.status) as string;
    const taskId = (cur.linked_task_id ?? null) as number | null;

    db.transaction(() => {
      db.prepare(`
        UPDATE reminders
           SET message = ?, trigger_at = ?, status = ?, repeat_rule = ?, channel = ?,
               fired_at = CASE WHEN ? THEN NULL ELSE fired_at END,
               -- 重新武装就把上一轮的送达回执一起清掉，下一轮重新投递、重新计数
               delivery_status = CASE WHEN ? THEN 'none' ELSE delivery_status END,
               delivery_attempts = CASE WHEN ? THEN 0 ELSE delivery_attempts END,
               delivery_error = CASE WHEN ? THEN NULL ELSE delivery_error END,
               next_retry_at = CASE WHEN ? THEN NULL ELSE next_retry_at END
         WHERE id = ?
      `).run(
        b.message ?? cur.message,
        b.triggerAt ?? cur.trigger_at,
        nextStatus,
        b.repeatRule ?? cur.repeat_rule,
        b.channel ?? cur.channel,
        rearm ? 1 : 0,
        rearm ? 1 : 0, rearm ? 1 : 0, rearm ? 1 : 0, rearm ? 1 : 0,
        id,
      );

      // 一次性提醒被改成重复规则但还没有系列标识：现场补一个，之后的期次由调度器继承
      if ((b.repeatRule ?? cur.repeat_rule) !== 'none' && !cur.series_id) {
        db.prepare('UPDATE reminders SET series_id = ? WHERE id = ?').run(String(newId()), id);
      }

      // 「同时完成任务」必须显式传才做：关掉提醒 ≠ 事情做完了，默认不同步。
      // 走的是与 PATCH /api/tasks/:id 相同的收尾（含重复任务生成下一期），避免两条路行为分叉。
      if (b.completeLinkedTask && nextStatus === 'done' && taskId) {
        const task = db.prepare('SELECT status, repeat_rule FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId) as
          | { status: string; repeat_rule: string }
          | undefined;
        if (task && task.status !== 'done') {
          const ts = now();
          db.prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, taskId);
          db.prepare("UPDATE reminders SET status = 'done' WHERE linked_task_id = ? AND status IN ('pending', 'fired') AND id != ?")
            .run(taskId, id);
          createNextRecurringTask(taskId);
        }
      }
    })();

    return db.prepare(
      `SELECT r.*, t.title AS task_title FROM reminders r LEFT JOIN tasks t ON t.id = r.linked_task_id WHERE r.id = ?`,
    ).get(id);
  });

  /**
   * 停止重复系列：本条保留（并转成一次性提醒），同一系列的后续期次全部取消。
   * 以前只能逐条删或逐条改成不重复 —— 同系列还有别期时，改掉一条根本停不下来。
   */
  app.post('/api/reminders/:id/stop-series', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const cur = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as
      | { id: number; message: string; repeat_rule: string; series_id: string | null; deleted_at: string | null }
      | undefined;
    if (!cur || cur.deleted_at) throw app.httpErrors.notFound('提醒不存在或已删除');

    // 历史数据多数没有 series_id（字段是后来加的），回退到「同内容 + 同重复规则」匹配，
    // 否则老用户建的那一条条重复提醒永远停不掉。
    const siblings = (cur.series_id
      ? db.prepare(
        `SELECT id FROM reminders
          WHERE series_id = ? AND id != ? AND deleted_at IS NULL AND status IN ('pending', 'fired')`,
      ).all(cur.series_id, id)
      : db.prepare(
        `SELECT id FROM reminders
          WHERE message = ? AND repeat_rule = ? AND repeat_rule != 'none'
            AND id != ? AND deleted_at IS NULL AND status IN ('pending', 'fired')`,
      ).all(cur.message, cur.repeat_rule, id)) as Array<{ id: number }>;

    const ts = now();
    db.transaction(() => {
      // 本条留着：它就是「这一次」，转成一次性，响完即止
      if (cur.repeat_rule !== 'none') db.prepare("UPDATE reminders SET repeat_rule = 'none' WHERE id = ?").run(id);
      const del = db.prepare('UPDATE reminders SET deleted_at = ? WHERE id = ?');
      for (const s of siblings) del.run(ts, s.id);
    })();

    return { ok: true, keptId: id, stopped: siblings.length };
  });

  /**
   * 合并重复实例：同一内容、同一规则、同一时刻被建了多份时只留本条，其余进回收站。
   * 触发瞬间被重复处理过（或手抖连点）就会留下一式 N 份，到点会连响 N 次。
   */
  app.post('/api/reminders/:id/dedupe', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const cur = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as
      | { id: number; message: string; repeat_rule: string; trigger_at: string; deleted_at: string | null }
      | undefined;
    if (!cur || cur.deleted_at) throw app.httpErrors.notFound('提醒不存在或已删除');

    const dups = db.prepare(
      `SELECT id FROM reminders
        WHERE message = ? AND repeat_rule = ? AND trigger_at = ? AND id != ?
          AND deleted_at IS NULL AND status IN ('pending', 'fired')
        ORDER BY id ASC`,
    ).all(cur.message, cur.repeat_rule, cur.trigger_at, id) as Array<{ id: number }>;

    const ts = now();
    const del = db.prepare('UPDATE reminders SET deleted_at = ? WHERE id = ?');
    db.transaction(() => { for (const d of dups) del.run(ts, d.id); })();
    return { ok: true, keptId: id, removed: dups.length };
  });

  // 重新发送：自动重试放弃后（或用户想再收一次）手动触发一次投递
  app.post('/api/reminders/:id/resend', async (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const result = await resendReminder(id);
    if (!result.ok) throw app.httpErrors.badRequest(result.error ?? '发送失败');
    return { ok: true };
  });

  // 软删除进回收站
  app.delete('/api/reminders/:id', (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    db.prepare('UPDATE reminders SET deleted_at = ? WHERE id = ?').run(now(), id);
    return { ok: true };
  });

  // ---------- 日历 ----------
  app.get('/api/events/status', () => ({
    dingtalk: getConfiguredFlag(),
    ics: { configured: Boolean(getIcsUrl()), url: getIcsUrl() ?? '' },
    caldav: getCaldavFlag(),
  }));

  app.get('/api/events', (req) => {
    const q = z.object({
      from: z.string().default(''), // YYYY-MM-DDTHH:MM:SS
      to: z.string().default(''),
    }).parse(req.query);
    if (!q.from || !q.to) {
      return db.prepare('SELECT * FROM events ORDER BY start_at ASC LIMIT 200').all();
    }
    return db.prepare(
      'SELECT * FROM events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC',
    ).all(q.from, `${q.to.slice(0, 10)}T23:59:59`);
  });

  // 日程的本地会议记录：同步只维护外部字段，用户手写内容单独保存。
  app.patch('/api/events/:id', (req) => {
    const { id: rawId } = z.object({ id: z.string().min(1) }).parse(req.params);
    const b = z.object({ detail: z.string().max(524288), externalId: z.string().min(1).max(500).optional() }).parse(req.body);
    const numericId = /^\d+$/.test(rawId) ? Number(rawId) : null;
    // 本地 id 可能在 ICS/CalDAV 全量同步时被重建；external_id 才是稳定身份。
    const result = db.prepare(
      'UPDATE events SET detail = ? WHERE (external_id = ? AND ? IS NOT NULL) OR (id = ? AND ? IS NOT NULL)',
    ).run(b.detail, b.externalId ?? null, b.externalId ?? null, numericId, numericId);
    if (!result.changes) throw app.httpErrors.notFound('日程不存在');
    return b.externalId
      ? db.prepare('SELECT * FROM events WHERE external_id = ?').get(b.externalId)
      : db.prepare('SELECT * FROM events WHERE id = ?').get(numericId);
  });

  app.post('/api/events/sync', async () => {
    const results: string[] = [];
    let total = 0;
    let anyOk = false;
    let lastError = '';
    if (getConfiguredFlag().configured) {
      const r = await syncEvents();
      if (r.ok) { total += r.count; anyOk = true; results.push(`钉钉 ${r.count} 条`); }
      else lastError = r.error;
    }
    if (getIcsUrl()) {
      const r = await syncIcs();
      if (r.ok) { total += r.count; anyOk = true; results.push(`ICS ${r.count} 条`); }
      else lastError = r.error;
    }
    if (getCaldavConfig()) {
      const r = await syncCaldav();
      if (r.ok) { total += r.count; anyOk = true; results.push(`CalDAV ${r.count} 条`); }
      else lastError = r.error;
    }
    if (!anyOk) {
      return { ok: false, error: lastError || '没有已配置的日历源' };
    }
    return { ok: true, count: total, detail: results.join('，') };
  });

  // CalDAV：保存账号（密码留空 = 不修改）
  app.post('/api/events/caldav', async (req) => {
    const b = z.object({
      username: z.string().min(1),
      password: z.string().optional(),
      server: z.string().optional(),
    }).parse(req.body);
    const cur = getSetting<Partial<CaldavConfig>>('caldav') ?? {};
    const password = b.password?.trim() || cur.password; // 留空保留旧密码
    if (!password) return { ok: false, error: '请填入专用密码' };
    setSetting('caldav', {
      username: b.username.trim(),
      password,
      server: b.server?.trim() || 'https://calendar.dingtalk.com',
    });
    // 保存后立即验证并拉一次
    return syncCaldav();
  });

  // ---------- 钉钉 MCP：创建日程 ----------
  app.get('/api/dingtalk/mcp/status', () => getMcpFlag());

  // 按姓名/关键词搜同事（返回 userId 供创建日程时作为参与人）
  app.get('/api/dingtalk/contacts/search', async (req) => {
    const q = z.object({ keyword: z.string().min(1).max(60) }).parse(req.query);
    try {
      return { ok: true, users: await searchColleagues(q.keyword) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), users: [] };
    }
  });

  // 查询时间段内空闲且可预定的会议室
  app.get('/api/dingtalk/rooms/available', async (req) => {
    const q = z.object({
      start: z.string().min(10),
      end: z.string().min(10),
      name: z.string().max(60).optional(),
    }).parse(req.query);
    try {
      return { ok: true, rooms: await queryAvailableRooms(q.start, q.end, q.name?.trim() || undefined) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), rooms: [] };
    }
  });

  // 查询同事忙闲（创建日程时提示时间冲突，只返回占用时间不含日程内容）
  app.get('/api/dingtalk/busy-status', async (req) => {
    const q = z.object({
      start: z.string().min(10),
      end: z.string().min(10),
      userIds: z.string().max(2000).default(''),
    }).parse(req.query);
    try {
      return { ok: true, busy: await queryBusyStatus(q.start, q.end, q.userIds.split(',')) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), busy: [] };
    }
  });

  // 根据参与人闲忙推荐共同空闲的会议时间
  app.get('/api/dingtalk/suggested-times', async (req) => {
    const q = z.object({
      start: z.string().min(10),
      end: z.string().min(10),
      userIds: z.string().max(2000).default(''),
      duration: z.coerce.number().int().positive().max(480).default(60),
    }).parse(req.query);
    try {
      return { ok: true, times: await suggestEventTimes(q.start, q.end, q.userIds.split(','), q.duration) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), times: [] };
    }
  });

  // 创建钉钉日程（成功后前端触发一次日历同步拉回本地缓存）
  app.post('/api/events/dingtalk', async (req) => {
    const b = z.object({
      title: z.string().min(1).max(100),
      description: z.string().max(2000).optional(),
      startAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
      endAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
      attendeeUserIds: z.array(z.string().max(64)).max(50).default([]),
      roomId: z.string().max(120).optional(),
      location: z.string().max(200).optional(),
      reminderMinutes: z.number().int().nullable().optional(),
    }).parse(req.body);
    if (b.endAt <= b.startAt) throw app.httpErrors.badRequest('结束时间需晚于开始时间');
    try {
      const r = await createDingtalkEvent(b);
      return { ok: true, eventId: typeof r.id === 'string' ? r.id : null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 手动导入 .ics 文件内容
  app.post('/api/events/import-ics', (req) => {
    const b = z.object({ text: z.string().min(10) }).parse(req.body);
    try {
      const list = parseICS(b.text);
      if (list.length === 0) return { ok: false, error: '没有解析到日程' };
      const count = upsertIcsEvents(list, 'ics-file:');
      return { ok: true, count };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
