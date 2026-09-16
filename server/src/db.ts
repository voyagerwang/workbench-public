/**
 * [INPUT]: schema.sql、既有 SQLite 数据与 DATA_DIR
 * [OUTPUT]: 数据库连接、模型费用约束等追加字段的幂等迁移与设置读写
 * [POS]: 本地数据唯一启动边界；助手新增字段仅追加，不派发历史任务
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { CATALOG_NOTE_FIXES } from './services/catalog-notes.js';
import { canonicalArchiveUrl } from './services/url-canonical.js';

// data 目录放在仓库根目录（server/../data），dev 与编译产物目录深度一致，均可定位
// DATA_DIR 可指向别处（试跑/多实例用），不影响日常默认路径
export const dataDir = process.env.DATA_DIR ?? fileURLToPath(new URL('../../data', import.meta.url));
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

export const db = new Database(`${dataDir}/workbench.db`);
// 多设备都可离线新建数据，不能继续依赖“每台机器从 1 往上加”的主键。
// 48 位随机数加高位前缀仍小于 JS Number.MAX_SAFE_INTEGER；历史小整数 ID 无需迁移。
export function newId(): number {
  return 1_000_000_000_000 + randomBytes(6).readUIntBE(0, 6);
}
db.function('sync_id', () => newId());
// schema.sql 的 DEFAULT sync_id() 与应用层插入共用同一 ID 生成器；业务代码插入时也直接用它
export const sync_id = newId;
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// 保留原文：后面的重建迁移要从这里取「与新建库完全一致」的表/索引/触发器定义，
// 手写第二份 DDL 迟早会和这里漂移。
const schemaSql = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf-8');
db.exec(schemaSql);
// V2 旧资料回填为首个可引用版本；片段是派生数据，可幂等补建。
db.exec(`INSERT INTO source_document_versions(id,document_key,version_no,content,content_hash,origin,source_version,is_current,created_at)
  SELECT sync_id(),d.source_key,1,d.content,COALESCE(d.content_hash,lower(hex(randomblob(32)))),CASE WHEN d.content_origin='manual' THEN 'manual' ELSE 'remote' END,d.source_version,1,d.updated_at
  FROM source_documents d WHERE d.content!='' AND NOT EXISTS(SELECT 1 FROM source_document_versions v WHERE v.document_key=d.source_key);
  INSERT INTO source_document_chunks(id,version_id,document_key,chunk_index,heading_path,anchor_from,anchor_to,content,content_hash,created_at)
  SELECT sync_id(),v.id,v.document_key,0,'',0,length(v.content),v.content,v.content_hash,v.created_at FROM source_document_versions v
  WHERE v.is_current=1 AND NOT EXISTS(SELECT 1 FROM source_document_chunks c WHERE c.version_id=v.id);`);
db.exec(`INSERT OR IGNORE INTO topic_member_overrides(topic_id,document_key,decision,updated_at)
  SELECT topic_id,document_key,CASE WHEN state='rejected' THEN 'exclude' ELSE 'include' END,updated_at FROM topic_members WHERE origin='user';`);

// 服务重启会把运行中的同步任务打断：历史里遗留的 running 是僵尸状态，启动时统一标失败
db.prepare("UPDATE knowledge_sync_history SET status = 'failed', error = '服务重启，任务中断', finished_at = ? WHERE status = 'running'")
  .run(new Date().toISOString());

// 早期知识库草案使用 unicode61，无法可靠匹配中文子串。FTS 是派生索引，可安全原地重建为 trigram。
const knowledgeFtsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_archives_fts'").get() as { sql?: string } | undefined)?.sql ?? '';
if (knowledgeFtsSql && !knowledgeFtsSql.includes("tokenize='trigram'")) {
  db.exec(`
    DROP TRIGGER IF EXISTS knowledge_archives_ai;
    DROP TRIGGER IF EXISTS knowledge_archives_ad;
    DROP TRIGGER IF EXISTS knowledge_archives_au;
    DROP TABLE IF EXISTS knowledge_archives_fts;
    CREATE VIRTUAL TABLE knowledge_archives_fts USING fts5(
      title, content, content='knowledge_archives', content_rowid='id', tokenize='trigram'
    );
    CREATE TRIGGER knowledge_archives_ai AFTER INSERT ON knowledge_archives BEGIN
      INSERT INTO knowledge_archives_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;
    CREATE TRIGGER knowledge_archives_ad AFTER DELETE ON knowledge_archives BEGIN
      INSERT INTO knowledge_archives_fts(knowledge_archives_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
    END;
    CREATE TRIGGER knowledge_archives_au AFTER UPDATE ON knowledge_archives BEGIN
      INSERT INTO knowledge_archives_fts(knowledge_archives_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO knowledge_archives_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;
    INSERT INTO knowledge_archives_fts(rowid, title, content)
      SELECT id, title, content FROM knowledge_archives;
  `);
}

// 记忆条目化迁移：旧的单条偏好文本按行拆成逐条记忆（幂等：迁移后清空 instructions，行内容已存在则跳过）。
const legacyMemories = db.prepare("SELECT scope_key, instructions FROM assistant_memory WHERE instructions != ''").all() as Array<{ scope_key: string; instructions: string }>;
for (const legacy of legacyMemories) {
  db.transaction(() => {
    for (const line of legacy.instructions.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (line.length <= 600 && !db.prepare('SELECT 1 FROM assistant_memory_entries WHERE scope_key = ? AND content = ?').get(legacy.scope_key, line)) {
        const ts = new Date().toISOString();
        db.prepare(`INSERT INTO assistant_memory_entries (scope_key, kind, content, status, source, source_session, created_at, updated_at)
          VALUES (?, 'preference', ?, 'active', 'command', NULL, ?, ?)`).run(legacy.scope_key, line, ts, ts);
      }
    }
    db.prepare("UPDATE assistant_memory SET instructions = '' WHERE scope_key = ?").run(legacy.scope_key);
  })();
}

// 轻量迁移：老库补列（CREATE IF NOT EXISTS 不会更新已存在的表）
function columnExists(table: string, col: string): boolean {  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === col);
}
if (!columnExists('tasks', 'remind_at')) {
  db.exec('ALTER TABLE tasks ADD COLUMN remind_at TEXT');
}
if (!columnExists('tasks', 'repeat_rule')) {
  db.exec("ALTER TABLE tasks ADD COLUMN repeat_rule TEXT NOT NULL DEFAULT 'none'");
}
if (!columnExists('reminders', 'linked_task_id')) {
  db.exec('ALTER TABLE reminders ADD COLUMN linked_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE');
}
// 同步历史的人类可读标题（空间名/文档名），列表页不再裸晒链接
if (!columnExists('knowledge_sync_history', 'title')) {
  db.exec('ALTER TABLE knowledge_sync_history ADD COLUMN title TEXT');
}

if (!columnExists('tasks', 'detail')) {
  db.exec("ALTER TABLE tasks ADD COLUMN detail TEXT NOT NULL DEFAULT ''");
}

if (!columnExists('tasks', 'sort_order')) {
  db.exec('ALTER TABLE tasks ADD COLUMN sort_order REAL');
}

if (!columnExists('events', 'organizer')) {
  db.exec('ALTER TABLE events ADD COLUMN organizer TEXT');
}

if (!columnExists('events', 'detail')) {
  db.exec("ALTER TABLE events ADD COLUMN detail TEXT NOT NULL DEFAULT ''");
}

if (!columnExists('fragments', 'rich_content')) {
  db.exec("ALTER TABLE fragments ADD COLUMN rich_content TEXT NOT NULL DEFAULT ''");
}

// 会话标题归属状态机（auto → fallback → named/user），见 assistant-sessions.ts
if (!columnExists('assistant_sessions', 'title_state')) {
  db.exec("ALTER TABLE assistant_sessions ADD COLUMN title_state TEXT NOT NULL DEFAULT 'auto'");
}

// 知识存档标签：JSON 数组字符串，与 notes/tasks 的 tags 列同构
if (!columnExists('knowledge_archives', 'tags')) {
  db.exec("ALTER TABLE knowledge_archives ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
}

// 知识存档 canonical_url：链接幂等身份（docs/social-link-skill-capture-plan.md P0b）。
// 列补齐后回填补存量 → 软删重复 → 建部分唯一索引，任一步失败 fail-closed：
// knowledgeDedupeReady() 返回 false，archive_url 写入口（工具与 HTTP）全部拒绝写入，
// 绝不静默降级继续制造重复。恢复方式：修复原因后重启服务（迁移只在启动时执行一次）。
if (!columnExists('knowledge_archives', 'canonical_url')) {
  db.exec('ALTER TABLE knowledge_archives ADD COLUMN canonical_url TEXT');
}
{
  const notCanonicalized = db.prepare(
    'SELECT id, source_url FROM knowledge_archives WHERE canonical_url IS NULL AND source_url IS NOT NULL',
  ).all() as Array<{ id: number; source_url: string }>;
  const setCanonical = db.prepare('UPDATE knowledge_archives SET canonical_url = ? WHERE id = ?');
  for (const row of notCanonicalized) {
    const canonical = canonicalArchiveUrl(row.source_url);
    if (canonical) setCanonical.run(canonical, row.id);
  }
  try {
    db.transaction(() => {
      // 「保留最新」必须全序确定：updated_at → created_at → id
      const groups = db.prepare(`
        SELECT canonical_url FROM knowledge_archives
        WHERE deleted_at IS NULL AND canonical_url IS NOT NULL
        GROUP BY canonical_url HAVING COUNT(*) > 1
      `).all() as Array<{ canonical_url: string }>;
      const softDelete = db.prepare('UPDATE knowledge_archives SET deleted_at = ? WHERE id = ?');
      for (const { canonical_url } of groups) {
        const rows = db.prepare(`
          SELECT id FROM knowledge_archives
          WHERE canonical_url = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC, created_at DESC, id DESC
        `).all(canonical_url) as Array<{ id: number }>;
        for (const dup of rows.slice(1)) softDelete.run(new Date().toISOString(), dup.id);
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_archives_canonical
        ON knowledge_archives(canonical_url) WHERE deleted_at IS NULL AND canonical_url IS NOT NULL
      `);
    })();
  } catch (error) {
    console.error('[db] 存档去重索引迁移失败，archive_url 写入已 fail-closed：', (error as Error).message);
  }
}

/** 存档去重唯一索引是否真实就绪（每次调用实测 sqlite_master，不信任内存标志）。 */
export function knowledgeDedupeReady(): boolean {
  const row = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_knowledge_archives_canonical'
  `).get();
  return !!row;
}

// 提醒送达渠道（auto/inapp/system/feishu/dingtalk）
if (!columnExists('reminders', 'channel')) {
  db.exec("ALTER TABLE reminders ADD COLUMN channel TEXT NOT NULL DEFAULT 'auto'");
}

// 飞书入站对话处理状态（编排 V3 阶段 1，ORCH-S1-MAJ-001：先落账后处理，失败可补偿）
for (const [col, ddl] of [
  ['chat_status', 'chat_status TEXT'],
  ['chat_attempts', 'chat_attempts INTEGER NOT NULL DEFAULT 0'],
  ['chat_reply', 'chat_reply TEXT'],
  ['chat_updated_at', 'chat_updated_at TEXT'],
] as const) {
  if (!columnExists('feishu_bot_messages', col)) db.exec(`ALTER TABLE feishu_bot_messages ADD COLUMN ${ddl}`);
}
for (const [col, ddl] of [
  ['scope_text', "scope_text TEXT NOT NULL DEFAULT ''"],
  ['focus_questions_json', "focus_questions_json TEXT NOT NULL DEFAULT '[]'"],
  ['auto_overview', "auto_overview TEXT NOT NULL DEFAULT ''"],
  ['auto_overview_fingerprint', 'auto_overview_fingerprint TEXT'],
  ['manual_notes', "manual_notes TEXT NOT NULL DEFAULT ''"],
] as const) {
  if (!columnExists('topics', col)) db.exec(`ALTER TABLE topics ADD COLUMN ${ddl}`);
}

// 知识库 P0 错误契约 + 手动正文通道（docs/knowledge-phase1_5-topics-redesign.md 3.2/3.7）
// last_fetch_status/fetch_error_code/fetch_error_retryable = 最近一次抓取结果；
// content_origin = 正文来源（fetch|manual）。body_status 语义不变。
for (const [col, ddl] of [
  ['last_fetch_status', "last_fetch_status TEXT CHECK (last_fetch_status IN ('ok','failed'))"],
  ['fetch_error_code', 'fetch_error_code TEXT'],
  ['fetch_error_retryable', 'fetch_error_retryable INTEGER CHECK (fetch_error_retryable IN (0,1))'],
  ['content_origin', "content_origin TEXT NOT NULL DEFAULT 'fetch' CHECK (content_origin IN ('fetch','manual'))"],
] as const) {
  if (!columnExists('source_documents', col)) db.exec(`ALTER TABLE source_documents ADD COLUMN ${ddl}`);
}
if (!columnExists('source_documents','source_nature')) db.exec("ALTER TABLE source_documents ADD COLUMN source_nature TEXT NOT NULL DEFAULT 'source'");
db.exec('CREATE INDEX IF NOT EXISTS idx_source_documents_last_fetch ON source_documents(last_fetch_status, fetch_error_retryable)');
for(const [col,ddl] of [['source_versions_json',"source_versions_json TEXT NOT NULL DEFAULT '[]'"],['coverage_json',"coverage_json TEXT NOT NULL DEFAULT '{}'"],['save_key','save_key TEXT'],['derived_document_key','derived_document_key TEXT']] as const){if(!columnExists('knowledge_outputs',col))db.exec(`ALTER TABLE knowledge_outputs ADD COLUMN ${ddl}`);}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_outputs_save_key ON knowledge_outputs(save_key) WHERE save_key IS NOT NULL');
// 历史回填：P0 之前落库的 failed 行没有 last_fetch_status，错误原因未知时按可重试处理（unknown → retryable）
db.exec(`UPDATE source_documents SET last_fetch_status = 'failed', fetch_error_code = COALESCE(fetch_error_code, 'unknown'),
  fetch_error_retryable = COALESCE(fetch_error_retryable, 1)
  WHERE deleted_at IS NULL AND body_status = 'failed' AND last_fetch_status IS NULL`);
for (const [col, ddl] of [
  ['round_attempts', 'round_attempts INTEGER NOT NULL DEFAULT 0'],
  ['retry_round', 'retry_round INTEGER NOT NULL DEFAULT 0'],
] as const) {
  if (!columnExists('knowledge_import_items', col)) db.exec(`ALTER TABLE knowledge_import_items ADD COLUMN ${ddl}`);
}
for (const [col, ddl] of [
  ['usable_count', 'usable_count INTEGER NOT NULL DEFAULT 0'],
  ['incomplete_count', 'incomplete_count INTEGER NOT NULL DEFAULT 0'],
  ['auto_organization_status', "auto_organization_status TEXT NOT NULL DEFAULT 'pending'"],
  ['auto_organization_error', 'auto_organization_error TEXT'],
  ['auto_organization_authorized', 'auto_organization_authorized INTEGER NOT NULL DEFAULT 0'],
  ['auto_organization_destination_hash', 'auto_organization_destination_hash TEXT'],
] as const) {
  if (!columnExists('knowledge_import_batches', col)) db.exec(`ALTER TABLE knowledge_import_batches ADD COLUMN ${ddl}`);
}

// 生命周期批次是本机任务：重启只回收 running claim，已成功项保持终态，不重复抓取。
db.exec(`UPDATE knowledge_import_items SET status='queued', claimed_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE status='running';
  UPDATE knowledge_import_batches SET status='partial', updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE status='running';`);

// 提醒送达回执：到点后服务端投递结果，失败可退避重试（见 scheduler.ts）
for (const [col, ddl] of [
  ['delivery_status', "delivery_status TEXT NOT NULL DEFAULT 'none'"],
  ['delivery_attempts', 'delivery_attempts INTEGER NOT NULL DEFAULT 0'],
  ['delivery_error', 'delivery_error TEXT'],
  ['delivered_channels', "delivered_channels TEXT NOT NULL DEFAULT ''"],
  ['channel_note', 'channel_note TEXT'],
  ['next_retry_at', 'next_retry_at TEXT'],
  ['last_delivery_at', 'last_delivery_at TEXT'],
] as const) {
  if (!columnExists('reminders', col)) db.exec(`ALTER TABLE reminders ADD COLUMN ${ddl}`);
}
// 索引必须等上面的补列跑完再建：schema.sql 里只有新建库才能直接用这些列
db.exec('CREATE INDEX IF NOT EXISTS idx_reminders_retry ON reminders(delivery_status, next_retry_at)');

// 重复系列标识：同一系列的各期共享（见 routes/time.ts 创建、scheduler.ts 下一期继承）
if (!columnExists('reminders', 'series_id')) {
  db.exec('ALTER TABLE reminders ADD COLUMN series_id TEXT');
}

// 派单结果触达：notified_at 防重复通知，read_at 记用户已读
if (!columnExists('assistant_actions', 'notified_at')) {
  db.exec('ALTER TABLE assistant_actions ADD COLUMN notified_at TEXT');
}
if (!columnExists('assistant_actions', 'read_at')) {
  db.exec('ALTER TABLE assistant_actions ADD COLUMN read_at TEXT');
}
// 幂等键：挡模型工具超时重试 / 用户手动重发造成的重复消息
if (!columnExists('assistant_actions', 'idempotency_key')) {
  db.exec('ALTER TABLE assistant_actions ADD COLUMN idempotency_key TEXT');
}
// 原子派发计划：历史 action/message 保持可读，新列为空代表旧链路记录。
if (!columnExists('assistant_actions', 'dispatch_item_id')) {
  db.exec('ALTER TABLE assistant_actions ADD COLUMN dispatch_item_id TEXT REFERENCES assistant_dispatch_items(id) ON DELETE SET NULL');
}
if (!columnExists('agent_tasks', 'project_id')) {
  db.exec('ALTER TABLE agent_tasks ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL');
}
if (!columnExists('agent_tasks', 'requested_cost_policy')) {
  db.exec("ALTER TABLE agent_tasks ADD COLUMN requested_cost_policy TEXT NOT NULL DEFAULT 'unspecified' CHECK (requested_cost_policy IN ('unspecified', 'free_only'))");
}

if (!columnExists('assistant_messages', 'agent_task_ids_json')) {
  db.exec("ALTER TABLE assistant_messages ADD COLUMN agent_task_ids_json TEXT CHECK (agent_task_ids_json IS NULL OR (json_valid(agent_task_ids_json) AND json_type(agent_task_ids_json) = 'array'))");
}

if (!columnExists('assistant_messages', 'plan_ids_json')) {
  db.exec("ALTER TABLE assistant_messages ADD COLUMN plan_ids_json TEXT CHECK (plan_ids_json IS NULL OR (json_valid(plan_ids_json) AND json_type(plan_ids_json) = 'array'))");
}

if (!columnExists('assistant_messages', 'images_json')) {
  db.exec("ALTER TABLE assistant_messages ADD COLUMN images_json TEXT CHECK (images_json IS NULL OR (json_valid(images_json) AND json_type(images_json) = 'array'))");
}
// 依赖轻量迁移新增列的索引必须在 ALTER TABLE 之后创建，避免老库启动时 schema.sql 提前失败。
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_actions_dispatch_item ON assistant_actions(dispatch_item_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_dispatch_target
    ON assistant_actions(dispatch_item_id, target_actor_id)
    WHERE dispatch_item_id IS NOT NULL AND target_actor_id IS NOT NULL;
`);

