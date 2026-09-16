/** 本地执行事件：入库立即唤醒，终态立即通知；不通过 IM 绕行。 */
let wakeHandler: (() => void) | undefined;
let settledHandler: (() => void) | undefined;
export function configureExecutionSignals(wake:()=>void,settled:()=>void) {wakeHandler=wake;settledHandler=settled;}
export function wakeExecution() {wakeHandler?.();}
export function executionSettled() {wakeHandler?.();settledHandler?.();}
/** 服务端容量，旧配置默认每种任务通道最多三个独立会话（用户确认 2026-09-13；可配置 1~8）。 */
export function executionConcurrency(value:unknown):number {return Number.isSafeInteger(value)&&Number(value)>=1&&Number(value)<=8?Number(value):3;}
