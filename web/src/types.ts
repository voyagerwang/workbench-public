/**
 * [INPUT]: 服务端助手会话与运行态 API
 * [OUTPUT]: 共享 API 契约，含文档附件/预览状态及助手任务编号
 * [POS]: 工作台助手界面与服务端契约的接线层
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
// 与 server API 对齐的类型（列名为 snake_case，与 SQLite 一致）
export interface DocumentAttachment {
  id: string; name: string; size: number; ext: string; kind: 'pdf' | 'slides' | 'file'; url: string;
  previewStatus: 'idle' | 'pending' | 'ready' | 'error' | 'unsupported'; previewUrl: string | null;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  domain: 'work' | 'life';
  status: 'active' | 'paused' | 'archived' | 'done';
  color: string | null;
  created_at: string;
  updated_at: string;
  open_tasks?: number;
  done_tasks?: number;
  last_done_at?: string | null;
}

export interface Task {
  id: number;
  title: string;
  notes: string;
  project_id: number | null;
  status: 'todo' | 'doing' | 'done';
  priority: number; // 0 普通 / 1 重要 / 2 紧急重要
  sort_order: number | null;   // 手动拖拽排序（null = 从未排过）
  due_at: string | null;
  planned_date: string | null; // YYYY-MM-DD，进了今日清单
  remind_at: string | null;    // 任务提醒（可选）
  repeat_rule: RepeatRule;      // 完成后生成下一期任务
  detail: string;              // 详情文档（Markdown，可含图片）
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  project_name?: string | null;
  project_domain?: 'work' | 'life' | null;
}

export type FragmentType = 'task' | 'note' | 'reminder';

/** 碎片落到的目标条目（清单/笔记/提醒里的真实行） */
export interface FragmentTarget {
  module: FragmentType;
  id: number;
  title: string;
  /** 目标已不存在 */
  missing?: boolean;
  /** 目标已在回收站 */
  trashed?: boolean;
  planned_date?: string | null;
  remind_at?: string | null;
  trigger_at?: string | null;
  repeat_rule?: string | null;
  status?: string | null;
  project_name?: string | null;
}

export interface Fragment {
  id: number;
  content: string;
  /** TipTap 生成的 Markdown，与分诊用纯文本分开保存 */
  rich_content?: string;
  triaged_type: FragmentType | null;
  triaged_id: number | null;
  created_at: string;
  triaged_at: string | null;
  target: FragmentTarget | null;
}

/** 一条分诊结果（含落库后的目标信息） */
export interface CaptureItem {
  fragmentId: number;
  type: FragmentType;
  content: string;
  /** 提醒语义顺带同时进了清单 */
  dual: boolean;
  needsReview: boolean;
  confidence: number;
  target: FragmentTarget | null;
}

export interface CaptureResult {
  aiUsed: boolean;
  split: boolean;
  analysis: {
    confidence: number;
    needsReview: boolean;
    splitReason: string | null;
  } | null;
  items: CaptureItem[];
}

export type { AssistantMessage, AssistantContext, RepeatRule, AssistantDraft, AssistantActionStatus, CorrelationMethod, AssistantAction, AssistantDispatchPlanStatus, AssistantDispatchItemStatus, AssistantDispatchTarget, AssistantDispatchItem, AssistantDispatchPlan, AssistantReply, StoredAssistantMessage, AssistantSessionRecord } from './lib/assistant-contracts';
import type { RepeatRule } from './lib/assistant-contracts';

export interface ReclassifyResult {
  ok: true;
  changed: boolean;
  type: FragmentType;
  id: number;
  target: FragmentTarget | null;
  note: string | null;
}

/** 删随手记时连带处理了哪些模块条目 */
export interface FragmentDeleteResult {
  ok: true;
  removed: Array<{ module: FragmentType; id: number; title: string }>;
  kept: Array<{ module: FragmentType; id: number; title: string; reason: string }>;
}

