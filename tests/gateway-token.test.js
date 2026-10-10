/**
 * 网关令牌的稳定性测试。
 *
 * 令牌必须对同一个数据根**长期不变**。理由不是美观：天枢的配置层会把这个值
 * 复制到 `config.json` 与 `provider-keys.json`（后者是权威），任何一次「顺手
 * 换掉」都会让副本立刻过期，表现为 401 —— 看起来像上游鉴权失败，实际是网关
 * 不认自己的旧令牌。实测就是这么踩到的。
 */

import assert from 'node:assert/strict'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { cleanupTmpDir, makeTmpDir } from './helpers/tmp.js'
import { ensureGatewayToken, gatewayTokenPath, readStoredToken, rotateGatewayToken } from '../src/gateway.js'

/** 在隔离的数据根下跑一段逻辑。 */
function withHome(fn) {
  const home = makeTmpDir('wb-token-')
  const previous = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  try {
    return fn(home)
  } finally {
    if (previous === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previous
    cleanupTmpDir(home)
  }
}

test('首次生成后写入独立文件，且第二次调用拿到同一个令牌', () => {
  withHome(() => {
    const first = ensureGatewayToken(undefined)
    assert.match(first, /^wb-[0-9a-f]{48}$/u)
    assert.equal(readStoredToken(), first)
    assert.equal(ensureGatewayToken(undefined), first)
    // 状态文件被清掉（stop / logout）不会影响令牌 —— 这正是它单独存放的意义。
    assert.equal(ensureGatewayToken(undefined), first)
  })
})

test('沿用传入的历史令牌并落盘（迁移既有安装时不会改变已生效的值）', () => {
  withHome(() => {
    const legacy = `wb-${'a'.repeat(48)}`
    assert.equal(ensureGatewayToken(legacy), legacy)
    assert.equal(readStoredToken(), legacy)
  })
})

test('已持久化的令牌优先于传入值：状态文件的副本不该反过来改写身份', () => {
  withHome(() => {
    const stable = ensureGatewayToken(undefined)
    const other = `wb-${'b'.repeat(48)}`
    assert.equal(ensureGatewayToken(other), stable)
  })
})

test('显式轮换才会换令牌', () => {
  withHome(() => {
    const before = ensureGatewayToken(undefined)
    const rotated = rotateGatewayToken()
    assert.notEqual(rotated, before)
    assert.equal(readStoredToken(), rotated)
    assert.equal(ensureGatewayToken(before), rotated, '轮换后仍以持久值为准')
  })
})

test('令牌文件落在插件状态目录下，权限收在 0600', () => {
  withHome(home => {
    ensureGatewayToken(undefined)
    const path = gatewayTokenPath()
    assert.equal(path, join(home, 'workbuddy', 'gateway-token'))
    assert.equal(existsSync(path), true)
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600)
    }
  })
})

test('令牌文件被写坏时退回生成新令牌，而不是把坏值当令牌用', () => {
  withHome(() => {
    const good = ensureGatewayToken(undefined)
    // 手工写坏（模拟被覆盖成非令牌内容）。
    writeFileSync(gatewayTokenPath(), 'not-a-token\n')
    assert.equal(readStoredToken(), undefined)
    assert.notEqual(ensureGatewayToken(undefined), 'not-a-token')
    assert.notEqual(ensureGatewayToken(undefined), good)
  })
})
