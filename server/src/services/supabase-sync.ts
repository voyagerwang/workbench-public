import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { dataDir, db, syncEntities } from '../db.js';

type SyncMode = 'seed' | 'join' | 'merge';
type RemoteRecord = {
  table_name: string;
  record_key: string;
  data: Record<string, unknown>;
  deleted: boolean;
  origin_device_id: string;
  updated_at: string;
};

const ENTITY = new Map<string, string>(syncEntities.map((item) => [item.table, item.key]));
const ENTITY_ORDER = new Map<string, number>(syncEntities.map((item, index) => [item.table, index]));
const PAGE_SIZE = 500;
const DEFAULT_INTERVAL_MS = 10_000;
const uploadsDir = join(dataDir, 'uploads');

type SyncConfig = {
  url: string;
  serviceKey: string;
  workspaceId: string;
  deviceName: string;
  intervalMs: number;
};

function config(): SyncConfig | null {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const workspaceId = process.env.SUPABASE_SYNC_WORKSPACE_ID;
  if (!url || !serviceKey || !workspaceId) return null;
  if (!/^https:\/\//.test(url)) throw new Error('SUPABASE_URL 必须是 https 地址');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
    throw new Error('SUPABASE_SYNC_WORKSPACE_ID 必须是 UUID');
  }
  const interval = Number(process.env.SUPABASE_SYNC_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  return {
    url,
    serviceKey,
    workspaceId,
    deviceName: process.env.SUPABASE_SYNC_DEVICE_NAME?.trim() || process.env.HOSTNAME || 'YZ 工作台设备',
    intervalMs: Number.isFinite(interval) ? Math.max(3_000, interval) : DEFAULT_INTERVAL_MS,
  };
}

function localState(key: string): string | undefined {
  return (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
}

function setLocalState(key: string, value: string): void {
  db.prepare(`INSERT INTO sync_state(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}

function deviceId(): string {
  const dir = join(homedir(), '.yz-workbench');
  const path = join(dir, 'device.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { id?: string };
    if (parsed.id && /^[0-9a-f-]{36}$/i.test(parsed.id)) return parsed.id;
  } catch { /* 首次运行 */ }
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  writeFileSync(path, JSON.stringify({ id }, null, 2), { mode: 0o600 });
  return id;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const cfg = config();
  if (!cfg) throw new Error('Supabase 同步尚未配置');
  const response = await fetch(`${cfg.url}${path}`, {
    ...init,
    headers: {
      apikey: cfg.serviceKey,
      // 新 sb_secret_ 密钥只放 apikey；旧 service_role 是 JWT，仍需 Bearer 才能以 service_role 执行。
      ...(cfg.serviceKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${cfg.serviceKey}` }),
      ...(init.body && !(init.body instanceof Uint8Array) && !(init.body instanceof Buffer)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 800);
    throw new Error(`Supabase ${response.status}：${detail || response.statusText}`);
  }
  return response;
}

async function registerDevice(): Promise<void> {
  const cfg = config()!;
  await request('/rest/v1/workspace_devices?on_conflict=workspace_id,device_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      workspace_id: cfg.workspaceId,
      device_id: deviceId(),
      device_name: cfg.deviceName,
      last_seen_at: new Date().toISOString(),
      app_version: '0.1.0',
    }),
  });
}

async function cloudHasRecords(): Promise<boolean> {
  const cfg = config()!;
  const query = new URLSearchParams({ select: 'record_key', workspace_id: `eq.${cfg.workspaceId}`, limit: '1' });
  const response = await request(`/rest/v1/workspace_records?${query}`);
  return ((await response.json()) as unknown[]).length > 0;
}

function queueAllLocalRows(): void {
  const stamp = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const entity of syncEntities) {
      const { table, key } = entity;
      db.prepare(`
        INSERT INTO sync_outbox(table_name, record_key, operation, queued_at, attempts, last_error)
        SELECT ?, CAST(${key} AS TEXT), 'upsert', ?, 0, NULL FROM ${table} WHERE ${'where' in entity ? entity.where : '1'}
        ON CONFLICT(table_name, record_key) DO UPDATE SET
          operation='upsert', queued_at=excluded.queued_at, attempts=0, last_error=NULL
      `).run(table, stamp);
    }
  });
  tx();
}

