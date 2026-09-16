/**
 * [INPUT]: 本地 uploads 目录、既有文件同步及 LibreOffice CLI
 * [OUTPUT]: 附件存储/元信息、原文件定位和可重试的 PPT → PDF 预览队列
 * [POS]: 文件持久化与转换边界；正文只保存稳定附件链接，派生预览不改变原文件
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, mkdtemp, copyFile, rm, rename } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { dataDir } from '../db.js';
import { downloadSyncFile, queueSyncFile } from './supabase-sync.js';

export const ATTACHMENT_LIMIT = 50 * 1024 * 1024;
export const attachmentId = z.string().regex(/^[a-z0-9]+-[a-f0-9]{12}$/);
const metadata = z.object({ id: attachmentId, name: z.string(), size: z.number(), ext: z.string(), kind: z.enum(['pdf', 'slides', 'file']) });
export type Attachment = z.infer<typeof metadata>;
const directory = join(dataDir, 'uploads');
const runFile = promisify(execFile);
const pending = new Map<string, Promise<void>>();
const failures = new Set<string>();
let queue = Promise.resolve();

async function stored(name: string): Promise<string | null> {
  const path = join(directory, name);
  if (existsSync(path)) return path;
  const remote = await downloadSyncFile(name);
  if (!remote) return null;
  await mkdir(directory, { recursive: true });
  await writeFile(path, remote);
  return path;
}
export async function saveAttachment(name: string, bytes: Buffer): Promise<Attachment> {
  const id = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
  const safeName = basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) || '未命名文件';
  const ext = extname(safeName).toLowerCase();
  const isPdf = ext === '.pdf' && bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
  const isSlides = (ext === '.pptx' && bytes.subarray(0, 2).toString() === 'PK') || (ext === '.ppt' && bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')));
  const value: Attachment = { id, name: safeName, size: bytes.length, ext, kind: isPdf ? 'pdf' : isSlides ? 'slides' : 'file' };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.bin`), bytes);
  await writeFile(join(directory, `${id}.meta`), JSON.stringify(value));
  queueSyncFile(`${id}.bin`); queueSyncFile(`${id}.meta`);
  return value;
}
export async function readAttachment(id: string): Promise<Attachment | null> {
  const path = await stored(`${attachmentId.parse(id)}.meta`);
  return path ? metadata.parse(JSON.parse(await readFile(path, 'utf8'))) : null;
}
export async function originalPath(id: string) { return stored(`${attachmentId.parse(id)}.bin`); }
export async function previewPath(file: Attachment) {
  return file.kind === 'pdf' ? originalPath(file.id) : file.kind === 'slides' ? stored(`${file.id}.pdf`) : null;
}
export async function attachmentInfo(file: Attachment) {
  const preview = await previewPath(file);
  return { ...file, url: `/api/attachments/${file.id}/download`,
    previewStatus: preview ? 'ready' : pending.has(file.id) ? 'pending' : failures.has(file.id) ? 'error' : file.kind === 'slides' ? 'idle' : 'unsupported',
    previewUrl: preview ? `/api/attachments/${file.id}/preview.pdf` : null };
}
function officeCommand() {
  if (process.env.OFFICE_CONVERTER) return process.env.OFFICE_CONVERTER;
  const local = ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice',
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice')];
  return local.find(existsSync) || 'soffice';
}
async function convert(file: Attachment) {
  const original = await originalPath(file.id);
  if (!original) throw new Error('原文件不存在');
  const work = await mkdtemp(join(tmpdir(), 'workbench-preview-'));
  try {
    const input = join(work, `source${file.ext}`);
    const profile = join(work, 'profile');
    await mkdir(join(profile, 'user'), { recursive: true });
    // 独立配置避免干扰用户的 Office 会话；最高宏安全级别，不执行文档宏。
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>');
    await copyFile(original, input);
    const filter = file.ext === '.pptx' ? 'Impress MS PowerPoint 2007 XML' : 'MS PowerPoint 97';
    await runFile(officeCommand(), [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--nologo', '--norestore', `--infilter=${filter}`, '--convert-to', 'pdf:impress_pdf_Export', '--outdir', work, input], { timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const pdf = await readFile(join(work, 'source.pdf'));
    if (!pdf.subarray(0, 8).toString().startsWith('%PDF-')) throw new Error('未生成有效预览');
    // 临时文件与原文件在同一目录；原子发布防止轮询读到半个 PDF。
    const temporary = join(directory, `${file.id}.pdf-part`);
    await writeFile(temporary, pdf); await rename(temporary, join(directory, `${file.id}.pdf`));
    queueSyncFile(`${file.id}.pdf`);
  } finally { await rm(work, { recursive: true, force: true }); }
}
export async function preparePreview(file: Attachment, logError: (error: unknown) => void) {
  if (file.kind !== 'slides' || await previewPath(file) || pending.has(file.id)) return;
  if (pending.size >= 8) throw Object.assign(new Error('预览任务较多，请稍后重试'), { statusCode: 429 });
  failures.delete(file.id);
  const work = queue.then(() => convert(file)).catch((error) => {
    // 失败只影响预览；原文件和文档链接始终保留。
    failures.add(file.id); logError(error);
    if (failures.size > 200) failures.delete(failures.values().next().value!);
  }).finally(() => { pending.delete(file.id); });
  pending.set(file.id, work); queue = work;
}
