/**
 * [INPUT]: 服务端助手会话与运行态 API
 * [OUTPUT]: 服务端会话的本地缓存，任务只保存编号
 * [POS]: 工作台助手界面与服务端契约的接线层
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '@/lib/api';
import type {
  AssistantAction, AssistantDispatchPlan, AssistantMessage, AssistantSessionRecord, CaptureResult, StoredAssistantMessage,
} from '@/types';

/**
 * 一条对话记录。
 *
 * **服务端是唯一权威**：有 id 的条目来自 `assistant_messages`，凭证挂在消息上而不是会话上，
 * 所以刷新后每一轮的落库凭证都能按原样还原，不会出现「凭证明明发生过却消失了」这种孤儿状态。
 * localStorage 降级为离线缓存，只负责首屏秒开与断网兜底。
 */
export type ChatEntry = AssistantMessage & {
  /** 服务端消息 id；有它就说明这条已经持久化 */
  id?: number;
  /** 仅存在于本地缓存（乐观插入或发送失败）的消息，下次拉到服务端记录后会被同内容的替换掉 */
  tempId?: string;
  /** 随消息发送的图片（/api/files/xxx 本地地址）。 */
  images?: string[];
  /** 服务端权威落库结果；有它就说明这一轮真的写了库 */
  receipt?: CaptureResult;
  /** 落库失败说明；非空 = 确实没记上 */
  receiptError?: string;
  /**
   * 本轮派出去的外部动作 id。状态本身不存快照（后台一直在变，存了就是过期数据），
   * 由 actions 表按需拉取，刷新后依然能对上。
   */
  actionIds?: string[];
  /** 本轮创建的原子派发计划 id；卡片状态进入页面后从服务端恢复。 */
  planIds?: string[];
  agentTaskIds?: string[];
};

export type AssistantSession = {
  key: string;
  title: string;
  messages: ChatEntry[];
  input: string;
  updatedAt: string;
  /** 已经用服务端数据对齐过；false 时下次发送会把本地缓存补种上去 */
  seeded?: boolean;
  /** 服务端是否确认持有这个会话（404 过就是还没有） */
  serverBacked?: boolean;
  /** 拉历史失败的原因。以前除 404 外一律静默吞掉，界面只剩空白，用户分不清「没消息」和「没读上来」 */
  loadError?: string;
};

type SessionPatch = Partial<Omit<AssistantSession, 'key'>>;

type AssistantState = {
  sessions: Record<string, AssistantSession>;
  ensure: (key: string, title: string) => void;
  update: (key: string, patch: SessionPatch) => void;
  remove: (key: string) => void;
  clear: () => void;
  /** 用服务端记录覆盖本地缓存；本地独有的（发送失败的）消息接在末尾保留。 */
  hydrate: (key: string) => Promise<void>;
};

const emptySession = (key: string, title: string): AssistantSession => ({
  key,
  title: title || '未命名对话',
  messages: [],
  input: '',
  updatedAt: new Date().toISOString(),
  seeded: false,
  serverBacked: false,
});

export function toEntry(message: StoredAssistantMessage): ChatEntry {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.images?.length ? { images: message.images } : {}),
    ...(message.receipt ? { receipt: message.receipt } : {}),
    ...(message.receiptError ? { receiptError: message.receiptError } : {}),
    ...(message.actionIds.length ? { actionIds: message.actionIds } : {}),
    ...(message.agentTaskIds?.length ? { agentTaskIds: message.agentTaskIds } : {}),
    ...(message.planIds?.length ? { planIds: message.planIds } : {}),
  };
}

/**
 * 合并服务端历史与本地缓存。
 * 服务端为准；本地只保留「服务端确实没有」的那几条——即发送失败后留在界面上的用户输入，
 * 免得用户刚打的字在重新对齐时凭空消失。同内容的按服务端那条算，避免重复气泡。
 */
function mergeMessages(server: ChatEntry[], local: ChatEntry[]): ChatEntry[] {
  const fingerprintOf = (entry: ChatEntry) => `${entry.role}\u0000${entry.content}\u0000${entry.images?.join(',') ?? ''}`;
  const fingerprints = new Set(server.map(fingerprintOf));
  const orphans = local.filter(
    (entry) => !entry.id && !fingerprints.has(fingerprintOf(entry)),
  );
  return [...server, ...orphans];
}

/**
 * v1 是「草稿待确认」时代的结构（会话上挂 drafts / savedSummary）。
 * v2 起改为服务端直接落库、凭证挂在消息上。
 * v3 起会话由服务端持有，本地退化为缓存：消息带上服务端 id，并记录补种状态。
 */
