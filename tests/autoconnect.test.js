/**
 * 启动自举的判定与编排测试。
 *
 * 「自举」是让「装上即可用」成立的那一步，因此它判错的两类代价都很具体：
 *
 *   - 判成「该接入」但本机没有可用登录态 → 只要插件被加载就白起一个网关进程，
 *     而它对每个请求只会回 401；
 *   - 判成「不用管」但配置里的绝对 URL 还指着网关 → 用户看到「模型突然用不了」，
 *     且这种现象完全没有线索指向端口。
 *
 * 判定本身是纯函数，因此这里穷举它；编排部分用注入的替身驱动，不真的起进程。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { AUTOCONNECT_ACTIONS, autoConnect, planAutoconnect } from '../src/autoconnect.js'

const STATE = { version: 1, port: 17871, token: 'wb-x'.repeat(6), pid: 4242, mode: 'daemon' }
// 注意：detectDrift 的成功返回里**没有** port 字段，只有整条 baseUrl —— 端口
// 必须从 baseUrl 反解。写成 { ok: true, port: 17871 } 会让这个用例在真实形态下
// 静默失效（永远拿不到端口 → 永远判成「尚未接入」）。
const OUR_DRIFT = { ok: true, baseUrl: 'http://127.0.0.1:17871/v1' }

/* ------------------------------------------------------------------ *
 * planAutoconnect —— 纯判定
 * ------------------------------------------------------------------ */

test('已接入且网关状态记得同一个端口：idle', () => {
  const plan = planAutoconnect({ drift: OUR_DRIFT, state: STATE })
  assert.equal(plan.action, 'idle')
  assert.equal(plan.port, 17871)
  assert.match(plan.reason, /已接入/u)
})

test('已接入但网关状态缺失：按配置里的端口重建，而不是判定「尚未接入」', () => {
  // 这是会话进程退出之后的常态：网关随会话没了，状态文件可能也清了，
  // 而 config.json 里的 http://127.0.0.1:17871/v1 还在。
  // 判成「尚未接入」的话，每个请求都会打在空端口上，故障永久化。
  const plan = planAutoconnect({ drift: OUR_DRIFT, state: undefined })
  assert.equal(plan.action, 'restart')
  assert.equal(plan.port, 17871)
})

test('已接入但状态文件记的是别的端口：以配置为准', () => {
  // 宿主实际会去连的是配置里那个端口，状态文件只是个提示。
  const plan = planAutoconnect({ drift: { ok: true, baseUrl: 'http://127.0.0.1:17890/v1' }, state: STATE })
  assert.equal(plan.action, 'restart')
  assert.equal(plan.port, 17890)
})

test('从未接入：尝试自动接入', () => {
  const plan = planAutoconnect({ drift: { ok: false, reason: '未接入' }, state: undefined })
  assert.equal(plan.action, 'connect')
  assert.equal(plan.port, undefined)
})

test('配置指向别的程序（不是我们）时不得视为已接入', () => {
  // drift.ok 只在「配置里有一条指向 127.0.0.1 上本插件网关」时为 true。
  const plan = planAutoconnect({ drift: { ok: false, reason: 'baseUrl 指向别处' }, state: STATE })
  assert.equal(plan.action, 'connect')
})

test('drift 为 undefined 时不抛错，按「未接入」处理', () => {
  const plan = planAutoconnect({})
  assert.equal(plan.action, 'connect')
  assert.equal(typeof plan.reason, 'string')
})

/* ------------------------------------------------------------------ *
 * autoConnect —— 编排（用替身驱动，不真的起进程）
 * ------------------------------------------------------------------ */

/** 造一个可控的依赖集合。 */
function fakeDeps(overrides = {}) {
  const calls = { ensure: [], connect: [] }
  const deps = {
    version: '1.0.0',
    readGatewayState: () => overrides.state,
    detectDrift: () => overrides.drift ?? { ok: false, reason: '未接入' },
    ensureGateway: async (options) => {
      calls.ensure.push(options)
      if (overrides.ensureThrows === true) throw new Error('listen EACCES')
      return { port: options.port, reused: true, inProcess: true }
    },
    connect: async (options) => {
      calls.connect.push(options)
      return overrides.connectReport ?? { ok: true, port: 17871, models: 17, displayName: 'WorkBuddy' }
    },
    ...overrides.deps,
  }
  return { deps, calls }
}

test('快路径：已接入且状态一致时只探活，不碰配置', async () => {
  const { deps, calls } = fakeDeps({ drift: OUR_DRIFT, state: STATE })
  const report = await autoConnect(deps)
  assert.equal(report.ok, true)
  assert.equal(report.action, 'idle')
  assert.equal(calls.ensure.length, 1)
  assert.equal(calls.ensure[0].port, 17871)
  assert.equal(calls.connect.length, 0, 'idle 路径不得调用完整接入（否则会平白重写配置）')
})

