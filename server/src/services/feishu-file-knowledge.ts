/**
 * [INPUT]: 飞书机器人私聊收到的文件消息（message_id + file_key + 文件名）与下载产物
 * [OUTPUT]: 经 lark-cli bot 身份下载到临时目录，提取正文（txt/md 直读、docx 解压 word/document.xml），
 *           写入知识存档（insertArchive，sourceKind='manual'，fileName 记原始文件名）并返回回执；
 *           不支持的扩展名抛错，不静默丢文件
 * [POS]: YZ工作台 飞书入口的「文件→知识库」链路；与网页端 import-files 共用 insertArchive 落库口径，
 *        不打标签（主题组织交给知识 V2 生命周期）；下载 argv 固定，输出路径相对下载目录
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertArchive } from './knowledge-archive.js';
import { resolveLarkCli } from './lark-cli.js';

const execFileAsync = promisify(execFile);

export type FeishuFileIngestResult = { archiveId: number; title: string; chars: number; kind: string };

/** 事件 content（预渲染文本）里解析 <file key="..." name="...">；解析不出返回 null。 */
export function parseFileContent(content: string): { key: string; name: string } | null {
  const key = content.match(/\bkey="([^"]+)"/)?.[1];
  const name = content.match(/\bname="([^"]+)"/)?.[1];
  if (!key || !name) return null;
  return { key, name };
}

/** lark-cli 下载资源只接受相对路径：把 cwd 切到临时目录，再传纯文件名。 */
async function downloadToTemp(messageId: string, fileKey: string): Promise<{ dir: string; filePath: string }> {
  const cliPath = process.env.LARK_CLI_PATH || await resolveLarkCli();
  if (!cliPath) throw new Error('未找到 lark-cli，无法下载飞书文件');
  const dir = await mkdtemp(join(tmpdir(), 'feishu-file-'));
  await execFileAsync(cliPath, [
    'im', '+messages-resources-download',
    '--message-id', messageId,
    '--file-key', fileKey,
    '--type', 'file',
    '--as', 'bot',
    '--output', 'resource.bin',
  ], { timeout: 60_000, cwd: dir, env: process.env, maxBuffer: 1024 * 1024 });
  return { dir, filePath: join(dir, 'resource.bin') };
}

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|json|log)$/i;
const DOCX_EXTENSIONS = /\.docx$/i;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** docx 正文提取：w:p/w:br 转换行、去标签、解码实体；提取不到非空文本视为失败。 */
export async function extractDocxText(docxPath: string): Promise<string> {
  const { stdout } = await execFileAsync('unzip', ['-p', docxPath, 'word/document.xml'], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  const text = decodeXmlEntities(
    stdout
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n'),
  ).replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('docx 解压成功但提取不到正文文本');
  return text;
}

/** 按扩展名提取文本；不支持的格式抛错（提示用户改走网页端或其他格式）。 */
export async function extractDocumentText(filePath: string, displayName: string): Promise<{ text: string; kind: string }> {
  if (DOCX_EXTENSIONS.test(displayName)) return { text: await extractDocxText(filePath), kind: 'docx' };
  if (TEXT_EXTENSIONS.test(displayName)) {
    const text = (await readFile(filePath, 'utf8')).trim();
    if (!text) throw new Error('文本文件内容为空');
    return { text, kind: 'text' };
  }
  throw new Error('暂只支持 docx 与纯文本（txt/md/csv/json/log）文件入库');
}

/** 下载 + 提取 + 入档一条龙；由 feishu-bot 的入站状态机在处理文件行时调用。 */
export async function ingestFeishuFileToKnowledge(input: { messageId: string; fileKey: string; fileName: string }): Promise<FeishuFileIngestResult> {
  const { dir, filePath } = await downloadToTemp(input.messageId, input.fileKey);
  try {
    const { text, kind } = await extractDocumentText(filePath, input.fileName);
    const title = input.fileName.replace(/\.[^.]+$/, '') || input.fileName;
    const view = insertArchive({
      title, content: text, sourceKind: 'manual', sourceUrl: null,
      fileName: input.fileName, tags: [], status: 'indexed', error: null,
    });
    return { archiveId: view.id, title, chars: text.length, kind };
  } finally {
    await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
}
