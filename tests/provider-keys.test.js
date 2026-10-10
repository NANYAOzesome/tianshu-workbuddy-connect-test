/**
 * key 池桥的单测。
 *
 * 这一层存在的唯一理由是「天枢的 Key 权威来源是 provider-keys.json 而不是
 * config.json」。测试围绕这条结论展开：能不能发现分叉、能不能对齐、会不会
 * 越界改别人的条目。
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { cleanupTmpDir, makeTmpDir } from './helpers/tmp.js'
import {
  DEFAULT_KEY_ID, detectKeyPoolDrift, effectiveKeyOf, providerKeysPath,
  readProviderKeys, removeProviderKeyPool, syncProviderKeyPool,
} from '../src/provider-keys.js'
import { installProvider, removeProvider } from '../src/rivet-config.js'

/** 建一个隔离的数据根：config.json + provider-keys.json 都在同一目录。 */
function sandbox() {
  const dir = makeTmpDir('wb-keys-')
  return {
    dir,
    configPath: join(dir, 'config.json'),
    keysPath: join(dir, 'provider-keys.json'),
    cleanup: () => cleanupTmpDir(dir),
  }
}

const MODELS = [
  { id: 'glm-5.3', contextWindow: 1000000, maxTokens: 64000, reasoningEffort: 'high' },
  { id: 'kimi-k3-1', contextWindow: 1000000, maxTokens: 32000, reasoningEffort: 'high' },
]

test('key 池路径与 config.json 同级（跟随 RIVET_CONFIG_PATH 的目录）', () => {
  const box = sandbox()
  try {
    assert.equal(providerKeysPath(box.configPath), box.keysPath)
  } finally { box.cleanup() }
})

test('没有 provider-keys.json：config.json 的内联 Key 即权威', () => {
  const box = sandbox()
  try {
    const drift = detectKeyPoolDrift({ configPath: box.configPath, configKey: 'wb-x' })
    assert.equal(drift.ok, true)
    assert.equal(drift.authoritative, 'config.json')
    assert.equal(readProviderKeys(box.keysPath), undefined)
  } finally { box.cleanup() }
})

test('首次同步：建文件、写入令牌与模型、只动自己那一条', () => {
  const box = sandbox()
  try {
    // 别的 provider 先占位，稍后必须逐字节不变。
    writeFileSync(box.keysPath, JSON.stringify({
      version: 1,
      providers: {
        deepseek: [{ id: 'default', label: 'default', keyRef: 'deepseek', models: [{ id: 'deepseek-v4-pro' }] }],
      },
    }))

    const result = syncProviderKeyPool({ configPath: box.configPath, token: 'wb-token-a', models: MODELS })
    assert.equal(result.action, 'updated')
    assert.equal(result.effective.kind, 'inline')

    const file = readProviderKeys(box.keysPath)
    assert.equal(file.version, 1)
    assert.deepEqual(Object.keys(file.providers).sort(), ['deepseek', 'workbuddy'])
    assert.deepEqual(file.providers.deepseek, [{ id: 'default', label: 'default', keyRef: 'deepseek', models: [{ id: 'deepseek-v4-pro' }] }])
    const entry = file.providers.workbuddy[0]
    assert.equal(entry.id, DEFAULT_KEY_ID)
    assert.equal(entry.apiKey, 'wb-token-a')
    assert.deepEqual(entry.models.map(m => m.id), ['glm-5.3', 'kimi-k3-1'])
    assert.equal('keyRef' in entry, false, '不能带 keyRef —— 它会盖过内联 apiKey')
  } finally { box.cleanup() }
})

test('分叉检测：池里是旧令牌时报不一致，并指明权威来源是键池', () => {
  const box = sandbox()
  try {
    syncProviderKeyPool({ configPath: box.configPath, token: 'wb-old-token', models: MODELS })
    const drift = detectKeyPoolDrift({ configPath: box.configPath, configKey: 'wb-new-token' })
    assert.equal(drift.ok, false)
    assert.equal(drift.authoritative, 'provider-keys.json')
    assert.match(drift.reason, /不一致/u)
    assert.equal(drift.effective.value, 'wb-old-token')

    // 这就是实测里的 401 成因：config.json 换了令牌，键池没换，请求仍用旧令牌。
    const aligned = syncProviderKeyPool({ configPath: box.configPath, token: 'wb-new-token', models: MODELS })
    assert.equal(aligned.action, 'updated')
    assert.equal(detectKeyPoolDrift({ configPath: box.configPath, configKey: 'wb-new-token' }).ok, true)
  } finally { box.cleanup() }
})

