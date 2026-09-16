/**
 * [INPUT]: sourceKey 旧深链及 version/from/to 搜索定位参数
 * [OUTPUT]: 跳转到资料工作区内同一 KnowledgeDocument 详情宿主
 * [POS]: 兼容稳定资料链接，避免全页与资料工作区形成两套详情交互
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Navigate, useParams, useSearchParams } from 'react-router-dom';

export function KnowledgeDocumentView() {
  const { sourceKey } = useParams();
  const [params] = useSearchParams();
  const next = new URLSearchParams(params);
  next.set('doc', decodeURIComponent(sourceKey ?? ''));
  return <Navigate replace to={`/knowledge/pool?${next.toString()}`} />;
}