// 重复规则扩展（monthly / ndays:N）：老表的 CHECK 只认旧枚举，SQLite 无法原地改 CHECK，需重建表
// 重建时按 PRAGMA table_info / foreign_key_list 还原列定义与外键，只放宽 repeat_rule 的 CHECK
function relaxRepeatRuleCheck(
  table: string,
  indexSql: string[],
  needsRebuild: (createSql: string) => boolean = (sql) => !sql.includes("'monthly'"),
  afterSql: string[] = [],
): void {
  const createSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table) as { sql?: string } | undefined)?.sql ?? '';
  if (!createSql || !needsRebuild(createSql)) return; // 新库或已迁移
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
  }>;
  const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    from: string; to: string | null; table: string; on_delete: string; on_update: string;
  }>;
  const autoincrement = /AUTOINCREMENT/i.test(createSql);
  const defs = cols.map((c) => {
    let def = `${c.name} ${c.type}`;
    if (c.pk) def += ` PRIMARY KEY${autoincrement ? ' AUTOINCREMENT' : ''}`;
    if (c.notnull) def += ' NOT NULL';
    // dflt_value 可能是字面量（'none'）或表达式（strftime(...)），统一套一层括号两种都合法
    if (c.dflt_value !== null) def += ` DEFAULT (${c.dflt_value})`;
    for (const fk of fks.filter((f) => f.from === c.name)) {
      def += ` REFERENCES ${fk.table}(${fk.to ?? 'id'}) ON DELETE ${fk.on_delete} ON UPDATE ${fk.on_update}`;
    }
    return def;
  });
  const names = cols.map((c) => c.name).join(', ');
  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.exec(`CREATE TABLE ${table}_new (${defs.join(', ')});`);
    db.exec(`INSERT INTO ${table}_new (${names}) SELECT ${names} FROM ${table};`);
    db.exec(`DROP TABLE ${table};`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table};`);
    for (const sql of indexSql) db.exec(sql);
    for (const sql of afterSql) db.exec(sql);
  });
  migrate();
  db.pragma('foreign_keys = ON');
}

relaxRepeatRuleCheck('tasks', [
  'CREATE INDEX IF NOT EXISTS idx_tasks_planned ON tasks(planned_date)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)',
]);
relaxRepeatRuleCheck('reminders', [
  'CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, trigger_at)',
]);

// 云端索引（status='remote'）：老表的 status CHECK 只认三个枚举，重建放宽；重建后要补回 FTS 触发器
relaxRepeatRuleCheck(
  'knowledge_archives',
  ['CREATE INDEX IF NOT EXISTS idx_knowledge_updated ON knowledge_archives(updated_at)'],
  (sql) => sql.includes('CHECK (status IN') && !sql.includes("'remote'"),
  [
    `CREATE TRIGGER IF NOT EXISTS knowledge_archives_ai AFTER INSERT ON knowledge_archives BEGIN
      INSERT INTO knowledge_archives_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS knowledge_archives_ad AFTER DELETE ON knowledge_archives BEGIN
      INSERT INTO knowledge_archives_fts(knowledge_archives_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS knowledge_archives_au AFTER UPDATE ON knowledge_archives BEGIN
      INSERT INTO knowledge_archives_fts(knowledge_archives_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO knowledge_archives_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;`,
  ],
);

/**
 * 微信派发 P0 热修（4.1.1）：老库的 assistant_dispatch_plans.session_id 是 NOT NULL，
 * 与 schema.sql 里「无 sessionKey 的一次性调用可建 sessionless Plan」的契约不符，
 * 模型封板插入计划时直接 500（NOT NULL constraint failed: ...session_id）。
 * CREATE TABLE IF NOT EXISTS 对已存在的表是空操作，光改 schema.sql 修不了老库，必须重建表。
 * 三不做：不做伪会话、不改回 NOT NULL、不手工改用户的 db 文件（换设备/恢复备份会复发）。
 *
 * 新表的 DDL / 索引 / 触发器一律从 schema.sql 原文抽取，不在这里另写一份缩水约束。
 */
function schemaStatement(sql: string, startMarker: string, endMarker: string): string {
  const start = sql.indexOf(startMarker);
  if (start < 0) throw new Error(`schema.sql 缺少语句：${startMarker}`);
  const end = sql.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`schema.sql 语句未闭合：${startMarker}`);
  return sql.slice(start, end + endMarker.length);
}

const DISPATCH_PLAN_TABLE = 'assistant_dispatch_plans';

function rebuildDispatchPlansForNullableSession(): void {
  const createSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(DISPATCH_PLAN_TABLE) as { sql?: string } | undefined)?.sql ?? '';
  // 幂等：新库或已迁移过的库都不含 NOT NULL，直接返回；二次启动必须是 no-op。
  if (!createSql || !/^\s*session_id\s+TEXT\s+NOT\s+NULL/im.test(createSql)) return;

  const columns = (db.prepare(`PRAGMA table_info(${DISPATCH_PLAN_TABLE})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
  const columnList = columns.join(', ');

  const newTableDdl = schemaStatement(schemaSql, `CREATE TABLE IF NOT EXISTS ${DISPATCH_PLAN_TABLE} (`, '\n);')
    .replace(
      new RegExp(`^\\s*CREATE TABLE IF NOT EXISTS\\s+${DISPATCH_PLAN_TABLE}\\s*\\(`),
      `CREATE TABLE ${DISPATCH_PLAN_TABLE}_new (`,
    );
  const indexSql = [
    'idx_dispatch_plans_session',
    'idx_dispatch_plans_pending',
    'idx_dispatch_plans_payload_recent',
  ].map((name) => schemaStatement(schemaSql, `CREATE INDEX IF NOT EXISTS ${name} ON`, ';'));
  const triggerSql = [
    'assistant_dispatch_plans_frozen_au',
    'assistant_dispatch_plans_source_message_au',
  ].map((name) => schemaStatement(schemaSql, `CREATE TRIGGER IF NOT EXISTS ${name}`, '\nEND;'));

  // PRAGMA foreign_keys 在事务里是空操作：先关掉再建事务，DROP 父表才不会级联删掉
  // items / targets。函数结束时按原状态恢复，不留副作用。
  const foreignKeysWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    // 事务内完成：任何一步失败（含历史数据违反新 CHECK）都整体回滚，
    // 不会留下 _new 表，也不会出现「表换了但索引/触发器没建回来」的半迁移状态。
    db.transaction(() => {
      db.exec(newTableDdl);
      db.exec(`INSERT INTO ${DISPATCH_PLAN_TABLE}_new (${columnList}) SELECT ${columnList} FROM ${DISPATCH_PLAN_TABLE};`);
      db.exec(`DROP TABLE ${DISPATCH_PLAN_TABLE};`);
      db.exec(`ALTER TABLE ${DISPATCH_PLAN_TABLE}_new RENAME TO ${DISPATCH_PLAN_TABLE};`);
      for (const sql of [...indexSql, ...triggerSql]) db.exec(sql);
      const violations = db.prepare(`PRAGMA foreign_key_check(${DISPATCH_PLAN_TABLE})`).all();
      if (violations.length) {
        throw new Error(`重建 ${DISPATCH_PLAN_TABLE} 后外键校验未通过：${JSON.stringify(violations)}`);
      }
    })();
  } catch (error) {
    throw new Error(
      `迁移 ${DISPATCH_PLAN_TABLE}（session_id 改为可空）失败，已回滚，原库与数据保持不变：${(error as Error).message}`,
    );
  } finally {
    if (foreignKeysWasOn) db.pragma('foreign_keys = ON');
  }
}