test('幂等：已是目标状态时不重写、不产生备份', () => {
  const box = sandbox()
  try {
    syncProviderKeyPool({ configPath: box.configPath, token: 'wb-t', models: MODELS })
    const again = syncProviderKeyPool({ configPath: box.configPath, token: 'wb-t', models: MODELS })
    assert.equal(again.action, 'unchanged')
    assert.equal(again.backup, undefined)
  } finally { box.cleanup() }
})

test('keyRef 存在时不擅自动手：报 blocked 且文件逐字节不变', () => {
  const box = sandbox()
  try {
    const original = JSON.stringify({
      version: 1,
      providers: { workbuddy: [{ id: 'default', label: 'default', keyRef: 'rivet:workbuddy', models: [] }] },
    }, null, 2)
    writeFileSync(box.keysPath, original)

    const result = syncProviderKeyPool({ configPath: box.configPath, token: 'wb-t', models: MODELS })
    assert.equal(result.action, 'blocked')
    assert.match(result.notes.join(''), /keyRef/u)
    assert.equal(readFileSync(box.keysPath, 'utf8'), original)

    // 诊断也要如实说明「当前不是用内联令牌取凭据」。
    const drift = detectKeyPoolDrift({ configPath: box.configPath, configKey: 'wb-t' })
    assert.equal(drift.ok, false)
    assert.match(drift.reason, /keyRef/u)
  } finally { box.cleanup() }
})

test('多 key 池收敛为 1 条，并在说明里点出来', () => {
  const box = sandbox()
  try {
    writeFileSync(box.keysPath, JSON.stringify({
      version: 1,
      providers: { workbuddy: [{ id: 'a', label: 'a', apiKey: 'wb-a', models: [] }, { id: 'b', label: 'b', apiKey: 'wb-b', models: [] }] },
    }))
    const result = syncProviderKeyPool({ configPath: box.configPath, token: 'wb-t', models: MODELS })
    assert.equal(result.action, 'updated')
    assert.match(result.notes.join(''), /收敛为 1 条/u)
    assert.equal(readProviderKeys(box.keysPath).providers.workbuddy.length, 1)
  } finally { box.cleanup() }
})

test('移除 key 池条目后文件仍在（天枢靠文件存在性区分「无文件」与「空池」）', () => {
  const box = sandbox()
  try {
    syncProviderKeyPool({ configPath: box.configPath, token: 'wb-t', models: MODELS })
    const removed = removeProviderKeyPool({ configPath: box.configPath })
    assert.equal(removed.removed, true)
    const file = readProviderKeys(box.keysPath)
    assert.notEqual(file, undefined)
    assert.equal('workbuddy' in file.providers, false)

    // 再删一次应当是「没有条目」而不是报错。
    assert.equal(removeProviderKeyPool({ configPath: box.configPath }).removed, false)
  } finally { box.cleanup() }
})

test('effectiveKeyOf 的优先级：keyRef > apiKey > apiKeyEnv', () => {
  assert.deepEqual(effectiveKeyOf([{ keyRef: 'r', apiKey: 'k', apiKeyEnv: 'E' }]), { kind: 'keyRef', value: 'r' })
  assert.deepEqual(effectiveKeyOf([{ apiKey: 'k', apiKeyEnv: 'E' }]), { kind: 'inline', value: 'k' })
  assert.deepEqual(effectiveKeyOf([{ apiKeyEnv: 'E' }]), { kind: 'env', value: 'E' })
  assert.equal(effectiveKeyOf([]), undefined)
  assert.equal(effectiveKeyOf([{}]), undefined)
  assert.equal(effectiveKeyOf(undefined), undefined)
})

test('installProvider 会同时写 config.json 与 key 池（只写前者会被盖住）', () => {
  const box = sandbox()
  try {
    const result = installProvider({ path: box.configPath, port: 17871, token: 'wb-token-x', models: MODELS })
    assert.equal(result.created, true)
    assert.equal(result.keyPool.action, 'created')

    const config = JSON.parse(readFileSync(box.configPath, 'utf8'))
    assert.equal(config.provider.providers.workbuddy.apiKey, 'wb-token-x')
    const pool = readProviderKeys(box.keysPath).providers.workbuddy[0]
    assert.equal(pool.apiKey, 'wb-token-x')
    assert.equal(pool.models.length, 2)

    // 移除时两处一起清。
    const removed = removeProvider(box.configPath)
    assert.equal(removed.removed, true)
    assert.equal(removed.keyPool.removed, true)
    assert.equal('workbuddy' in JSON.parse(readFileSync(box.configPath, 'utf8')).provider.providers, false)
    assert.equal('workbuddy' in readProviderKeys(box.keysPath).providers, false)
  } finally { box.cleanup() }
})