export interface Note {
  id: number;
  title: string;
  content: string;
  tags: string[];
  source_fragment_id: number | null;
  /** 置顶：1 = 钉在列表最前。服务端排序是 pinned DESC, updated_at DESC */
  pinned: number;
  created_at: string;
  updated_at: string;
}

/** 随手记写入体。pinned 用布尔（服务端 zod 收 boolean，读回来是 0/1） */
export type NoteWrite = {
  title?: string;
  content?: string;
  tags?: string[];
  pinned?: boolean;
  /** 自动标题这类「系统代写」置 false：不刷新 updated_at，列表顺序只跟用户的编辑走 */
  touchUpdatedAt?: boolean;
};

/**
 * 标签的全局管理动作。四个动作共用一条事务接口，因为「撤销」就是反向再来一次：
 *   rename A→B 的撤销是 rename B→A；merge / remove 的撤销是 add 回原处。
 */
export type TagBatchOp =
  | { op: 'rename'; from: string; to: string }
  | { op: 'merge'; from: string; to: string }
  | { op: 'remove'; tag: string }
  | { op: 'add'; tag: string; ids: number[] };

export type TagBatchResult = { affected: number[] };

// ---------- AI 资源库 ----------
export interface SkillSummary {
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
  bySource?: Array<{ source: string; count: number }>;
}

export interface PromptItem {
  id: number;
  title: string;
  content: string;
  description: string;
  tags: string[];
  /** 导入来源集合名（如「12个常用Prompt」），只读展示，不与用户标签混用 */
  source: string;
  created_at: string;
  updated_at: string;
}
export interface SkillCaptureSaved { stage: 'saved'; id: string; name: string; path: string; action: 'create'|'update'; backup: string|null; hint: string; }
export interface SkillCaptureDraft { draftId: string; revision: number; source: { type: string; id: string; title: string; version: string; hash: string }; candidate: { name: string; description: string; content: string; kind: 'method'; validation: Record<string, boolean> }; status: 'generating'|'failed'|'cancelled'|'draft'|'saved'; error?: string|null; saved: SkillCaptureSaved|null; action: 'create'|'update'; }

// ---------- 知识存档 ----------
export interface KnowledgeArchive {
  id: number;
  title: string;
  content: string;
  source_kind: 'manual' | 'feishu' | 'dingtalk' | 'url' | 'folder' | 'conversation';
  source_url: string | null;
  file_name: string | null;
  tags: string[];
  status: 'indexed' | 'needs_auth' | 'failed' | 'remote';
  error: string | null;
  created_at: string;
  updated_at: string;
  /** 派生：云端知识空间同步出来的「一整篇链接目录」，不是落了正文的文档 */
  is_catalog: boolean;
  /**
   * 派生：非目录存档为 null。
   * - total：目录列出的篇数
   * - saved_bodies：这些篇目里本地已保存正文的篇数（目录 ∩ 本地正文，不是 provider 总数）
   * - search_available：正文检索通道当前是否可用（飞书依赖 :8792 服务）
   * 前两个是「存了几篇」，第三个是「现在能不能搜」，分开存才能表达「存了 800 篇但一篇也搜不到」。
   */
  catalog: { provider: 'feishu' | 'dingtalk'; total: number; saved_bodies: number; search_available: boolean } | null;
}

export type KnowledgeProvider = 'feishu' | 'dingtalk';

/** 知识空间同步任务进度 */
export interface KnowledgeSyncJob {
  id: string;
  provider: KnowledgeProvider;
  mode: 'index' | 'full';
  status: 'running' | 'done' | 'failed';
  total: number;
  indexed: number;
  failed: number;
  current: string | null;
  error: string | null;
  spaceHint: string | null;
  /** 人类可读标题（钉钉空间名 / 飞书空间名 / 文档名），历史列表优先展示 */
  title: string | null;
  startedAt: number;
  finishedAt?: string | null;
}

/** 知识基线状态：feishu-kb 本地快照 + 最近一次目录同步 */
export interface KnowledgeBaseline {
  snapshot: { available: boolean; docs?: number; concepts?: number; indexLoadedAt?: string | null };
  lastSync: { spaceHint: string; finishedAt: string | null } | null;
  archiveCount: number;
}

