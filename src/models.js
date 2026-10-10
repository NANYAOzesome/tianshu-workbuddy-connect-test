/**
 * 模型目录：上游 `/v3/config` 文档 → 天枢 model 配置行。
 *
 * 上游把「CLI 可用模型」放在 `data.agents[name=cli].models`（字符串 id 列表），
 * 把每个模型的元数据放在 `data.models`（对象行）。两者的**交集**才是这个
 * 插件真正能服务的名册 —— 只按 `data.models` 全量渲染会把 App 内部模型
 * （如 `default`）也列出来，那些 id 在 chat 端点不一定可用。
 *
 * @module tianshu-workbuddy-connect/models
 */

/** 天枢 `reasoningEffort` 的合法取值。 */
const TIENSHU_EFFORTS = new Set(['off', 'low', 'medium', 'high', 'max'])

/**
 * 内置兜底名册（国内版）。
 *
 * 只在「配置写入时上游不可达」这一种情况下被使用：网关在线时永远以实时
 * 目录为准，并把结果缓存下来。快照按 2026-10 实测的 CLI 名册录入，字段取自
 * 上游同一份文档，不是手写猜测。
 */
export const FALLBACK_CN_MODELS = Object.freeze([
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1000000, maxTokens: 128000, supportsVision: true, effort: 'high' },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1000000, maxTokens: 128000, supportsVision: true, effort: 'high' },
  { id: 'space-bunny', name: 'Space-Bunny', contextWindow: 1000000, maxTokens: 128000, supportsVision: true, effort: 'max' },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 64000, supportsVision: true, effort: 'high' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1000000, maxTokens: 131072, supportsVision: true, effort: 'high' },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, maxTokens: 64000, supportsVision: true, effort: 'high' },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, maxTokens: 48000, supportsVision: true, effort: 'high' },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200000, maxTokens: 64000, supportsVision: true, effort: 'high' },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1000000, maxTokens: 32000, supportsVision: true, effort: 'high' },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1000000, maxTokens: 64000, supportsVision: true, effort: 'high' },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256000, maxTokens: 32000, supportsVision: true, effort: 'high' },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256000, maxTokens: 32000, supportsVision: true, effort: 'high' },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512000, maxTokens: 64000, supportsVision: true, effort: 'high' },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: 200000, maxTokens: 48000, supportsVision: true, effort: 'high' },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 960000, maxTokens: 64000, supportsVision: true, effort: 'high' },
  { id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000, supportsVision: true, effort: 'high' },
  { id: 'hy3-x', name: 'Hy3', contextWindow: 192000, maxTokens: 64000, supportsVision: true, effort: 'high' },
])

/** 内置兜底名册（国际版）。国际版目录来自 App 界面接口，随上游变化，此处只留常见档。 */
export const FALLBACK_AI_MODELS = Object.freeze([
  { id: 'gpt-5.6', name: 'GPT-5.6', contextWindow: 400000, maxTokens: 128000, supportsVision: true, effort: 'high' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000, maxTokens: 64000, supportsVision: true, effort: 'high' },
])

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * 上游 effort 词表 → 天枢 `reasoningEffort`。
 *
 * 天枢只认 `off|low|medium|high|max`；上游还会出现 `xhigh`，映射到最高档
 * `max`（语义上都是「最高档」，而不是贴身档位，故不做线性缩放）。
 */
export function normalizeEffort(value) {
  if (typeof value !== 'string') return undefined
  const lower = value.toLowerCase()
  if (lower === 'xhigh') return 'max'
  return TIENSHU_EFFORTS.has(lower) ? lower : undefined
}

/** 由一个上游模型行决定天枢侧的推理档。 */
function effortFor(row) {
  const reasoning = isObject(row.reasoning) ? row.reasoning : {}
  const declared = normalizeEffort(reasoning.defaultEffort)
  if (declared !== undefined) return declared
  const supported = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : []
  // 未声明默认档时，取已声明支持的最高档 —— 上游只在这类模型上真正校验该参数。
  for (const candidate of ['max', 'high', 'medium', 'low']) {
    if (supported.includes(candidate)) return normalizeEffort(candidate)
  }
  // 只报「支持推理」但既无默认档也无档位集合：不写具体档位，交给上游默认。
  return row.onlyReasoning === true ? 'high' : undefined
}

/** 天枢 tier 推断：按上下文与是否旗舰档做保守归类，仅影响路由回退偏好。 */
function tierFor(row, model) {
  const ctx = model.contextWindow ?? 0
  if (ctx >= 900000) return 'strong'
  if (ctx >= 190000) return 'balanced'
  return 'cheap'
}

