-- [INPUT]: 工作台本地持久化契约与既有数据库迁移需求
-- [OUTPUT]: SQLite 规范 DDL；助手显式记忆、用量、消息任务关联与统一标签池
-- [POS]: 数据表结构唯一来源；db.ts 负责旧库追加迁移
-- [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
-- YZ 工作台本地数据库结构（SQLite，全部时间为本地时区无后缀 ISO: YYYY-MM-DDTHH:MM:SS）

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  domain      TEXT NOT NULL DEFAULT 'work' CHECK (domain IN ('work', 'life')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived', 'done')),
  color       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  notes         TEXT NOT NULL DEFAULT '',
  project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  priority      INTEGER NOT NULL DEFAULT 0,           -- 0 普通 / 1 重要 / 2 紧急重要
  sort_order    REAL,                                  -- 手动拖拽排序（NULL = 从未排过，按时间倒序兜底）
  due_at        TEXT,                                  -- 截止时间（ISO 本地）
  planned_date  TEXT,                                  -- 计划日期 YYYY-MM-DD（今日视图）
  remind_at     TEXT,                                  -- 任务提醒（可选，默认不设）
  repeat_rule   TEXT NOT NULL DEFAULT 'none' CHECK (repeat_rule IN ('none', 'daily', 'weekly', 'weekdays', 'monthly') OR repeat_rule GLOB 'ndays:[0-9]*'), -- 完成后生成下一次任务；ndays:N = 每 N 天
  detail        TEXT NOT NULL DEFAULT '',               -- 详情文档（Markdown，可含图片，默认空）
  completed_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS fragments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  content        TEXT NOT NULL,
  rich_content   TEXT NOT NULL DEFAULT '',                    -- 富文本 Markdown（可含已上传图片）
  triaged_type   TEXT CHECK (triaged_type IN ('task', 'note', 'reminder')),  -- NULL = 未分诊
  triaged_id     INTEGER,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  triaged_at     TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT NOT NULL DEFAULT '',
  content             TEXT NOT NULL DEFAULT '',
  tags                TEXT NOT NULL DEFAULT '[]',
  source_fragment_id  INTEGER REFERENCES fragments(id) ON DELETE SET NULL,
  pinned              INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),  -- 置顶：列表排序 pinned DESC, updated_at DESC
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message     TEXT NOT NULL,
  trigger_at  TEXT NOT NULL,
  repeat_rule TEXT NOT NULL DEFAULT 'none' CHECK (repeat_rule IN ('none', 'daily', 'weekly', 'weekdays', 'monthly') OR repeat_rule GLOB 'ndays:[0-9]*'),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'done')),
  channel     TEXT NOT NULL DEFAULT 'auto', -- auto=跟随设置；支持单渠道或逗号分隔多选
  fired_at    TEXT,
  linked_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, -- 任务附带的提醒
  series_id TEXT,                                -- 重复系列标识：同一系列的各期共享，新建重复提醒时生成、下一期继承
  -- 送达回执：到点后服务端的投递结果。none=还没到点；pending=已发起；sent/failed；skipped=应用内等无需服务端发送的渠道
  delivery_status TEXT NOT NULL DEFAULT 'none' CHECK (delivery_status IN ('none', 'pending', 'sent', 'failed', 'skipped')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,  -- 已投递次数，含自动重试，上限 3
  delivery_error TEXT,                           -- 最后一次失败的原因摘要（成功即清空）
  delivered_channels TEXT NOT NULL DEFAULT '',   -- 实际送达成功的渠道，逗号分隔
  channel_note  TEXT,                            -- 渠道不可用时的降级说明：保留用户意图，不静默改成 auto
  next_retry_at TEXT,                            -- 失败退避的下次重试时刻；为空代表不再自动重试
  last_delivery_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  start_at    TEXT NOT NULL,
  end_at      TEXT,
  is_all_day  INTEGER NOT NULL DEFAULT 0,
  location    TEXT,
  organizer   TEXT,
  detail      TEXT NOT NULL DEFAULT '',
  synced_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- chat_status：P2P 文本入站对话的处理状态（编排 V3 阶段 1，ORCH-S1-MAJ-001）。
-- pending=已入账待处理；replying=对话完成、回复已暂存待发送；done=回复已发出；failed=重试耗尽转人工。
-- 补偿扫描依据 chat_updated_at；任务侧幂等由 agent_tasks.intent_key 保证，重跑不会重复建任务。
CREATE TABLE IF NOT EXISTS feishu_bot_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, message_id TEXT, chat_id TEXT, content TEXT NOT NULL, received_at TEXT NOT NULL, chat_status TEXT, chat_attempts INTEGER NOT NULL DEFAULT 0, chat_reply TEXT, chat_updated_at TEXT);

-- AI 资源库：提示词与 Skill 调用记录。Skill 本体仍以本机 SKILL.md 为唯一事实来源。
CREATE TABLE IF NOT EXISTS prompts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  deleted_at  TEXT                                   -- 回收站软删除标记
);

CREATE TABLE IF NOT EXISTS skill_usage_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_path  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'workspace',
  used_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

-- 知识存档：一条记录对应一个可编辑文档；content 同时是本地全文索引的原始内容。
CREATE TABLE IF NOT EXISTS knowledge_archives (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '',
  source_kind   TEXT NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual', 'feishu', 'dingtalk', 'url', 'folder', 'conversation')),
  source_url    TEXT,
  canonical_url TEXT,                                  -- 链接幂等身份（url-canonical.ts 归一化），仅 http(s) 非空
  file_name     TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',         -- JSON 数组，小写归一后去重；检索时可与正文一起命中
  status        TEXT NOT NULL DEFAULT 'indexed' CHECK (status IN ('indexed', 'needs_auth', 'failed', 'remote')),
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  deleted_at    TEXT                                   -- 回收站软删除标记
);

