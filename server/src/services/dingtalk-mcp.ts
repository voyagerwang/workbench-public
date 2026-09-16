/**
 * [INPUT]: settings 与 Codex 中已授权的钉钉网关，dingtalk-gateway 的会话与结果校验
 * [OUTPUT]: 本人身份、同事、忙闲、会议室及日程创建/删除能力
 * [POS]: 小精灵和日历路由的钉钉业务层；创建只在收到真实日程 ID 后返回成功
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { getSetting, setSetting } from '../db.js';
import { callDingtalkTool as mcpCall, listDingtalkTools as listMcpTools } from './dingtalk-gateway.js';

const execFileAsync = promisify(execFile);

/** 无 settings 时的兜底来源（部署可注入）；本机正常走 settings，见 data/workbench.db。 */
const ENV_URL = {
  calendarUrl: 'DINGTALK_MCP_CALENDAR_URL',
  contactsUrl: 'DINGTALK_MCP_CONTACTS_URL',
} as const;

const readEnvUrl = (name: string) => (process.env[name] ?? '').trim();
const notConfigured = (what: string, env: string) =>
  new Error(`未配置钉钉${what} MCP：把 mcp-gw.dingtalk.com 链接写进 settings 表 'dingtalk_mcp'，或设环境变量 ${env}`);

export interface DingtalkMcpConfig {
  calendarUrl?: string;
  contactsUrl?: string;
}

