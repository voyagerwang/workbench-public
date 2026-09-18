// 系统通知状态：一颗胶囊搞定。
// 未授权时点它=先看用途说明；用户在说明里再次确认后才发起系统授权。
// 长文案一律收在面板里，页头只留状态本身。
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { BellOff, BellRing, Check, Send, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNotifyPermission, type NotifyPermission } from '@/lib/notify-permission';
import { askNotifyPermission, openNotificationSettings, testSystemNotification } from '@/lib/notify-actions';
import { browserPermissionPath, notifySettingsShortPath, notifySettingsUrl, platformLabel } from '@/lib/system-notify-settings';

const site = typeof window === 'undefined' ? '' : window.location.host;
const embedded = typeof window !== 'undefined' && window.self !== window.top;
const canJump = Boolean(notifySettingsUrl());

const META: Record<NotifyPermission, { label: string; tip: string; tone: string }> = {
  granted: { label: '浏览器通知权限已开启', tip: '仅表示浏览器权限，不代表群机器人已配置或 macOS 通知已送达', tone: 'border-ok/35 bg-ok/12 text-ok' },
  default: { label: '开启浏览器通知', tip: '先查看用途与范围；不授权也有应用内横幅', tone: 'border-line-strong text-ink-2' },
  denied: { label: '浏览器通知权限被拦截', tip: '浏览器记住了拦截 · 点开看怎么改', tone: 'border-warn bg-warn/15 text-warn' },
  unsupported: {
    label: '当前窗口不支持浏览器通知',
    tip: embedded ? '工作台被内嵌在别的页面里，宿主没让出通知权限' : '当前窗口没有 Web Notification 接口',
    tone: 'border-line-strong text-ink-3',
  },
};

export function NotifyStatusChip() {
  const { permission } = useNotifyPermission();
  const meta = META[permission];
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (permission === 'granted') setOpen(false); }, [permission]);

  const onClick = () => setOpen((v) => !v);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={onClick}
        title={meta.tip}
        aria-expanded={open}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] leading-4 transition-colors hover:brightness-110',
          meta.tone,
        )}
      >
        {permission === 'denied' ? <BellOff className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}
        {meta.label}
      </button>
      {open && (
        <NotifyPanel
          permission={permission}
          anchor={anchor.current}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** 侧栏「提醒」旁的常驻小圆点：不进提醒页也能看出通知开没开 */
export function NotifyStatusDot() {
  const { permission } = useNotifyPermission();
  return (
    <span
      title={META[permission].label}
      className={cn(
        'ml-auto size-1.5 shrink-0 rounded-full',
        permission === 'granted' ? 'bg-ok' : permission === 'denied' ? 'bg-warn' : 'bg-ink-4',
      )}
    />
  );
}

function NotifyPanel({ permission, anchor, onClose }: {
  permission: NotifyPermission;
  anchor: HTMLButtonElement | null;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const W = 320;
  const rect = anchor?.getBoundingClientRect();
  const style = rect
    ? {
        width: W,
        left: Math.max(12, Math.min(rect.right - W, window.innerWidth - W - 12)),
        top: rect.bottom + 6 + W > window.innerHeight ? Math.max(12, rect.top - 6 - 168) : rect.bottom + 6,
      }
    : { width: W, left: 12, top: 12 };

  const pick = (fn: () => void) => () => { onClose(); fn(); };
  const copy = (text: string) => () => {
    navigator.clipboard?.writeText(text)
      .then(() => toast.success('已复制', { description: text, duration: 6_000 }))
      .catch(() => toast.info(text));
    onClose();
  };

  return createPortal(
    <div
      ref={box}
      style={style}
      className="pop-panel fixed z-[70] rounded-xl border border-line p-1.5 shadow-lg"
    >
      {permission === 'default' && (
        <>
          <Note>
            此权限用于当前浏览器显示通知，不会启用飞书、钉钉或微信。macOS 提醒渠道由本机服务发送；浏览器权限不代表它已获得系统授权。
          </Note>
          <Row icon={<BellRing className="size-3.5" />} onClick={pick(() => { void askNotifyPermission(); })}>
            允许浏览器通知
          </Row>
        </>
      )}
      {permission === 'granted' && (
        <>
          <Row icon={<Send className="size-3.5" />} onClick={pick(testSystemNotification)}>测试浏览器通知</Row>
          <SettingsRow onJump={pick(openNotificationSettings)} />
          <Note>权限按站点记：{site}。横幅老是被系统吞掉的话，去「{notifySettingsShortPath()}」里允许当前 App。</Note>
        </>
      )}
      {permission === 'denied' && (
        <>
          <SettingsRow onJump={pick(openNotificationSettings)} />
          <Row icon={<Check className="size-3.5" />} onClick={copy(browserPermissionPath())}>复制浏览器里的改法</Row>
          <Note>{browserPermissionPath()} · 改完回到这页会自动更新，不用刷新。</Note>
        </>
      )}
      {permission === 'unsupported' && (
        <Note>
          {embedded ? '当前 Codex 内嵌区域没有提供系统通知能力。' : '当前宿主没有 Web Notification 接口。'}
          不会因此打开独立网页；应用内横幅与钉钉 / 飞书推送仍然可用。
        </Note>
      )}
    </div>,
    document.body,
  );
}

function Row({ icon, children, onClick, tip }: {
  icon: React.ReactNode; children: React.ReactNode; onClick: () => void; tip?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tip}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink [&_svg]:text-ink-4"
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
    </button>
  );
}

/** 有直达链接就跳，没有（Linux 之类）就复制路径——文案跟着实际行为走 */
function SettingsRow({ onJump }: { onJump: () => void }) {
  return canJump ? (
    <Row icon={<Settings className="size-3.5" />} onClick={onJump} tip={`浏览器会问你一次要不要打开 ${platformLabel()} 的设置`}>
      打开 {platformLabel()} 通知设置
    </Row>
  ) : (
    <Row icon={<Settings className="size-3.5" />} onClick={onJump}>
      复制 {platformLabel()} 通知设置路径
    </Row>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-0.5 border-t border-line px-2.5 pb-1.5 pt-2 text-[11px] leading-relaxed text-ink-4">
      {children}
    </p>
  );
}
