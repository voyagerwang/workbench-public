import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Check, Clock3, Loader2, MapPin, UserRound, X, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { CalendarEvent } from '@/types';
import { cn, fmtDateTime, fmtTime } from '@/lib/utils';
import { Dialog } from '@/ui/dialog';
import { DocumentEditor } from '@/components/DocumentEditor';

/** 日程的本地会议记录面板；外部日历字段只读，detail 独立落在本地。 */
export function MeetingDetailDialog({ event, open, onClose }: {
  event: CalendarEvent;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [detail, setDetail] = useState(event.detail ?? '');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const savedRef = useRef(event.detail ?? '');
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setDetail(event.detail ?? '');
    savedRef.current = event.detail ?? '';
    setSaveState('idle');
  }, [open, event.id]);

  const mut = useMutation({
    mutationFn: (value: string) => api.updateEvent(event.id, { detail: value, externalId: event.external_id }),
    onSuccess: (_saved, value) => {
      savedRef.current = value;
      setSaveState('saved');
      window.setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1800);
      qc.invalidateQueries({ queryKey: ['events'] });
    },
    onError: (error) => { setSaveState('idle'); toast.error(`保存失败：${(error as Error).message}`); },
  });

  const queueSave = (value: string) => {
    setDetail(value);
    if (value === savedRef.current) return;
    setSaveState('saving');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => mut.mutate(value), 700);
  };

  const flushAndClose = () => {
    window.clearTimeout(saveTimer.current);
    if (detail !== savedRef.current) mut.mutate(detail);
    onClose();
  };

  const time = event.is_all_day === 1
    ? '全天'
    : `${fmtTime(event.start_at)}${event.end_at ? ` - ${fmtTime(event.end_at)}` : ''}`;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && flushAndClose()} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className="pop-panel fixed inset-y-0 right-0 z-50 flex w-[min(620px,100vw)] flex-col overflow-hidden border-l border-line bg-chrome/95 data-[state=open]:animate-[panel-in_.22s_cubic-bezier(.2,.9,.3,1)]"
        >
          <div className="border-b border-line px-6 pb-6 pt-7 sm:px-10">
            <div className="mx-auto w-full max-w-[760px]">
              <div className="flex items-start gap-4">
                <h2 className="min-w-0 flex-1 break-words text-[26px] font-semibold leading-tight tracking-tight text-ink sm:text-[30px]">{event.title}</h2>
                <button onClick={flushAndClose} aria-label="关闭" className="-mr-2 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"><X className="size-4" /></button>
              </div>
              <div className="mt-7 max-w-[600px] space-y-0.5">
                <Property icon={Clock3} label="时间"><span className="px-2 py-1 font-mono text-xs text-ink-2 tnum">{time}</span></Property>
                {event.location && <Property icon={MapPin} label="地点"><span className="whitespace-pre-wrap px-2 py-1 text-sm text-ink-2">{event.location}</span></Property>}
                {event.organizer && <Property icon={UserRound} label="组织者"><span className="px-2 py-1 text-sm text-ink-2">{event.organizer}</span></Property>}
                <Property icon={Clock3} label="同步时间"><span className="px-2 py-1 font-mono text-xs text-ink-3 tnum">{fmtDateTime(event.synced_at)}</span></Property>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto min-h-full w-full max-w-[760px] px-6 py-8 sm:px-10 sm:py-10">
              <p className="mb-3 text-xs font-medium text-ink-3">会议记录</p>
              <DocumentEditor key={event.id} value={detail} onChange={queueSave} placeholder="记录讨论内容、结论和后续行动…" className="min-h-[320px]" />
            </div>
          </div>
          {saveState !== 'idle' && <div className="pointer-events-none absolute bottom-4 right-6 flex h-7 items-center gap-1 rounded-full border border-line bg-surface-2/90 px-3 text-xs text-ink-3 shadow-sm">{saveState === 'saving' ? <><Loader2 className="size-3 animate-spin" />保存中</> : <><Check className="size-3" />已保存</>}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}

function Property({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: React.ReactNode }) {
  return <div className="group flex min-h-9 items-center rounded-md transition-colors hover:bg-surface-1/70"><div className="flex w-[104px] shrink-0 items-center gap-2 px-2 py-1 text-xs text-ink-4"><Icon className="size-3.5" /><span>{label}</span></div><div className={cn('min-w-0 flex-1', label === '地点' && 'break-words')}>{children}</div></div>;
}
