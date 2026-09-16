/**
 * [INPUT]: 提醒正文、触发时间与重复规则；由调用方提供落库回调
 * [OUTPUT]: ReminderComposer 弹窗：填内容 + 选时间（+常用重复），提交后回调
 * [POS]: 文档正文插入「提醒事项」的输入面板；只收集与提交，不碰正文（正文由 DocumentEditor 负责）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RepeatRule } from '@/types';
import { Button } from '@/ui/button';
import { Dialog, DialogContent } from '@/ui/dialog';
import { DateTimePicker } from '@/ui/datetime-picker';

/** 与提醒页保持一致，只给常用项；冷门周期（每 N 天）建好后去提醒页改 */
const REPEAT_OPTIONS: Array<{ value: RepeatRule; label: string }> = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
];

const p2 = (n: number) => String(n).padStart(2, '0');

/**
 * 默认提醒时间：下一个整点。
 * 写文档时顺手加提醒，多半是「过一会儿/今天某个点提醒我」，给一个能直接确认的值比留空更省事。
 */
export function defaultTriggerAt(now = new Date()) {
  const next = new Date(now.getTime() + 60 * 60 * 1000);
  next.setMinutes(0, 0, 0);
  return `${next.getFullYear()}-${p2(next.getMonth() + 1)}-${p2(next.getDate())}T${p2(next.getHours())}:00`;
}

export function ReminderComposer({ open, onClose, onSave }: {
  open: boolean;
  onClose: () => void;
  /** 真正去建提醒。抛错时不关闭弹窗，让用户重试——静默关掉等于假装记上了 */
  onSave: (input: { message: string; triggerAt: string; repeatRule: RepeatRule }) => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [triggerAt, setTriggerAt] = useState(() => defaultTriggerAt());
  const [repeatRule, setRepeatRule] = useState<RepeatRule>('none');
  const [saving, setSaving] = useState(false);
  // 每次打开都回到干净状态：上一篇残留的正文插进这一篇会很莫名其妙
  useEffect(() => {
    if (!open) return;
    setMessage('');
    setTriggerAt(defaultTriggerAt());
    setRepeatRule('none');
  }, [open]);

  const submit = async () => {
    const text = message.trim();
    if (!text || !triggerAt || saving) return;
    setSaving(true);
    try { await onSave({ message: text, triggerAt, repeatRule }); onClose(); }
    catch { /* 失败留在弹窗里，用户改完能直接再点一次"添加" */ }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent title="添加提醒事项" className="max-w-sm">
        <div className="space-y-4 p-5">
          <p className="flex items-center gap-2 text-sm font-medium text-ink">
            <BellRing className="size-4 text-accent" />提醒事项
          </p>
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit(); }}
            autoFocus
            placeholder="提醒我做什么"
            aria-label="提醒内容"
            className="h-9 w-full rounded-md border border-line bg-surface-1 px-3 text-sm text-ink outline-none placeholder:text-ink-4 focus:border-accent"
          />
          <DateTimePicker value={triggerAt} onChange={setTriggerAt} className="h-9 w-full bg-surface-1 text-xs" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-ink-3">重复</span>
            <div className="flex items-center rounded-lg border border-line bg-surface-1 p-0.5">
              {REPEAT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={repeatRule === option.value}
                  onClick={() => setRepeatRule(option.value)}
                  className={cn(
                    'h-7 rounded-md px-2 text-[11px] font-medium transition-colors',
                    repeatRule === option.value ? 'bg-accent-dim text-accent' : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-xs leading-relaxed text-ink-4">
            到点按提醒页设置的渠道通知；正文里会留下一行条目，提醒本身存在提醒表里，之后可在提醒页改时间和重复。
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="primary" disabled={!message.trim() || !triggerAt || saving} onClick={() => void submit()}>
              {saving ? '添加中…' : '添加'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