const sanitizeUrl = (u: string) => u.replace(/[`'"\s]/g, '');

// ---------------------------------------------------------------------------
// 从 Codex 已装的钉钉 MCP 里自动取回链接
//
// 用户往往早就在 Codex 里装好了钉钉通讯录/日历 MCP，但工作台这边是另一套 settings，
// 两边不通气 —— 表现就是助手一口咬定「钉钉未配置」，可链接其实就躺在 ~/.codex 里。
// 这里按「服务器暴露了哪些工具」来分辨谁是通讯录、谁是日历，比靠名字猜可靠。
// ---------------------------------------------------------------------------

/** 通讯录 MCP 的特征工具（命中数多者胜） */
const CONTACTS_HINTS = ['search_contact_by_key_word', 'search_user_by_key_word', 'get_user_info_by_user_ids'];
/** 日历 MCP 的特征工具，与下方 mcpCall 实际调用的名字保持一致 */
const CALENDAR_HINTS = ['list_meeting_room_groups', 'query_available_meeting_room', 'query_busy_status', 'create_calendar_event'];

function codexCommand(): string {
  const configured = process.env.CODEX_CLI_PATH;
  if (configured) return configured;
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex';
  return existsSync(bundled) ? bundled : 'codex';
}

type CodexMcpEntry = { enabled?: boolean; name?: string; transport?: { url?: string } };

async function listCodexDingtalkUrls(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(codexCommand(), ['mcp', 'list', '--json'], { timeout: 20_000 });
    const parsed = JSON.parse(stdout) as CodexMcpEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item.enabled !== false)
      .map((item) => sanitizeUrl(item?.transport?.url ?? ''))
      .filter((url) => url.includes('mcp-gw.dingtalk.com'));
  } catch {
    return [];
  }
}

export type DiscoveredMcp = { calendarUrl?: string; contactsUrl?: string; probed: number };

export async function discoverDingtalkMcp(): Promise<DiscoveredMcp> {
  const urls = await listCodexDingtalkUrls();
  const found: DiscoveredMcp = { probed: urls.length };
  let bestContacts = { score: 0, url: '' };
  let bestCalendar = { score: 0, url: '' };
  for (const url of urls) {
    let tools: string[];
    try {
      tools = await listMcpTools(url);
    } catch {
      continue; // 单个服务器探测失败不影响其他
    }
    const contacts = CONTACTS_HINTS.filter((t) => tools.includes(t)).length;
    const calendar = CALENDAR_HINTS.filter((t) => tools.includes(t)).length;
    if (contacts > bestContacts.score) bestContacts = { score: contacts, url };
    if (calendar > bestCalendar.score) bestCalendar = { score: calendar, url };
  }
  if (bestContacts.url) found.contactsUrl = bestContacts.url;
  if (bestCalendar.url) found.calendarUrl = bestCalendar.url;
  return found;
}

/**
 * 未配置时自动从 Codex 取回链接并落 settings。
 * 每个进程只试一次（失败也记住），避免每次工具调用都去探测一遍网络。
 */
let autoConfigAttempted = false;

export async function ensureDingtalkMcpConfig(): Promise<DingtalkMcpConfig> {
  const current = getMcpConfig();
  if (current.calendarUrl && current.contactsUrl) return current;
  // 失败不锁死：网络/登录恢复后允许后续调用再次发现配置。
  if (autoConfigAttempted && !current.calendarUrl && !current.contactsUrl) autoConfigAttempted = false;
  autoConfigAttempted = true;
  try {
    const found = await discoverDingtalkMcp();
    if (!found.calendarUrl && !found.contactsUrl) return current;
    const merged: DingtalkMcpConfig = {
      calendarUrl: current.calendarUrl || found.calendarUrl,
      contactsUrl: current.contactsUrl || found.contactsUrl,
    };
    setSetting('dingtalk_mcp', merged);
    console.log(`[dingtalk-mcp] 已从 Codex 自动接入：日历 ${merged.calendarUrl ? '✓' : '✗'} 通讯录 ${merged.contactsUrl ? '✓' : '✗'}`);
    return merged;
  } catch (error) {
    console.warn('[dingtalk-mcp] 自动接入失败:', (error as Error).message);
    return current;
  }
}

export function getMcpConfig(): DingtalkMcpConfig {
  const cfg = getSetting<Partial<DingtalkMcpConfig>>('dingtalk_mcp') ?? {};
  const calendarUrl = sanitizeUrl(cfg.calendarUrl || readEnvUrl(ENV_URL.calendarUrl));
  const contactsUrl = sanitizeUrl(cfg.contactsUrl || readEnvUrl(ENV_URL.contactsUrl));
  return { calendarUrl, contactsUrl };
}

// 懒接入：只有缺链接时才真的去 Codex 探测一次，之后走内存标记直接返回。
async function resolveConfig(): Promise<DingtalkMcpConfig> {
  const current = getMcpConfig();
  if (current.calendarUrl && current.contactsUrl) return current;
  await ensureDingtalkMcpConfig();
  return getMcpConfig();
}

async function needCalendarUrl(): Promise<string> {
  const { calendarUrl } = await resolveConfig();
  if (!calendarUrl) throw notConfigured('日历', ENV_URL.calendarUrl);
  return calendarUrl;
}

async function needContactsUrl(): Promise<string> {
  const { contactsUrl } = await resolveConfig();
  if (!contactsUrl) throw notConfigured('通讯录', ENV_URL.contactsUrl);
  return contactsUrl;
}

export function getMcpFlag(): { calendarConfigured: boolean; contactsConfigured: boolean } {
  const { calendarUrl, contactsUrl } = getMcpConfig();
  return { calendarConfigured: Boolean(calendarUrl), contactsConfigured: Boolean(contactsUrl) };
}

// ---------- 通讯录：当前登录用户（“我”是谁） ----------
//
// 助手之所以会在「我和某某几点有空」这类问题上来回搜自己的名字，是因为它压根不知道
// 用户本人的钉钉 userId。网关是拿用户自己的凭据鉴权的，所以 get_current_user_profile
// 返回的就是用户本人，这是唯一可靠的「我」的来源。
export interface CurrentUserProfile {
  userId: string;
  name: string;
  orgName?: string;
  deptPath?: string;
  email?: string;
  title?: string;
}

/** 网关返回形态不稳定：可能是数组、套 result、或把字段藏在 orgEmployeeModel 里 */
function profileRow(payload: Record<string, unknown> | unknown[], depth = 0): Record<string, unknown> | null {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!first || typeof first !== 'object' || depth >= 3) return null;
  const obj = first as Record<string, unknown>;
  if (obj.orgEmployeeModel && typeof obj.orgEmployeeModel === 'object') {
    return obj.orgEmployeeModel as Record<string, unknown>;
  }
  if (obj.userId != null && (obj.orgUserName != null || obj.name != null)) return obj;
  for (const key of ['result', 'data', 'user', 'userProfile', 'profile', 'orgEmployeeModel']) {
    const nested = obj[key];
    if (nested && typeof nested === 'object') {
      const found = profileRow(nested as Record<string, unknown>, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const text = (v: unknown) => (v == null || v === '' ? undefined : String(v));

export async function getCurrentUserProfile(): Promise<CurrentUserProfile> {
  const contactsUrl = await needContactsUrl();
  const row = profileRow(await mcpCall(contactsUrl, 'get_current_user_profile', {}));
  if (!row?.userId) throw new Error('钉钉通讯录没有返回当前用户信息，无法确认你的身份');
  const depts = Array.isArray(row.depts) ? row.depts as Array<Record<string, unknown>> : [];
  const deptPath = depts.map((d) => text(d?.deptPathName) ?? text(d?.deptName)).filter(Boolean).join(' / ');
  return {
    userId: text(row.userId)!,
    name: text(row.orgUserName) ?? text(row.name) ?? '',
    orgName: text(row.orgName),
    deptPath: deptPath || undefined,
    email: text(row.orgEmail) ?? text(row.orgAuthEmail),
    title: text(row.title),
  };
}

const ME_SETTING = 'dingtalk_me';

/** 取「我」的身份；成功一次就缓存进 settings，之后同步读取，不必每次打网关。 */
export function cachedMyProfile(): CurrentUserProfile | null {
  const saved = getSetting<Partial<CurrentUserProfile>>(ME_SETTING) ?? {};
  return saved.userId ? (saved as CurrentUserProfile) : null;
}

let myProfileAttempted = false;

export async function ensureMyProfile(): Promise<CurrentUserProfile | null> {
  const cached = cachedMyProfile();
  if (cached) return cached;
  if (myProfileAttempted) return null;
  myProfileAttempted = true;
  try {
    const me = await getCurrentUserProfile();
    setSetting(ME_SETTING, me);
    console.log(`[dingtalk-mcp] 已确认本人身份：${me.name}（${me.userId}）`);
    return me;
  } catch (error) {
    console.warn('[dingtalk-mcp] 获取本人身份失败:', (error as Error).message);
    return null;
  }
}

// ---------- 通讯录：搜索同事 ----------
export interface Colleague {
  userId: string;
  name: string;
  title?: string;
  deptPath?: string;
}

export async function searchColleagues(keyword: string): Promise<Colleague[]> {
  const contactsUrl = await needContactsUrl();
  const kw = keyword.trim();
  if (!kw) return [];

  // 首选：好友 + 同事联合搜索（覆盖关联组织、花名/昵称，如「彭雪(繁星)」，
  // search_user_by_key_word 只搜组织内成员会漏掉这类联系人）
  try {
    const r = await mcpCall(contactsUrl, 'search_contact_by_key_word', { keyword: kw });
    const list = Array.isArray(r)
      ? r as Array<Record<string, unknown>>
      : Array.isArray((r as { result?: unknown }).result)
        ? (r as { result: Array<Record<string, unknown>> }).result
        : [];
    const mapped = list.map((item): Colleague | null => {
      const userId = String(item.userId ?? '');
      if (!userId) return null;
      return {
        userId,
        name: String(item.nick || item.name || userId),
        title: typeof item.title === 'string' ? item.title : undefined,
      };
    }).filter((u): u is Colleague => u !== null);
    if (mapped.length) return mapped;
  } catch { /* 联合搜索失败则走组织内搜索兜底 */ }

  const r = await mcpCall(contactsUrl, 'search_user_by_key_word', { keyWord: kw });
  const raw = r.userId as string[] | string | undefined;
  const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (ids.length === 0) return [];

  try {
    const detail = await mcpCall(contactsUrl, 'get_user_info_by_user_ids', { user_id_list: ids });
    // mcpCall 已解包外层 result；此处拿到的是数组本身
    const list = Array.isArray(detail)
      ? detail as Array<Record<string, unknown>>
      : Array.isArray((detail as { result?: unknown }).result)
        ? (detail as { result: Array<Record<string, unknown>> }).result
        : [];
    return list.map((item) => {
      const emp = (item.orgEmployeeModel ?? {}) as Record<string, unknown>;
      const userId = String(emp.orgUserId ?? item.orgUserId ?? '');
      const depts = Array.isArray(emp.depts) ? emp.depts as Array<Record<string, unknown>> : [];
      const deptPath = typeof depts[0]?.deptPathName === 'string' ? depts[0].deptPathName as string : undefined;
      return {
        userId,
        name: typeof emp.orgUserName === 'string' ? emp.orgUserName : userId,
        title: typeof emp.orgTitle === 'string' ? emp.orgTitle : undefined,
        deptPath,
      };
    }).filter((u) => u.userId);
  } catch {
    // 详情接口失败时兜底：只返回 userId
    return ids.map((id) => ({ userId: id, name: id }));
  }
}

// ---------- 日历：会议室 ----------
export interface MeetingRoom {
  roomId: string;
  roomName: string;
  capacity?: number;
  groupPath?: string;
}

interface RoomGroup { groupId: number; groupName: string; parentId: number }

async function listRoomGroups(calendarUrl: string): Promise<RoomGroup[]> {
  const groups: RoomGroup[] = [];
  let pageIndex = 0;
  for (;;) {
    const r = await mcpCall(calendarUrl, 'list_meeting_room_groups', { pageIndex: String(pageIndex), pageSize: '100' });
    const res = r as { groupList?: RoomGroup[]; hasMore?: boolean; nextPageIndex?: number | string };
    groups.push(...(res.groupList ?? []));
    if (!res.hasMore) break;
    pageIndex = Number(res.nextPageIndex ?? pageIndex + 100);
  }
  return groups;
}

function collectRooms(r: Record<string, unknown>, into: Map<string, MeetingRoom>): { hasMore?: boolean; nextPageIndex?: number } {
  const list = Array.isArray(r.result) ? r.result as Array<Record<string, unknown>> : [];
  for (const item of list) {
    const roomId = typeof item.roomId === 'string' ? item.roomId : '';
    const roomName = typeof item.roomName === 'string' ? item.roomName : '';
    if (!roomId || !roomName) continue;
    into.set(roomId, {
      roomId,
      roomName,
      capacity: typeof item.capacity === 'number' ? item.capacity : undefined,
      groupPath: typeof item.fullGroupPath === 'string' ? item.fullGroupPath : undefined,
    });
  }
  return {
    hasMore: r.hasMore === true,
    nextPageIndex: Number(r.nextPageIndex),
  };
}

/** 拉取一个范围（企业根 / 指定分组）内全部空闲会议室，自动翻页 */
async function queryRoomRange(calendarUrl: string, baseArgs: Record<string, unknown>, groupId: number | null, into: Map<string, MeetingRoom>): Promise<void> {
  let pageIndex = 0;
  for (let page = 0; page < 50; page += 1) { // 翻页上限，防异常死循环
    const args: Record<string, unknown> = { ...baseArgs, pageIndex: String(pageIndex), pageSize: '100' };
    if (groupId != null) args.groupId = String(groupId);
    const r = await mcpCall(calendarUrl, 'query_available_meeting_room', args);
    const { hasMore, nextPageIndex } = collectRooms(r, into);
    if (!hasMore || !Number.isFinite(nextPageIndex)) break;
    pageIndex = nextPageIndex as number;
  }
}

/** 查询 [start, end] 时间段内空闲且可预定的会议室；企业会议室超 100 间时按分组并行查询（自动翻页取全） */
export async function queryAvailableRooms(startAt: string, endAt: string, name?: string): Promise<MeetingRoom[]> {
  const calendarUrl = await needCalendarUrl();
  const startMs = new Date(startAt).getTime();
  const endMs = new Date(endAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('时间参数无效');
  }
  // 网关会拒绝「已经开始」的时间段（errorCode 400002 filterStartTime can not less current time），
  // 而这个失败会被下面的分组兜底分支吞掉，最终变成「0 间可用」——等于把查不到说成没房。
  if (startMs < Date.now() - 60_000) {
    throw new Error(`开始时间 ${startAt} 已经过去，钉钉不接受查询已开始的时间段；请换一个还没到的时间重新查询`);
  }
  const baseArgs: Record<string, unknown> = { startTime: startMs, endTime: endMs, pageSize: '100' };
  if (name) baseArgs.roomName = name;

  const merged = new Map<string, MeetingRoom>();
  let primaryFailed = false;
  try {
    await queryRoomRange(calendarUrl, baseArgs, null, merged);
  } catch {
    // 全企业查询超上限（错误码 458019）：枚举全部分组并行查询（含父分组，按 roomId 去重）
    primaryFailed = true;
  }
  if (primaryFailed) {
    const groups = await listRoomGroups(calendarUrl);
    const failures: string[] = [];
    await Promise.all(groups.map(async (g) => {
      try {
        await queryRoomRange(calendarUrl, baseArgs, g.groupId, merged);
      } catch (error) {
        failures.push((error as Error).message); // 单组失败不阻断其余分组
      }
    }));
    // 一个分组都没查成功：必须把真实原因抛出去。静默返回 0 间会让调用方（含模型）
    // 误读成「这个时段确实没会议室」，从而推荐出根本订不到的时间。
    if (!merged.size && failures.length) {
      throw new Error(`查询会议室失败：${failures[0]}`);
    }
  }
  // 排序：深圳优先，楼层从大到小，同楼层按名称
  const isSZ = (r: MeetingRoom) => /深圳/.test(`${r.groupPath ?? ''}${r.roomName}`) ? 0 : 1;
  const floorOf = (r: MeetingRoom) => {
    const m = r.roomName.match(/(\d+)\s*楼/);
    return m ? Number(m[1]) : -1;
  };
  return [...merged.values()].sort((a, b) =>
    isSZ(a) - isSZ(b)
    || floorOf(b) - floorOf(a)
    || (a.groupPath ?? '').localeCompare(b.groupPath ?? '')
    || a.roomName.localeCompare(b.roomName));
}

// ---------- 日历：忙闲查询与时间推荐 ----------

/** 把接口时间转为东八区本地 "YYYY-MM-DDTHH:mm"。接口可能返回毫秒/秒时间戳或 ISO 字符串。 */
function toLocalMinute(value: unknown): string {
  const raw = String(value ?? '').trim();
  const numeric = typeof value === 'number' ? value : (/^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN);
  let d: Date;
  if (Number.isFinite(numeric) && numeric > 0) {
    // 部分网关版本返回 Unix 秒，Date 构造器要求毫秒。
    d = new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
  } else {
    // 无时区的 ISO 值按产品约定的东八区解释，而不是随服务器 TZ 漂移。
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw)
      ? `${raw}+08:00`
      : raw;
    d = new Date(iso);
  }
  if (Number.isNaN(d.getTime())) return '';
  const china = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${china.getUTCFullYear()}-${pad(china.getUTCMonth() + 1)}-${pad(china.getUTCDate())}T${pad(china.getUTCHours())}:${pad(china.getUTCMinutes())}`;
}

function localTimeMs(value: string): number {
  const raw = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw) ? `${raw}+08:00` : raw;
  return new Date(iso).getTime();
}

