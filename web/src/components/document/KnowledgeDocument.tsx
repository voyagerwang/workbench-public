/**
 * [INPUT]: 资料正文、版本信息、标签池 API 与知识库正文保存 API
 * [OUTPUT]: KnowledgeDocument，将当前资料或历史版本映射到共享文档详情，附统一标签池的标签行
 * [POS]: 资料入口到 document 的薄业务适配；当前版本可编辑，历史版本只读；标签改动即时落库
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, ExternalLink, FileText, History, Library, RotateCcw, Tags } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk } from '@/lib/api';
import type { KnowledgeDocumentVersion, SourceDocumentDetail } from '@/types';
import { fmtDateTime } from '@/lib/utils';
import { hasTag } from '@/lib/tags';
import { TagPicker } from '@/components/TagPicker';
import { DocumentDetail, DocumentProperty } from './DocumentDetail';
import { useDocumentSession } from './use-document-session';
import type { DetailMode } from './DetailHost';

const STATUS: Record<string, string> = { fetched: '正文可用', suspect: '正文可能不完整', failed: '抓取失败', pending: '待补充正文' };

export function KnowledgeDocument({ document, version, topicNames, mode = 'embedded', onClose, onVersionHistory }: {
  document: SourceDocumentDetail; topicNames?: string | null; version?: KnowledgeDocumentVersion | null; mode?: DetailMode;
  onClose: () => void; onVersionHistory?: () => void;
}) {
  const qc = useQueryClient();
  const readonly = Boolean(version);
  const sourceKey = document.source_key;
  const session = useDocumentSession({
    initial: { title: version?.title ?? document.title, body: version?.content ?? document.content },
    storageKey: () => `knowledge:${sourceKey}${version ? `:version:${version.id}` : ''}`,
    persist: async (patch, value) => {
      if (readonly) return;
      if (!value.title.trim()) throw new Error('资料标题不能为空');
      const result = await api.knowledgeManualBody(sourceKey, patch.body ?? value.body,
        patch.title !== undefined ? patch.title.trim() || '未命名文档' : undefined);
      qc.setQueryData(qk.knowledgeDocument(sourceKey), (old: { document?: SourceDocumentDetail; evidence?: unknown[] } | undefined) =>
        ({ ...old, document: { ...old?.document, ...result.document, title: value.title, content: value.body } }));
      void qc.invalidateQueries({ queryKey: ['knowledge', 'pool'] });
      void qc.invalidateQueries({ queryKey: ['knowledge', 'versions', sourceKey] });
    },
  });
  // 标签池：自动与手动同池；选中候选来自全池，让资料与手记共用同一套词汇
  const poolTags = useQuery({ queryKey: qk.tags, queryFn: api.tagList, enabled: !readonly });
  const poolTagNames = useMemo(() => (poolTags.data?.tags ?? []).map((tag) => tag.name), [poolTags.data]);
  const poolTagCounts = useMemo(
    () => Object.fromEntries((poolTags.data?.tags ?? []).map((tag) => [tag.name, tag.document_count + tag.note_count])),
    [poolTags.data],
  );
  const docTags = document.tags ?? [];
  const refreshTags = () => {
    void qc.invalidateQueries({ queryKey: qk.knowledgeDocument(sourceKey) });
    void qc.invalidateQueries({ queryKey: qk.tags });
    void qc.invalidateQueries({ queryKey: ['knowledge', 'pool'] });
  };
  const addTag = async (name: string) => {
    try { await api.knowledgeDocumentTagAdd(sourceKey, name); refreshTags(); }
    catch (error) { toast.error((error as Error).message); }
  };
  const removeTag = async (name: string) => {
    try { await api.knowledgeDocumentTagRemove(sourceKey, name); refreshTags(); }
    catch (error) { toast.error((error as Error).message); }
  };
  const toggleTag = (tag: string) => { if (hasTag(docTags.map((item) => item.name), tag)) void removeTag(tag); else void addTag(tag); };
  const derived = (version ? version.derived_from : document.derived_from) ?? [];
  const providerLabel = ({ feishu: '飞书', dingtalk: '钉钉', local: '本地', url: '网页', conversation: '对话' } as Record<string, string>)[document.provider] ?? '其他来源';
  const actions = [
    ...(onVersionHistory ? [{ key: 'versions', label: '查看历史版本', onSelect: onVersionHistory }] : []),
    ...(!readonly && document.body_status === 'fetched' ? [{ key: 'autotag', label: '重新自动打标', onSelect: () => {
      void api.tagAutoRun([sourceKey], true)
        .then(() => toast.success('已排队自动打标，完成后标签会出现在标签行'))
        .catch((error: Error) => toast.error(error.message));
      // 队列异步执行（模型需要时间），稍后拉一次最新标签
      setTimeout(refreshTags, 12_000);
    } }] : []),
    ...(!readonly && document.body_status === 'failed' ? [{ key: 'retry', label: '重新抓取正文', onSelect: () => {
      void api.knowledgeDocumentRefetch(sourceKey).then(() => {
        void qc.invalidateQueries({ queryKey: qk.knowledgeDocument(sourceKey) });
        void qc.invalidateQueries({ queryKey: ['knowledge', 'pool'] });
        toast.success('重试完成');
      }).catch((error: Error) => toast.error(error.message));
    } }] : []),
  ];
  return <DocumentDetail session={session} mode={mode} label={readonly ? `历史版本 ${version?.version_no}` : '资料详情'}
    editable={!readonly} titleRequired={!readonly} onClose={onClose} actions={actions}
    context={{ kind: 'document', knowledgeSourceKey: sourceKey }}
    getAssistantIdentity={async () => ({ sessionKey: `knowledge:${sourceKey}`, context: { kind: 'document', knowledgeSourceKey: sourceKey } })}
    getLink={() => `/knowledge/documents/${encodeURIComponent(sourceKey)}${version ? `?version=${version.id}` : ''}`}
    properties={<>
      <DocumentProperty icon={FileText} label="状态"><span>{readonly ? '历史版本（只读）' : STATUS[document.body_status] ?? document.body_status}</span></DocumentProperty>
      <DocumentProperty icon={Library} label="来源"><span className="inline-flex items-center gap-2">{providerLabel}{document.canonical_url && <a href={document.canonical_url} target="_blank" rel="noreferrer" className="text-primary" onClick={(event) => event.stopPropagation()}><ExternalLink className="size-3.5" /></a>}</span></DocumentProperty>
      {/* 标签行始终提供添加入口（cm 2026-09-14）：无标签文档之前漏渲染选择器，导致没法手动加标签 */}
      <DocumentProperty icon={Tags} label="标签">
        {readonly ? <span className="text-ink-3">{docTags.length ? `#${docTags.map((tag) => tag.name).join(' #')}` : '暂无标签'}</span>
          : <div className="flex flex-wrap items-center gap-1">
            {docTags.map((tag) => <button key={tag.name} title={tag.origin === 'ai' ? '自动打标，点击移除' : '点击移除'}
              className="rounded-full border border-line px-2 py-px text-[11px] hover:text-danger" onClick={() => void removeTag(tag.name)}>
              #{tag.name} ×{tag.origin === 'ai' && <span className="ml-0.5 text-[9px] text-ink-4">自动</span>}
            </button>)}
            <TagPicker allTags={poolTagNames} counts={poolTagCounts} selected={docTags.map((tag) => tag.name)}
              placeholder="+ 添加标签" className="rounded-full border border-dashed border-line px-2 py-px text-[11px] hover:border-ink-3"
              onToggle={toggleTag} onCreate={(name) => void addTag(name)} />
          </div>}
      </DocumentProperty>
    </>}
    secondaryProperties={<>
      {(document.topic_names ?? topicNames) && <DocumentProperty icon={Library} label="主题">{document.topic_names ?? topicNames}</DocumentProperty>}
      {derived.length > 0 && <DocumentProperty icon={FileText} label="参考资料"><div className="flex flex-wrap gap-2">{derived.map((source) => <Link className="text-primary underline" key={`${source.document_key}:${source.version_id}`} to={`/knowledge/documents/${encodeURIComponent(source.document_key)}?version=${source.version_id}`}>参考版本 {source.version_no ?? source.version_id}</Link>)}</div></DocumentProperty>}
      <DocumentProperty icon={History} label="版本">{version ? `版本 ${version.version_no}` : document.source_version || '当前版本'}</DocumentProperty>
      <DocumentProperty icon={Clock3} label="更新时间">{fmtDateTime(version?.created_at ?? document.updated_at)}</DocumentProperty>
      {document.fetch_error && !readonly && <DocumentProperty icon={RotateCcw} label="抓取结果"><span className="text-danger">{document.fetch_error}</span></DocumentProperty>}
    </>} />;
}
