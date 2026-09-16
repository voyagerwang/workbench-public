/**
 * [INPUT]: SQLite 持久化的长期执行者/模型偏好（agent_execution_preferences），编排层的登记输入
 * [OUTPUT]: 偏好的确定性存储、解析与撤销（resolveExecutionPreference）；解析规则=临时指定>长期偏好>默认
 * [POS]: S19 策略后端；不读自由文本记忆、不改记忆面板；不支持/不可用的执行者与模型在登记或派发时
 *        明确失败（白名单校验仍在 agent-registry / agent-execution），绝不静默换模型
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { db, now } from '../db.js';
import { isExecutorAllowed } from './agent-registry.js';
import { modelRequirement, type ModelCostPolicy } from './agent-model-policy.js';

export type ExecutionPreference = {
  executor: string;
  requestedModel: string | null;
  requestedCostPolicy: ModelCostPolicy;
  updatedAt: string;
};

export type PreferenceSource = 'temporary' | 'preference' | 'default';

export function getExecutionPreference(): ExecutionPreference | null {
  const row = db.prepare(`SELECT executor,requested_model,requested_cost_policy,updated_at FROM agent_execution_preferences WHERE scope_key='global'`)
    .get() as { executor: string; requested_model: string | null; requested_cost_policy: ModelCostPolicy; updated_at: string } | undefined;
  if (!row) return null;
  return { executor: row.executor, requestedModel: row.requested_model, requestedCostPolicy: row.requested_cost_policy, updatedAt: row.updated_at };
}

/** 保存长期偏好；执行者必须已在册并启用，模型/费用约束经 modelRequirement 规范化校验。
 *  模型是否获派发授权不在保存时判定——由登记/派发层明确失败，这里不静默放宽。 */
export function setExecutionPreference(input: { executor: string; model?: string | null; costPolicy?: ModelCostPolicy }): ExecutionPreference {
  const raw = input.executor?.trim();
  if (!raw) throw Object.assign(new Error('缺少执行者'), { statusCode: 400, publicCode: 'executor_required' });
  const entry = isExecutorAllowed(raw);
  if (!entry) throw Object.assign(new Error(`未登记或未启用的执行者：${raw}`), { statusCode: 400, publicCode: 'executor_unknown' });
  const requirement = modelRequirement(input.model ?? undefined, input.costPolicy ?? 'unspecified');
  const ts = now();
  db.prepare(`INSERT INTO agent_execution_preferences(scope_key,executor,requested_model,requested_cost_policy,created_at,updated_at)
    VALUES('global',?,?,?,?,?)
    ON CONFLICT(scope_key) DO UPDATE SET executor=excluded.executor,requested_model=excluded.requested_model,
      requested_cost_policy=excluded.requested_cost_policy,updated_at=excluded.updated_at`)
    .run(entry.id, requirement.requestedModel, requirement.requestedCostPolicy, ts, ts);
  return getExecutionPreference()!;
}

/** 撤销长期偏好；返回是否存在过（幂等，重复撤销返回 false 而不是报错）。 */
export function clearExecutionPreference(): boolean {
  const info = db.prepare(`DELETE FROM agent_execution_preferences WHERE scope_key='global'`).run();
  return info.changes > 0;
}

/** 解析规则（确定性，记录级）：任一字段有临时指定时整条偏好失效，未指定的字段回到调用方默认；
 *  完全没有临时指定才使用长期偏好；两者皆无回到默认。这样"本次指定 Codex"不会背上
 *  偏好执行者的模型组合，临时指定也不污染默认。
 *  这里只做选择，不做能力判断：不可用的执行者/模型由登记（agent-registry 白名单）与
 *  派发（agent-execution 模型授权）明确失败。 */
export function resolveExecutionPreference(input: {
  executor?: string | null; model?: string | null; costPolicy?: ModelCostPolicy | null;
}): { executor: string | null; requestedModel: string | null; requestedCostPolicy: ModelCostPolicy; source: PreferenceSource } {
  const hasTemporary = Boolean(input.executor?.trim()) || input.model != null || input.costPolicy != null;
  if (hasTemporary) {
    return {
      executor: input.executor?.trim() ?? null,
      requestedModel: input.model ?? null,
      requestedCostPolicy: input.costPolicy ?? 'unspecified',
      source: 'temporary',
    };
  }
  const preference = getExecutionPreference();
  if (preference) {
    return { executor: preference.executor, requestedModel: preference.requestedModel, requestedCostPolicy: preference.requestedCostPolicy, source: 'preference' };
  }
  return { executor: null, requestedModel: null, requestedCostPolicy: 'unspecified', source: 'default' };
}
