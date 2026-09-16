// 标签的全局管理：重命名 / 合并 / 删除。
//
// 和 TagPicker 的区别：TagPicker 管的是「这一条笔记带哪些标签」，这里管的是
// 「标签池里有没有这个名字」。动作会波及所有带它的笔记，所以每个动作都遵循：
//   先报数（影响几条）→ 确认才执行 → 做完后给一次撤销
//
// 撤销的实现是「反向操作」而不是快照回滚：改名就反向改名，合并/删除就把标签
// add 回受影响的那批笔记 id。服务端返回 affected 就是给撤销用的。
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, GitMerge, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Dialog, DialogContent } from '@/ui/dialog';
import { Input } from '@/ui/form';
import { Button } from '@/ui/button';
import { MenuButton, type MenuItem } from '@/ui/menu';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { exactTagMatch, invertTagOp, normalizeTag, tagKey, tagMatches } from '@/lib/tags';
import type { TagBatchOp } from '@/types';

export type TagAction = 'rename' | 'merge' | 'remove';

const ACTION_LABEL: Record<TagAction, string> = {
  rename: '重命名标签',
  merge: '合并到另一个标签',
  remove: '删除标签',
};

export type TagManagerProps = {
  /** 库里已有的全部标签（已规范化） */
  allTags: string[];
  counts: Record<string, number>;
  /** 操作完成后通知外部刷新/清理筛选 */
  onDone?: (op: TagBatchOp, affected: number[]) => void;
};

/**
 * 标签管理入口 + 弹窗。内部自带执行、toast 撤销和缓存失效，
 * 外部只要把它挂到标签行上、并把当前操作的标签传进来。
 */
export function useTagManager({ allTags, counts, onDone }: TagManagerProps) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<{ action: TagAction; tag: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (op: TagBatchOp, doneText: string) => {
    setBusy(true);
    try {
      const res = await api.tagBatch(op);
      await qc.invalidateQueries({ queryKey: ['notes'] });
      const undo = invertTagOp(op, res.affected);
      toast.success(doneText, {
        description: res.affected.length
          ? `${res.affected.length} 条随手记已更新`
          : '没有随手记用到这个标签',
        action: undo
          ? {
            label: '撤销',
            onClick: () => {
              api.tagBatch(undo)
                .then(() => {
                  qc.invalidateQueries({ queryKey: ['notes'] });
                  toast.success('已撤销');
                  onDone?.(undo, res.affected);
                })
                .catch((e: Error) => toast.error(`撤销失败：${e.message}`));
            },
          }
          : undefined,
      });
      onDone?.(op, res.affected);
      setPending(null);
    } catch (error) {
      toast.error((error as Error).message || '操作失败，标签没有改动');
    } finally {
      setBusy(false);
    }
  };

  const menu = (tag: string): MenuItem[] => ([
    { key: 'rename', label: '重命名', hint: `${counts[tag] ?? 0}`, onSelect: () => setPending({ action: 'rename', tag }) },
    { key: 'merge', label: '合并到…', onSelect: () => setPending({ action: 'merge', tag }) },
    {
      key: 'remove',
      label: '删除标签',
      tone: 'danger',
      onSelect: () => setPending({ action: 'remove', tag }),
    },
  ]);

  const dialog = pending ? (
    <TagActionDialog
      action={pending.action}
      tag={pending.tag}
      allTags={allTags}
      counts={counts}
      busy={busy}
      onClose={() => setPending(null)}
      onConfirm={(op, doneText) => void run(op, doneText)}
    />
  ) : null;

  return { menu, dialog, open: (action: TagAction, tag: string) => setPending({ action, tag }) };
}

/** 每个标签行右侧的「⋯」入口 */
export function TagRowMenu({ items, title = '管理标签' }: { items: MenuItem[]; title?: string }) {
  return (
    <MenuButton
      title={title}
      width={168}
      items={items}
      className="shrink-0 rounded-md p-1 text-ink-4 opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover/tagrow:opacity-100"
    >
      <MoreHorizontal className="size-3.5" />
    </MenuButton>
  );
}