rebuildDispatchPlansForNullableSession();

/**
 * agent_execution_events 的外键原指向 agent_execution_jobs(task_id)，但事件事实属于"一次交办"：
 * 内容线任务（视频/文章总结）没有派发 job 行，写事件会撞外键（阶段②包1：内容线关键节点入账）。
 * 重建为指向 agent_tasks(id)；幂等——已迁移（外键已指 agent_tasks）或全新库直接返回。
 */
function rebuildAgentEventsForTaskFk(): void {
  const table = 'agent_execution_events';
  const createSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table) as { sql?: string } | undefined)?.sql ?? '';
  if (!createSql) return;
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>;
  if (!foreignKeys.some((fk) => fk.table === 'agent_execution_jobs')) return;
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const newTableDdl = schemaStatement(schemaSql, `CREATE TABLE IF NOT EXISTS ${table} (`, 'NOT NULL);')
    .replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${table}_new (`);
  const foreignKeysWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(newTableDdl);
      db.exec(`INSERT INTO ${table}_new (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM ${table};`);
      db.exec(`DROP TABLE ${table};`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table};`);
      const violations = db.prepare(`PRAGMA foreign_key_check(${table})`).all();
      if (violations.length) {
        throw new Error(`重建 ${table} 后外键校验未通过：${JSON.stringify(violations)}`);
      }
    })();
  } catch (error) {
    throw new Error(
      `迁移 ${table}（外键改指 agent_tasks）失败，已回滚，原库与数据保持不变：${(error as Error).message}`,
    );
  } finally {
    if (foreignKeysWasOn) db.pragma('foreign_keys = ON');
  }
}