/** 飞书树形选择器的浏览分支（描述要列哪一层的子节点） */
export interface BrowseBranch {
  root: 'wiki' | 'drive';
  spaceId?: string;
  parentNodeToken?: string;
  folderToken?: string;
}

/** 飞书树形选择器里的一个节点 */
export interface BrowseNode {
  key: string;
  title: string;
  kind: 'space' | 'folder' | 'doc';
  type: string | null;
  hasChild: boolean;
  branch: BrowseBranch | null;
  /** 容器节点：被某次同步覆盖过的时间（ISO）；null = 没同步过 */
  syncedAt?: string | null;
  /** 文档叶子：本地索引里是否已有这篇 */
  indexed?: boolean;
}

/** 知识空间同步的范围：可混合勾选空间、云文档文件夹与单个文档 */
export interface KnowledgeSyncScope {
  wiki?: Array<{ spaceId: string; spaceName?: string; parentNodeToken?: string }>;
  drive?: string[];
  docs?: Array<{ reference: string; title?: string; url?: string | null; space?: string }>;
}

/** 云端文档列表条目（飞书/钉钉 CLI 或 MCP 返回后的归一化结果） */
export interface RemoteDoc {
  title: string;
  reference: string;
  url: string | null;
  type: string | null;
}

export interface KnowledgeConnectorStatus {
  codexAvailable: boolean;
  selections: Partial<Record<KnowledgeProvider, string[]>>;
  notes?: Record<string, string>;
  cliSelections?: Partial<Record<KnowledgeProvider, string>>;
  cli?: Partial<Record<KnowledgeProvider, {
    command: string | null;
    available: boolean;
    authenticated: boolean | null;
    appConfigured?: boolean | null;
    detectedAs: 'dws' | 'custom' | null;
    error: string | null;
    detail?: string | null;
  }>>;
  servers: Array<{
    name: string;
    enabled: boolean;
    transport: string;
    authStatus: string;
    urlHint?: string;
    note?: string | null;
    boundTo?: KnowledgeProvider[];
    suggestedFor: KnowledgeProvider | null;
  }>;
}

export interface KnowledgeAuthorizationJob {
  id: string;
  provider: KnowledgeProvider;
  serverName: string;
  connectorType: 'mcp' | 'cli';
  status: 'waiting' | 'authorized' | 'failed';
  stage?: 'detect' | 'install' | 'app' | 'login' | 'verify' | 'mcp';
  message?: string | null;
  authorizationUrl: string | null;
  error: string | null;
  startedAt: number;
}

export type ReminderChannel = 'auto' | 'inapp' | 'system' | 'feishu' | 'dingtalk' | 'weixin';

/** 创建/修改提醒时可写的字段，与后端 zod 契约一致 */
export type ReminderPatch = {
  message?: string;
  /** YYYY-MM-DDTHH:mm，本地时间不带时区后缀 */
  triggerAt?: string;
  status?: 'pending' | 'fired' | 'done';
  repeatRule?: RepeatRule | string;
  channel?: ReminderChannel;
  /** 完成联动提醒时顺带把关联清单项也标记完成；默认不同步（关掉提醒 ≠ 事情做完） */
  completeLinkedTask?: boolean;
};

/** 服务端投递回执：none=还没到点；pending=已发起；sent/failed；skipped=应用内等无需服务端发送的渠道 */
export type DeliveryStatus = 'none' | 'pending' | 'sent' | 'failed' | 'skipped';