/**
 * 把一条上游模型行映射为天枢 model 配置。
 *
 * 只写 schema 认识且有意义的下游字段：`alias` 自天枢 2026-09 起已废弃并被
 * schema 剥离，写它只会产生噪音配置。
 */
export function toTianshuModel(row) {
  const contextWindow = positiveInt(row.maxInputTokens) ?? positiveInt(row.maxAllowedSize) ?? 200000
  const declaredOut = positiveInt(row.maxOutputTokens) ?? 32000
  const model = {
    id: row.id,
    ...(typeof row.descriptionZh === 'string' && row.descriptionZh !== ''
      ? { description: row.descriptionZh }
      : typeof row.descriptionEn === 'string' && row.descriptionEn !== ''
        ? { description: row.descriptionEn }
        : {}),
    contextWindow,
    // 输出上限永远不高于上下文窗口，与天枢 schema 的 transform 同口径 —— 在这里
    // 就夹住，写进配置的值与运行时解析结果一致，便于排查。
    maxTokens: Math.min(declaredOut, contextWindow),
    supportsVision: row.supportsImages === true,
  }
  const effort = effortFor(row)
  if (effort !== undefined) model.reasoningEffort = effort
  const tier = tierFor(row, model)
  if (tier !== undefined) model.tier = tier
  return model
}

/**
 * 解析 `/v3/config` 响应体，返回 CLI 名册（已按上游顺序去重）。
 *
 * 文档可能是 `{code,msg,data}` 包裹形态，也可能把产品文档裸放在顶层 ——
 * 两种都在实盘见过，因此只在带 `models`/`agents` 时才当作目录文档。
 */
export function parseCatalog(document) {
  const envelope = isObject(document) ? document : {}
  const data = isObject(envelope.data) && (Array.isArray(envelope.data.models) || Array.isArray(envelope.data.agents))
    ? envelope.data
    : Array.isArray(envelope.models) || Array.isArray(envelope.agents)
      ? envelope
      : undefined
  if (data === undefined) {
    return { models: [], cliIds: [], rows: [], reason: '上游文档里没有 models/agents 字段' }
  }

  const rows = Array.isArray(data.models) ? data.models.filter(isObject) : []
  const byId = new Map(rows.map(row => [row.id, row]))

  const cliAgent = Array.isArray(data.agents)
    ? data.agents.find(agent => isObject(agent) && agent.name === 'cli')
    : undefined
  let cliIds = cliAgent !== undefined && Array.isArray(cliAgent.models)
    ? cliAgent.models.filter(id => typeof id === 'string' && id !== '')
    : []

  // 没有 agents 段（部分上游形态）时退回全量 models，至少不返回空名册。
  if (cliIds.length === 0) cliIds = rows.map(row => row.id)

  const seen = new Set()
  const models = []
  for (const id of cliIds) {
    if (seen.has(id)) continue
    const row = byId.get(id)
    // 名册里有 id 但 models 段没有对应行：跳过而不是猜 —— 天枢侧没有上下文
    // 窗口的模型会在请求时按默认值截断，宁可少列也不误导。
    if (row === undefined) continue
    seen.add(id)
    models.push(toTianshuModel(row))
  }

  return {
    models,
    cliIds,
    rows,
    enterpriseId: typeof data.enterpriseId === 'string' ? data.enterpriseId : undefined,
  }
}

/** 兜底名册 → 天枢 model 配置。 */
export function fallbackModels(variant) {
  const source = variant.region === 'global' ? FALLBACK_AI_MODELS : FALLBACK_CN_MODELS
  return source.map(entry => ({
    id: entry.id,
    description: entry.name,
    contextWindow: entry.contextWindow,
    maxTokens: Math.min(entry.maxTokens, entry.contextWindow),
    supportsVision: entry.supportsVision === true,
    ...(entry.effort === undefined ? {} : { reasoningEffort: entry.effort }),
    tier: entry.contextWindow >= 900000 ? 'strong' : entry.contextWindow >= 190000 ? 'balanced' : 'cheap',
  }))
}

/**
 * 内存目录：保存当前名册与来源，供网关 `/v1/models` 与状态接口读取。
 *
 * 来源分级：`live`（本次拉取）→ `saved`（上次成功拉取）→ `fallback`（内置）。
 * 与源插件同构，让「为什么列表是这个样子」永远可回答。
 */
export class ModelCatalog {
  constructor(variant) {
    this.variant = variant
    this.models = fallbackModels(variant)
    this.source = 'fallback'
    this.fetchedAtMs = undefined
    this.error = undefined
  }

  set(models, source) {
    this.models = models
    this.source = source
    this.fetchedAtMs = Date.now()
    this.error = undefined
  }

  fail(error) {
    this.error = error
  }

  ids() {
    return this.models.map(model => model.id)
  }
}
