/**
 * [INPUT]: 文档初值与业务持久化函数；不依赖 React 或 HTTP 实现
 * [OUTPUT]: SaveQueue 串行保存、字段合并、失败重试与排空契约
 * [POS]: document 模块的保存状态机；页面、自动标题和属性更新共用一个队列
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
export type SaveStatus = 'saved' | 'editing' | 'saving' | 'error';
export type SaveSnapshot<T> = { value: T; status: SaveStatus; error: string | null };
const hasFields = (value: object) => Object.keys(value).length > 0;

export class SaveQueue<T extends object> {
  private pending: Partial<T> = {};
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private snapshot: SaveSnapshot<T>;
  private confirmed: T;
  private stopped = false;
  private held = false;
  private submitted: T | null = null;

  constructor(initial: T, private persist: (patch: Partial<T>, value: T) => Promise<void>, private delay = 600) {
    this.confirmed = initial;
    this.snapshot = { value: initial, status: 'saved', error: null };
  }
  getSnapshot = () => this.snapshot;
  isOwnVersion(value: T) { return JSON.stringify(value) === JSON.stringify(this.confirmed) || JSON.stringify(value) === JSON.stringify(this.submitted); }
  hold() { this.held = true; clearTimeout(this.timer); }
  release() { this.held = false; }
  async settle() { try { await this.running; } catch { /* 外部版本取代失败草稿时允许丢弃本地队列 */ } }
  get savedValue() { return this.confirmed; }
  get dirty() { return hasFields(this.pending) || this.running !== null; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(status: SaveStatus, error: string | null = null) {
    this.snapshot = { ...this.snapshot, status, error };
    this.listeners.forEach((listener) => listener());
  }
  change(patch: Partial<T>) {
    if (this.stopped) return;
    this.snapshot = { ...this.snapshot, value: { ...this.snapshot.value, ...patch } };
    this.pending = { ...this.pending, ...patch };
    this.emit('editing');
    clearTimeout(this.timer);
    if (this.held) return;
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, this.delay);
  }
  /** 仅用于用户明确采用外部版本或无本地改动的同步。 */
  reset(value: T) {
    if (this.running) throw new Error('请等待当前保存完成');
    clearTimeout(this.timer);
    this.pending = {};
    this.confirmed = value;
    this.submitted = null;
    this.snapshot = { value, status: 'saved', error: null };
    this.emit('saved');
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.stopped) return;
    if (this.held) throw new Error('请先处理文档的外部更新');
    if (this.running) { await this.running; return this.flush(); }
    if (!hasFields(this.pending)) return;
    // 将循环放到微任务，确保同步抛错也在 running 建立之后处理。
    this.running = Promise.resolve().then(async () => {
      while (hasFields(this.pending) && !this.held) {
        const patch = this.pending;
        const submitted = this.snapshot.value;
        this.submitted = submitted;
        this.pending = {};
        this.emit('saving');
        try {
          await this.persist(patch, submitted);
          this.confirmed = { ...this.confirmed, ...patch };
        } catch (error) {
          this.pending = { ...patch, ...this.pending }; // 后输入的字段始终优先
          clearTimeout(this.timer);
          this.emit('error', error instanceof Error ? error.message : '保存失败');
          throw error;
        }
      }
    });
    try { await this.running; }
    finally {
      this.running = null;
      if (this.snapshot.status !== 'error') this.emit(hasFields(this.pending) ? 'editing' : 'saved');
    }
    if (hasFields(this.pending)) await this.flush();
  }
  /** 删除成功后停止队列；失败的删除不调用此方法。 */
  stop() { clearTimeout(this.timer); this.stopped = true; this.pending = {}; }
  pause() { clearTimeout(this.timer); }
}