function recordArray(value: unknown): Array<Record<string, unknown>> | null {
  return Array.isArray(value) && value.every((item) => item && typeof item === 'object')
    ? value as Array<Record<string, unknown>>
    : null;
}

function nestedArray(value: unknown, keys: string[], depth = 0): Array<Record<string, unknown>> | null {
  const direct = recordArray(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || depth >= 3) return null;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const found = nestedArray(obj[key], keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function busyRows(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const direct = recordArray(payload);
  if (direct) return direct;
  for (const key of ['result', 'data', 'busyStatus', 'userBusyStatus', 'users', 'items']) {
    const rows = nestedArray(payload[key], ['result', 'data', 'items', 'users', 'userBusyStatus', 'busyStatus']);
    if (rows) return rows;
  }
  throw new Error('钉钉忙闲接口返回格式无法解析，已停止判定为空闲');
}

function scheduleRows(item: Record<string, unknown>): Array<Record<string, unknown>> {
  for (const key of ['scheduleItems', 'scheduleItemList', 'schedules', 'busyPeriods', 'busyIntervals', 'items']) {
    const rows = nestedArray(item[key], ['items', 'scheduleItems', 'scheduleItemList', 'schedules', 'busyPeriods', 'busyIntervals']);
    if (rows) return rows;
  }
  return [];
}

function timeField(value: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const candidate = value[key];
    if (candidate != null && candidate !== '') {
      if (typeof candidate === 'object' && candidate) {
        const nested = candidate as Record<string, unknown>;
        return nested.timestamp ?? nested.time ?? nested.value ?? nested.dateTime ?? nested.date ?? candidate;
      }
      return candidate;
    }
  }
  return undefined;
}

export interface BusyStatus {
  userId: string;
  busy: Array<{ start: string; end: string }>; // 本地 "YYYY-MM-DDTHH:mm"
}

/** 查询一组同事在指定时段的忙闲（只返回占用时间，不含日程内容，隐私友好）；最多 20 人 */
export async function queryBusyStatus(startAt: string, endAt: string, userIds: string[]): Promise<BusyStatus[]> {
  const calendarUrl = await needCalendarUrl();
  const ids = userIds.map((id) => id.trim()).filter(Boolean).slice(0, 20);
  if (!ids.length) return [];
  const startMs = localTimeMs(startAt);
  const endMs = localTimeMs(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error('时间参数无效');
  const r = await mcpCall(calendarUrl, 'query_busy_status', { startTime: startMs, endTime: endMs, userIds: ids });
  // 网关返回形态在不同版本间有差异；无法识别时抛错，避免把未知误报为“完全空闲”。
  const list = busyRows(r);
  return list.map((item) => ({
    userId: String(item.userId ?? item.userID ?? item.user_id ?? item.userid ?? item.attendeeUserId ?? item.id ?? ''),
    busy: scheduleRows(item)
      .map((s) => ({
        start: toLocalMinute(timeField(s, 'startTime', 'start_time', 'startDateTime', 'start')),
        end: toLocalMinute(timeField(s, 'endTime', 'end_time', 'endDateTime', 'end')),
      }))
      .filter((s) => s.start && s.end && s.start < s.end),
  }));
}

export interface SuggestedTime { start: string; end: string; conflicts: string[] }

/** 根据参与人闲忙推荐会议时间；conflicts 为该时段有时间冲突的 userId */
export async function suggestEventTimes(startAt: string, endAt: string, userIds: string[], durationMinutes: number): Promise<SuggestedTime[]> {
  const calendarUrl = await needCalendarUrl();
  const ids = userIds.map((id) => id.trim()).filter(Boolean).slice(0, 20);
  if (!ids.length) return [];
  const duration = Math.max(15, Math.min(480, Math.round(durationMinutes)));
  const startMs = localTimeMs(startAt);
  const endMs = localTimeMs(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error('时间参数无效');
  const busy = await queryBusyStatus(startAt, endAt, ids);
  const stepMs = 30 * 60_000;
  const results: SuggestedTime[] = [];
  // 起点先对齐到下一个整点/半点：候选窗口常常从「现在」开始（15:43 之类），
  // 直接按半小时步进会推出 15:43、16:13 这种碎时间，没人会这么约。
  // 东八区偏移正好是 30 分钟的整数倍，所以按 epoch 取模即等价于按本地时钟取模。
  const rem = startMs % stepMs;
  const first = rem === 0 ? startMs : startMs + (stepMs - rem);
  // 按半小时枚举整个候选窗口，避免钉钉推荐接口只返回前三个时段。
  for (let cursor = first; cursor + duration * 60_000 <= endMs && results.length < 200; cursor += stepMs) {
    const slotStart = toLocalMinute(cursor);
    const slotEnd = toLocalMinute(cursor + duration * 60_000);
    if (!slotStart || !slotEnd) continue;
    const conflicts = busy.filter((person) => person.busy.some((b) => b.start < slotEnd && b.end > slotStart)).map((person) => person.userId);
    results.push({ start: slotStart, end: slotEnd, conflicts });
  }
  return results;
}

// ---------- 日历：创建日程 ----------
export interface CreateEventInput {
  title: string;
  description?: string;
  startAt: string; // YYYY-MM-DDTHH:MM（本地时间）
  endAt: string;
  attendeeUserIds: string[];
  roomId?: string;
  location?: string;
  reminderMinutes?: number | null; // null = 不提醒；undefined = 默认提前 15 分钟
}

export async function createDingtalkEvent(input: CreateEventInput): Promise<Record<string, unknown>> {
  const startMs = localTimeMs(input.startAt);
  const endMs = localTimeMs(input.endAt);
  if (!input.title.trim()) throw new Error('日程标题不能为空');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error('时间参数无效');
  const calendarUrl = await needCalendarUrl();

  const args: Record<string, unknown> = {
    summary: input.title.trim(),
    startDateTime: new Date(startMs).toISOString(),
    endDateTime: new Date(endMs).toISOString(),
    timeZone: 'Asia/Shanghai',
  };
  if (input.description?.trim()) args.description = input.description.trim();
  if (input.attendeeUserIds.length > 0) args.attendees = input.attendeeUserIds;
  if (input.roomId) args.roomIds = [input.roomId];
  if (input.location?.trim()) args.location = input.location.trim();
  if (input.reminderMinutes === null) args.reminders = [];
  else if (input.reminderMinutes != null) args.reminders = [{ minutes: input.reminderMinutes }];

  const created = await mcpCall(calendarUrl, 'create_calendar_event', args);
  const id = created.id ?? created.eventId;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('钉钉未返回日程 ID，创建结果待确认；请先查询日历，勿重复创建');
  }
  return { ...created, id };

}

// ---------------------------------------------------------------------------
// 取消 / 删除日程
//
// 网关暴露 delete_calendar_event：用 eventId 直接删除。返回 success=true 表示
// 真的删了；success=false + errorMsg "Event not exist"（errorCode 300014）表示
// id 不存在 / 已经删了——这种情况当作成功处理，不要抛错，避免重复取消时炸
// 工具链路。
//
// 网关同时还有 update_calendar_event，但有「非 confirmed 状态不允许 patch」的
// 限制（create 后短暂处于中间态时调用会被拒），改时间比较稳的做法还是
// delete + create，所以这里只接 delete，不接 update。
// ---------------------------------------------------------------------------

export interface DeleteEventInput { eventId: string }

export async function deleteDingtalkEvent(input: DeleteEventInput): Promise<{ eventId: string; status: 'deleted' | 'already_gone' }> {
  const calendarUrl = await needCalendarUrl();
  const eventId = input.eventId.trim();
  if (!eventId) throw new Error('eventId 不能为空');
  try {
    // mcpCall 已经会把 success:false 抛成 Error('Event not exist' 等)；
    // 所以走到这里就意味着网关真的删了 / 接受了请求。
    // 返回体里 result 永远是空对象，没法用 success 字段做判定。
    await mcpCall(calendarUrl, 'delete_calendar_event', { eventId });
    return { eventId, status: 'deleted' };
  } catch (error) {
    const msg = String((error as Error)?.message ?? '');
    // 重复取消 / id 不存在 → 幂等成功
    if (/not\s*exist|已经删除|300014/i.test(msg)) return { eventId, status: 'already_gone' };
    throw error;
  }
}
