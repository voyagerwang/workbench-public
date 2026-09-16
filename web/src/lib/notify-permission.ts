// 系统通知（Web Notification）权限状态。
// 只读一次 Notification.permission 会漏掉用户在地址栏里改权限的动作，
// 所以这里订阅 Permissions API 的 change 事件，让「已开启」标识跟着真实状态走。
import { useCallback, useEffect, useState } from 'react';

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

const hasApi = () => typeof window !== 'undefined' && 'Notification' in window;

export function readNotifyPermission(): NotifyPermission {
  if (!hasApi()) return 'unsupported';
  const p = Notification.permission;
  return p === 'granted' || p === 'denied' || p === 'default' ? p : 'unsupported';
}

/** 有权限就弹系统通知，没有就返回 false（调用方自己决定要不要兜底成 toast） */
export function fireSystemNotification(title: string, body: string): boolean {
  if (readNotifyPermission() !== 'granted') return false;
  try {
    new Notification(title, { body });
    return true;
  } catch {
    // 某些宿主（内嵌 webview）有接口但构造即抛
    return false;
  }
}

export function useNotifyPermission() {
  const [permission, setPermission] = useState<NotifyPermission>(readNotifyPermission);

  const refresh = useCallback(() => setPermission(readNotifyPermission()), []);

  useEffect(() => {
    if (!hasApi()) return;
    let status: PermissionStatus | null = null;
    let disposed = false;
    navigator.permissions
      ?.query({ name: 'notifications' as PermissionName })
      .then((s) => {
        if (disposed) return;
        status = s;
        s.addEventListener('change', refresh);
        refresh();
      })
      .catch(() => { /* 宿主没实现该权限名就算了，靠 visibilitychange 兜底 */ });

    const onVisible = () => refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      status?.removeEventListener('change', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { permission, refresh };
}
