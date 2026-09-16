// 创建钉钉日程：时间 + 同事（通讯录 MCP 搜索）+ 会议室（空闲查询与预定）
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Loader2, Search, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, qk, type Colleague, type MeetingRoom } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Input, Select } from '@/ui/form';
import { Dialog, DialogContent } from '@/ui/dialog';
import { DateTimePicker } from '@/ui/datetime-picker';

const pad2 = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 默认开始时间：今天（或指定日期）的下一个整点，结束顺延 1 小时 */
function defaultRange(dateKey?: string): { start: string; end: string } {
  const n = new Date();
  const base = dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : keyOf(n);
  const startH = base === keyOf(n) ? Math.min(n.getHours() + 1, 23) : 10;
  return { start: `${base}T${pad2(startH)}:00`, end: addHours(`${base}T${pad2(startH)}:00`, 1) };
}

/** "YYYY-MM-DDTHH:mm" + n 小时 */
function addHours(value: string, hours: number): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  d.setHours(d.getHours() + hours);
  return `${keyOf(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

type RoomType = 'all' | 'meeting' | 'talk' | 'live';

/** 按分组路径/名称识别会议室类型 */
function roomTypeOf(r: MeetingRoom): Exclude<RoomType, 'all'> {
  const text = `${r.groupPath ?? ''}${r.roomName}`;
  if (/直播间/.test(text)) return 'live';
  if (/洽谈/.test(text)) return 'talk';
  return 'meeting';
}

const ROOM_TYPE_LABEL: Record<Exclude<RoomType, 'all'>, string> = {
  meeting: '会议室',
  talk: '洽谈室',
  live: '直播间',
};

export function CreateEventDialog({ open, onClose, defaultDate }: {
  open: boolean;
  onClose: () => void;
  defaultDate?: string; // YYYY-MM-DD，来自月历选中日
}) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 60_000 });
  const init = useMemo(defaultRange, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [title, setTitle] = useState('');
  const [startAt, setStartAt] = useState(init.start);
  const [endAt, setEndAt] = useState(init.end);
  const [endTouched, setEndTouched] = useState(false); // 结束时间被手动改过后不再自动跟随开始时间
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<Colleague[]>([]);
  const [searching, setSearching] = useState(false);
  const [contacts, setContacts] = useState<Colleague[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomType, setRoomType] = useState<RoomType>('all');
  const [rooms, setRooms] = useState<MeetingRoom[]>([]);
  const [roomLoading, setRoomLoading] = useState(false);
  const [roomsQueried, setRoomsQueried] = useState(false);
  const [showRooms, setShowRooms] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [location, setLocation] = useState('');
  const [reminder, setReminder] = useState('default');
  const [busyMap, setBusyMap] = useState<Record<string, Array<{ start: string; end: string }>> | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ start: string; end: string; conflicts: string[] }>>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);

  const searchSeq = useRef(0);
  const roomSeq = useRef(0);
  const hideRoomsTimer = useRef<number | null>(null);

  // 弹窗每次打开重置表单
  useEffect(() => {
    if (!open) return;
    const r = defaultRange(defaultDate);
    setTitle(''); setStartAt(r.start); setEndAt(r.end); setEndTouched(false);
    setKeyword(''); setResults([]); setContacts([]); setShowResults(false);
    setRoomName(''); setRoomType('all'); setRooms([]); setRoomLoading(false);
    setRoomsQueried(false); setShowRooms(false); setRoomId(''); setLocation('');
    setReminder('default');
    setBusyMap(null); setSuggestOpen(false); setSuggestions([]); setSuggestLoading(false);
  }, [open, defaultDate]);

  // 同事搜索：防抖 400ms
  useEffect(() => {
    if (!open || !keyword.trim()) { setResults([]); setSearching(false); return; }
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.searchColleagues(keyword.trim());
        if (seq !== searchSeq.current) return;
        setResults(r.users);
        setShowResults(true);
        if (!r.ok && r.error) toast.error(r.error);
      } catch (e) {
        if (seq === searchSeq.current) toast.error((e as Error).message);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [keyword, open]);

  const timesValid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startAt) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(endAt) && endAt > startAt;

  // 参与人忙闲：同事或时间变化后自动查（防抖 500ms），只提示冲突不展示日程内容
  const busyKey = contacts.map((c) => c.userId).join(',');
  const selfUserId = settings?.dingtalk.userId?.trim() || '';
  const suggestionUserIds = [...new Set([selfUserId, ...contacts.map((c) => c.userId)].filter(Boolean))];
  useEffect(() => {
    if (!open || !busyKey || !timesValid) { setBusyMap(null); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.busyStatus(startAt, endAt, busyKey.split(','));
        setBusyMap(r.ok ? Object.fromEntries(r.busy.map((b) => [b.userId, b.busy])) : null);
      } catch { setBusyMap(null); }
    }, 500);
    return () => clearTimeout(t);
  }, [open, busyKey, startAt, endAt, timesValid]);

  // 当前时段与参与人忙闲的交集
  const conflicts = useMemo(() => {
    if (!busyMap) return [];
    const out: Array<{ name: string; slot: string }> = [];
    for (const c of contacts) {
      for (const b of busyMap[c.userId] ?? []) {
        if (b.start < endAt && b.end > startAt) {
          out.push({ name: c.name, slot: `${b.start.slice(11, 16)}-${b.end.slice(11, 16)}` });
        }
      }
    }
    return out;
  }, [busyMap, contacts, startAt, endAt]);

  const conflictNames = (ids: string[]) =>
    ids.map((id) => contacts.find((c) => c.userId === id)?.name ?? id).join('、');

  // 推荐共同空闲时段：按公司工作时间 11:00-20:00，并把当前用户本人纳入参与人
  const querySuggestions = async () => {
    if (!suggestionUserIds.length || !timesValid) return;
    setSuggestLoading(true);
    try {
      const day = startAt.slice(0, 10);
      const duration = Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60000);
      const r = await api.suggestedTimes(`${day}T11:00`, `${day}T20:00`, suggestionUserIds, duration);
      setSuggestions(r.times);
      setSuggestOpen(true);
      if (!r.ok && r.error) toast.error(r.error);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSuggestLoading(false);
    }
  };

  const applySuggestion = (slot: { start: string; end: string }) => {
    setStartAt(slot.start);
    setEndAt(slot.end);
    setEndTouched(true); // 用户显式选择了推荐时段，结束时间此后不再自动跟随
    setSuggestOpen(false);
  };

  const queryRooms = async () => {
    if (!timesValid) return; // 时间没就绪时静默跳过
    const seq = ++roomSeq.current;
    setRoomLoading(true);
    try {
      const r = await api.availableRooms(startAt, endAt);
      if (seq !== roomSeq.current) return;
      setRooms(r.rooms);
      setRoomsQueried(true);
      if (!r.ok && r.error) toast.error(r.error);
    } catch (e) {
      if (seq === roomSeq.current) toast.error((e as Error).message);
    } finally {
      if (seq === roomSeq.current) setRoomLoading(false);
    }
  };

  const handleStartChange = (v: string) => {
    setStartAt(v);
    // 结束时间没手动设过时，自动跟随为开始时间 +1 小时（日期同天切换）
    if (!endTouched) setEndAt(addHours(v, 1));
  };

  const handleEndChange = (v: string) => {
    setEndAt(v);
    setEndTouched(true);
  };

  const focusRooms = () => {
    if (hideRoomsTimer.current !== null) {
      window.clearTimeout(hideRoomsTimer.current);
      hideRoomsTimer.current = null;
    }
    setShowRooms(true);
    void queryRooms(); // 点开就自动查空闲，不需要手动按钮
  };

  const blurRooms = () => {
    if (hideRoomsTimer.current !== null) window.clearTimeout(hideRoomsTimer.current);
    hideRoomsTimer.current = window.setTimeout(() => setShowRooms(false), 150);
  };

  const mut = useMutation({
    mutationFn: () => api.createDingtalkEvent({
      title: title.trim(),
      startAt,
      endAt,
      attendeeUserIds: contacts.map((c) => c.userId),
      roomId: roomId || undefined,
      location: location.trim() || undefined,
      reminderMinutes: reminder === 'none' ? null : reminder === 'default' ? undefined : Number(reminder),
    }),
    onSuccess: (r) => {
      if (!r.ok) { toast.error(r.error ?? '创建失败'); return; }
      toast.success('已创建');
      onClose();
      // 拉一次日历同步，把新日程带回本地缓存（CalDAV 源）
      api.syncEvents().then(() => {
        qc.invalidateQueries({ queryKey: ['events'] });
      }).catch(() => { /* 同步失败不打扰，下次手动同步 */ });
    },
    onError: (e) => toast.error(e.message),
  });

  const submit = () => {
    if (!title.trim()) { toast.error('请填写日程标题'); return; }
    if (!timesValid) { toast.error('结束时间需晚于开始时间'); return; }
    mut.mutate();
  };

  const addContact = (c: Colleague) => {
    if (contacts.some((x) => x.userId === c.userId)) return;
    setContacts((prev) => [...prev, c]);
  };

  const kw = roomName.trim().toLowerCase();
  const visibleRooms = rooms.filter((r) => {
    if (kw && !`${r.groupPath ?? ''}${r.roomName}`.toLowerCase().includes(kw)) return false;
    if (roomType === 'all') return true;
    const t = roomTypeOf(r);
    if (roomType === 'meeting') return t === 'meeting';
    return t === roomType;
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent title="创建钉钉日程" className="max-w-xl">
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between pr-6">
            <h2 className="text-sm font-semibold">创建钉钉日程</h2>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-2">标题</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：项目评审会" maxLength={100} autoFocus />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-2">开始</label>
              <DateTimePicker value={startAt} onChange={handleStartChange} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-2">结束</label>
              <DateTimePicker value={endAt} onChange={handleEndChange} />
            </div>
          </div>

          {/* 参与人：通讯录搜索 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-2">参与同事</label>
            <div className="relative">
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onFocus={() => results.length > 0 && setShowResults(true)}
                placeholder="输入姓名搜索同事并添加"
                maxLength={60}
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-4">
                {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              </span>
              {showResults && results.length > 0 && (
                <div className="pop-panel absolute z-10 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-line p-1">
                  {results.map((u) => {
                    const added = contacts.some((x) => x.userId === u.userId);
                    return (
                      <button
                        key={u.userId}
                        disabled={added}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { addContact(u); setShowResults(false); setKeyword(''); }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-2 disabled:opacity-40"
                      >
                        <UserPlus className="size-3.5 shrink-0 text-ink-4" />
                        <span className="font-medium text-ink">{u.name}</span>
                        {(u.title || u.deptPath) && <span className="truncate text-ink-4">{u.title ?? u.deptPath}</span>}
                        {added && <span className="ml-auto text-ink-4">已添加</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {contacts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {contacts.map((c) => (
                  <span key={c.userId} className="flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs">
                    {c.name}
                    <button
                      aria-label={`移除 ${c.name}`}
                      onClick={() => setContacts((prev) => prev.filter((x) => x.userId !== c.userId))}
                      className="text-ink-4 transition-colors hover:text-ink"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {/* 忙闲冲突提示：选了同事且时间有效后自动查询 */}
            {contacts.length > 0 && timesValid && busyMap && (
              conflicts.length > 0 ? (
                <div className="space-y-0.5">
                  {conflicts.map((c, i) => (
                    <p key={i} className="text-[11px] text-danger">冲突：{c.name} {c.slot} 已有安排</p>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-ink-4">所有参与人在该时段都有空</p>
              )
            )}
            {/* 推荐共同空闲时段：一键选中 */}
            {contacts.length > 0 && (
              <div className="relative pt-0.5">
                <button
                  type="button"
                  disabled={!timesValid || suggestLoading}
                  onClick={() => { if (suggestOpen) { setSuggestOpen(false); return; } void querySuggestions(); }}
                  className="flex items-center gap-1 text-[11px] text-accent transition-colors hover:underline disabled:opacity-40"
                >
                  {suggestLoading ? <Loader2 className="size-3 animate-spin" /> : <Clock className="size-3" />}
                  {suggestLoading ? '正在查询参与人闲忙…' : '推荐共同空闲时间'}
                </button>
                {suggestOpen && (
                  <div className="pop-panel absolute z-10 mt-1 max-h-44 w-full overflow-y-auto rounded-lg border border-line p-1">
                    {suggestions.length === 0 ? (
                      <p className="px-2 py-1.5 text-xs text-ink-4">当天 11:00-20:00 没有共同空闲时段，换个日期试试</p>
                    ) : suggestions.map((slot, i) => (
                      <button
                        key={i}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applySuggestion(slot)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-2"
                      >
                        <span className="shrink-0 font-mono text-ink">{slot.start.slice(5, 16).replace('T', ' ')} - {slot.end.slice(11, 16)}</span>
                        <span className={cn('truncate', slot.conflicts.length ? 'text-danger' : 'text-ink-4')}>
                          {slot.conflicts.length ? `冲突：${conflictNames(slot.conflicts)}` : '全员有空'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 会议室：点开输入框自动查空闲，失焦收起 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-2">会议室</label>
            <div className="flex gap-2">
              <Select
                value={roomType}
                onChange={(e) => setRoomType(e.target.value as RoomType)}
                className="w-28 shrink-0"
                aria-label="会议室类型"
              >
                <option value="all">全部</option>
                <option value="meeting">会议室</option>
                <option value="talk">洽谈室</option>
                <option value="live">直播间</option>
              </Select>
              <div className="relative flex-1">
                <Input
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  onFocus={focusRooms}
                  onBlur={blurRooms}
                  placeholder={roomsQueried ? '按名称过滤' : '点击自动查询该时段空闲会议室'}
                  maxLength={60}
                />
                {roomLoading && (
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-4">
                    <Loader2 className="size-4 animate-spin" />
                  </span>
                )}
                {showRooms && visibleRooms.length > 0 && (
                  <div className="pop-panel absolute z-10 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-line p-1">
                    {visibleRooms.map((r) => (
                      <button
                        key={r.roomId}
                        onMouseDown={(e) => e.preventDefault()} // 避免失焦收起导致点击丢失
                        onClick={() => {
                          const next = roomId === r.roomId ? '' : r.roomId;
                          setRoomId(next);
                          setLocation(next ? `${r.groupPath ? `${r.groupPath} · ` : ''}${r.roomName}` : '');
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-2',
                          roomId === r.roomId && 'bg-accent/10',
                        )}
                      >
                        <span className={cn('size-2 shrink-0 rounded-full border', roomId === r.roomId ? 'border-accent bg-accent' : 'border-line')} />
                        <span className="font-medium text-ink">{r.roomName}</span>
                        {r.capacity != null && <span className="text-ink-4">{r.capacity} 人</span>}
                        <span className="ml-auto truncate text-ink-4">{ROOM_TYPE_LABEL[roomTypeOf(r)]} · {r.groupPath}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {showRooms && roomsQueried && !roomLoading && visibleRooms.length === 0 && (
              <p className="px-1 text-xs text-ink-4">该时间段没有可预定的空闲{roomType === 'all' ? '会议室' : ROOM_TYPE_LABEL[roomType as Exclude<RoomType, 'all'>]}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-2">地点</label>
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="选会议室后自动填入" maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-2">提醒</label>
              <Select value={reminder} onChange={(e) => setReminder(e.target.value)}>
                <option value="default">默认（开始前 15 分钟）</option>
                <option value="5">提前 5 分钟</option>
                <option value="30">提前 30 分钟</option>
                <option value="60">提前 1 小时</option>
                <option value="1440">提前 1 天</option>
                <option value="none">不提醒</option>
              </Select>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
            <Button size="sm" disabled={mut.isPending} onClick={submit}>
              {mut.isPending && <Loader2 className="size-4 animate-spin" />}
              创建日程
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
