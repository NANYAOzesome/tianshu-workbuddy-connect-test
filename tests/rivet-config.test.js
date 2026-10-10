/**
 * 天枢配置桥单测：只动自己那一条、保留其它 provider 与默认值、先备份、
 * 可安全移除、漂移可检。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { makeTmpDir, trackTmpDir } from './helpers/tmp.js'
import {
  PROVIDER_NAME, buildProviderEntry, classifyBaseUrl, configuredGatewayPort, detectDrift, diffProvider,
  installProvider, isOurBaseUrl, portOfGatewayUrl, removeProvider,
} from '../src/rivet-config.js'

/**
 * 建一个隔离的 config.json。
 *
 * 每个用例一个目录，登记后由进程退出时统一回收 —— 这条路径以前是每跑一次
 * 套件就往 `%TEMP%` 留一批目录。
 */
function tempConfig(initial) {
  const dir = trackTmpDir(makeTmpDir('twc-cfg-'))
  const path = join(dir, 'config.json')
  if (initial !== undefined) writeFileSync(path, JSON.stringify(initial, null, 2))
  return path
}

const MODELS = [{ id: 'a', contextWindow: 1000, maxTokens: 500 }]

test('新建条目：不改变 provider.default，也不动别的 provider', () => {
  const path = tempConfig({
    provider: {
      default: 'deepseek',
      providers: { deepseek: { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', models: [] } },
    },
    unrelated: { keep: true },
  })
  const report = installProvider({ port: 17871, token: 'wb-test', models: MODELS, path })
  assert.equal(report.created, true)
  assert.equal(report.changed, true)
  assert.notEqual(report.backup, undefined)

  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(written.provider.default, 'deepseek')
  assert.equal(written.provider.providers.deepseek.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(written.provider.providers[PROVIDER_NAME].baseUrl, 'http://127.0.0.1:17871/v1')
  assert.equal(written.provider.providers[PROVIDER_NAME].protocol, 'openai')
  assert.equal(written.provider.providers[PROVIDER_NAME].models.length, 1)
  assert.deepEqual(written.unrelated, { keep: true })
})

test('幂等：已是目标状态时不重写、不新增备份', () => {
  const path = tempConfig()
  installProvider({ port: 17871, token: 'wb-test', models: MODELS, path })
  const first = readFileSync(path, 'utf8')
  const second = installProvider({ port: 17871, token: 'wb-test', models: MODELS, path })
  assert.equal(second.changed, false)
  assert.equal(second.backup, undefined)
  assert.equal(readFileSync(path, 'utf8'), first)
})

test('--default 时才切换默认 provider', () => {
  const path = tempConfig({ provider: { default: 'deepseek', providers: {} } })
  installProvider({ port: 1, token: 't', models: MODELS, path, setDefault: true })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).provider.default, PROVIDER_NAME)
})

test('覆盖现有条目时回报原 baseUrl，供上层告警', () => {
  const path = tempConfig({ provider: { providers: { [PROVIDER_NAME]: { name: 'workbuddy', baseUrl: 'http://127.0.0.1:8789/v1', models: [] } } } })
  const report = installProvider({ port: 17871, token: 'wb-test', models: MODELS, path })
  assert.equal(report.previousBaseUrl, 'http://127.0.0.1:8789/v1')
  const notes = report.notes.join('\n')
  assert.match(notes, /baseUrl/)
})

test('移除：清掉条目，并在默认指向它时一并清空 default', () => {
  const path = tempConfig({ provider: { default: PROVIDER_NAME, providers: { [PROVIDER_NAME]: { name: 'workbuddy', baseUrl: 'http://127.0.0.1:1/v1', models: [] }, other: { name: 'other' } } } })
  const result = removeProvider(path)
  assert.equal(result.removed, true)
  assert.equal(result.clearedDefault, true)
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(PROVIDER_NAME in written.provider.providers, false)
  assert.equal('default' in written.provider, false)
  assert.ok('other' in written.provider.providers)
})

test('移除不存在的条目时如实返回原因', () => {
  const path = tempConfig({ provider: { providers: {} } })
  assert.equal(removeProvider(path).removed, false)
  assert.equal(removeProvider(tempConfig()).removed, false)
})

test('漂移检测：未接入 / 指向别处 / 缺 apiKey / 就绪', () => {
  assert.equal(detectDrift({ path: tempConfig({ provider: { providers: {} } }) }).ok, false)
  assert.equal(detectDrift({ path: tempConfig() }).ok, false)

  // 本机可能同时跑着别的回环转接服务：仅凭「回环 + /v1」不足以认定归属，
  // 给了当前网关端口就必须端口精确匹配。
  const elsewhere = tempConfig({ provider: { providers: { [PROVIDER_NAME]: { baseUrl: 'http://127.0.0.1:8789/v1', apiKey: 'x', models: [] } } } })
  const drift = detectDrift({ path: elsewhere, port: 17871 })
  assert.equal(drift.ok, false)
  assert.match(drift.reason, /但当前网关在 17871 端口/)
  // 同一个文件，端口一致时才算就绪
  assert.equal(detectDrift({ path: elsewhere, port: 8789 }).ok, true)
  // 拿不到端口时退回形状判定，并标注不确定
  const shapeOnly = detectDrift({ path: elsewhere })
  assert.equal(shapeOnly.ok, true)
  assert.notEqual(shapeOnly.note, undefined)

  const notLoopback = tempConfig({ provider: { providers: { [PROVIDER_NAME]: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'x', models: [] } } } })
  assert.equal(detectDrift({ path: notLoopback, port: 17871 }).ok, false)
  assert.match(detectDrift({ path: notLoopback }).reason, /不是本插件的网关/)

  // 内联 apiKey 缺失、且没有键池 = 真的没配 → 仍须判失败。
  // （tempConfig 只写 config.json，同目录没有 provider-keys.json。）
  const noKey = tempConfig({ provider: { providers: { [PROVIDER_NAME]: { baseUrl: 'http://127.0.0.1:1/v1', models: [] } } } })
  assert.match(detectDrift({ path: noKey, port: 1 }).reason, /apiKey/)

  const good = tempConfig()
  installProvider({ port: 17871, token: 'wb-test', models: MODELS, path: good })
  const ok = detectDrift({ path: good, port: 17871 })
  assert.equal(ok.ok, true)
  assert.equal(ok.modelCount, 1)
  assert.equal(ok.isDefault, false)
  assert.equal(existsSync(good), true)
})