function migrateSessions(persisted: unknown): Record<string, AssistantSession> {
  const raw = (persisted as { sessions?: Record<string, Partial<AssistantSession>> } | null | undefined)?.sessions ?? {};
  const sessions: Record<string, AssistantSession> = {};
  for (const [key, session] of Object.entries(raw)) {
    if (!session || typeof session !== 'object') continue;
    sessions[key] = {
      key: typeof session.key === 'string' ? session.key : key,
      title: typeof session.title === 'string' ? session.title : '未命名对话',
      input: typeof session.input === 'string' ? session.input : '',
      updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date().toISOString(),
      // 老会话在服务端还没有记录：标成未补种，第一次发送时会把整段历史带上去
      seeded: false,
      serverBacked: session.serverBacked === true,
      messages: Array.isArray(session.messages)
        ? session.messages
          .filter((entry): entry is ChatEntry => Boolean(entry) && (entry.role === 'user' || entry.role === 'assistant'))
          .map(({ role, content, images, receipt, receiptError, actionIds, planIds, agentTaskIds, id }) => ({
            role, content, receipt, receiptError,
            ...(typeof id === 'number' ? { id } : {}),
            ...(Array.isArray(images) && images.length ? {
              images: images.filter((v): v is string => typeof v === 'string'),
            } : {}),
            actionIds: Array.isArray(actionIds) ? actionIds.filter((v): v is string => typeof v === 'string') : undefined,
            agentTaskIds: Array.isArray(agentTaskIds) ? agentTaskIds.filter((v): v is string => typeof v === 'string') : undefined,
            planIds: Array.isArray(planIds) ? planIds.filter((v): v is string => typeof v === 'string') : undefined,
          }))
        : [],
    };
  }
  return sessions;
}

// 代号重命名迁移：workbench.assistant-sessions -> workbench.assistant-sessions（仅执行一次，避免丢失本地会话缓存）
try {
  if (localStorage.getItem('workbench.assistant-sessions') == null && localStorage.getItem('yao.assistant-sessions') != null) {
    localStorage.setItem('workbench.assistant-sessions', localStorage.getItem('yao.assistant-sessions')!);
    localStorage.removeItem('yao.assistant-sessions');
  }
} catch { /* 隐私模式等场景下 localStorage 不可用，忽略 */ }

export const useAssistantSessions = create<AssistantState>()(
  persist(
    (set, get) => ({
      sessions: {},
      ensure: (key, title) => set((state) => state.sessions[key]
        ? state
        : { sessions: { ...state.sessions, [key]: emptySession(key, title) } }),
      update: (key, patch) => set((state) => {
        const current = state.sessions[key] ?? emptySession(key, '未命名对话');
        return {
          sessions: {
            ...state.sessions,
            [key]: {
              ...current,
              ...patch,
              updatedAt: new Date().toISOString(),
            },
          },
        };
      }),
      remove: (key) => set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[key];
        return { sessions };
      }),
      clear: () => set({ sessions: {} }),

      hydrate: async (key) => {
        const current = get().sessions[key];
        if (!current) return;
        try {
          const { session, messages } = await api.assistantSession(key);
          set((state) => {
            const latest = state.sessions[key] ?? current;
            return {
              sessions: {
                ...state.sessions,
                [key]: {
                  ...latest,
                  title: session.title,
                  messages: mergeMessages(messages.map(toEntry), latest.messages),
                  seeded: true,
                  serverBacked: true,
                  loadError: undefined,
                },
              },
            };
          });
        } catch (error) {
          // 404 是正常的：这个会话还没在服务端落过（比如刚打开还没说过话）。
          // 服务端也返回文字 '会话不存在'，把它一并当作「还没创建」处理，避免新会话顶部冒红条。
          // 其余错误也不打断渲染——但必须留痕，否则用户看到的是「空白且无从解释」。
          const message = (error as Error).message || '读取历史失败';
          const status = message.match(/\((\d{3})\)/)?.[1];
          const notFound = status === '404' || message.includes('会话不存在');
          set((state) => {
            const latest = state.sessions[key];
            if (!latest) return state;
            return {
              sessions: {
                ...state.sessions,
                [key]: notFound
                  ? { ...latest, seeded: false, serverBacked: false, loadError: undefined }
                  : { ...latest, loadError: message },
              },
            };
          });
        }
      },
    }),
    {
      name: 'workbench.assistant-sessions',
      version: 3,
      partialize: (state) => ({ sessions: state.sessions }),
      migrate: (persisted) => ({ sessions: migrateSessions(persisted) }) as unknown as AssistantState,
    },
  ),
);