export interface Reminder {
  id: number;
  message: string;
  trigger_at: string;
  repeat_rule: RepeatRule;
  status: 'pending' | 'fired' | 'done';
  /** 送达渠道：auto=系统通知兜底+已启用推送；inapp=只应用内 */
  channel?: ReminderChannel;
  fired_at: string | null;
  created_at: string;
  // ---- 送达回执 ----
  delivery_status?: DeliveryStatus;
  delivery_attempts?: number;
  /** 最后一次失败的原因摘要，成功即清空 */
  delivery_error?: string | null;
  /** 实际送达成功的渠道，逗号分隔 */
  delivered_channels?: string;
  /** 渠道不可用时的降级说明（如「飞书未配置，本次已降级为系统通知」） */
  channel_note?: string | null;
  /** 失败退避的下次重试时刻，为空代表不再自动重试 */
  next_retry_at?: string | null;
  last_delivery_at?: string | null;
  // ---- 联动任务 ----
  linked_task_id?: number | null;
  /** GET 列表 LEFT JOIN 出来的关联任务标题 */
  task_title?: string | null;
  /** 重复系列标识：同一系列的各期共享（一次性提醒为空） */
  series_id?: string | null;
}

export interface CalendarEvent {
  id: number;
  external_id: string;
  title: string;
  start_at: string;
  end_at: string | null;
  is_all_day: number;
  location: string | null;
  organizer: string | null;
  detail: string;
  synced_at: string;
}

// 钉钉创建日程（MCP）：同事与会议室
export interface Colleague {
  userId: string;
  name: string;
  title?: string;
  deptPath?: string;
}

export interface MeetingRoom {
  roomId: string;
  roomName: string;
  capacity?: number;
  groupPath?: string;
}

export interface Settings {
  dingtalk: { appKey: string; userId: string; hasSecret: boolean };
  model: {
    provider: string;
    baseUrl: string;
    model: string;
    hasApiKey: boolean;
    wireApi: 'responses' | 'chat_completions';
    reasoningEffort: string;
    assistantReasoningEffort: string;
    disableResponseStorage: boolean;
  };
  imageModel?: {
    provider: string;
    baseUrl: string;
    model: string;
    aspect: string;
    hasApiKey: boolean;
    learnedSizes?: number;
  };
  general: {
    accent?: string;
    theme?: 'auto' | 'light' | 'dark';
    appName?: string; // 工作台名称，默认「YZ工作台」
    appAvatar?: string; // 头像/Logo 图片 URL
    shortcut?: string; // 全局搜索快捷键，如 'mod+k'
    location?: { name: string; lat: number; lon: number; admin?: string };
  };
  mood?: { enabled: boolean; tone: MoodTone; ai: boolean; whisper: boolean; character: MoodCharacter; name: string };
  notify?: {
    prefix: string;
    pushReminders: boolean;
    defaultChannel?: 'auto' | 'inapp' | 'system' | 'feishu' | 'dingtalk' | 'weixin';
    weixinEnabled?: boolean;
    systemSupported?: boolean;
    dingtalk: NotifyChannelStatus;
    feishu: NotifyChannelStatus;
  };
  feishuBot?: { configured: boolean; appId: string; hasSecret: boolean; hasVerificationToken: boolean; hasEncryptKey: boolean; callbackPath: string };
}

/** 推送通道状态：服务端不回传 webhook 与密钥明文，只给「配了没有」 */
export interface NotifyChannelStatus {
  configured: boolean;
  enabled: boolean;
  hasSecret: boolean;
  hint: string;
}

export type NotifyChannelKind = 'dingtalk' | 'feishu';

export interface WeeklyReview {
  /** 所选周的周一（YYYY-MM-DD） */
  weekStart: string;
  /** 是否为「本周」，决定是否展示「一键创建下周清单」 */
  isCurrentWeek: boolean;
  stats: {
    completedTasks: number;
    workDone: number;
    lifeDone: number;
    noneDone: number;
    newNotes: number;
    newFragments: number;
    activeProjects: number;
  };
  perDay: Array<{ d: string; n: number }>;
  recentCompleted: Task[];
  nextWeekTasks: Task[];
  stagnant: Array<{
    id: number; name: string; domain: 'work' | 'life';
    open_tasks: number; last_done: string | null;
  }>;
  upcomingReminders: Reminder[];
  /** 用户编辑过的自定义段落（已去序号）。key 是 sectionIndex；缺 key 表示用自动生成 */
  overrides: Record<number, string>;
}