test('网关掉了：只按配置端口拉回来，不重写配置', async () => {
  const { deps, calls } = fakeDeps({ drift: OUR_DRIFT, state: undefined })
  const report = await autoConnect(deps)
  assert.equal(report.ok, true)
  assert.equal(report.action, 'started')
  assert.equal(calls.ensure[0].port, 17871)
  assert.equal(calls.connect.length, 0)
})

test('首次接入：走与「用户说一句接入」完全相同的 connect()', async () => {
  const { deps, calls } = fakeDeps({ drift: { ok: false } })
  const report = await autoConnect(deps)
  assert.equal(report.ok, true)
  assert.equal(report.action, 'connected')
  assert.equal(report.models, 17)
  assert.equal(calls.connect.length, 1)
  // 不得擅自把 workbuddy 设成默认 provider —— 那是用户的选择，不是自举的。
  assert.equal(calls.connect[0].setDefault, undefined)
})

test('没有已登录的桌面 App：skip 而不是 failed，且不留副作用', async () => {
  // 这是最常见的「失败」，但它根本不是错误 —— 用户只是还没装/没登录 WorkBuddy。
  // 报成 failed 会让 doctor 一上来就是红的，淹没真故障。
  const { deps, calls } = fakeDeps({
    drift: { ok: false },
    connectReport: { ok: false, stage: 'account', message: '还没有登录 WorkBuddy，暂时无法接入', hint: '请打开 WorkBuddy 并完成登录' },
  })
  const report = await autoConnect(deps)
  assert.equal(report.ok, false)
  assert.equal(report.action, 'skip')
  assert.equal(report.stage, 'account')
  assert.match(report.reason, /登录/u)
  // message 与 hint 用句号拼接，而不是套括号 —— 新手看到的是两句话，不是嵌套括号。
  assert.equal(report.reason, '还没有登录 WorkBuddy，暂时无法接入。请打开 WorkBuddy 并完成登录')
  assert.equal(report.message, '还没有登录 WorkBuddy，暂时无法接入')
  assert.equal(calls.ensure.length, 0, 'skip 路径不得起网关')
})

test('接入在网关阶段失败：报 failed 并带上原因', async () => {
  const { deps } = fakeDeps({
    drift: { ok: false },
    connectReport: { ok: false, stage: 'gateway', message: '启动本地网关失败：EACCES', hint: '换个端口' },
  })
  const report = await autoConnect(deps)
  assert.equal(report.ok, false)
  assert.equal(report.action, 'failed')
  assert.equal(report.stage, 'gateway')
  assert.match(report.reason, /EACCES/u)
})

test('起网关抛错：报 failed，绝不向外抛（否则会拖垮会话启动）', async () => {
  const { deps } = fakeDeps({ drift: OUR_DRIFT, state: STATE, ensureThrows: true })
  const report = await autoConnect(deps)
  assert.equal(report.ok, false)
  assert.equal(report.action, 'failed')
  assert.match(report.reason, /EACCES/u)
})

test('读配置抛错：报 failed 而不是崩溃', async () => {
  const { deps } = fakeDeps({ state: STATE, deps: { detectDrift: () => { throw new Error('config.json 不是 JSON') } } })
  const report = await autoConnect(deps)
  assert.equal(report.ok, false)
  assert.equal(report.action, 'failed')
  assert.match(report.reason, /不是 JSON/u)
})

test('读状态文件抛错：降级为「未接入」，由 connect 定论', async () => {
  const { deps, calls } = fakeDeps({
    drift: { ok: false },
    deps: { readGatewayState: () => { throw new Error('EPERM') } },
  })
  const report = await autoConnect(deps)
  assert.equal(report.action, 'connected')
  assert.equal(calls.connect.length, 1)
})

test('永不抛错：所有输入组合下 autoConnect 都 resolve 出结构化报告', async () => {
  const cases = [
    {},
    { drift: OUR_DRIFT },
    { drift: OUR_DRIFT, state: STATE },
    { drift: { ok: false }, ensureThrows: true },
    { drift: { ok: false }, connectReport: { ok: false, stage: 'catalog', message: '目录为空' } },
  ]
  for (const scenario of cases) {
    const { deps } = fakeDeps(scenario)
    const report = await autoConnect(deps)
    assert.equal(typeof report.ok, 'boolean')
    assert.ok(AUTOCONNECT_ACTIONS.includes(report.action), `非法动作：${report.action}`)
    assert.equal(typeof report.reason, 'string')
    assert.ok(report.reason.length > 0)
  }
})

test('动作集合固定', () => {
  assert.deepEqual([...AUTOCONNECT_ACTIONS], ['idle', 'started', 'connected', 'skip', 'failed'])
})