/** 还没结束、需要继续盯的动作状态。 */
export const isActionOpen = (action: AssistantAction | undefined): boolean =>
  !!action && (action.status === 'dispatched' || action.status === 'acked' || action.status === 'progress');

/** 已经有结果但用户还没看过——前端据此显示未读提示与状态点。 */
export const isUnread = (action: AssistantAction): boolean =>
  action.readAt === null && (action.status === 'succeeded' || action.status === 'failed' || action.status === 'expired');

type HistoryState = {
  sessions: AssistantSessionRecord[];
  loading: boolean;
  /** 从服务端拉会话索引（不含消息体，列表页够用）。 */
  refresh: () => Promise<void>;
  remove: (key: string) => Promise<void>;
};

/**
 * 服务端会话索引。非持久化：列表随时会变，且进入会话时会重新拉全量消息。
 * 有了它，别的页面、别的浏览器里聊过的对话也能在这里翻到。
 */
export const useAssistantHistory = create<HistoryState>()((set, get) => ({
  sessions: [],
  loading: false,

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const { sessions } = await api.assistantSessions(50);
      set({ sessions });
    } catch {
      // 列表拉取失败不影响对话本身，静默保留上一次结果
    } finally {
      set({ loading: false });
    }
  },

  remove: async (key) => {
    await api.deleteAssistantSession(key);
    set((state) => ({ sessions: state.sessions.filter((session) => session.id !== key) }));
  },
}));

type ActionsState = {
  actions: Record<string, AssistantAction>;
  loading: boolean;
  error: string | null;
  /** 未读的终态结果：机器人回没回，不用打开对话也能知道。 */
  unreadIds: string[];
  /** 拉取动作状态；不传 ids 时刷新已知的全部。 */
  refresh: (ids?: string[]) => Promise<void>;
  /** 只拉未读列表，比 refresh 轻，给 Dock 的状态点用。 */
  refreshUnread: () => Promise<void>;
  /** 标已读；不传 ids 表示全部已读。 */
  markRead: (ids?: string[]) => Promise<void>;
  /** 人工结案：分类器没认出终态、或自己确认已经做完了。 */
  resolve: (id: string, status: 'succeeded' | 'failed', note?: string) => Promise<void>;
  /** 手动重发：已发出过会被后端挡掉（不二发），前端据此提示。 */
  retry: (id: string) => Promise<{ resent: boolean }>;
  /** 不等下一个调度周期，立刻扫一遍。 */
  pollNow: () => Promise<void>;
};

/**
 * 派单动作的实时状态。**不持久化**：状态由服务端后台轮询持续推进，
 * 存快照只会展示过期数据；会话里只记 id，刷新后按 id 重新拉。
 */