/** 周选择器：某年某月每一周是否有完成记录（用于弹层打点） */
export interface ReviewWeekInfo {
  weekN: number;
  weekStart: string;
  weekEnd: string;
  hasData: boolean;
}

// 回收站
export type TrashKind =
  | 'tasks' | 'projects' | 'fragments' | 'reminders'
  | 'notes' | 'knowledge' | 'prompts' | 'skills';
/** 旧命名兼容：删除 / 恢复入口仍写作 TrashType */
export type TrashType = TrashKind;
export type TrashGroupKey = 'workspace' | 'knowledge' | 'ai';
export interface TrashChip {
  label: string;
  tone: 'muted' | 'accent' | 'warn';
}
export interface TrashEntry {
  kind: TrashKind;
  id: number;
  title: string;
  /** 正文摘要，卡片上直接回显 */
  preview: string;
  /** 正文字数，0 = 没有可展开的正文 */
  chars: number;
  chips: TrashChip[];
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string;
  expandable: boolean;
}
export interface TrashData {
  retainDays: number;
  total: number;
  counts: Partial<Record<TrashKind, number>>;
  categories: Array<{
    key: TrashGroupKey;
    label: string;
    kinds: Array<{ kind: TrashKind; label: string; count: number }>;
  }>;
  items: TrashEntry[];
}
export interface TrashDetail {
  title: string;
  body: string;
}

// ---------- 情绪球 ----------
export type MoodKind = 'fresh' | 'calm' | 'busy' | 'heavy' | 'cozy' | 'lit' | 'low' | 'sleepy';
export type MoodTone = '温和' | '中性' | '冷淡' | '毒舌';
export type MoodCharacter = 'ball' | 'nimbo' | 'twinkle' | 'yoona';
export type MoodPulse = 'tick' | 'capture' | 'snooze' | 'delete' | 'remind' | 'idle';

export interface MoodWeather {
  code: number; label: string;
  tempC: number; feelsC: number; humidity: number; windKph: number;
  precipMm: number; cloudCover: number; rain: number; cloud: number;
  tempMax: number; tempMin: number; precipChance: number;
  valence: number; heat: boolean; cold: boolean; storm: boolean; snow: boolean;
  fetchedAt: string; stale: boolean;
}

export interface MoodSignals {
  date: string; weekday: number; hour: number; minuteOfDay: number;
  weekend: boolean; night: boolean;
  open: number; done: number; doneRatio: number; overdue: number; urgent: number;
  events: number; ongoing: boolean; nextInMin: number | null; backToBack: number;
  freeBlockMin: number; reminders: number; nextReminderInMin: number | null;
  fragmentsToday: number; streak: number; gapHours: number; stagnant: number; empty: boolean;
}

export interface MoodSnapshot {
  ok: true;
  at: string;
  dayKey: string;
  kind: MoodKind;
  label: string;
  valence: number;
  arousal: number;
  quiet: boolean;
  line: string;
  lineId: string;
  rare: string | null;
  tone: MoodTone;
  whisper: boolean;
  ai: boolean;
  aiLine: string | null;
  location: { name: string; lat: number; lon: number; admin?: string } | null;
  weather: MoodWeather | null;
  solar: {
    altitudeDeg: number | null; daylight: number;
    sunrise: string | null; sunset: string | null;
    minutesToSunEvent: number | null; sunEventKind: 'rise' | 'set' | null;
    termToday: string | null; termNext: { name: string; days: number } | null;
    moon: { name: string; illuminated: number };
  };
  signals: MoodSignals;
  palette: { h: number; s: number; l: number; glow: number; rim: number; dim: number };
  motion: { breathSec: number; filmSec: number };
  face: { eyesPath: string; mouthPath: string; pupil: boolean };
  whispers: Record<MoodPulse, string[]>;
  config: { enabled: boolean; tone: MoodTone; ai: boolean; whisper: boolean; character: MoodCharacter; name: string };
  status: { configured: boolean; location: MoodSnapshot['location']; cached: boolean; fresh: boolean; cacheAgeMin: number | null };
}