function queueAllFiles(): void {
  if (!existsSync(uploadsDir)) return;
  const insert = db.prepare(`INSERT INTO sync_file_outbox(name, queued_at, attempts, last_error)
    VALUES (?, ?, 0, NULL) ON CONFLICT(name) DO UPDATE SET queued_at=excluded.queued_at, attempts=0, last_error=NULL`);
  const stamp = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const name of readdirSync(uploadsDir)) {
      if (/^[a-z0-9]+-[a-f0-9]{12}\.[a-z0-9]+$/i.test(name)) insert.run(name, stamp);
    }
  });
  tx();
}

export function queueSyncFile(name: string): void {
  db.prepare(`INSERT INTO sync_file_outbox(name, queued_at, attempts, last_error)
    VALUES (?, ?, 0, NULL) ON CONFLICT(name) DO UPDATE SET queued_at=excluded.queued_at, attempts=0, last_error=NULL`)
    .run(basename(name), new Date().toISOString());
}

function readLocalRecord(table: string, key: string): Record<string, unknown> | undefined {
  const primary = ENTITY.get(table);
  if (!primary) return undefined;
  return db.prepare(`SELECT * FROM ${table} WHERE ${primary} = ?`).get(key) as Record<string, unknown> | undefined;
}

async function pushRows(): Promise<number> {
  const cfg = config()!;
  const rows = db.prepare(`SELECT table_name, record_key, operation, queued_at
    FROM sync_outbox ORDER BY queued_at LIMIT ?`).all(PAGE_SIZE) as Array<{
      table_name: string; record_key: string; operation: 'upsert' | 'delete'; queued_at: string;
    }>;
  if (!rows.length) return 0;

  const payload = rows.map((row) => {
    const data = row.operation === 'delete' ? undefined : readLocalRecord(row.table_name, row.record_key);
    return {
      workspace_id: cfg.workspaceId,
      table_name: row.table_name,
      record_key: row.record_key,
      data: data ?? {},
      deleted: row.operation === 'delete' || !data,
      origin_device_id: deviceId(),
    };
  });
  try {
    await request('/rest/v1/workspace_records?on_conflict=workspace_id,table_name,record_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload),
    });
    const remove = db.prepare('DELETE FROM sync_outbox WHERE table_name=? AND record_key=? AND queued_at=?');
    db.transaction(() => rows.forEach((row) => remove.run(row.table_name, row.record_key, row.queued_at)))();
    return rows.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fail = db.prepare(`UPDATE sync_outbox SET attempts=attempts+1, last_error=?
      WHERE table_name=? AND record_key=? AND queued_at=?`);
    db.transaction(() => rows.forEach((row) => fail.run(message, row.table_name, row.record_key, row.queued_at)))();
    throw error;
  }
}

function contentType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' } as Record<string, string>)[ext ?? '']
    ?? 'application/octet-stream';
}

async function uploadFile(name: string): Promise<void> {
  const cfg = config()!;
  const safe = basename(name);
  const local = join(uploadsDir, safe);
  if (!existsSync(local)) return;
  const objectPath = `${cfg.workspaceId}/uploads/${encodeURIComponent(safe)}`;
  await request(`/storage/v1/object/workbench-sync/${objectPath}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType(safe), 'x-upsert': 'true' },
    body: readFileSync(local),
  });
}

async function pushFiles(): Promise<number> {
  const rows = db.prepare('SELECT name, queued_at FROM sync_file_outbox ORDER BY queued_at LIMIT 20')
    .all() as Array<{ name: string; queued_at: string }>;
  let pushed = 0;
  for (const row of rows) {
    try {
      await uploadFile(row.name);
      db.prepare('DELETE FROM sync_file_outbox WHERE name=? AND queued_at=?').run(row.name, row.queued_at);
      pushed += 1;
    } catch (error) {
      db.prepare('UPDATE sync_file_outbox SET attempts=attempts+1, last_error=? WHERE name=? AND queued_at=?')
        .run(error instanceof Error ? error.message : String(error), row.name, row.queued_at);
      throw error;
    }
  }
  return pushed;
}

export async function downloadSyncFile(name: string): Promise<Buffer | null> {
  const cfg = config();
  if (!cfg || localState('supabase_initialized') !== '1') return null;
  const safe = basename(name);
  try {
    const objectPath = `${cfg.workspaceId}/uploads/${encodeURIComponent(safe)}`;
    const response = await request(`/storage/v1/object/workbench-sync/${objectPath}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.message.includes('Supabase 404')) return null;
    throw error;
  }
}