function TagActionDialog({ action, tag, allTags, counts, busy, onClose, onConfirm }: {
  action: TagAction;
  tag: string;
  allTags: string[];
  counts: Record<string, number>;
  busy: boolean;
  onClose: () => void;
  onConfirm: (op: TagBatchOp, doneText: string) => void;
}) {
  const count = counts[tag] ?? 0;
  const [name, setName] = useState(tag);
  const [target, setTarget] = useState('');

  // 重命名撞上已存在的标签：服务端会 409，这里提前拦下来并指去用合并
  const conflict = useMemo(() => {
    if (action !== 'rename') return null;
    const next = normalizeTag(name);
    if (!next || tagKey(next) === tagKey(tag)) return null;
    return exactTagMatch(allTags.filter((t) => tagKey(t) !== tagKey(tag)), next);
  }, [action, name, tag, allTags]);

  const cleaned = normalizeTag(name);
  const nameValid = action === 'rename' && Boolean(cleaned) && !conflict && tagKey(cleaned) !== tagKey(tag);
  const targetValid = action === 'merge' && Boolean(normalizeTag(target));
  const canSubmit = action === 'remove' ? true : (nameValid || targetValid);

  const submit = () => {
    if (action === 'rename') onConfirm({ op: 'rename', from: tag, to: cleaned }, `已改名为「${cleaned}」`);
    else if (action === 'merge') onConfirm({ op: 'merge', from: tag, to: normalizeTag(target) }, `已合并到「${normalizeTag(target)}」`);
    else onConfirm({ op: 'remove', tag }, `已删除标签「${tag}」`);
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent title={ACTION_LABEL[action]} className="max-w-md">
        <div className="space-y-4 p-5">
          <div className="pr-6">
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink">
              {action === 'rename' && <Pencil className="size-3.5 text-ink-3" />}
              {action === 'merge' && <GitMerge className="size-3.5 text-ink-3" />}
              {action === 'remove' && <Trash2 className="size-3.5 text-danger" />}
              {ACTION_LABEL[action]}
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
              {action === 'remove'
                ? `「${tag}」会从所有随手记上摘掉，标签本身不再出现在列表里。内容不会丢。`
                : action === 'merge'
                  ? `所有带「${tag}」的随手记会改带目标标签，之后「${tag}」不再存在。`
                  : `所有带「${tag}」的随手记会一起改用新名字。`}
              <span className="ml-1 text-ink-4">当前 {count} 条随手记在用。</span>
            </p>
          </div>

          {action === 'rename' && (
            <div className="space-y-1.5">
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && nameValid && !busy) submit(); }}
                placeholder="新的标签名"
              />
              {conflict && (
                <p className="text-xs text-danger">
                  已经有「{conflict}」这个标签了。要把两个并成一个，请用「合并到…」。
                </p>
              )}
              {!conflict && cleaned && tagKey(cleaned) === tagKey(tag) && (
                <p className="text-xs text-ink-4">只改了大小写也算改名，当前写法会统一成这次输入的。</p>
              )}
            </div>
          )}

          {action === 'merge' && (
            <TargetPicker
              allTags={allTags}
              counts={counts}
              exclude={tag}
              value={target}
              onChange={setTarget}
            />
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>取消</Button>
            <Button
              variant={action === 'remove' ? 'dangerGhost' : 'primary'}
              size="sm"
              disabled={!canSubmit || busy}
              onClick={submit}
            >
              {busy ? '处理中…' : action === 'rename' ? '重命名' : action === 'merge' ? '合并' : '删除标签'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 合并的目标标签选择：可搜索、排除自己、选中打勾 */
function TargetPicker({ allTags, counts, exclude, value, onChange }: {
  allTags: string[];
  counts: Record<string, number>;
  exclude: string;
  value: string;
  onChange: (tag: string) => void;
}) {
  const [query, setQuery] = useState('');
  const candidates = useMemo(
    () => allTags
      .filter((t) => tagKey(t) !== tagKey(exclude) && tagMatches(t, query.trim()))
      .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b, 'zh-Hans-CN')),
    [allTags, counts, exclude, query],
  );

  return (
    <div className="space-y-2">
      <Input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索要合并到哪个标签"
      />
      <div className="max-h-48 overflow-y-auto rounded-lg border border-line">
        {candidates.length === 0 ? (
          <p className="px-2.5 py-3 text-center text-[11px] text-ink-4">没有匹配的标签</p>
        ) : candidates.map((t) => {
          const on = tagKey(t) === tagKey(value);
          return (
            <button
              key={t}
              type="button"
              onClick={() => onChange(t)}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
                on ? 'bg-accent-dim text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{t}</span>
              <span className="shrink-0 text-[10px] text-ink-4">{counts[t] ?? 0}</span>
              {on && <Check className="size-3 shrink-0 text-accent" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
