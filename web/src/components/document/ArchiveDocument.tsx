/**
 * [INPUT]: 普通知识存档与存档更新 API
 * [OUTPUT]: ArchiveDocument，将旧存档字段映射到共享文档详情
 * [POS]: 旧存档兼容入口；仅适配既有存储，不复制编辑器、保存队列或助手
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Clock3, FileText, Link2 } from 'lucide-react';
import { api, qk } from '@/lib/api';
import type { KnowledgeArchive } from '@/types';
import { fmtDateTime } from '@/lib/utils';
import { DocumentDetail, DocumentProperty } from './DocumentDetail';
import { useDocumentSession } from './use-document-session';

export function ArchiveDocument({ item, onClose, onDelete, authorization }: { item: KnowledgeArchive; onClose: () => void; onDelete: () => void; authorization?: ReactNode }) {
  const qc = useQueryClient();
  const session = useDocumentSession({
    initial: { title: item.title, body: item.content }, storageKey: () => `archive:${item.id}`,
    persist: async (patch) => {
      await api.updateKnowledgeArchive(item.id, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { content: patch.body } : {}),
      });
      void qc.invalidateQueries({ queryKey: qk.knowledge });
    },
  });
  return <DocumentDetail session={session} label="知识存档" onClose={onClose}
    actions={[{ key: 'delete', label: '删除文档', tone: 'danger', onSelect: async () => { await session.flush(); onDelete(); } }]}
    context={{ kind: 'document', knowledgeArchiveIds: [item.id] }}
    getAssistantIdentity={async () => ({ sessionKey: `archive:${item.id}`, context: { kind: 'document', knowledgeArchiveIds: [item.id] } })}
    getLink={() => `/knowledge/archives?archive=${item.id}`}
    properties={<DocumentProperty icon={FileText} label="状态">{item.status === 'indexed' ? '已索引' : item.status === 'needs_auth' ? '需要授权' : item.status === 'remote' ? '云端索引' : '导入失败'}</DocumentProperty>}
    secondaryProperties={<>
      {authorization}
      <DocumentProperty icon={Clock3} label="更新时间">{fmtDateTime(item.updated_at)}</DocumentProperty>
      {(item.source_url || item.file_name) && <DocumentProperty icon={Link2} label="来源">{item.source_url ? <a href={/^workbench:note:\d+$/.test(item.source_url)?`/notes?note=${item.source_url.split(':').pop()}`:item.source_url} target={/^workbench:note:\d+$/.test(item.source_url)?undefined:'_blank'} rel="noreferrer" className="text-primary">{/^workbench:note:\d+$/.test(item.source_url)?'查看来源随手记':item.source_url}</a> : item.file_name}</DocumentProperty>}
    </>} />;
}
