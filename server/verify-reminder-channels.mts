/** 隔离库验收：不读取真实数据，fetch 只模拟本地测试机器人。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'workbench-channel-verify-'));
const old = new Database(join(process.env.DATA_DIR, 'workbench.db'));
old.function('sync_id', () => 900001);
const sql = readFileSync(new URL('./src/schema.sql', import.meta.url), 'utf8').replace(
  "channel     TEXT NOT NULL DEFAULT 'auto',",
  "channel     TEXT NOT NULL DEFAULT 'auto' CHECK (channel IN ('auto','inapp','system','feishu','dingtalk')),",
);
old.exec(sql);
old.exec(`INSERT INTO reminders (id,message,trigger_at,channel) VALUES (42,'旧提醒','2099-01-01T09:00','inapp');
CREATE INDEX legacy_channel_index ON reminders(channel);
CREATE TABLE migration_probe (id INTEGER);
CREATE TRIGGER legacy_reminder_trigger AFTER UPDATE ON reminders BEGIN INSERT INTO migration_probe VALUES(new.id); END;`);
old.close();
const { db, setSetting, getSetting } = await import('./src/db.js');
const { default: timeRoutes } = await import('./src/routes/time.js');
const { default: miscRoutes } = await import('./src/routes/misc.js');
const { planDelivery, deliverRows, resendReminder } = await import('./src/services/reminder-delivery.js');
const { resolveReminderChannel, syncTaskReminder } = await import('./src/services/reminders.js');
const { reminderChannelSchema } = await import('./src/services/reminder-channels.js');
const app = Fastify();
await app.register(sensible);
app.setErrorHandler((err, _req, reply) => reply.status(err instanceof ZodError ? 400 : err.statusCode ?? 500).send({ error: err.message }));
await app.register(timeRoutes);
await app.register(miscRoutes);
await app.ready();
let checks = 0;
const check = (name: string, fn: () => void) => { fn(); console.log(`✓ ${name}`); checks++; };
const put = (notify: object) => app.inject({ method: 'PUT', url: '/api/settings', payload: { notify } });
const create = async (channel?: string) => {
  const r = await app.inject({ method: 'POST', url: '/api/reminders', payload: { message: '多渠道验收', triggerAt: '2099-01-01T09:00', channel } });
  assert.equal(r.statusCode, 200, r.body); return r.json();
};
try {
  check('旧提醒与索引触发器保留，微信/组合可落库，外键正常', () => {
    assert.equal((db.prepare('SELECT message FROM reminders WHERE id=42').get() as any).message, '旧提醒');
    assert.equal((db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('legacy_channel_index','legacy_reminder_trigger')").get() as any).n, 2);
    db.prepare("UPDATE reminders SET channel='feishu,weixin' WHERE id=42").run();
    assert.equal((db.prepare('SELECT count(*) n FROM migration_probe').get() as any).n, 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  });
  check('共用校验去重排序，拒绝未知渠道和 auto 混选', () => {
    assert.equal(reminderChannelSchema.parse('weixin,feishu,feishu'), 'feishu,weixin');
    for (const input of ['', 'auto,weixin', 'email', 'feishu,']) assert.equal(reminderChannelSchema.safeParse(input).success, false);
  });
  const response = await put({ defaultChannel: 'weixin', weixinEnabled: false });
  check('微信默认渠道和推送开关可保存回显', () => {
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().notify.defaultChannel, 'weixin');
    assert.equal(response.json().notify.weixinEnabled, false);
    assert.equal((getSetting('notify') as any).weixinEnabled, false);
  });
  await put({ defaultChannel: 'dingtalk,feishu', pushReminders: true,
    feishu: { webhook: 'https://notify.invalid/feishu', enabled: true },
    dingtalk: { webhook: 'https://notify.invalid/dingtalk', enabled: true } });
  check('配置状态不回显机器人地址路径或令牌', () => {
    const saved = (getSetting('notify') as any); assert.ok(saved.feishu.webhook);
    assert.equal(planDelivery('feishu').channels[0], 'feishu');
  });
  const masked = await app.inject({method:'GET',url:'/api/settings'});
  assert.equal(masked.json().notify.feishu.hint, 'notify.invalid/…');
  const inherited = await create();
  const explicit = await create('inapp,weixin');
  check('未指定渠道保持跟随，显式组合/微信保留', () => {
    assert.equal(inherited.channel, 'auto'); assert.equal(explicit.channel, 'inapp,weixin');
    assert.equal(resolveReminderChannel('weixin'), 'weixin');
    assert.deepEqual(planDelivery('auto').channels, ['feishu','dingtalk']);
  });
  await put({ defaultChannel: 'inapp' });
  check('默认修改实时影响跟随提醒，不改自定义渠道', () => {
    assert.deepEqual(planDelivery(inherited.channel).channels, []);
    assert.deepEqual(planDelivery('feishu,dingtalk').channels, ['feishu','dingtalk']);
  });
  const patched = await app.inject({ method: 'PATCH', url: `/api/reminders/${explicit.id}`, payload: { channel: 'weixin,dingtalk' } });
  check('提醒编辑组合规范化', () => { assert.equal(patched.statusCode,200,patched.body); assert.equal(patched.json().channel,'dingtalk,weixin'); });
  await put({ pushReminders: false });
  check('总开关覆盖显式多选，不偷偷转发到系统渠道', () => {
    const plan = planDelivery('feishu,dingtalk,weixin'); assert.deepEqual(plan.channels, []); assert.match(plan.note!, /已暂停/);
  });
  await put({ pushReminders: true, feishu: { enabled: false } });
  check('未启用渠道不外发且说明原因', () => {
    assert.deepEqual(planDelivery('feishu,dingtalk').channels,['dingtalk']); assert.match(planDelivery('feishu').note!,/未配置或未启用/);
  });
  await put({ feishu: { enabled: true } });
  const counts = { feishu: 0, dingtalk: 0 };
  globalThis.fetch = async (input) => {
    const url = String(input); assert.match(url,/^https:\/\/notify\.invalid\/(feishu|dingtalk)$/);
    const kind = url.endsWith('feishu') ? 'feishu' : 'dingtalk'; counts[kind]++;
    return new Response(JSON.stringify(kind === 'dingtalk' && counts.dingtalk === 1 ? { errcode: 1, errmsg:'模拟失败' } : { code: 0 }), {status:200});
  };
  const row = await create('feishu,dingtalk');
  db.prepare("UPDATE reminders SET status='fired' WHERE id=?").run(row.id);
  await deliverRows([{...row, status:'fired'}]);
  let receipt = db.prepare('SELECT * FROM reminders WHERE id=?').get(row.id) as any;
  check('部分失败保留成功渠道并安排重试', () => {
    assert.equal(receipt.delivery_status,'failed'); assert.equal(receipt.delivered_channels,'feishu'); assert.ok(receipt.next_retry_at);
  });
  await deliverRows([receipt]);
  receipt = db.prepare('SELECT * FROM reminders WHERE id=?').get(row.id) as any;
  check('重试只发失败渠道，最终回执包含全部成功渠道', () => {
    assert.deepEqual(counts,{feishu:1,dingtalk:2}); assert.equal(receipt.delivery_status,'sent');
    assert.equal(receipt.delivered_channels,'feishu,dingtalk'); assert.equal(receipt.next_retry_at,null);
  });
  await resendReminder(row.id);
  check('成功后的主动重发确实重新投递全部渠道', () => assert.deepEqual(counts,{feishu:2,dingtalk:3}));
  const taskId = Number(db.prepare("INSERT INTO tasks(title) VALUES ('渠道联动任务')").run().lastInsertRowid);
  syncTaskReminder(taskId, '渠道联动任务', '2099-01-01T10:00');
  check('任务入口保存跟随设置', () => assert.equal((db.prepare('SELECT channel FROM reminders WHERE linked_task_id=?').get(taskId) as any).channel,'auto'));
  const recurrence = await app.inject({method:'POST',url:'/api/reminders',payload:{message:'组合重复提醒',triggerAt:'2000-01-01T09:00',repeatRule:'daily',channel:'feishu,dingtalk'}});
  const { fireDueReminders } = await import('./src/scheduler.js');
  fireDueReminders();
  // 等本次模拟异步投递结束再关闭 DB。
  for (let i=0;i<50;i++) {
    const current = db.prepare('SELECT delivery_status FROM reminders WHERE id=?').get(recurrence.json().id) as any;
    if (current.delivery_status !== 'pending') break;
    await new Promise((r)=>setTimeout(r,10));
  }
  check('重复提醒下一期继承多选与系列标识', () => {
    const next = db.prepare("SELECT channel,series_id FROM reminders WHERE message='组合重复提醒' AND status='pending'").get() as any;
    assert.equal(next.channel,'feishu,dingtalk'); assert.equal(next.series_id,recurrence.json().series_id);
  });
  const rejected = await app.inject({ method: 'POST', url: '/api/reminders', payload: {message:'非法渠道',triggerAt:'2099-01-01T09:00',channel:'auto,feishu'} });
  check('HTTP 拒绝不合法组合',()=>assert.equal(rejected.statusCode,400));
  console.log(`PASS ${checks} checks; isolated DB: ${process.env.DATA_DIR}`);
} finally { await app.close(); db.close(); }