// ---------------------------------------------------------------------------
// 阶段 1 三层知识模型（docs/knowledge-phase1-handoff.md）
// ---------------------------------------------------------------------------

export type SourceDocumentBodyStatus = 'pending' | 'fetched' | 'suspect' | 'failed';
export type KnowledgeItemKind = 'conclusion' | 'rule' | 'decision' | 'method' | 'data' | 'experience';
export type EvidenceDriftState = 'ok' | 'changed' | 'missing';

export type KnowledgeTopic = {
  id: number;
  name: string;
  summary: string;
  document_count: number;
  knowledge_count: number;
  created_at: string;
  updated_at: string;
  scope_text?: string;
  focus_questions_json?: string;
  auto_overview?: string;
  auto_overview_fingerprint?: string | null;
  manual_notes?: string;
  auto_organization_status?: string;
  auto_organization_authorized?: number;
};

export type SourceDocumentSummary = {
  source_key: string;
  title: string;
  canonical_url: string | null;
  document_type: string;
  source_version: string | null;
  body_status: SourceDocumentBodyStatus;
  fetch_error: string | null;
  fetched_at: string | null;
  updated_at: string;
  member_since: string;
  /** P0 错误契约 / 手动通道（docs/knowledge-phase1_5-topics-redesign.md 3.2/3.7） */
  last_fetch_status?: 'ok' | 'failed' | null;
  fetch_error_code?: string | null;
  fetch_error_retryable?: 0 | 1 | null;
  content_origin?: 'fetch' | 'manual';
  origin?: 'auto' | 'manual';
  member_decision?: 'include' | 'exclude' | null;
  version_id?: number | null;
  version_no?: number | null;
  version_hash?: string | null;
};

export type TopicUnderstanding = {
  status: 'empty' | 'running' | 'published' | 'stale' | 'failed'; run_id?: string; overview?: string; error?: string;
  citations?: Array<{ document_key: string; version_id: number; claim: string; relation: string }>;
  coverage: { candidate_count: number; covered_count: number; partial: boolean };
};

export type KnowledgePoolDocument = {
  source_key: string;
  provider: string;
  title: string;
  canonical_url: string | null;
  document_type: string;
  source_version: string | null;
  body_status: SourceDocumentBodyStatus;
  fetch_error: string | null;
  last_fetch_status: 'ok' | 'failed' | null;
  fetch_error_code: string | null;
  fetch_error_retryable: 0 | 1 | null;
  content_origin: 'fetch' | 'manual';
  fetched_at: string | null;
  updated_at: string;
  topic_names: string | null;
  tag_names?: string | null;
  source_nature?: 'source' | 'agent_derived';
  derived_from?: Array<{ document_key:string; version_id:number; version_no?:number }>;
  content_preview?: string;
};

// 统一标签池（docs/knowledge-tags-unified-pool.md）：自动（ai）与手动（user）同池
export type KnowledgeTag = { name: string; origin: 'user' | 'ai'; document_count: number; note_count: number };
export type DocumentTag = { name: string; origin: 'user' | 'ai'; created_at: string };
export type TagItems = {
  documents: Array<{ source_key: string; title: string; updated_at: string }>;
  notes: Array<{ id: number; title: string }>;
};

export type KnowledgePoolData = {
  documents: KnowledgePoolDocument[];
  summary: { total: number; failed: number; untopic: number };
  page: { limit: number; offset: number; total: number };
};

export type TopicCandidate = { id:number; name:string; reason:string; summary_draft:string; member_keys_json:string; status:'pending'|'accepted'|'ignored'; accepted_topic_id:number|null; member_documents?:Array<{source_key:string;title:string;canonical_url:string|null;body_status:string;provider:string}> };

