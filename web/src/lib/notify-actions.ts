// 系统通知的三个动作：授权、试一条、跳到系统设置。
// 只做「点一下就到底」的那一步，长说明交给胶囊面板。
import { toast } from 'sonner';
import { fireSystemNotification, readNotifyPermission } from '@/lib/notify-permission';
import { notifySettingsPath, notifySettingsUrl, openNotifySettings, platformLabel } from '@/lib/system-notify-settings';

const canJump = () => Boolean(notifySettingsUrl());

/** 系统层没有直达链接时（Linux 等），把路径复制走，省得手打 */
function copySettingsPath() {
  const path = notifySettingsPath();
  const byHand = () => toast.info(`${platformLabel()} 没有直达链接，手动走一下`, { description: path, duration: 14_000 });
  if (!navigator.clipboard) return byHand();
  navigator.clipboard.writeText(path)
    .then(() => toast.success('设置路径已复制', { description: path, duration: 10_000 }))
    .catch(byHand);
}

/** 跳到系统「通知」面板；跳不动就退回给路径 */
export function openNotificationSettings() {
  if (openNotifySettings()) toast.info(`已请求打开 ${platformLabel()} 的通知设置`, { duration: 5_000 });
  else copySettingsPath();
}

/** 发起浏览器授权 */
export async function askNotifyPermission() {
  try {
    await Notification.requestPermission();
  } catch { /* 老宿主只接回调形式，读一下当前状态就好 */ }
  const next = readNotifyPermission();
  if (next === 'granted') toast.success('系统通知已开启', { duration: 6_000 });
  else if (next === 'unsupported') toast.error('这个窗口给不了系统通知', { description: '用独立标签页打开工作台就好', duration: 12_000 });
  else toast.info('未授权，应用内通知仍有效', { duration: 8_000 });
  return next;
}

/** 发一条测试通知 */
export function testSystemNotification() {
  const sent = fireSystemNotification('YZ工作台', '系统通知链路正常，到点就这样弹');
  toast[sent ? 'success' : 'error'](sent ? '测试通知已发出' : '这个窗口发不出系统通知', {
    description: sent ? '桌面没出现的话，是系统那半边挡着' : '应用内横幅仍然有效',
    duration: 10_000,
    action: canJump()
      ? { label: '打开通知设置', onClick: openNotificationSettings }
      : { label: '复制设置路径', onClick: copySettingsPath },
  });
}