test('内联 apiKey 被天枢剥掉时，靠键池供凭据仍判就绪', () => {
  // 天枢 saveConfig 按设计把 provider 级明文 apiKey 剥掉（"config.json never
  // receives plaintext API keys"），凭据由 provider-keys.json 的键池供给。
  // 这是**正常落盘形态**，不能因为内联值为空就报「未接入」——否则一个完全可用的
  // 接入会稳定报红，把真故障淹掉。
  const dir = makeTmpDir('twc-drift-')
  const cfg = join(dir, 'config.json')
  writeFileSync(cfg, JSON.stringify({
    provider: {
      providers: {
        [PROVIDER_NAME]: { name: PROVIDER_NAME, baseUrl: 'http://127.0.0.1:17871/v1', protocol: 'openai', models: [{ id: 'm1' }] },
      },
    },
  }))
  writeFileSync(join(dir, 'provider-keys.json'), JSON.stringify({
    version: 1,
    providers: { [PROVIDER_NAME]: [{ id: 'default', label: 'default', apiKey: 'wb-pool-key', models: [{ id: 'm1' }] }] },
  }))

  // 内联无 key + 键池有值 → 就绪（修复前这里会误报「缺少 apiKey」）
  const pooled = detectDrift({ path: cfg, port: 17871, token: 'wb-pool-key' })
  assert.equal(pooled.ok, true)
  assert.equal(pooled.keyPool.authoritative, 'provider-keys.json')

  // 内联有 key 但键池是另一个值 → 仍须报分歧（请求实际用键池）
  writeFileSync(cfg, JSON.stringify({
    provider: {
      providers: {
        [PROVIDER_NAME]: { name: PROVIDER_NAME, apiKey: 'wb-stale-inline', baseUrl: 'http://127.0.0.1:17871/v1', protocol: 'openai', models: [{ id: 'm1' }] },
      },
    },
  }))
  const diverged = detectDrift({ path: cfg, port: 17871 })
  assert.equal(diverged.ok, false)
  assert.match(diverged.reason, /不一致/)
})

