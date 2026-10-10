/**
 * 天枢 provider 配置桥。
 *
 * 把网关注册成 `~/.rivet/config.json` 里的一个 OpenAI provider。三条纪律：
 *
 * 1. **只动自己那一条。** 其它 provider 与 `provider.default` 原样保留 ——
 *    用户当前的默认模型不因为装了这个插件而改变。
 * 2. **先备份，再原子写。** 配置整体失效是这类集成最严重的事故形态。
 * 3. **如实汇报替换了什么。** 若原条目的 `baseUrl` 指向别处（例如用户自己
 *    维护的另一个 WorkBuddy 转接服务），回报里必须点名，而不是默默覆盖。
 *
 * 关于 capabilities 的取值：全部按**实测保守**填。上游是否接受天枢的前缀
 * 缓存参数没有实测结论，因此 `prefixCache: 'none'`、`prefixCompletion: false`
 * —— 与其猜一个可能 400 的优化，不如先跑通再做性能取舍。
 *
 * @module tianshu-workbuddy-connect/rivet-config
 */

import { existsSync } from 'node:fs'
import { PROVIDER_NAME } from './identity.js'
import {
  detectKeyPoolDrift, providerKeysPath, removeProviderKeyPool, syncProviderKeyPool,
} from './provider-keys.js'
import { backupFile, clip, readJsonSafe, rivetConfigPath, writeJsonAtomic } from './util.js'

/** 本插件负责的 provider key。 */
export { PROVIDER_NAME }

/** 保守的 provider 能力声明。 */
const CAPABILITIES = Object.freeze({
  cacheControl: false,
  // 网关已在上游请求前剥掉 stream_options，这里再声明一次是为了让天枢侧
  // 不生成它 —— 双重保险，成本为零。
  stripParams: ['stream_options'],
  toolJsonBug: false,
  prefixCache: 'none',
  prefixCompletion: false,
})

/** 读取天枢用户配置。缺失或非法时返回一个空壳（而不是抛错）。 */
export function readRivetConfig(path = rivetConfigPath()) {
  const raw = readJsonSafe(path)
  if (raw === undefined) return { config: {}, exists: existsSync(path), path }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`天枢配置文件不是 JSON 对象：${path}`)
  }
  return { config: raw, exists: true, path }
}

/** 由端口、令牌与模型列表构造 provider 条目。 */
export function buildProviderEntry({ port, token, models, stableId = true }) {
  return {
    name: PROVIDER_NAME,
    // 令牌是本机回环网关的准入凭据，不是上游凭据；它只对 127.0.0.1 上的这一个
    // 端口有效，且该端口本身还要求桌面 App 已登录。因此以明文落在 config.json
    // 与天枢既有的本地 provider 约定一致，不需要 secrets.json 间接层。
    apiKey: token,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    protocol: 'openai',
    capabilities: { ...CAPABILITIES },
    thinking: 'enabled',
    maxRetries: 2,
    models: models.map(model => ({ ...model })),
    unsupported: [],
    ...(stableId ? {} : {}),
  }
}

/**
 * 比较期望条目与现有条目，产出人类可读的差异清单。
 *
 * 用于让「配置是否真的生效」可被回答，而不是靠再去读一遍文件。
 */
export function diffProvider(existing, desired) {
  if (existing === undefined) return ['（原本没有 workbuddy 条目，将新建）']
  const notes = []
  if (existing.baseUrl !== desired.baseUrl) notes.push(`baseUrl：${existing.baseUrl ?? '（无）'} → ${desired.baseUrl}`)
  if (existing.apiKey !== desired.apiKey) notes.push('apiKey：已更新（网关令牌变更）')
  const before = Array.isArray(existing.models) ? existing.models.map(m => m.id) : []
  const after = desired.models.map(m => m.id)
  const added = after.filter(id => !before.includes(id))
  const removed = before.filter(id => !after.includes(id))
  if (added.length > 0) notes.push(`新增模型：${added.join(', ')}`)
  if (removed.length > 0) notes.push(`移除模型：${removed.join(', ')}`)
  if (added.length === 0 && removed.length === 0 && notes.length === 0) notes.push('（已是目标状态）')
  return notes
}