export type KnowledgeImportStatus = 'draft' | 'running' | 'paused' | 'completed' | 'partial' | 'failed';
export type KnowledgeImportItemStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type KnowledgeImportBatch = {
  id: string; provider: 'feishu' | 'dingtalk'; status: KnowledgeImportStatus;
  discovered_count: number; completed_count: number; usable_count: number; incomplete_count: number; failed_count: number; skipped_count: number;
  created_at: string; updated_at: string; finished_at?: string | null;
  auto_organization_status?: 'pending'|'running'|'completed'|'partial'|'failed';
  auto_organization_authorized?: 0|1;
  auto_organization_error?: string|null;
};
export type KnowledgeImportItem = {
  id: string; source_key: string; source_reference: string; title: string; canonical_url: string | null;
  source_path: string | null; source_type: string | null; status: KnowledgeImportItemStatus;
  attempts: number; error_code: string | null; error_message: string | null; retryable: 0 | 1 | null; updated_at: string;
  body_status?: SourceDocumentBodyStatus | null;
};
export type KnowledgeImportBatchDetail = { batch: KnowledgeImportBatch; items: KnowledgeImportItem[] };
export type KnowledgeDocumentSearchHit = {
  document_key: string; version_id: number; version_no: number; content_hash: string;
  chunk_index: number; heading_path: string | null; anchor_from: number; anchor_to: number;
  snippet: string; title: string; canonical_url: string | null;
};
export type KnowledgeDocumentVersion = {
  id: number; document_key: string; version_no: number; content_hash: string; title: string;
  content?: string; created_at: string; source_version?: string | null;
  range?: { from:number; to:number; total:number; truncated:boolean };
  derived_from?: Array<{ document_key:string; version_id:number; version_no?:number }>;
};
export type AgentTaskUsage = {
  taskId: string;
  attempts: Array<{ stage: 'execution' | 'review'; attempt: number; requestedModel: string | null; observedModel: string | null; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reported: boolean }>;
  totals: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reportedAttempts: number; unknownAttempts: number };
  reviewCalls: Array<{ state: string; tokenLimit: number | null; inputTokens: number | null; outputTokens: number | null; reported: boolean }>;
  known: boolean;
};

export type KnowledgeOutput = {
  id: number; title: string; content: string; scope_kind: string; scope_id: string | null;
  source_keys_json: string; source_versions_json?: string; coverage_json?: string; status: string; created_at: string; updated_at: string;
};

export type KnowledgeEvidenceSummary = {
  id: number;
  knowledge_id: number;
  document_key: string;
  quote_text: string;
  drift_state: EvidenceDriftState;
  checked_at: string | null;
  source_title: string | null;
  source_body_status?: SourceDocumentBodyStatus;
};

export type KnowledgeItem = {
  id: number;
  statement: string;
  kind: KnowledgeItemKind;
  status: 'active' | 'deprecated' | 'disputed';
  created_at: string;
  updated_at: string;
};

export type TopicDetail = {
  topic: KnowledgeTopic;
  documents: SourceDocumentSummary[];
  knowledge: KnowledgeItem[];
  evidence: KnowledgeEvidenceSummary[];
  deletedKnowledge: KnowledgeItem[];
  inactiveKnowledge: KnowledgeItem[];
};

export type SourceDocumentDetail = {
  source_key: string;
  provider: string;
  external_id: string;
  title: string;
  canonical_url: string | null;
  document_type: string;
  source_version: string | null;
  content: string;
  content_hash: string | null;
  body_status: SourceDocumentBodyStatus;
  fetch_error: string | null;
  fetch_attempts: number;
  fetched_at: string | null;
  updated_at: string;
  source_nature?: 'source' | 'agent_derived';
  derived_from?: Array<{ document_key:string; version_id:number; version_no?:number }>;
  tags?: DocumentTag[];
  topic_names?: string | null;
};

export type DocumentEvidence = {
  id: number;
  knowledge_id: number;
  topic_id: number | null;
  quote_text: string;
  quote_prefix: string;
  quote_suffix: string;
  anchor_from: number;
  anchor_to: number;
  anchor_basis: string;
  doc_hash_at_ref: string;
  drift_state: EvidenceDriftState;
  statement: string;
};
