/**
 * 天枢 key 池（`provider-keys.json`）桥。
 *
 * 这是本次适配里最容易踩空、后果又最难查的一处。天枢的配置层有一条明确的
 * 架构决定：**keys 池的权威来源不是 `config.json`，而是同级目录下的
 * `provider-keys.json`**（`src/config/provider-keys-store.ts` 头注：「A′：keys
 * 移出 config.json」）。`loadConfig` 的行为是：
 *
 *   1. `migrateProviderToKeys()` 在 `config.json` 没有 keys 时，用它的内联
 *      `apiKey` 合成 `keys[0]`；
 *   2. `injectProviderKeys()` **优先采用文件里的池**（`if (fromFile?.length > 0)
 *      provider.keys = fromFile`），并把池写回磁盘。
 *
 * 于是只要某次运行把池落过盘，之后 `config.json` 里的 `apiKey` 就再也影响不了
 * 实际发出的凭据 —— 配置页显示的是 `config.json` 的值，客户端用的是池里的值，
 * 两者可以永远不同。实测就是这么撞上的：插件每次接入换一个新令牌、只写
 * `config.json`，而池里留的是第一次的令牌，表现是稳定的 401。
 *
 * 因此本模块做两件事，缺一不可：
 *   - 接入时把池里的 `workbuddy` 条目一并对齐（令牌 + 模型清单）；
 *   - `doctor` 能回答「生效的到底是哪一个 Key」——这是上述分歧唯一可见的地方。
 *
 * 写盘纪律与 `rivet-config.js` 一致：只动自己那一条，其它 provider 原样保留，
 * 覆盖前先备份，原子写。
 *
 * @module tianshu-workbuddy-connect/provider-keys
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROVIDER_NAME } from './identity.js'
import { backupFile, readJsonSafe, rivetConfigPath, writeJsonAtomic } from './util.js'

/** 文件形状版本，与天枢 `PROVIDER_KEYS_FILE_VERSION` 对齐。 */
export const PROVIDER_KEYS_FILE_VERSION = 1

/** key 池条目的 id/label —— 与天枢从 `config.json` 迁移时合成的一致。 */
export const DEFAULT_KEY_ID = 'default'
export const DEFAULT_KEY_LABEL = 'default'

/**
 * `provider-keys.json` 路径。与 `config.json` 同目录，`RIVET_CONFIG_PATH`
 * 指向别处时跟着走（与天枢 `providerKeysPath()` 同一规则）。
 */
export function providerKeysPath(configPath = rivetConfigPath()) {
  return join(dirname(configPath), 'provider-keys.json')
}

/** 读取 key 池文件；缺失或非法时返回 undefined（绝不抛出）。 */
export function readProviderKeys(path = providerKeysPath()) {
  const raw = readJsonSafe(path)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  if (raw.version !== PROVIDER_KEYS_FILE_VERSION) return undefined
  const providers = raw.providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return undefined
  return { version: PROVIDER_KEYS_FILE_VERSION, providers }
}

/** 取某 provider 在当前生效路径下实际使用的内联 Key。 */
export function effectiveKeyOf(entry) {
  if (!Array.isArray(entry) || entry.length === 0) return undefined
  const first = entry[0]
  if (typeof first !== 'object' || first === null) return undefined
  if (typeof first.keyRef === 'string' && first.keyRef !== '') {
    return { kind: 'keyRef', value: first.keyRef }
  }
  if (typeof first.apiKey === 'string' && first.apiKey !== '') {
    return { kind: 'inline', value: first.apiKey }
  }
  if (typeof first.apiKeyEnv === 'string' && first.apiKeyEnv !== '') {
    return { kind: 'env', value: first.apiKeyEnv }
  }
  return undefined
}

/**
 * 对齐本插件的 key 池条目。
 *
 * 保留已有的 `id` / `label` / 其它 provider 的全部内容，只改「本插件应当拥有」
 * 的字段。刻意**不写 `keyRef`**：`keyRef` 指向 `secrets.json`，一旦存在就会
 * 盖过内联 `apiKey`，而网关令牌不是上游凭据、没有进 secrets.json 的理由。
 * 若原条目带着 `keyRef`，说明有别的机制在管这个 provider，此时只报警不动手。
 *
 * @returns {{path: string, action: 'unchanged'|'created'|'updated'|'blocked', backup?: string, notes: string[], effective?: object}}
 */
