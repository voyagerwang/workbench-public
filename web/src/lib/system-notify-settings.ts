// 「去系统设置里查通知权限」这种话等于把活儿丢回给用户。
// 这里按平台/浏览器把路径写清楚，并尽量给一个能直接跳过去的链接。
export type Platform = 'macos' | 'windows' | 'linux' | 'other';
export type Browser = 'chrome' | 'edge' | 'safari' | 'firefox' | 'other';

const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent);
const platformRaw = () => {
  if (typeof navigator === 'undefined') return '';
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return `${data?.platform ?? ''} ${navigator.platform ?? ''}`.toLowerCase();
};

export function detectPlatform(): Platform {
  const p = platformRaw();
  if (/mac|iphone|ipad/.test(p)) return 'macos';
  if (/win/.test(p)) return 'windows';
  if (/linux|android|cros/.test(p)) return 'linux';
  const u = ua();
  if (/macintosh|mac os x|iphone|ipad/i.test(u)) return 'macos';
  if (/windows/i.test(u)) return 'windows';
  if (/linux|x11|android|cros/i.test(u)) return 'linux';
  return 'other';
}

export function detectBrowser(): Browser {
  const u = ua();
  if (/edg\//i.test(u)) return 'edge';
  if (/firefox\//i.test(u)) return 'firefox';
  if (/chrome|chromium|crios/i.test(u)) return 'chrome';
  if (/safari\//i.test(u)) return 'safari';
  return 'other';
}

const isEmbedded = () => typeof window !== 'undefined' && window.self !== window.top;

/** 系统「通知」列表里要认的那个 App 名 */
export function hostAppLabel(): string {
  if (isEmbedded() || /electron\//i.test(ua())) return '承载这个页面的 App';
  const map: Record<Browser, string> = {
    chrome: 'Chrome', edge: 'Edge', safari: 'Safari', firefox: 'Firefox', other: '你的浏览器',
  };
  return map[detectBrowser()];
}

/** 系统设置里通知面板的直达链接（Linux 各家桌面不统一，给不了） */
export function notifySettingsUrl(platform = detectPlatform()): string | null {
  if (platform === 'macos') return 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
  if (platform === 'windows') return 'ms-settings:notifications';
  return null;
}

/** 点了就跳到系统通知设置；跳不动返回 false，调用方退回文字路径 */
export function openNotifySettings(): boolean {
  const url = notifySettingsUrl();
  if (!url || typeof document === 'undefined') return false;
  try {
    if (window.open(url, '_blank', 'noopener')) return true;
  } catch { /* 沙箱里弹窗可能被拦，继续试兜底 */ }
  try {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.click();
    return true;
  } catch {
    return false;
  }
}

/** 系统层的操作路径 */
export function notifySettingsPath(app = hostAppLabel(), platform = detectPlatform()): string {
  if (platform === 'macos') {
    return `系统设置 → 通知 → 在列表里找到「${app}」（不对就找你现在开这个页面的那个 App）→ 打开「允许通知」，提醒样式选「横幅」`;
  }
  if (platform === 'windows') {
    // Windows 把网页通知单列成一条，条目名带「(Web notifications)」后缀
    return `设置 → 系统 → 通知 → 在应用列表里找到「${app} (Web notifications)」→ 打开开关，通知类型选「横幅」`;
  }
  if (platform === 'linux') {
    return `系统设置的「通知」里允许「${app}」发通知（桌面环境不同，名字可能是 Notifications / 通知与焦点）`;
  }
  return `在系统设置的通知项里允许「${app}」发通知`;
}

/** 注脚用的短路径，只给面板名，不铺开整条链路 */
export function notifySettingsShortPath(platform = detectPlatform()): string {
  const map: Record<Platform, string> = {
    macos: '系统设置 → 通知',
    windows: '设置 → 系统 → 通知',
    linux: '系统设置的通知面板',
    other: '系统通知设置',
  };
  return map[platform];
}

/** 浏览器层的授权路径（被拦时网页自己解不开，只能人去改） */
export function browserPermissionPath(): string {
  const site = typeof window === 'undefined' ? '' : window.location.host;
  switch (detectBrowser()) {
    case 'chrome':
    case 'edge':
      return `点地址栏左侧的锁形图标 → 网站设置 → 通知 → 改成「允许」（站点 ${site}），回到页面会自动更新`;
    case 'safari':
      return `Safari 菜单 → 设置 → 网站 → 通知 → 找到 ${site} 改成「允许」`;
    case 'firefox':
      return `点地址栏左侧的锁形图标 → 清除「通知」权限后重新授权（站点 ${site}）`;
    default:
      return `在浏览器的网站设置里把 ${site} 的通知改成「允许」`;
  }
}

/** 平台标签，用于文案前缀 */
export function platformLabel(platform = detectPlatform()): string {
  const map: Record<Platform, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux', other: '系统' };
  return map[platform];
}
