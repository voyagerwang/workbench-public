/**
 * [INPUT]: 文档类型/ID 路由参数与现有查询 API
 * [OUTPUT]: DocumentView 稳定全页地址、缺失状态与业务详情接入
 * [POS]: 全页路由薄入口，填满 AppShell 剩余高度并使用共用 document 模块
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { countTags } from '@/lib/tags';
import { notifyDeleted } from '@/lib/trash';
import { NoteDocument } from '@/components/document/NoteDocument';
import { TaskDocument } from '@/components/document/TaskDocument';
import type { Note, Task } from '@/types';
import { Button } from '@/ui/button';
export function DocumentView() {
  const { kind, id: rawId } = useParams();
  const id = Number(rawId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const valid = (kind === 'note' || kind === 'task') && Number.isSafeInteger(id) && id > 0;
  const query = useQuery<Note | Task>({
    queryKey: ['document', kind, id], enabled: valid, retry: false,
    queryFn: () => kind === 'note' ? api.note(id) : api.task(id),
  });
  const { data: notes = [] } = useQuery({ queryKey: ['notes', ''], queryFn: () => api.notes(''), enabled: kind === 'note' });
  const tags = countTags(notes);
  const close = () => navigate(kind === 'note' ? '/notes' : '/');
  if (!valid || query.isError || (!query.isPending && !query.data)) return <div className="p-8 text-center">
    <p>{valid && query.error ? query.error.message : '文档不存在或已删除'}</p>
    <Button className="mt-4" onClick={close}>返回列表</Button>
  </div>;
  if (query.isPending) return <p className="p-8 text-sm text-ink-3">正在打开文档…</p>;
  return <div className="min-h-0 flex-1">
    {kind === 'note' ? <NoteDocument key={`note:${id}`} note={query.data as Note} mode="page" onClose={close}
      allTags={tags.map((tag) => tag.tag)} tagCounts={Object.fromEntries(tags.map((tag) => [tag.tag, tag.count]))} recentTags={[]}
      onDelete={async () => { await api.deleteNote(id); notifyDeleted(qc, 'notes', id); close(); }} />
      : <TaskDocument key={`task:${id}`} task={query.data as Task} mode="page" onClose={close} />}
  </div>;
}