export function syncProviderKeyPool(options) {
  const path = options.path ?? providerKeysPath(options.configPath)
  const { token, models } = options
  const existing = readProviderKeys(path)

  if (options.rotateAwayFromKeyRef !== true) {
    const current = effectiveKeyOf(existing?.providers?.[PROVIDER_NAME])
    if (current?.kind === 'keyRef') {
      return {
        path,
        action: 'blocked',
        notes: [`key 池里的 \`${PROVIDER_NAME}\` 用的是 keyRef（指向 secrets.json），不由本插件管理，未改动`],
        effective: current,
      }
    }
  }

  const pools = existing?.providers ?? {}
  const previous = Array.isArray(pools[PROVIDER_NAME]) ? pools[PROVIDER_NAME] : []
  const first = typeof previous[0] === 'object' && previous[0] !== null ? previous[0] : {}

  const entry = {
    ...first,
    id: typeof first.id === 'string' && first.id !== '' ? first.id : DEFAULT_KEY_ID,
    label: typeof first.label === 'string' && first.label !== '' ? first.label : DEFAULT_KEY_LABEL,
    apiKey: token,
    models: models.map(model => ({ ...model })),
  }
  // keyRef 会盖过 apiKey；进入到这里说明要么原本没有，要么已被显式允许覆盖。
  delete entry.keyRef

  const nextEntry = [entry]
  const nextFile = {
    version: PROVIDER_KEYS_FILE_VERSION,
    providers: { ...pools, [PROVIDER_NAME]: nextEntry },
  }

  const notes = []
  if (previous.length === 0) notes.push(`在 \`${PROVIDER_NAME}\` 下新建 key 池条目`)
  else if (previous.length > 1) notes.push(`\`${PROVIDER_NAME}\` 原有 ${previous.length} 条 key，已收敛为 1 条（本插件只用一个网关令牌）`)
  const before = effectiveKeyOf(previous)
  if (before?.value !== token) notes.push('key 池里的令牌已更新（这是配置页与请求端可能不一致的地方）')
  const modelsChanged = JSON.stringify(previous[0]?.models ?? []) !== JSON.stringify(nextEntry[0].models)
  if (modelsChanged) notes.push('key 池里的模型清单已同步')

  if (JSON.stringify(nextFile) === JSON.stringify(existing)) {
    return { path, action: 'unchanged', notes: ['已是目标状态'], effective: { kind: 'inline', value: token } }
  }

  const backup = existsSync(path) ? backupFile(path) : undefined
  writeJsonAtomic(path, nextFile, 0o600)
  return {
    path,
    ...(backup === undefined ? {} : { backup }),
    action: existing === undefined ? 'created' : 'updated',
    notes,
    effective: { kind: 'inline', value: token },
  }
}

/**
 * 分歧检测：`config.json` 里写的 Key 与 key 池里生效的 Key 是否同一个。
 *
 * 这就是「配置页显示 /v1 用的是新令牌，实际请求带的是旧令牌」这一现象的唯一
 * 可见入口。存在 `provider-keys.json` 时它是权威，因此必须在接入报告与诊断里
 * 显式呈现，而不是等用户去比对两个文件。
 */
export function detectKeyPoolDrift(options = {}) {
  const configKey = options.configKey
  const path = options.path ?? providerKeysPath(options.configPath)
  const file = readProviderKeys(path)
  if (file === undefined) {
    return { ok: true, authoritative: 'config.json', reason: '没有 provider-keys.json，config.json 的内联 Key 即权威' }
  }
  const pool = file.providers?.[PROVIDER_NAME]
  if (pool === undefined) {
    return { ok: true, authoritative: 'config.json', reason: `provider-keys.json 里没有 \`${PROVIDER_NAME}\` 条目` }
  }
  const effective = effectiveKeyOf(pool)
  if (effective === undefined) {
    return { ok: false, authoritative: 'provider-keys.json', reason: `\`${PROVIDER_NAME}\` 的 key 池条目没有任何凭据字段` }
  }
  if (effective.kind !== 'inline') {
    return {
      ok: false,
      authoritative: 'provider-keys.json',
      reason: `\`${PROVIDER_NAME}\` 的 key 池用 ${effective.kind}（${effective.value}）取凭据，网关令牌不生效`,
      effective,
    }
  }
  if (configKey !== undefined && effective.value !== configKey) {
    return {
      ok: false,
      authoritative: 'provider-keys.json',
      reason: 'config.json 与 provider-keys.json 里的 Key 不一致；天枢实际使用后者',
      effective,
    }
  }
  return { ok: true, authoritative: 'provider-keys.json', reason: '两处 Key 一致', effective }
}

/**
 * 移除本插件的 key 池条目。
 *
 * 只删 `providers.<name>`；文件因此变空时保留文件本身（天枢靠文件存在性区分
 * 「没有文件」与「空池」，删掉文件会让它退回迁移路径）。
 */
export function removeProviderKeyPool(options = {}) {
  const path = options.path ?? providerKeysPath(options.configPath)
  const file = readProviderKeys(path)
  if (file === undefined || file.providers?.[PROVIDER_NAME] === undefined) {
    return { removed: false, path, reason: 'key 池里没有本插件的条目' }
  }
  const pools = { ...file.providers }
  delete pools[PROVIDER_NAME]
  const backup = backupFile(path)
  writeJsonAtomic(path, { version: PROVIDER_KEYS_FILE_VERSION, providers: pools }, 0o600)
  return { removed: true, path, ...(backup === undefined ? {} : { backup }) }
}