rebuildAgentEventsForTaskFk();

/**
 * 存量目录存档里的假文案修复（幂等）。
 *
 * 背景：只建索引的同步会在目录正文里写死一句「全文已建本地快照（data/kb/dingtalk）」，
 * 而快照目录压根不存在 —— 页面上等于在撒谎。代码已经改成按 mode 生成诚实文案，
 * 但**存量数据不会自己变**：恢复备份、换设备、从旧库迁移，假文案会原样回来。
 * 所以修数据这件事必须进代码，而且必须幂等。
 *
 * 幂等的来源：只在命中「特定 source_url + 旧文案原文」时动手，改完就不再命中，
 * 二次启动是 no-op。刻意不碰其它行 —— 用户手动写的笔记里有同样字句也不该被动到。
 */
function repairCatalogNotes(): void {
  for (const fix of CATALOG_NOTE_FIXES) {
    const pending = db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_archives WHERE source_url = ? AND deleted_at IS NULL AND content LIKE ?`,
    ).get(fix.sourceUrl, `%${fix.from}%`) as { n: number } | undefined;
    if (!pending?.n) continue;
    // FTS 由 knowledge_archives_au 触发器同步：better-sqlite3 自带的 SQLite 允许
    // 触发器里的 fts5 'delete' 命令，系统 sqlite3 CLI（3.43.2）会报 unsafe use of virtual table。
    const info = db.prepare(
      `UPDATE knowledge_archives SET content = replace(content, ?, ?) WHERE source_url = ? AND deleted_at IS NULL AND content LIKE ?`,
    ).run(fix.from, fix.to, fix.sourceUrl, `%${fix.from}%`);
    console.log(`[db] 修正目录存档文案 ${fix.sourceUrl}：${info.changes} 行`);
  }
}

repairCatalogNotes();

// 回收站：软删除标记（删除先进回收站，30 天后由 /api/trash 惰性清除）
// 知识库（笔记 / 知识存档）与 AI 资源库（提示词）同样走软删，保证回收站能回显
for (const t of ['projects', 'tasks', 'fragments', 'notes', 'reminders', 'knowledge_archives', 'prompts']) {
  if (!columnExists(t, 'deleted_at')) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN deleted_at TEXT`);
  }
}