function tableColumns(table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function applyRemoteRecord(record: RemoteRecord): void {
  const primary = ENTITY.get(record.table_name);
  if (!primary) return;
  const pending = db.prepare('SELECT 1 FROM sync_outbox WHERE table_name=? AND record_key=?')
    .get(record.table_name, record.record_key);
  if (pending) return; // 本机尚未上传的修改优先，稍后推送到云端形成明确的 last-push-wins。
  if (record.deleted) {
    db.prepare(`DELETE FROM ${record.table_name} WHERE ${primary}=?`).run(record.record_key);
    return;
  }

  // 日程的本地 id 是设备内生成的，跨设备不能作为同一日程的身份；external_id 才来自
  // 日历提供方并保持稳定。省略本地 id 后按 external_id upsert，避免合并时唯一键冲突。
  if (record.table_name === 'events') {
    const columns = Object.keys(record.data).filter((column) => column !== 'id' && tableColumns('events').has(column));
    if (!columns.includes('external_id')) return;
    const update = columns.filter((column) => column !== 'external_id')
      .map((column) => `${column}=excluded.${column}`).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const conflict = update ? `DO UPDATE SET ${update}` : 'DO NOTHING';
    db.prepare(`INSERT INTO events (${columns.join(', ')}) VALUES (${placeholders})
      ON CONFLICT(external_id) ${conflict}`).run(...columns.map((column) => record.data[column]));
    return;
  }
  const allowed = tableColumns(record.table_name);
  const data = { ...record.data, [primary]: record.data[primary] ?? record.record_key };
  const columns = Object.keys(data).filter((column) => allowed.has(column));
  if (!columns.includes(primary)) return;
  const update = columns.filter((column) => column !== primary)
    .map((column) => `${column}=excluded.${column}`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const conflict = update ? `DO UPDATE SET ${update}` : 'DO NOTHING';
  db.prepare(`INSERT INTO ${record.table_name} (${columns.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(${primary}) ${conflict}`).run(...columns.map((column) => data[column]));
}

async function fetchRemote(): Promise<RemoteRecord[]> {
  const cfg = config()!;
  const cursor = localState('supabase_pull_cursor') ?? '1970-01-01T00:00:00.000Z';
  const records: RemoteRecord[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = new URLSearchParams({
      select: 'table_name,record_key,data,deleted,origin_device_id,updated_at',
      workspace_id: `eq.${cfg.workspaceId}`,
      updated_at: `gte.${cursor}`,
      order: 'updated_at.asc,table_name.asc,record_key.asc',
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    const response = await request(`/rest/v1/workspace_records?${query}`);
    const page = await response.json() as RemoteRecord[];
    records.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return records;
}

async function pullRows(): Promise<number> {
  const records = await fetchRemote();
  if (!records.length) return 0;
  const upserts = records.filter((row) => !row.deleted)
    .sort((a, b) => (ENTITY_ORDER.get(a.table_name) ?? 99) - (ENTITY_ORDER.get(b.table_name) ?? 99));
  const deletes = records.filter((row) => row.deleted)
    .sort((a, b) => (ENTITY_ORDER.get(b.table_name) ?? -1) - (ENTITY_ORDER.get(a.table_name) ?? -1));
  const tx = db.transaction(() => {
    setLocalState('applying_remote', '1');
    try {
      db.pragma('defer_foreign_keys = ON');
      for (const row of [...upserts, ...deletes]) applyRemoteRecord(row);
      const last = records.at(-1)?.updated_at;
      if (last) setLocalState('supabase_pull_cursor', last);
    } finally {
      setLocalState('applying_remote', '0');
    }
  });
  tx();
  return records.length;
}

function clearSyncedLocalData(): void {
  const tx = db.transaction(() => {
    setLocalState('applying_remote', '1');
    try {
      for (const { table } of [...syncEntities].reverse()) {
        if (table !== 'settings') db.prepare(`DELETE FROM ${table}`).run();
      }
      db.prepare('DELETE FROM sync_outbox').run();
      db.prepare('DELETE FROM sync_file_outbox').run();
    } finally {
      setLocalState('applying_remote', '0');
    }
  });
  tx();
}

let running = false;
let timer: NodeJS.Timeout | null = null;
let lastSuccessAt: string | null = null;
let lastError: string | null = null;

export async function syncNow(): Promise<{ pushed: number; pulled: number; files: number }> {
  if (!config()) throw new Error('Supabase 同步尚未配置');
  if (localState('supabase_initialized') !== '1') throw new Error('需要先选择“上传本机数据”或“加入云端工作台”');
  if (running) return { pushed: 0, pulled: 0, files: 0 };
  running = true;
  try {
    await registerDevice();
    let pushed = 0;
    while (true) {
      const count = await pushRows();
      pushed += count;
      if (count < PAGE_SIZE) break;
    }
    const pulled = await pullRows();
    const files = await pushFiles();
    lastSuccessAt = new Date().toISOString();
    lastError = null;
    return { pushed, pulled, files };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    running = false;
  }
}

export async function initializeSupabaseSync(mode: SyncMode): Promise<{ mode: SyncMode; result: Awaited<ReturnType<typeof syncNow>> }> {
  if (!config()) throw new Error('请先配置 SUPABASE_URL、SUPABASE_SECRET_KEY 和 SUPABASE_SYNC_WORKSPACE_ID');
  const remoteExists = await cloudHasRecords();
  if (mode === 'seed' && remoteExists) throw new Error('云端已经有数据，不能再次作为第一台设备上传；请使用“加入云端工作台”或“合并”');
  if (mode === 'join' && !remoteExists) throw new Error('云端还没有数据，请先在第一台电脑执行“上传本机数据”');
  if (mode === 'join') clearSyncedLocalData();
  setLocalState('supabase_pull_cursor', '1970-01-01T00:00:00.000Z');
  setLocalState('supabase_initialized', '1');
  if (mode !== 'join') {
    queueAllLocalRows();
    queueAllFiles();
  }
  const result = await syncNow();
  startSupabaseSync();
  return { mode, result };
}

export function supabaseSyncStatus() {
  const cfg = config();
  const pendingRows = (db.prepare('SELECT COUNT(*) AS count FROM sync_outbox').get() as { count: number }).count;
  const pendingFiles = (db.prepare('SELECT COUNT(*) AS count FROM sync_file_outbox').get() as { count: number }).count;
  return {
    configured: Boolean(cfg),
    initialized: localState('supabase_initialized') === '1',
    workspaceId: cfg?.workspaceId ?? null,
    deviceId: cfg ? deviceId() : null,
    deviceName: cfg?.deviceName ?? null,
    running,
    pendingRows,
    pendingFiles,
    lastSuccessAt,
    lastError,
  };
}

export function startSupabaseSync(): void {
  const cfg = config();
  if (!cfg || localState('supabase_initialized') !== '1' || timer) return;
  const run = () => void syncNow().catch((error) => console.warn('[supabase-sync]', error.message));
  run();
  timer = setInterval(run, cfg.intervalMs);
  timer.unref();
  console.log(`[supabase-sync] 已启动：每 ${Math.round(cfg.intervalMs / 1000)} 秒同步一次`);
}
