/**
 * 网关保活决策的穷举测试。
 *
 * 这个判定决定「每轮对话之前要不要拉起网关」。判错的两种代价都不小：
 * 该拉没拉 → 用户在不该失败的时候失败；不该拉却拉 → 每次对话都白起进程，
 * 甚至在错误的数据根下多出一个守护进程。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { planKeepalive, KEEPALIVE_ACTIONS } from '../src/keepalive.js'

const STATE = { version: 1, port: 17871, token: 'wb-x'.repeat(6), pid: 4242, mode: 'daemon' }
const HEALTH = { ok: true, marker: 'tianshu-workbuddy-connect', version: '1.0.0' }

test('尚未接入：状态文件缺失时不凭空拉起进程', () => {
  for (const state of [undefined, null]) {
    const plan = planKeepalive({ state, health: undefined, version: '1.0.0' })
    assert.equal(plan.action, 'idle')
    assert.match(plan.reason, /尚未接入/u)
  }
})

test('状态文件丢了但天枢配置仍指向我们：必须拉起（否则每个请求都打在空端口上）', () => {
  // 这是 `stop`、清理数据目录、跨机器迁移之后的真实形态：
  // 状态文件没了，但 config.json 里的绝对 URL 还在。
  const plan = planKeepalive({ state: undefined, port: 17871, health: undefined, version: '1.0.0' })
  assert.equal(plan.action, 'start')
  assert.match(plan.reason, /17871/u)
})

test('状态文件丢了且配置也指不出来：不拉起', () => {
  const plan = planKeepalive({ state: undefined, port: undefined, health: undefined, version: '1.0.0' })
  assert.equal(plan.action, 'idle')
  assert.match(plan.reason, /尚未接入/u)
})

test('状态文件里的端口优先于配置里的端口', () => {
  const plan = planKeepalive({ state: STATE, port: 19999, health: undefined, version: '1.0.0' })
  assert.match(plan.reason, /17871/u)
})

test('显式停止标记优先于一切：stop 之后保活不得把它拉回来', () => {
  const stopped = { version: 1, reason: 'stop', at: Date.now() }
  // 即便端口可达性未知、配置仍指向我们，也必须尊重用户的 stop。
  const plan = planKeepalive({
    state: undefined, port: 17871, health: undefined, version: '1.0.0', disabled: stopped,
  })
  assert.equal(plan.action, 'idle')
  assert.match(plan.reason, /显式停止/u)

  // 在线时同样 idle，且不得因为「版本漂移」去重启一个用户已停掉的网关。
  const drifted = planKeepalive({
    state: STATE, health: { ...HEALTH, version: '0.9.0' }, version: '1.0.0', disabled: stopped,
  })
  assert.equal(drifted.action, 'idle')
})

test('网关在线且版本一致：什么都不做', () => {
  const plan = planKeepalive({ state: STATE, health: HEALTH, version: '1.0.0' })
  assert.equal(plan.action, 'idle')
  assert.equal(plan.reason, '网关在线')
})

test('不知道版本时以在线为准（保持向后兼容的老调用方）', () => {
  const plan = planKeepalive({ state: STATE, health: HEALTH, version: undefined })
  assert.equal(plan.action, 'idle')
})

test('网关不在：拉起', () => {
  const plan = planKeepalive({ state: STATE, health: undefined, version: '1.0.0' })
  assert.equal(plan.action, 'start')
  assert.match(plan.reason, /17871/u)
})

test('版本漂移：先停后拉，而不是将就复用旧代码', () => {
  const plan = planKeepalive({
    state: STATE,
    health: { ...HEALTH, version: '0.9.0' },
    version: '1.0.0',
  })
  assert.equal(plan.action, 'restart')
  assert.match(plan.reason, /0\.9\.0/u)
  assert.match(plan.reason, /1\.0\.0/u)
})

test('neverStart：只探活不拉起（诊断/只读场景）', () => {
  const dead = planKeepalive({ state: STATE, health: undefined, version: '1.0.0', neverStart: true })
  assert.equal(dead.action, 'idle')
  const drifted = planKeepalive({
    state: STATE,
    health: { ...HEALTH, version: '0.9.0' },
    version: '1.0.0',
    neverStart: true,
  })
  assert.equal(drifted.action, 'idle')
  // 但「已在线」这一判定不受 neverStart 影响。
  const alive = planKeepalive({ state: STATE, health: HEALTH, version: '1.0.0', neverStart: true })
  assert.equal(alive.action, 'idle')
  assert.equal(alive.reason, '网关在线')
})

test('动作集合固定，且每个动作都有可读原因', () => {
  assert.deepEqual([...KEEPALIVE_ACTIONS], ['idle', 'start', 'restart'])
  const plans = [
    planKeepalive({}),
    planKeepalive({ state: STATE, health: HEALTH, version: '1.0.0' }),
    planKeepalive({ state: STATE, health: undefined, version: '1.0.0' }),
    planKeepalive({ state: STATE, health: { ...HEALTH, version: 'x' }, version: '1.0.0' }),
  ]
  for (const plan of plans) {
    assert.ok(KEEPALIVE_ACTIONS.includes(plan.action), `非法动作：${plan.action}`)
    assert.equal(typeof plan.reason, 'string')
    assert.ok(plan.reason.length > 0)
  }
})