// 随手记置顶：列表排序改为「置顶 > 最近编辑」。
// CHECK (pinned IN (0,1)) 只影响新建库，老库靠这里的默认 0 补列即可，不需要重建表。
if (!columnExists('notes', 'pinned')) {
  db.exec('ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned, updated_at DESC)');

// 提示词来源（导入集合名，如「12个常用Prompt」）与用户标签分离：
// 来源只读展示，不混进可编辑的 tags。
if (!columnExists('prompts', 'source')) {
  db.exec('ALTER TABLE prompts ADD COLUMN source TEXT');
}
// 一次性把历史里混进 tags 的来源标记挪到 source 列（挪完后 tags 不再含该串，可重复启动安全）
{
  const legacySourceTag = '12个常用Prompt';
  const legacy = db.prepare(`SELECT id, tags FROM prompts WHERE deleted_at IS NULL AND tags LIKE ?`)
    .all(`%${legacySourceTag}%`) as Array<{ id: number; tags: string }>;
  for (const row of legacy) {
    const tags: string[] = JSON.parse(row.tags || '[]');
    if (tags.includes(legacySourceTag)) {
      db.prepare(`UPDATE prompts SET source = ?, tags = ? WHERE id = ?`)
        .run(legacySourceTag, JSON.stringify(tags.filter((t) => t !== legacySourceTag)), row.id);
    }
  }
}

/**
 * Supabase 只作为同步中枢，本机 SQLite 仍是应用的读写库。
 * 这些表是用户在两台设备间真正需要共享的内容；FTS、同步历史、Skill 文件和密钥设置
 * 都是派生数据或设备数据，不进入云端。
 */
export const syncEntities = [
  { table: 'projects', key: 'id' },
  { table: 'tasks', key: 'id' },
  { table: 'fragments', key: 'id' },
  { table: 'notes', key: 'id' },
  { table: 'reminders', key: 'id' },
  { table: 'events', key: 'id' },
  { table: 'prompts', key: 'id' },
  { table: 'knowledge_archives', key: 'id' },
  // 阶段 1 三层知识模型。顺序即外键依赖顺序：资料 → 主题 → 成员 → 知识 → 证据；
  // source_documents 用业务键 source_key 同步（跨设备稳定），FTS 是派生数据不进云端。
  { table: 'source_documents', key: 'source_key' },
  { table: 'topics', key: 'id' },
  { table: 'topic_members', key: 'id' },
  { table: 'knowledge_items', key: 'id' },
  { table: 'knowledge_evidence', key: 'id' },
  { table: 'mood_log', key: 'day' },
  // 只同步无密钥的偏好；model/notify/dingtalk/caldav/authSessions 等永远留在设备本地。
  { table: 'settings', key: 'key', where: "key IN ('general', 'mood')" },
] as const;

db.exec(`
  CREATE TABLE IF NOT EXISTS sync_outbox (
    table_name TEXT NOT NULL,
    record_key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    queued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    PRIMARY KEY (table_name, record_key)
  );
  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_file_outbox (
    name TEXT PRIMARY KEY,
    queued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sync_outbox_queued ON sync_outbox(queued_at);
`);

// 统一由触发器捕获变更，避免要求所有路由/后台任务记得手动上报。
// 每次启动重建，保证后续升级触发器逻辑时老数据库也能同步更新。
for (const entity of syncEntities) {
  const { table, key } = entity;
  for (const suffix of ['ai', 'au', 'ad']) db.exec(`DROP TRIGGER IF EXISTS sync_${table}_${suffix}`);
  const queue = (row: 'NEW' | 'OLD', operation: 'upsert' | 'delete') => `
    INSERT INTO sync_outbox(table_name, record_key, operation, queued_at, attempts, last_error)
    VALUES ('${table}', CAST(${row}.${key} AS TEXT), '${operation}',
      strftime('%Y-%m-%dT%H:%M:%f', 'now'), 0, NULL)
    ON CONFLICT(table_name, record_key) DO UPDATE SET
      operation=excluded.operation, queued_at=excluded.queued_at, attempts=0, last_error=NULL;
  `;
  const enabled = `COALESCE((SELECT value FROM sync_state WHERE key = 'applying_remote'), '0') != '1'`;
  const where = 'where' in entity ? entity.where : undefined;
  const filter = (row: 'NEW' | 'OLD') => where
    ? ` AND (${where.replace(/\bkey\b/g, `${row}.${key}`)})`
    : '';
  db.exec(`
    CREATE TRIGGER sync_${table}_ai AFTER INSERT ON ${table} WHEN ${enabled}${filter('NEW')} BEGIN
      ${queue('NEW', 'upsert')}
    END;
    CREATE TRIGGER sync_${table}_au AFTER UPDATE ON ${table} WHEN ${enabled}${filter('NEW')} BEGIN
      ${queue('NEW', 'upsert')}
    END;
    CREATE TRIGGER sync_${table}_ad AFTER DELETE ON ${table} WHEN ${enabled}${filter('OLD')} BEGIN
      ${queue('OLD', 'delete')}
    END;
  `);
}

export const now = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const today = (): string => now().slice(0, 10);

export function getSetting<T>(key: string): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value) as T; } catch { return undefined; }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}

// S03-S05 候选持久化：兼容本地早期候选表，已有业务表不变。
for (const [name,ddl] of [['saved_json','TEXT'],['error','TEXT'],['destination_signature',"TEXT NOT NULL DEFAULT "],['target_hash','TEXT']]) {
  if (!columnExists('skill_capture_drafts', name)) db.exec(`ALTER TABLE skill_capture_drafts ADD COLUMN ${name} ${ddl}`);
}