/**
 * 安装/刷新 provider 条目。
 *
 * **两处都要写**：`config.json` 的 `providers.<name>`，以及 `provider-keys.json`
 * 的 key 池。只写前者会被后者盖住 —— 天枢的键池是权威来源，详见
 * `provider-keys.js` 头注。返回报告里如实列出两处的改动。
 *
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.token
 * @param {Array}  options.models   天枢 model 配置数组
 * @param {boolean} [options.setDefault] 是否同时把默认 provider 指过来（默认否）
 * @param {string} [options.path]   显式配置文件路径（测试用）
 * @returns {{path: string, backup?: string, created: boolean, notes: string[], previousBaseUrl?: string, configChanged: boolean, keyPoolChanged: boolean, changed: boolean, keyPool: object}}
 */
export function installProvider(options) {
  const { config, exists, path } = readRivetConfig(options.path)
  const provider = typeof config.provider === 'object' && config.provider !== null ? config.provider : {}
  const providers = typeof provider.providers === 'object' && provider.providers !== null ? provider.providers : {}
  const existing = providers[PROVIDER_NAME]

  const desired = buildProviderEntry({
    port: options.port,
    token: options.token,
    models: options.models,
  })
  const notes = diffProvider(existing, desired)

  const nextProviders = { ...providers, [PROVIDER_NAME]: { ...(existing ?? {}), ...desired } }
  const nextProvider = { ...provider, providers: nextProviders }
  if (options.setDefault === true) nextProvider.default = PROVIDER_NAME
  const nextConfig = { ...config, provider: nextProvider }

  const changed = JSON.stringify(existing) !== JSON.stringify(nextProviders[PROVIDER_NAME])
    || (options.setDefault === true && provider.default !== PROVIDER_NAME)

  let written = { path, created: false, changed: false }
  if (changed || !exists) {
    const backup = exists ? backupFile(path) : undefined
    writeJsonAtomic(path, nextConfig)
    written = {
      path,
      ...(backup === undefined ? {} : { backup }),
      created: existing === undefined,
      changed: true,
    }
  }

  // key 池同步即使 config.json 无需改动也要做：两者可能已经分叉（历史遗留），
  // 而「config.json 已是目标状态」并不代表键池也是。
  const keyPool = syncProviderKeyPool({
    configPath: path,
    token: desired.apiKey,
    models: desired.models,
  })

  return {
    ...written,
    notes,
    ...(existing?.baseUrl === undefined ? {} : { previousBaseUrl: existing.baseUrl }),
    // 分开报：`config.json` 与 key 池是两份文件，混成一个布尔值会出现
    // 「配置已写入」而实际上只改了 key 池这种误导（反过来也一样）。
    configChanged: written.changed,
    keyPoolChanged: keyPool.action === 'created' || keyPool.action === 'updated',
    changed: written.changed || keyPool.action === 'created' || keyPool.action === 'updated',
    keyPool,
  }
}

/**
 * 从 baseUrl 反解出端口；形态不是「回环 + /v1」时返回 undefined。
 *
 * 与 {@link classifyBaseUrl} 共用同一套形态判定，区别只在返回值：这里给的是
 * 端口本身，供「网关该在哪个端口」这类需要**去连它**的场景使用。
 *
 * @param {unknown} baseUrl
 * @returns {number|undefined}
 */
