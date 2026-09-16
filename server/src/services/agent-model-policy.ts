/**
 * [INPUT]: 用户指定模型/费用约束，以及执行器在当前账号和通道查到的模型档位
 * [OUTPUT]: 规范化任务约束、时效/档位核验和明确的模型选择；缺少证据时拒绝执行
 * [POS]: 委派登记与执行器共用的模型边界；免费属于账号下的具体档位，不属于模型名称
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
export type ModelCostPolicy = 'unspecified' | 'free_only';
export type ModelRequirement = { requestedModel: string | null; requestedCostPolicy: ModelCostPolicy };

export function modelRequirement(model?: unknown, cost?: unknown): ModelRequirement {
  if (model != null && typeof model !== 'string') throw new Error('指定模型必须是名称');
  if (cost != null && cost !== 'unspecified' && cost !== 'free_only') throw new Error('模型费用约束无效');
  const name = typeof model === 'string' ? model.trim() : '';
  if (name.length > 120) throw new Error('模型名称过长');
  const freeAlias = /^(免费(?:模型)?|free(?: model)?)$/i.test(name);
  const requestedCostPolicy = freeAlias ? 'free_only' : cost ?? 'unspecified';
  if (requestedCostPolicy === 'free_only' && /^(auto|自动)$/i.test(name)) throw new Error('仅免费任务不能使用 Auto 路由，请选择明确的免费档位');
  return { requestedModel: freeAlias ? null : name || null, requestedCostPolicy };
}

/** 只能由执行器查询结果构造，不接受助手工具传入价格或账号范围。 */
export type ModelCatalog = {
  executor: string;
  accountScope: string;
  checkedAt: number;
  offers: Array<{
    selectionId: string;
    modelId: string;
    displayName: string;
    available: boolean;
    cost: 'free' | 'quota' | 'paid' | 'unknown';
    /** free 必须同时证明不扣金额、不扣付费积分；订阅额度不算免费。 */
    moneyCharge: number | null;
    creditCharge: number | null;
    expiresAt?: number;
  }>;
};
export type ModelSelection = ModelCatalog['offers'][number] & { checkedAt: number };
const CATALOG_MAX_AGE_MS = 60_000;

/** 每次启动/重试前查询；不能拿桌面目录作为 CLI 的价格证明。 */
export function selectTaskModel(input: ModelRequirement, catalog: ModelCatalog | null,
  scope: { executor: string; accountScope: string }, timestamp = Date.now()): ModelSelection {
  const requirement = modelRequirement(input.requestedModel, input.requestedCostPolicy);
  if (!catalog || !scope.accountScope || catalog.executor !== scope.executor || catalog.accountScope !== scope.accountScope) {
    throw new Error('缺少当前账号、当前执行通道的模型目录，未启动任务');
  }
  if (!Number.isFinite(catalog.checkedAt) || catalog.checkedAt > timestamp || timestamp - catalog.checkedAt > CATALOG_MAX_AGE_MS) {
    throw new Error('模型目录已过期，需要重新查询，未启动任务');
  }
  const name = requirement.requestedModel?.toLowerCase();
  let offers = catalog.offers.filter((offer) => offer.available && offer.selectionId && offer.modelId
    && (offer.expiresAt == null || (Number.isFinite(offer.expiresAt) && offer.expiresAt > timestamp))
    && (!name || offer.modelId.toLowerCase() === name || offer.displayName.toLowerCase() === name));
  if (requirement.requestedCostPolicy === 'free_only') {
    offers = offers.filter((offer) => offer.cost === 'free' && offer.moneyCharge === 0 && offer.creditCharge === 0
      && !/^(auto|自动)$/i.test(offer.modelId));
  }
  if (!offers.length) throw new Error('没有符合指定模型和费用要求的可用档位，未启动任务，不自动换用付费模型');
  if (name && offers.length !== 1) throw new Error('该模型存在多个档位，需要明确档位，未启动任务');
  return { ...offers[0], checkedAt: catalog.checkedAt };
}

export function modelRequirementLabel(input: ModelRequirement): string {
  return `${input.requestedModel ?? '未指定'}${input.requestedCostPolicy === 'free_only' ? ' · 仅免费（不扣金额/付费积分）' : ''}`;
}