-- Skill 写入确认凭证（workbench_save_skill 两段式，见 docs/social-link-skill-capture-plan.md）：
-- 状态机 pending_preview → user_approved → consumed / cancelled。user_approved 只能由服务端
-- 处理真实用户入站消息触发；consume 是单条条件 UPDATE，身份/会话/哈希不匹配影响行数为 0。
CREATE TABLE IF NOT EXISTS skill_confirmations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  token             TEXT NOT NULL UNIQUE,               -- 加密随机 32 字节 hex
  payload_hash      TEXT NOT NULL,                      -- sha256(name+description+content 规范化载荷)
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  content           TEXT NOT NULL DEFAULT '',
  action            TEXT NOT NULL CHECK (action IN ('create', 'update')),
  conversation_key  TEXT NOT NULL,                      -- dispatch.sessionId ?? inbound.sourceConversationId
  requester_user_id TEXT NOT NULL,                      -- 服务端从入站上下文推导，不可为空
  approver_user_id  TEXT,                               -- user_approved 时由服务端记录
  approve_message_id TEXT,                              -- 触发确认的用户入站消息 id（审计）
  status            TEXT NOT NULL DEFAULT 'pending_preview' CHECK (status IN ('pending_preview', 'user_approved', 'consumed', 'cancelled')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  expires_at        TEXT NOT NULL,
  consumed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_confirmations_conversation
  ON skill_confirmations(conversation_key, status);

CREATE TABLE IF NOT EXISTS skill_capture_drafts (
  id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL, source_version TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '', candidate_json TEXT NOT NULL,
  saved_json TEXT, error TEXT, destination_signature TEXT NOT NULL DEFAULT '', target_hash TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('generating','failed','draft','cancelled','saved')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- 旧库幂等补列由 db.ts 启动迁移负责
CREATE INDEX IF NOT EXISTS idx_skill_capture_source ON skill_capture_drafts(source_type, source_id);

-- Skill 回收站：Skill 本体是文件目录，删除时整体移入 data/skill-trash，这里登记原位置以便恢复。
CREATE TABLE IF NOT EXISTS skill_trash (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  origin_dir  TEXT NOT NULL,                          -- 删除前所在目录
  trash_dir   TEXT NOT NULL,                          -- data/skill-trash 下的备份目录
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  deleted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

-- 周报自定义内容：用户编辑过的三个分区段落。content 是去掉序号后的纯净文本（前端展示时再加 1. 2. 3.）。
-- 这是个人化编辑结果，不进 sync_entities。
CREATE TABLE IF NOT EXISTS weekly_report_overrides (
  week_start    TEXT NOT NULL,                       -- YYYY-MM-DD（该周周一）
  section_index INTEGER NOT NULL,                    -- 0/1/2
  content       TEXT NOT NULL,                       -- 去序号的纯内容，\n 分隔
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  PRIMARY KEY (week_start, section_index)
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_archives_fts USING fts5(
  title, content, content='knowledge_archives', content_rowid='id', tokenize='trigram'
);

-- 知识空间同步历史：任务落库，页面关掉也能重新接上进度；scope_json 为空表示全量同步
CREATE TABLE IF NOT EXISTS knowledge_sync_history (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'index',
  status      TEXT NOT NULL DEFAULT 'running',
  total       INTEGER NOT NULL DEFAULT 0,
  indexed     INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  scope_json  TEXT,
  space_hint  TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

-- 本地知识库快照（钉钉等）的全文检索表：同步完成后按 provider 全量重建
CREATE VIRTUAL TABLE IF NOT EXISTS kb_snapshot_fts USING fts5(
  title, content, space, url UNINDEXED, provider UNINDEXED, tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS knowledge_archives_ai AFTER INSERT ON knowledge_archives BEGIN
  INSERT INTO knowledge_archives_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_archives_ad AFTER DELETE ON knowledge_archives BEGIN
  INSERT INTO knowledge_archives_fts(knowledge_archives_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_archives_au AFTER UPDATE ON knowledge_archives BEGIN
  INSERT INTO knowledge_archives_fts(knowledge_archives_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO knowledge_archives_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

-- 心情轨迹：每天一行（真实打分，不吃强制 kind），回顾页以后画「本周心情」条带用
CREATE TABLE IF NOT EXISTS mood_log (
  day        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  valence    REAL NOT NULL,
  arousal    REAL NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 助手动作台账：派出去的事必须有回音。
--
-- 只记「外部副作用」型动作（当前只有飞书派单），本地写库由凭证卡直接闭环，不进这张表。
-- 状态机：dispatched → acked（对方答了个"收到"）→ progress（有实质进展）→ succeeded（终态信号）
--         任一环节超过 watch_deadline_at 仍未到终态 → expired（如实说"没等到结果"，绝不冒充完成）
--
-- 设备本地表，不参与 Supabase 同步：轮询用的是本机 lark-cli 身份，换设备既读不到也接不上。
CREATE TABLE IF NOT EXISTS assistant_actions (
  id                  TEXT PRIMARY KEY,
  -- 新派发链路中，一个 Item 是一条真实飞书消息；历史动作保持 NULL。
  dispatch_item_id    TEXT REFERENCES assistant_dispatch_items(id) ON DELETE SET NULL,
  kind                TEXT NOT NULL DEFAULT 'feishu_dispatch',
  status              TEXT NOT NULL DEFAULT 'dispatched',
  summary             TEXT NOT NULL DEFAULT '',
  chat_id             TEXT,
  chat_name           TEXT,
  outbound_message_id TEXT,
  -- 幂等键：同签名（群+身份+被@者+归一化正文）在 IDEMPOTENCY_WINDOW 内只允许真正发出一次。
  -- 用来挡「模型工具超时后重试」或「用户手动重发」造成的重复消息。
  idempotency_key     TEXT,
  outbound_position   INTEGER,
  self_sender_id      TEXT,
  target_actor_id     TEXT,
  target_actor_name   TEXT,
  correlation         TEXT,
  result_text         TEXT,
  last_reply_at       TEXT,
  -- 结果触达两阶段：notified_at = 已推过通知（防重复打扰），read_at = 用户真打开看过。
  -- 分开记是因为系统通知可能被用户忽略或系统吞掉，只有前端上报才算已读。
  notified_at         TEXT,
  read_at             TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_poll_at        TEXT,
  watch_deadline_at   TEXT,
  seen_json           TEXT NOT NULL DEFAULT '[]',
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- 助手会话：把对话从「浏览器里的一坨缓存」变成「服务端的一份资产」。
--
-- 设备本地表，不参与 Supabase 同步：对话里带着本机数据快照与本机飞书/钉钉身份，
-- 同步到别的设备既读不全，也没有可执行的凭据。
--
-- id 当前等于页面派生 key（global:今天 / task:123 / document:标题），
-- 接「新对话」入口后改成 sess_<nanoid>，届时页面归属另开列承载。
CREATE TABLE IF NOT EXISTS assistant_sessions (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'global',       -- global | task | document
  ref_id        TEXT,                                 -- 任务 id / 文档 id，可空
  title         TEXT NOT NULL DEFAULT '新对话',
  -- 标题归属状态机：auto（默认，可被首句话顶掉）→ fallback（已用首句话兜底，待模型起名）
  --                → named（模型起过名，或试过但失败，两种都不再重试）/ user（用户改过，永不覆盖）
  title_state   TEXT NOT NULL DEFAULT 'auto'
      CHECK (title_state IN ('auto', 'fallback', 'named', 'user')),
  summary       TEXT,                                 -- 一句话摘要，列表页预览用
  model         TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  action_count  INTEGER NOT NULL DEFAULT 0,           -- 本会话派出去过多少外部动作
  pinned        INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 会话消息：追加写日志，服务端是唯一权威。
-- receipt_json 存服务端真实落库结果（模型的自然语言不能代表写没写进去）；
-- action_ids_json 只存动作 id —— 状态一直在后台变，存快照就是存过期数据。
CREATE TABLE IF NOT EXISTS assistant_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  receipt_json    TEXT,
  receipt_error   TEXT,
  action_ids_json TEXT,
  agent_task_ids_json TEXT CHECK (agent_task_ids_json IS NULL OR (json_valid(agent_task_ids_json) AND json_type(agent_task_ids_json) = 'array')),
  -- 本轮创建的派发计划 id。计划状态单独查询，不在消息中保存易过期快照。
  plan_ids_json   TEXT CHECK (
      plan_ids_json IS NULL OR (json_valid(plan_ids_json) AND json_type(plan_ids_json) = 'array')
  ),
  -- 本轮随消息发送的图片（/api/files/xxx 本地地址）；模型调用时服务端读盘转成 data URI 内联。
  images_json     TEXT CHECK (
      images_json IS NULL OR (json_valid(images_json) AND json_type(images_json) = 'array')
  ),
  created_at      TEXT NOT NULL
);

-- 原子派发计划：模型只提交一次完整意图，服务端冻结后决定直发或等待确认。
-- 本地表，不参与 Supabase 同步；payload 可能包含对话正文，只随本机会话保留。
CREATE TABLE IF NOT EXISTS assistant_dispatch_plans (
  id                       TEXT PRIMARY KEY,
  -- NULL 保持 /api/assistant/chat 无 sessionKey 的一次性调用契约；有会话时删除会级联清理计划。
  session_id               TEXT REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  source_message_id        INTEGER REFERENCES assistant_messages(id) ON DELETE SET NULL,
  status                   TEXT NOT NULL
      CHECK (status IN ('pending_confirmation', 'dispatching', 'dispatched',
                        'partial_failed', 'failed', 'cancelled', 'expired')),
  confirmation_required    INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_required IN (0, 1)),
  confirmation_reasons_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(confirmation_reasons_json) AND json_type(confirmation_reasons_json) = 'array'),
  item_count               INTEGER NOT NULL CHECK (item_count >= 1),
  target_count             INTEGER NOT NULL DEFAULT 0 CHECK (target_count >= 0),
  chat_count               INTEGER NOT NULL CHECK (chat_count >= 1),
  frozen_payload_json      TEXT NOT NULL
      CHECK (json_valid(frozen_payload_json) AND json_type(frozen_payload_json) = 'object'),
  payload_hash             TEXT NOT NULL CHECK (length(trim(payload_hash)) > 0),
  expires_at               TEXT,
  confirmed_at             TEXT,
  cancelled_at             TEXT,
  last_error               TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  CHECK (
    (confirmation_required = 1 AND expires_at IS NOT NULL)
    OR (confirmation_required = 0)
  ),
  CHECK (status != 'pending_confirmation' OR confirmation_required = 1),
  CHECK (status != 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (cancelled_at IS NULL OR status = 'cancelled'),
  CHECK (confirmed_at IS NULL OR status IN ('dispatching', 'dispatched', 'partial_failed', 'failed'))
);

-- 一条 Item 对应一条实际飞书消息。同群、同正文、同格式、同身份才能合并目标。
CREATE TABLE IF NOT EXISTS assistant_dispatch_items (
  id                  TEXT PRIMARY KEY,
  plan_id             TEXT NOT NULL REFERENCES assistant_dispatch_plans(id) ON DELETE CASCADE,
  item_order          INTEGER NOT NULL CHECK (item_order >= 0),
  status              TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'recalling', 'recalled')),
  chat_id             TEXT NOT NULL CHECK (length(trim(chat_id)) > 0),
  chat_name           TEXT,
  body                TEXT NOT NULL CHECK (length(trim(body)) > 0),
  format              TEXT NOT NULL DEFAULT 'text' CHECK (format IN ('text', 'markdown')),
  sender_identity     TEXT NOT NULL CHECK (sender_identity IN ('user', 'bot')),
  frozen_payload_json TEXT NOT NULL
      CHECK (json_valid(frozen_payload_json) AND json_type(frozen_payload_json) = 'object'),
  payload_hash        TEXT NOT NULL CHECK (length(trim(payload_hash)) > 0),
  idempotency_key     TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  outbound_message_id TEXT,
  sent_at             TEXT,
  recalled_at         TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (plan_id, item_order),
  UNIQUE (plan_id, payload_hash),
  UNIQUE (plan_id, idempotency_key),
  CHECK (status NOT IN ('sent', 'recalling', 'recalled') OR (outbound_message_id IS NOT NULL AND sent_at IS NOT NULL)),
  CHECK (sent_at IS NULL OR outbound_message_id IS NOT NULL),
  CHECK ((status = 'recalled' AND recalled_at IS NOT NULL) OR (status != 'recalled' AND recalled_at IS NULL))
);

-- Item 的被 @ 目标。expects_reply=1 才会在发送成功后生成一个 child action。
CREATE TABLE IF NOT EXISTS assistant_dispatch_targets (
  id               TEXT PRIMARY KEY,
  dispatch_item_id TEXT NOT NULL REFERENCES assistant_dispatch_items(id) ON DELETE CASCADE,
  target_key       TEXT NOT NULL CHECK (length(trim(target_key)) > 0),
  actor_id         TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  actor_name       TEXT NOT NULL CHECK (length(trim(actor_name)) > 0),
  expects_reply    INTEGER NOT NULL DEFAULT 1 CHECK (expects_reply IN (0, 1)),
  mention_order    INTEGER NOT NULL CHECK (mention_order >= 0),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (dispatch_item_id, target_key),
  UNIQUE (dispatch_item_id, mention_order),
  CHECK (target_key = actor_id)
);

-- 风险判定与确认执行都依赖同一份冻结输入；状态变化不能顺手改写发送内容。
CREATE TRIGGER IF NOT EXISTS assistant_dispatch_plans_frozen_au
BEFORE UPDATE OF session_id, confirmation_required, confirmation_reasons_json,
                 item_count, target_count, chat_count, frozen_payload_json, payload_hash
ON assistant_dispatch_plans
BEGIN
  SELECT RAISE(ABORT, 'assistant dispatch plan payload is immutable');
END;

-- 来源消息可被独立删除，因此允许 FK 把旧引用置 NULL；禁止改绑到另一条消息或从 NULL 恢复。
CREATE TRIGGER IF NOT EXISTS assistant_dispatch_plans_source_message_au
BEFORE UPDATE OF source_message_id ON assistant_dispatch_plans
WHEN NOT (OLD.source_message_id IS NOT NULL AND NEW.source_message_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'assistant dispatch plan source message is immutable');
END;

CREATE TRIGGER IF NOT EXISTS assistant_dispatch_items_frozen_au
BEFORE UPDATE OF plan_id, item_order, chat_id, chat_name, body, format, sender_identity,
                 frozen_payload_json, payload_hash, idempotency_key
ON assistant_dispatch_items
BEGIN
  SELECT RAISE(ABORT, 'assistant dispatch item payload is immutable');
END;

CREATE TRIGGER IF NOT EXISTS assistant_dispatch_targets_frozen_au
BEFORE UPDATE OF dispatch_item_id, target_key, actor_id, actor_name, expects_reply, mention_order
ON assistant_dispatch_targets
BEGIN
  SELECT RAISE(ABORT, 'assistant dispatch target payload is immutable');
END;

-- ---------------------------------------------------------------------------
-- Agent 任务聚合根（编排 V3，docs/agent-orchestration-handoff-v3.md 第八节为唯一契约）。
-- 跨规划、执行、审核、通知的唯一真相源在 SQLite；.handoff 只存任务卡/结果卡/审核卡产物，
-- .handoff/relay/registry.json 是已冻结实验的通信探针，不是本表的对等物。
-- 阶段 1 只创建 drafted 任务（模型经 agent_delegate 登记意图），不派发、不审核；
-- 后续阶段在本表上用条件更新/CAS 推进状态机。
-- 设备本地表，不参与 Supabase 同步。
-- 注意：建表语句内部不能有行内注释——sqlite_master 会原样保存 DDL 文本，
-- verify-db-migration.mts 按登记 DDL 逐 token 比对，注释会导致比对失败。
-- 列级说明：source/source_conversation_id/source_message_id 是来源元数据（阶段 4 来源感知通知依赖）；
-- executor 存 registry 里的 agent id（如 zcode/codex），不是自由文本；
-- intent_key = sha1(source|source_message_id|task_type|executor|objective)，同一外部消息重复投递 + 相同语义只建一条。
CREATE TABLE IF NOT EXISTS agent_tasks (
  id                     TEXT PRIMARY KEY,
  source                 TEXT NOT NULL CHECK (source IN ('feishu', 'weixin', 'workbench')),
  source_conversation_id TEXT,
  source_message_id      TEXT NOT NULL CHECK (length(trim(source_message_id)) > 0),
  task_type              TEXT NOT NULL DEFAULT 'other'
      CHECK (task_type IN ('code', 'frontend', 'document', 'research', 'other')),
  objective              TEXT NOT NULL CHECK (length(trim(objective)) > 0),
  supervisor             TEXT CHECK (supervisor IS NULL OR supervisor = 'codex'),
  executor               TEXT,
  requested_model        TEXT,
  requested_cost_policy  TEXT NOT NULL DEFAULT 'unspecified' CHECK (requested_cost_policy IN ('unspecified', 'free_only')),
  observed_model         TEXT,
  project_id             INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  project_path           TEXT,
  worktree_path          TEXT,
  task_card_path         TEXT,
  status                 TEXT NOT NULL DEFAULT 'drafted'
      CHECK (status IN ('drafted', 'planning', 'ready_to_dispatch', 'dispatched', 'acknowledged',
                        'executing', 'pending_review', 'changes_requested', 'approved', 'completed',
                        'blocked', 'needs_human', 'failed', 'cancelled')),
  attempt                INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  dispatch_action_id     TEXT,
  dispatch_message_id    TEXT,
  reply_message_id       TEXT,
  review_path            TEXT,
  last_error             TEXT,
  intent_key             TEXT NOT NULL CHECK (length(trim(intent_key)) > 0),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_intent ON agent_tasks(intent_key);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_source ON agent_tasks(source, source_message_id);


CREATE INDEX IF NOT EXISTS idx_tasks_planned ON tasks(planned_date);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, trigger_at);
-- 注意：idx_reminders_retry 不在这里建。它依赖的 delivery_status / next_retry_at 是后加的列，
-- 老库跑到这里时列还不存在（CREATE TABLE IF NOT EXISTS 对已存在的表是空操作）会直接报错。
-- 索引在 db.ts 的迁移之后创建。
CREATE INDEX IF NOT EXISTS idx_events_range  ON events(start_at);
CREATE INDEX IF NOT EXISTS idx_skill_usage_path ON skill_usage_events(skill_path, used_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_updated ON knowledge_archives(updated_at);
CREATE INDEX IF NOT EXISTS idx_actions_open ON assistant_actions(status, next_poll_at);
CREATE INDEX IF NOT EXISTS idx_actions_chat ON assistant_actions(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_am_session ON assistant_messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_as_updated ON assistant_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_plans_session ON assistant_dispatch_plans(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_plans_pending ON assistant_dispatch_plans(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_plans_payload_recent ON assistant_dispatch_plans(payload_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_items_plan ON assistant_dispatch_items(plan_id, item_order);
CREATE INDEX IF NOT EXISTS idx_dispatch_items_status ON assistant_dispatch_items(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_items_idempotency_recent ON assistant_dispatch_items(idempotency_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_targets_item ON assistant_dispatch_targets(dispatch_item_id, mention_order);

-- ---------------------------------------------------------------------------
-- 阶段 1：自研直播知识闭环（docs/knowledge-phase1-handoff.md 第五节为唯一契约，
-- server/verify-db-migration.mts 的 EXPECTED_NEW_* 登记了同样的预期结构，两边必须同步改）
-- ---------------------------------------------------------------------------

-- 资料的稳定身份。source_key 在所有设备上相同，避免同一云文档被重复导入。
-- P0 错误契约（docs/knowledge-phase1_5-topics-redesign.md 3.2/3.7）：
-- last_fetch_status 是「最近一次抓取结果」，body_status 是「当前可用正文质量」，两维度独立。
-- content_origin 标记正文来源：fetch=连接器抓取，manual=用户手动补正文/手动新建。
CREATE TABLE IF NOT EXISTS source_documents (
  source_key       TEXT PRIMARY KEY,
  provider         TEXT NOT NULL CHECK (provider IN ('feishu','dingtalk','url','local','conversation')),
  external_id      TEXT NOT NULL,
  space            TEXT,
  path             TEXT,
  title            TEXT NOT NULL DEFAULT '',
  canonical_url    TEXT,
  document_type    TEXT NOT NULL DEFAULT 'other'
                   CHECK (document_type IN ('prd','version','manual','governance','research','data','plan','ops','other')),
  source_version   TEXT,
  content          TEXT NOT NULL DEFAULT '',
  content_hash     TEXT,
  normalizer_version TEXT NOT NULL DEFAULT 'content-normalizer-v1',
  body_status      TEXT NOT NULL DEFAULT 'pending'
                   CHECK (body_status IN ('pending','fetched','suspect','failed')),
  fetch_error      TEXT,
  last_fetch_status TEXT CHECK (last_fetch_status IN ('ok','failed')),
  fetch_error_code  TEXT,
  fetch_error_retryable INTEGER CHECK (fetch_error_retryable IN (0,1)),
  content_origin   TEXT NOT NULL DEFAULT 'fetch' CHECK (content_origin IN ('fetch','manual')),
  source_nature   TEXT NOT NULL DEFAULT 'source' CHECK (source_nature IN ('source','agent_derived')),
  fetch_attempts   INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  TEXT,
  fetched_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  deleted_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_documents_provider_external
  ON source_documents(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_source_documents_status
  ON source_documents(body_status, updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS source_documents_fts USING fts5(
  title, content,
  content='source_documents', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS source_documents_ai AFTER INSERT ON source_documents BEGIN
  INSERT INTO source_documents_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS source_documents_ad AFTER DELETE ON source_documents BEGIN
  INSERT INTO source_documents_fts(source_documents_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS source_documents_au AFTER UPDATE OF title, content ON source_documents BEGIN
  INSERT INTO source_documents_fts(source_documents_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO source_documents_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

CREATE TABLE IF NOT EXISTS topics (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE,
  summary     TEXT NOT NULL DEFAULT '',
  scope_text  TEXT NOT NULL DEFAULT '',
  focus_questions_json TEXT NOT NULL DEFAULT '[]',
  auto_overview TEXT NOT NULL DEFAULT '',
  auto_overview_fingerprint TEXT,
  manual_notes TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  deleted_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_name
  ON topics(name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS topic_members (
  id            INTEGER PRIMARY KEY,
  topic_id      INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  document_key  TEXT NOT NULL REFERENCES source_documents(source_key) ON DELETE CASCADE,
  origin        TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','ai')),
  state         TEXT NOT NULL DEFAULT 'confirmed' CHECK (state IN ('suggested','confirmed','rejected')),
  confirmed_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  UNIQUE(topic_id, document_key)
);

-- 人工边界与自动计算分开：自动重算只改 auto_*，永不覆盖人工排除/固定。
CREATE TABLE IF NOT EXISTS topic_member_overrides (
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  document_key TEXT NOT NULL REFERENCES source_documents(source_key) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('include','exclude')),
  updated_at TEXT NOT NULL, PRIMARY KEY(topic_id,document_key)
);
CREATE TABLE IF NOT EXISTS topic_analysis_runs (
  id INTEGER PRIMARY KEY, topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('discovery','understanding')),
  input_fingerprint TEXT NOT NULL, input_versions_json TEXT NOT NULL DEFAULT '[]',
  covered_versions_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK (status IN ('running','published','stale','failed')),
  result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_analysis_runs_topic ON topic_analysis_runs(topic_id,kind,updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id          INTEGER PRIMARY KEY,
  topic_id    INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  statement   TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'conclusion'
              CHECK (kind IN ('conclusion','rule','decision','method','data','experience')),
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','deprecated','disputed')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_evidence (
  id               INTEGER PRIMARY KEY,
  knowledge_id     INTEGER NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  document_key     TEXT NOT NULL REFERENCES source_documents(source_key) ON DELETE CASCADE,
  quote_text       TEXT NOT NULL,
  quote_prefix     TEXT NOT NULL DEFAULT '',
  quote_suffix     TEXT NOT NULL DEFAULT '',
  anchor_from      INTEGER NOT NULL,
  anchor_to        INTEGER NOT NULL,
  anchor_basis     TEXT NOT NULL DEFAULT 'tiptap-pm-v1',
  source_version   TEXT,
  doc_hash_at_ref  TEXT NOT NULL,
  drift_state      TEXT NOT NULL DEFAULT 'ok'
                   CHECK (drift_state IN ('ok','changed','missing')),
  checked_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_knowledge
  ON knowledge_evidence(knowledge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_document
  ON knowledge_evidence(document_key);

-- 知识库生命周期任务只保存本机执行事实；资料身份仍由 source_documents 承担。
CREATE TABLE IF NOT EXISTS knowledge_import_batches (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','paused','completed','partial','failed')),
  discovered_count INTEGER NOT NULL DEFAULT 0, completed_count INTEGER NOT NULL DEFAULT 0,
  usable_count INTEGER NOT NULL DEFAULT 0, incomplete_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0,
  auto_organization_status TEXT NOT NULL DEFAULT 'pending' CHECK (auto_organization_status IN ('pending','running','completed','failed')),
  auto_organization_error TEXT,
  auto_organization_authorized INTEGER NOT NULL DEFAULT 0 CHECK (auto_organization_authorized IN (0,1)),
  auto_organization_destination_hash TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS knowledge_import_items (
  id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES knowledge_import_batches(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL, source_reference TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', canonical_url TEXT, source_path TEXT,
  document_type TEXT NOT NULL DEFAULT 'other', source_type TEXT, status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0, round_attempts INTEGER NOT NULL DEFAULT 0, retry_round INTEGER NOT NULL DEFAULT 0,
  error_code TEXT, error_message TEXT, retryable INTEGER,
  claimed_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(batch_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_import_items_claim
  ON knowledge_import_items(batch_id, status, updated_at);

-- 来源身份与正文版本分离。远程刷新永远追加版本；source_documents.content 是当前展示版本。
CREATE TABLE IF NOT EXISTS source_document_versions (
  id INTEGER PRIMARY KEY, document_key TEXT NOT NULL REFERENCES source_documents(source_key) ON DELETE CASCADE,
  version_no INTEGER NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('remote','manual','agent')),
  source_version TEXT, is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_document_versions_current
  ON source_document_versions(document_key) WHERE is_current=1;
CREATE TABLE IF NOT EXISTS source_document_chunks (
  id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES source_document_versions(id) ON DELETE CASCADE,
  document_key TEXT NOT NULL REFERENCES source_documents(source_key) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL, heading_path TEXT NOT NULL DEFAULT '',
  anchor_from INTEGER NOT NULL, anchor_to INTEGER NOT NULL, content TEXT NOT NULL,
  content_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(version_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_source_document_chunks_document ON source_document_chunks(document_key, version_id);
CREATE VIRTUAL TABLE IF NOT EXISTS source_document_chunks_fts USING fts5(
  heading_path, content, document_key UNINDEXED, version_id UNINDEXED, chunk_index UNINDEXED, tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS source_document_chunks_ai AFTER INSERT ON source_document_chunks BEGIN
  INSERT INTO source_document_chunks_fts(rowid,heading_path,content,document_key,version_id,chunk_index)
  VALUES(new.id,new.heading_path,new.content,new.document_key,new.version_id,new.chunk_index);
END;
CREATE TRIGGER IF NOT EXISTS source_document_chunks_ad AFTER DELETE ON source_document_chunks BEGIN
  DELETE FROM source_document_chunks_fts WHERE rowid=old.id;
END;

CREATE TABLE IF NOT EXISTS topic_candidates (
  id INTEGER PRIMARY KEY, input_hash TEXT NOT NULL, input_snapshot_json TEXT NOT NULL DEFAULT '{}', name TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
  summary_draft TEXT NOT NULL DEFAULT '', member_keys_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','ignored')),
  accepted_topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_candidates_input_name ON topic_candidates(input_hash, name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS topic_candidate_runs (
  input_hash TEXT PRIMARY KEY, rule_version TEXT NOT NULL, input_snapshot_json TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 统一标签池（docs/knowledge-tags-unified-pool.md）。
-- 自动（origin='ai'）与手动（'user'）标签同池不分家；手记的 tags JSON 列仍是手记侧存储，
-- 全局改名/删除由服务层同时波及两张载体。tags 是全局名字登记表（NOCASE 唯一），
-- 全局删除走软删：deleted_at 是「这名字别再自动打」的记忆，手动重新使用同名会复活该行。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE,
  origin      TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','ai')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  deleted_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(name) WHERE deleted_at IS NULL;

-- 资料↔标签关联。state='rejected' 表示用户从这篇资料上移除过：自动打标永不再加回；
-- 手动添加一律 origin='user'、state='active'，优先级永远高于自动结果，自动重跑不覆盖。
CREATE TABLE IF NOT EXISTS source_document_tags (
  id           INTEGER PRIMARY KEY,
  tag_id       INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  document_key TEXT NOT NULL REFERENCES source_documents(source_key) ON DELETE CASCADE,
  origin       TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','ai')),
  state        TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','rejected')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  UNIQUE(tag_id, document_key)
);
CREATE INDEX IF NOT EXISTS idx_source_document_tags_document ON source_document_tags(document_key, state);
CREATE INDEX IF NOT EXISTS idx_source_document_tags_tag ON source_document_tags(tag_id, state);

CREATE TABLE IF NOT EXISTS knowledge_outputs (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, scope_kind TEXT NOT NULL,
  scope_id TEXT, source_keys_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft',
  source_versions_json TEXT NOT NULL DEFAULT '[]', coverage_json TEXT NOT NULL DEFAULT '{}',
  save_key TEXT, derived_document_key TEXT REFERENCES source_documents(source_key) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- 仅保存用户明确输入；身份不跨渠道合并，项目作用域限于会话。
CREATE TABLE IF NOT EXISTS assistant_memory (
  scope_key TEXT PRIMARY KEY,
  instructions TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
-- 记忆条目：用户明确说出的偏好/事实/执行偏好，按入口身份隔离；小精灵在对话中或面板手动写入。
-- 同 scope 同内容只保留一条（幂等），停用走 status 而不是删除，保留来源便于追溯。
CREATE TABLE IF NOT EXISTS assistant_memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'preference'
      CHECK (kind IN ('preference', 'fact', 'skill_preference', 'task_preference')),
  content TEXT NOT NULL CHECK (length(trim(content)) > 0 AND length(content) <= 600),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  source TEXT NOT NULL CHECK (source IN ('command', 'conversation', 'manual')),
  source_session TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_entries_scope ON assistant_memory_entries(scope_key, status, updated_at);

-- S19 长期执行者/模型偏好：结构化单行（scope_key='global'），与自由文本记忆分开存储；
-- 解析规则固定为 临时指定 > 长期偏好 > 默认；不支持/不可用在登记与派发时明确失败，不静默换模型。
CREATE TABLE IF NOT EXISTS agent_execution_preferences (
  scope_key TEXT PRIMARY KEY,
  executor TEXT NOT NULL,
  requested_model TEXT,
  requested_cost_policy TEXT NOT NULL DEFAULT 'unspecified' CHECK (requested_cost_policy IN ('unspecified', 'free_only')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 本地观测台账；token 数为供应商已报告部分，reported_calls 表达缺失覆盖率。
CREATE TABLE IF NOT EXISTS assistant_usage (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  model_calls INTEGER NOT NULL,
  reported_calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  cache_reported_calls INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- BEGIN AGENT EXECUTION SCHEMA
CREATE TABLE IF NOT EXISTS agent_execution_jobs (
    task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id), state TEXT NOT NULL,
    task_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, artifact_path TEXT, artifact_hash TEXT,
    review_json TEXT, error TEXT, runtime_partition TEXT NOT NULL DEFAULT 'legacy', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_execution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES agent_tasks(id),
    kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    DROP INDEX IF EXISTS agent_execution_single_running;
CREATE INDEX IF NOT EXISTS agent_execution_state ON agent_execution_jobs(state,created_at,task_id);
CREATE TABLE IF NOT EXISTS agent_execution_notifications (
    task_id TEXT PRIMARY KEY REFERENCES agent_execution_jobs(task_id), source TEXT NOT NULL,
    destination TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    message_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
-- END AGENT EXECUTION SCHEMA

-- BEGIN CONTENT EXECUTION SCHEMA
CREATE TABLE IF NOT EXISTS content_execution_jobs (
 task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id),
 state TEXT NOT NULL CHECK(state IN ('ready_to_dispatch','executing','pending_review','completed','needs_human')),
 snapshot_json TEXT NOT NULL,
 note_id INTEGER REFERENCES notes(id),
 note_content TEXT,
 artifact_path TEXT,
 artifact_hash TEXT,
 error TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DROP INDEX IF EXISTS idx_content_execution_single_active;
CREATE INDEX IF NOT EXISTS idx_content_execution_state ON content_execution_jobs(state,created_at,task_id);
-- END CONTENT EXECUTION SCHEMA

CREATE TABLE IF NOT EXISTS content_execution_notifications (
 task_id TEXT PRIMARY KEY REFERENCES content_execution_jobs(task_id), source TEXT NOT NULL,
 destination TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 message_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- 单次模型请求独立台账；后台任务不依赖入口 AsyncLocalStorage 的存活时间。
CREATE TABLE IF NOT EXISTS model_call_usage (
 id TEXT PRIMARY KEY, purpose TEXT NOT NULL, source TEXT, session_id TEXT, message_id TEXT,
 provider_host TEXT NOT NULL, requested_model TEXT NOT NULL, observed_model TEXT,
 input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
 prompt_chars INTEGER NOT NULL, tool_chars INTEGER NOT NULL, tool_count INTEGER NOT NULL,
 task_id TEXT,
 outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_call_usage_time ON model_call_usage(created_at);
CREATE TABLE IF NOT EXISTS assistant_direct_receipts (
 request_key TEXT PRIMARY KEY, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_context_segments (
 session_id TEXT PRIMARY KEY REFERENCES assistant_sessions(id) ON DELETE CASCADE,
 start_message_id INTEGER NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE
);

-- BEGIN AGENT REVIEW SCHEMA

-- 本包新增：attempt 注册（绑定现有 task + 可信 scope + 绑定目录 + provider 线程/轮次映射）
CREATE TABLE IF NOT EXISTS agent_execution_attempts (
  task_id        TEXT NOT NULL,
  attempt        INTEGER NOT NULL,
  owner          TEXT NOT NULL,
  project_scope  TEXT NOT NULL,
  executor       TEXT,
  provider       TEXT,
  thread_id      TEXT,
  turn_id        TEXT,
  bound_dir      TEXT,
  status         TEXT NOT NULL DEFAULT 'registered',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (task_id, attempt)
);

-- 本包新增：合成回执（始终 pending_review，不标任务完成）
CREATE TABLE IF NOT EXISTS agent_execution_receipts (
  event_id    TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('completion','failure')),
  result_key  TEXT NOT NULL,
  result_hash TEXT,
  result_path TEXT,
  allowed_fields_json TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (event_id),
  UNIQUE (task_id, attempt, result_key)
);

-- 本包新增：可持久化验收队列（outbox 候选）
CREATE TABLE IF NOT EXISTS agent_review_queue (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           TEXT NOT NULL,
  attempt           INTEGER NOT NULL,
  receipt_event_id  TEXT NOT NULL,
  result_key        TEXT NOT NULL,
  result_hash       TEXT,
  result_path       TEXT,
  owner             TEXT NOT NULL,
  project_scope     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','claimed','confirmed','rejected')),
  claim_owner       TEXT,
  claim_token       TEXT,
  lease_until       TEXT,
  confirmed_at      TEXT,
  reviewed_by       TEXT,
  review_result_hash TEXT,
  notified_at       TEXT,
  notify_state      TEXT,
  notify_error      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (receipt_event_id)
);
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON agent_review_queue(status, id);

-- 本包新增：验收动作审计（只追加）
CREATE TABLE IF NOT EXISTS agent_review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  token TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_events_queue ON agent_review_events(queue_id, id);

CREATE TABLE IF NOT EXISTS agent_review_budget(
 queue_id INTEGER PRIMARY KEY REFERENCES agent_review_queue(id),
 attempts INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, reason TEXT);
CREATE TABLE IF NOT EXISTS agent_review_calls (
 claim_token TEXT PRIMARY KEY, queue_id INTEGER NOT NULL REFERENCES agent_review_queue(id),
 state TEXT NOT NULL CHECK(state IN ('running','finished','unknown')),
 token_limit INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
-- END AGENT REVIEW SCHEMA

-- BEGIN AGENT REVISION SCHEMA
CREATE TABLE IF NOT EXISTS agent_task_revisions (
 owner TEXT NOT NULL, project_scope TEXT NOT NULL, request_id TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES agent_tasks(id), from_attempt INTEGER NOT NULL,
 to_attempt INTEGER NOT NULL, request_hash TEXT NOT NULL, feedback TEXT NOT NULL,
 prior_task_json TEXT NOT NULL, prior_job_json TEXT NOT NULL, prior_notification_json TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner,project_scope,request_id), UNIQUE(task_id,from_attempt));
-- END AGENT REVISION SCHEMA

-- BEGIN AGENT PROVIDER SESSION SCHEMA
CREATE TABLE IF NOT EXISTS agent_provider_sessions (
 task_id TEXT NOT NULL REFERENCES agent_tasks(id), attempt INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('execution','review')), owner TEXT NOT NULL,
 project_scope TEXT NOT NULL, project_root TEXT NOT NULL, account_scope TEXT NOT NULL,
 provider TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,attempt,role));
-- END AGENT PROVIDER SESSION SCHEMA

-- BEGIN INTERNAL TEXT CACHE SCHEMA
-- 纯文本归纳的精确缓存：只有调用方显式传入 cacheScope 才写入/读取（默认不启用）。
-- 键由完整受保护 prompt 哈希 + 目的地（baseURL/wire/model）+ 账号不可逆指纹 + scope/version 组成，
-- 只存结果正文与元数据，绝不保存密钥或原始资料。
CREATE TABLE IF NOT EXISTS internal_text_cache (
  cache_key TEXT PRIMARY KEY,
  cache_scope TEXT NOT NULL,
  prompt_version TEXT NOT NULL DEFAULT '',
  prompt_hash TEXT NOT NULL,
  destination_fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  wire TEXT NOT NULL,
  content TEXT NOT NULL,
  content_bytes INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_internal_text_cache_expiry ON internal_text_cache(expires_at);
-- 本地命中证据（缓存命中不写 model_call_usage，不伪造供应商用量）
CREATE TABLE IF NOT EXISTS internal_text_cache_hits (
  cache_key TEXT NOT NULL,
  hit_at TEXT NOT NULL,
  cache_scope TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_internal_text_cache_hits_key ON internal_text_cache_hits(cache_key);
-- END INTERNAL TEXT CACHE SCHEMA