export function portOfGatewayUrl(baseUrl) {
  if (typeof baseUrl !== 'string') return undefined
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    return undefined
  }
  if (!(url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return undefined
  if (url.pathname.replace(/\/$/u, '') !== '/v1') return undefined
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

/**
 * 天枢配置里「本插件网关应当在哪个端口」。
 *
 * `preTurn` 保活用它兜住状态文件丢失的情形：`stop`、清理数据目录、跨机器迁移
 * 都会让状态文件消失，而 `config.json` 里的绝对 URL 还在。此时天枢的每个请求
 * 都会打在空端口上，保活若只看状态文件就会判定「尚未接入」而什么都不做。
 *
 * 只认 `providers.<name>` 且必须是回环 `/v1` 形态 —— 本机完全可能同时跑着别的
 * 回环转接服务，只有这个 provider 名下的地址才是我们的。
 */
export function configuredGatewayPort(path = rivetConfigPath()) {
  const { config } = readRivetConfig(path)
  return portOfGatewayUrl(config?.provider?.providers?.[PROVIDER_NAME]?.baseUrl)
}

/**
 * 判断一个 baseUrl 是不是指向本插件网关。
 *
 * 只凭「回环 + /v1」**不足以**认定归属：本机完全可能同时跑着另一个 WorkBuddy
 * 转接服务（实测就有一个跑在 8789 的）。因此当调用方知道当前网关端口时，必须
 * 用端口精确比对；只有拿不到端口时才退回形状判定，并把它标注为不确定。
 *
 * @param {string} baseUrl
 * @param {number} [expectedPort] 当前网关端口
 * @returns {{match: boolean, confident: boolean}}
 */
export function classifyBaseUrl(baseUrl, expectedPort) {
  const port = portOfGatewayUrl(baseUrl)
  if (port === undefined) return { match: false, confident: true }
  if (expectedPort === undefined) return { match: true, confident: false }
  return { match: port === expectedPort, confident: true }
}

/** 简写：形状上是不是一个「回环 /v1」地址。 */
export function isOurBaseUrl(baseUrl) {
  return classifyBaseUrl(baseUrl).match
}

/**
 * 配置漂移检测：网关状态、`config.json` 与 `provider-keys.json` 三者是否一致。
 *
 * `doctor` 用它回答「为什么天枢里的 WorkBuddy 模型用不了」这一类问题。键池一
 * 致性是必须查的一环 —— 天枢实际发出的凭据取自键池，只查 `config.json` 会在
 * 「两个文件写着不同的 Key」时给出「配置正常」的错误结论。
 *
 * @param {object} [options]
 * @param {number} [options.port] 当前网关端口 —— 给了就用端口精确判定归属
 * @param {string} [options.path] 显式配置文件路径
 */
export function detectDrift(options = {}) {
  const path = options.path ?? rivetConfigPath()
  const { config, exists } = readRivetConfig(path)
  if (!exists) return { ok: false, reason: `天枢配置文件不存在：${path}` }
  const providers = config.provider?.providers ?? {}
  const entry = providers[PROVIDER_NAME]
  if (entry === undefined) return { ok: false, reason: '配置里没有 `providers.workbuddy` 条目，尚未接入' }
  if (typeof entry.baseUrl !== 'string') return { ok: false, reason: '`providers.workbuddy` 缺少 baseUrl' }

  const classification = classifyBaseUrl(entry.baseUrl, options.port)
  if (!classification.match) {
    return {
      ok: false,
      reason: options.port === undefined
        ? `\`providers.workbuddy\` 的 baseUrl 指向别处（${clip(entry.baseUrl, 80)}），不是本插件的网关`
        : `\`providers.workbuddy\` 指向 ${clip(entry.baseUrl, 80)}，但当前网关在 ${options.port} 端口上运行；重新执行接入可修正`,
    }
  }
  // `config.json` 里的 apiKey **不是必需**的：天枢的 `saveConfig` 会主动把 provider
  // 级明文剥掉（manager.ts「config.json never receives plaintext API keys」），凭据
  // 由 provider-keys.json 的键池供给。因此这里不能因为内联值为空就判「未接入」——
  // 那会在一个完全可用的接入上稳定报红，把真故障淹掉。
  //
  // 真正要回答的是「天枢实际会拿哪个凭据」，所以：
  //   1. 内联值可用 → 用它（未迁移/未剥落的形态）；
  //   2. 内联值缺失 → 交给键池决定（下面 detectKeyPoolDrift 会核对它是否 inline 形态、
  //      以及与网关令牌是否一致）；键池也没有才是真的没配。
  const inlineKey = typeof entry.apiKey === 'string' && entry.apiKey !== '' ? entry.apiKey : undefined

  // 「生效的 Key」以网关为准：网关没跑时退而比较 config.json 的内联值。
  // 内联值也缺失时不传 configKey —— 一切交给键池判定（它才是权威）。
  const expectedKey = options.token ?? inlineKey
  const keyPool = detectKeyPoolDrift({ configPath: path, configKey: expectedKey })
  if (!keyPool.ok) {
    return {
      ok: false,
      reason: `Key 池不一致：${keyPool.reason}`,
      keyPool,
      hint: '重新执行接入会同时对齐 config.json 与 provider-keys.json',
    }
  }
  // 内联值缺失、但键池给出了 inline 凭据 = 天枢的正常落盘形态（saveConfig 剥了明文）。
  // 只在键池也没给出任何凭据时才判失败。
  if (inlineKey === undefined && keyPool.effective === undefined) {
    return { ok: false, reason: '`providers.workbuddy` 缺少 apiKey，且键池里也没有可用凭据' }
  }
  // 键池一致但 config.json 落伍：请求能成功，可配置页显示的是旧值 —— 值得点名，
  // 否则下次有人照着配置页排查会得出错误结论。
  const staleDisplay = options.token !== undefined && inlineKey !== undefined && inlineKey !== options.token

  const models = Array.isArray(entry.models) ? entry.models : []
  return {
    ok: true,
    baseUrl: entry.baseUrl,
    modelCount: models.length,
    isDefault: config.provider?.default === PROVIDER_NAME,
    keyPool,
    ...(staleDisplay ? { note: 'config.json 里的 apiKey 与当前网关令牌不同（请求实际用键池，故不影响使用；重新接入可对齐显示）' } : {}),
    ...(classification.confident ? {} : { note: '未能核对端口（网关未运行），只按地址形状判定' }),
  }
}

/**
 * 移除 provider 条目。
 *
 * 两处都清：`config.json` 的 `providers.<name>` 与 `provider-keys.json` 的键池。
 * 只删前者会留下一个键池条目 —— 天枢会在下次加载时用它把 provider 重新“捞”回来
 * （凭据从键池取），表现为「明明登出了却还在用」。
 *
 * 若 `provider.default` 正指向它，则一并清掉 `default` 字段而不是替用户选一个新
 * 的 —— 让天枢回落到自己的内置默认，比替用户决定用一个别的 provider 更可预期。
 */
export function removeProvider(path = rivetConfigPath()) {
  const { config, exists } = readRivetConfig(path)
  const keyPool = removeProviderKeyPool({ configPath: path })
  if (!exists) return { removed: false, reason: '配置文件不存在', keyPool }
  const provider = typeof config.provider === 'object' && config.provider !== null ? config.provider : {}
  const providers = typeof provider.providers === 'object' && provider.providers !== null ? provider.providers : {}
  if (!(PROVIDER_NAME in providers)) {
    return { removed: false, reason: '`providers.workbuddy` 不存在', keyPool }
  }

  const nextProviders = { ...providers }
  delete nextProviders[PROVIDER_NAME]
  const nextProvider = { ...provider, providers: nextProviders }
  let clearedDefault = false
  if (nextProvider.default === PROVIDER_NAME) {
    delete nextProvider.default
    clearedDefault = true
  }
  const backup = backupFile(path)
  writeJsonAtomic(path, { ...config, provider: nextProvider })
  return { removed: true, ...(backup === undefined ? {} : { backup }), clearedDefault, keyPool }
}

export { providerKeysPath }