test('baseUrl 归属判定：形状 vs 端口精确', () => {
  assert.equal(isOurBaseUrl('http://127.0.0.1:17871/v1'), true)
  assert.equal(isOurBaseUrl('http://localhost:1/v1'), true)
  assert.equal(isOurBaseUrl('https://api.deepseek.com/v1'), false)
  assert.equal(isOurBaseUrl('http://127.0.0.1:17871/v2'), false)
  assert.equal(isOurBaseUrl(undefined), false)

  // 端口给了就必须一致
  assert.equal(classifyBaseUrl('http://127.0.0.1:17871/v1', 17871).match, true)
  assert.equal(classifyBaseUrl('http://127.0.0.1:8789/v1', 17871).match, false)
  assert.equal(classifyBaseUrl('http://127.0.0.1:8789/v1', 17871).confident, true)
  // 没给端口时只能按形状判，并如实标注不自信
  assert.equal(classifyBaseUrl('http://127.0.0.1:8789/v1').confident, false)
})

test('条目构造：能力声明保守且不含已废弃字段', () => {
  const entry = buildProviderEntry({ port: 1, token: 't', models: MODELS })
  assert.equal(entry.capabilities.prefixCache, 'none')
  assert.equal(entry.capabilities.prefixCompletion, false)
  assert.deepEqual(entry.capabilities.stripParams, ['stream_options'])
  assert.equal('alias' in entry.models[0], false)
})

test('差异渲染能区分新增与移除', () => {
  const notes = diffProvider(
    { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 't', models: [{ id: 'old' }] },
    { baseUrl: 'http://127.0.0.1:2/v1', apiKey: 't', models: [{ id: 'new' }] },
  ).join('\n')
  assert.match(notes, /新增模型：new/)
  assert.match(notes, /移除模型：old/)
})

test('portOfGatewayUrl：只认「回环 + /v1」，其余一律 undefined', () => {
  assert.equal(portOfGatewayUrl('http://127.0.0.1:17871/v1'), 17871)
  assert.equal(portOfGatewayUrl('http://127.0.0.1:17871/v1/'), 17871)
  assert.equal(portOfGatewayUrl('http://localhost:17871/v1'), 17871)
  // 本机可能同时跑着别的回环转接服务，因此非本插件形态必须拒绝。
  assert.equal(portOfGatewayUrl('http://127.0.0.1:17871/v2'), undefined)
  assert.equal(portOfGatewayUrl('https://api.deepseek.com/v1'), undefined)
  assert.equal(portOfGatewayUrl('http://192.168.1.9:17871/v1'), undefined)
  assert.equal(portOfGatewayUrl('127.0.0.1:17871/v1'), undefined, '不带协议的不是合法 URL')
  assert.equal(portOfGatewayUrl(undefined), undefined)
  assert.equal(portOfGatewayUrl('http://127.0.0.1/v1'), 80, '省略端口时取协议默认端口')
})

test('configuredGatewayPort：状态文件丢失后靠它认出「网关该在哪个端口」', () => {
  const path = tempConfig({
    provider: {
      default: 'zhipu-vision',
      providers: {
        'zhipu-vision': { name: 'zhipu-vision', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [] },
        workbuddy: { name: 'workbuddy', baseUrl: 'http://127.0.0.1:17871/v1', apiKey: 'wb-t', models: [] },
      },
    },
  })
  assert.equal(configuredGatewayPort(path), 17871)

  // 未接入时不能凭空给出端口 —— 否则保活会凭空起一个监听。
  const bare = tempConfig({ provider: { default: 'deepseek', providers: {} } })
  assert.equal(configuredGatewayPort(bare), undefined)

  // 别的 provider 指向回环也不算我们的。
  const foreign = tempConfig({
    provider: { providers: { workbuddy: { name: 'workbuddy', baseUrl: 'http://127.0.0.1:8789/v1' } } },
  })
  assert.equal(configuredGatewayPort(foreign), 8789, '同名的 provider 仍按端口给出，由调用方按端口精确判定归属')
})
