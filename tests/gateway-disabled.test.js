/**
 * 「已显式停止」标记的生命周期。
 *
 * 这个小哨兵文件决定 `stop` 是不是一个**真的**操作。没有它，`preTurn` 保活会
 * 在下一轮对话前把网关拉回来 —— 用户停掉、下一秒又活过来，`stop` 变成摆设。
 * 反过来，它也不能被误判成「从未接入」：那会让状态文件丢失（清理数据目录、
 * 跨机器迁移）之后的每一次请求都打在空端口上而无人修复。
 *
 * 两条边界都要钉住，因此单独成文件。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { cleanupTmpDir, makeTmpDir } from './helpers/tmp.js'
import {
  clearGatewayDisabled, gatewayDisabled, gatewayDisabledPath, markGatewayDisabled,
  readGatewayState, stopGateway, writeGatewayState,
} from '../src/gateway.js'

/** 在隔离的数据根下跑一段逻辑（需要 await，故不走 helpers 里的同步壳）。 */
async function withHome(fn) {
  const home = makeTmpDir('wb-disabled-')
  const previous = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previous
    cleanupTmpDir(home)
  }
}

test('标记落在插件状态目录下，且随 RIVET_HOME 迁移', async () => {
  await withHome(home => {
    assert.equal(gatewayDisabledPath(), join(home, 'workbuddy', 'gateway.disabled'))
    assert.equal(gatewayDisabled(), undefined, '未停止时不应存在标记')
  })
})

test('markGatewayDisabled 写入后可读，clearGatewayDisabled 可撤销', async () => {
  await withHome(() => {
    markGatewayDisabled('stop')
    const mark = gatewayDisabled()
    assert.equal(mark.reason, 'stop')
    assert.equal(typeof mark.at, 'number')
    assert.equal(clearGatewayDisabled(), true)
    assert.equal(gatewayDisabled(), undefined)
  })
})

test('写网关状态就等于「网关应当在线」：顺手撤销已停止标记', async () => {
  await withHome(() => {
    markGatewayDisabled('stop')
    assert.notEqual(gatewayDisabled(), undefined)

    // 版本漂移重启那条路径会先 stop 再 launch，launch 里守护进程会写状态；
    // 若写状态不清标记，刚起来的网关会被下一轮保活判成「已停止」。
    writeGatewayState({ version: 1, port: 59997, token: 'wb-t', pid: process.pid, mode: 'daemon', startedAt: Date.now() })
    assert.equal(gatewayDisabled(), undefined)
  })
})

test('stopGateway 之后留下标记：保活据此尊重用户意图', async () => {
  await withHome(async () => {
    // 状态文件指向本进程 → 走进程内路径，不需要真的去连端口。
    writeGatewayState({ version: 1, port: 59996, token: 'wb-t', pid: process.pid, mode: 'in-process', startedAt: Date.now() })
    assert.equal(gatewayDisabled(), undefined)

    const result = await stopGateway()
    assert.equal(result.mode, 'in-process')
    assert.equal(readGatewayState(), undefined, '状态文件应被清掉')
    assert.equal(gatewayDisabled()?.reason, 'stop', '必须留下显式停止标记')
  })
})
