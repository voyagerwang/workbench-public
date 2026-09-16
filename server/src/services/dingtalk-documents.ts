/**
 * [INPUT]: 已按工具能力筛选的钉钉文档网关，依赖 dingtalk-gateway 的会话与业务校验
 * [OUTPUT]: 文档搜索、正文读取与知识库枚举；资源类型不匹配时返回可执行的能力提示
 * [POS]: knowledge-connectors 的钉钉文档适配器，负责节点字段和分页，不负责账号选择
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { withDingtalkGateway, unwrapDingtalkResult } from './dingtalk-gateway.js';
import type { SyncDoc } from './knowledge-connectors.js';

type Gateway = { name: string; url: string };

export async function searchDingtalkViaGateway(gateway: Gateway, query: string, limit: number): Promise<unknown> {
  return withDingtalkGateway(gateway.url, async (client) => {
    const documents: unknown[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    let hasMore = false;
    do {
      const page = unwrapDingtalkResult(await client.callTool({ name: 'search_documents', arguments: {
        ...(query.trim() ? { keyword: query.trim() } : {}),
        pageSize: Math.min(30, limit - documents.length), ...(pageToken ? { pageToken } : {}),
      } }));
      if (!Array.isArray(page.documents)) throw new Error('钉钉文档搜索未返回 documents 列表');
      documents.push(...page.documents.slice(0, limit - documents.length));
      hasMore = page.hasMore === true;
      pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : undefined;
      if (hasMore && (!pageToken || seen.has(pageToken))) throw new Error('钉钉文档分页游标缺失或重复，结果不完整');
      if (pageToken) seen.add(pageToken);
    } while (hasMore && documents.length < limit);
    return { documents, hasMore, nextPageToken: hasMore ? pageToken : undefined };
  });
}

export async function readDingtalkViaGateway(gateway: Gateway, reference: string): Promise<{ title: string; content: string }> {
  return withDingtalkGateway(gateway.url, async (client) => {
    const info = unwrapDingtalkResult(await client.callTool({ name: 'get_document_info', arguments: { nodeId: reference } }));
    const title = String(info.name || reference);
    if (info.extension && info.extension !== 'adoc') {
      const type = info.extension === 'able' ? 'AI 表格（多维表）' : info.extension === 'axls' ? '电子表格' : String(info.extension);
      throw new Error(`「${title}」是钉钉${type}，当前文档连接只能读取在线文字文档；请在设置中接入对应${type}能力。现有文档连接有效，无需重新登录文档连接`);
    }
    const parsed = unwrapDingtalkResult(await client.callTool({ name: 'get_document_content', arguments: { nodeId: reference, format: 'markdown' } }));
    const body = typeof parsed.markdown === 'string' ? parsed.markdown.trim() : '';
    if (!body) throw new Error('钉钉未返回文档正文，内容为空或尚未就绪');
    return { title, content: body };
  });
}

export async function enumerateDingtalkViaGateway(gateway: Gateway, spaceUrl: string): Promise<SyncDoc[]> {
  return withDingtalkGateway(gateway.url, async (client) => {
    const docs: SyncDoc[] = [];
    const seen = new Set<string>();
    const queue: string[] = [''];
    while (queue.length) {
      const folderId = queue.shift()!;
      const cursors = new Set<string>();
      let pageToken: string | undefined;
      do {
        const page = unwrapDingtalkResult(await client.callTool({ name: 'list_nodes', arguments: {
          workspaceId: spaceUrl, pageSize: 50, ...(folderId ? { folderId } : {}), ...(pageToken ? { pageToken } : {}),
        } }));
        if (!Array.isArray(page.nodes)) throw new Error('钉钉知识库未返回 nodes 列表');
        for (const node of page.nodes as Array<Record<string, unknown>>) {
          if (typeof node.nodeId !== 'string' || seen.has(node.nodeId)) continue;
          seen.add(node.nodeId);
          if (seen.size > 5000) throw new Error('知识库超过单次 5000 节点上限，请缩小同步范围');
          if (node.nodeType === 'folder') {
            if (node.hasChildren) queue.push(node.nodeId);
          } else {
            docs.push({ title: String(node.name || node.nodeId), reference: node.nodeId,
              url: typeof node.docUrl === 'string' ? node.docUrl : null,
              type: typeof node.extension === 'string' ? node.extension : null });
          }
        }
        pageToken = page.hasMore && typeof page.nextPageToken === 'string' ? page.nextPageToken : undefined;
        if (page.hasMore && (!pageToken || cursors.has(pageToken))) throw new Error('钉钉知识库分页游标缺失或重复，枚举不完整');
        if (pageToken) cursors.add(pageToken);
      } while (pageToken);
    }
    return docs;
  });
}