export const useAssistantActions = create<ActionsState>()((set, get) => ({
  actions: {},
  loading: false,
  error: null,
  unreadIds: [],

  refresh: async (ids) => {
    // 并发刷新同一批没有意义，服务端返回的是全量列表，取一次就够
    if (get().loading) return;
    void ids;
    set({ loading: true });
    try {
      const { actions } = await api.assistantActions(100);
      const map: Record<string, AssistantAction> = { ...get().actions };
      for (const action of actions) map[action.id] = action;
      // 顺带同步未读：全量列表里已经带了 readAt，不必再单独打一次未读接口
      set({ actions: map, unreadIds: actions.filter(isUnread).map((action) => action.id), error: null });
    } catch (error) {
      set({ error: (error as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  refreshUnread: async () => {
    try {
      const { actions } = await api.unreadAssistantActions();
      set({ unreadIds: actions.map((action) => action.id) });
    } catch {
      // 未读数是锦上添花，拉不到就保持上一次的值，不要打断页面
    }
  },

  markRead: async (ids) => {
    const before = get().unreadIds;
    const target = ids?.length ? ids : before;
    if (!target.length) return;
    // 乐观清掉：点了就该立刻消，网络失败再回滚，别让用户盯着红点等
    set({ unreadIds: before.filter((id) => !target.includes(id)) });
    try {
      await api.readAssistantActions(target);
    } catch {
      set({ unreadIds: before });
    }
  },

  resolve: async (id, status, note) => {
    const { action } = await api.resolveAssistantAction(id, status, note);
    set((state) => ({ actions: { ...state.actions, [id]: action }, error: null }));
  },

  retry: async (id) => {
    const { action, resent } = await api.retryAssistantAction(id);
    set((state) => ({ actions: { ...state.actions, [id]: action }, error: null }));
    return { resent };
  },

  pollNow: async () => {
    await api.pollAssistantActions();
    await get().refresh();
  },
}));

type DispatchPlansState = {
  plans: Record<string, AssistantDispatchPlan>;
  loadingIds: string[];
  /** 卡片自己的操作锁；同一计划确认与取消互斥。 */
  mutatingIds: string[];
  errorById: Record<string, string>;
  put: (plans: AssistantDispatchPlan[]) => void;
  refresh: (ids: string[]) => Promise<void>;
  confirm: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  retryItem: (planId: string, itemId: string) => Promise<void>;
  /** 撤回一条已发送的消息。只改投递状态，不改任务执行状态。 */
  recallItem: (planId: string, itemId: string) => Promise<void>;
};

const replacePlan = (
  state: DispatchPlansState,
  plan: AssistantDispatchPlan,
): Pick<DispatchPlansState, 'plans' | 'errorById'> => {
  const errorById = { ...state.errorById };
  delete errorById[plan.id];
  return { plans: { ...state.plans, [plan.id]: plan }, errorById };
};

/**
 * 派发计划状态不持久化。消息只记 plan id，打开会话后重新读取，避免把过期确认态留在本地。
 */
export const useAssistantDispatchPlans = create<DispatchPlansState>()((set, get) => ({
  plans: {},
  loadingIds: [],
  mutatingIds: [],
  errorById: {},

  put: (plans) => set((state) => {
    const next = { ...state.plans };
    for (const plan of plans) next[plan.id] = plan;
    return { plans: next };
  }),

  refresh: async (ids) => {
    const unique = [...new Set(ids)].filter(Boolean);
    const pending = unique.filter((id) => !get().loadingIds.includes(id));
    if (!pending.length) return;
    set((state) => ({ loadingIds: [...state.loadingIds, ...pending] }));
    const results = await Promise.allSettled(pending.map((id) => api.assistantDispatchPlan(id)));
    set((state) => {
      const plans = { ...state.plans };
      const errorById = { ...state.errorById };
      results.forEach((result, index) => {
        const id = pending[index];
        if (result.status === 'fulfilled') {
          plans[id] = result.value.plan;
          delete errorById[id];
        } else {
          errorById[id] = (result.reason as Error).message;
        }
      });
      return {
        plans,
        errorById,
        loadingIds: state.loadingIds.filter((id) => !pending.includes(id)),
      };
    });
  },

  confirm: async (id) => {
    if (get().mutatingIds.includes(id)) return;
    set((state) => ({ mutatingIds: [...state.mutatingIds, id] }));
    try {
      const { plan } = await api.confirmAssistantDispatchPlan(id);
      set((state) => replacePlan(state, plan));
    } catch (error) {
      set((state) => ({ errorById: { ...state.errorById, [id]: (error as Error).message } }));
      throw error;
    } finally {
      set((state) => ({ mutatingIds: state.mutatingIds.filter((value) => value !== id) }));
    }
  },

  cancel: async (id) => {
    if (get().mutatingIds.includes(id)) return;
    set((state) => ({ mutatingIds: [...state.mutatingIds, id] }));
    try {
      const { plan } = await api.cancelAssistantDispatchPlan(id);
      set((state) => replacePlan(state, plan));
    } catch (error) {
      set((state) => ({ errorById: { ...state.errorById, [id]: (error as Error).message } }));
      throw error;
    } finally {
      set((state) => ({ mutatingIds: state.mutatingIds.filter((value) => value !== id) }));
    }
  },

  retryItem: async (planId, itemId) => {
    if (get().mutatingIds.includes(itemId)) return;
    set((state) => ({ mutatingIds: [...state.mutatingIds, itemId] }));
    try {
      const { plan } = await api.retryAssistantDispatchItem(itemId);
      set((state) => replacePlan(state, plan));
    } catch (error) {
      set((state) => ({ errorById: { ...state.errorById, [planId]: (error as Error).message } }));
      throw error;
    } finally {
      set((state) => ({ mutatingIds: state.mutatingIds.filter((value) => value !== itemId) }));
    }
  },

  recallItem: async (planId, itemId) => {
    if (get().mutatingIds.includes(itemId)) return;
    set((state) => ({ mutatingIds: [...state.mutatingIds, itemId] }));
    try {
      const { plan } = await api.recallAssistantDispatchItem(itemId);
      set((state) => replacePlan(state, plan));
    } catch (error) {
      set((state) => ({ errorById: { ...state.errorById, [planId]: (error as Error).message } }));
      throw error;
    } finally {
      set((state) => ({ mutatingIds: state.mutatingIds.filter((value) => value !== itemId) }));
    }
  },
}));
