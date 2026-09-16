/**
 * [INPUT]: 依赖调用方提供的稳定 owner 标识与关闭回调
 * [OUTPUT]: 对外提供 claimHoverLayer、releaseHoverLayer，统一约束 hover 预览同屏唯一
 * [POS]: lib 的无 UI 生命周期协调器，被各类 portal hover 预览复用，不介入点击型菜单与弹窗
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

let activeLayer: { owner: object; dismiss: () => void } | null = null;
let listening = false;

function dismissActiveHoverLayer() {
  const layer = activeLayer;
  activeLayer = null;
  layer?.dismiss();
  stopListeningIfIdle();
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') dismissActiveHoverLayer();
}

function startListening() {
  if (listening) return;
  listening = true;
  window.addEventListener('scroll', dismissActiveHoverLayer, true);
  window.addEventListener('resize', dismissActiveHoverLayer);
  window.addEventListener('blur', dismissActiveHoverLayer);
  document.addEventListener('keydown', onKeyDown);
}

function stopListeningIfIdle() {
  if (!listening || activeLayer) return;
  listening = false;
  window.removeEventListener('scroll', dismissActiveHoverLayer, true);
  window.removeEventListener('resize', dismissActiveHoverLayer);
  window.removeEventListener('blur', dismissActiveHoverLayer);
  document.removeEventListener('keydown', onKeyDown);
}

export function claimHoverLayer(owner: object, dismiss: () => void) {
  if (activeLayer?.owner !== owner) dismissActiveHoverLayer();
  activeLayer = { owner, dismiss };
  startListening();
}

export function releaseHoverLayer(owner: object) {
  if (activeLayer?.owner === owner) activeLayer = null;
  stopListeningIfIdle();
}
