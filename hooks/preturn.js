#!/usr/bin/env node
/**
 * preTurn hook —— 网关兜底保活。
 *
 * 主路径已经不需要它了：插件模块被 `import` 时会做一次幂等的自动接入
 * （见 `src/autoconnect.js`），那时网关就已经和配置里的端口对齐了。
 *
 * 这个 hook 存在的理由是**插件没被加载**的那些轮次：
 *
 *   - 用户把插件禁用了（`plugins.enabled[name] === false`），但天枢配置里那条
 *     provider 还在 → 每轮都会打在空端口上；
 *   - 宿主在读到插件之前就先读了配置，而进程内的网关因为别的原因没起来；
 *   - 宿主加载插件失败（依赖缺失、语法错误），因此 `ready` 那条路径根本没跑。
 *
 * 也就是说：**它是「插件路径失效」时的第二道防线**，而不是主路径。代价是每轮
 * 一次 Node 启动（约 60–120ms），换来的是「插件挂了但模型还能用」。
 *
 * 三条纪律：
 *   1. 极快。探活本身只是一次回环 HTTP 往返（1ms 级）。
 *   2. 绝不新增噪音。一切正常时不输出任何内容；出问题时只写一行 stderr。
 *   3. 绝不阻断对话。任何异常都以退出码 0 结束 —— 保活失败最多让模型请求报
 *      一次错，不能让整轮对话起不来。
 */

import { planKeepalive } from '../src/keepalive.js'
import { PLUGIN_VERSION } from '../src/version.js'
import { configuredGatewayPort } from '../src/rivet-config.js'
import {
  HEALTH_MARKER, ensureGateway, gatewayDisabled, probeGateway, readGatewayState,
} from '../src/gateway.js'
import { logLine } from '../src/util.js'

/** 自我限时：manifest 给出的预算是 8s，这里留出余量，超时就不再等。 */
const SELF_TIMEOUT_MS = 6000

/** 探活超时（回环地址，正常在 1ms 级）。 */
const PROBE_TIMEOUT_MS = 1500

function warn(message) {
  // 天枢会捕获 hook 的 stdout+stderr；出问题时才写，正常路径保持静默。
  process.stderr.write(`[workbuddy-connect] ${message}\n`)
}

/**
 * 网关应当所在的端口：状态文件优先，其次从天枢配置反解。
 *
 * 只信状态文件是不够的 —— `stop`、清理数据目录、跨机器迁移都会让它消失，
 * 而 `config.json` 里的绝对 URL 还在，那时每个请求都会打在空端口上。
 */
function targetPort(state) {
  if (state?.port !== undefined) return state.port
  try {
    return configuredGatewayPort()
  } catch {
    // 配置读不动（不可读 / 非法 JSON）不该阻断对话，静默降级为「不拉起」。
    return undefined
  }
}

/** 天枢配置是否仍指向本插件的网关（用于「已停止但配置还在」的告警）。 */
function configuredPortStillOurs() {
  try {
    return configuredGatewayPort() !== undefined
  } catch {
    return false
  }
}

async function main() {
  const state = readGatewayState()
  const disabled = gatewayDisabled()
  const port = disabled === undefined ? targetPort(state) : undefined
  // 先按「授权令牌」探活；失败再匿名探一次 —— 匿名指纹能认出「同门但换了令牌」
  // 的实例，那种情况下的处置（restart）与「端口上是别人」完全不同。
  let health
  if (port !== undefined) {
    health = await probeGateway(port, state?.token, PROBE_TIMEOUT_MS)
    if (health === undefined) health = await probeGateway(port, undefined, PROBE_TIMEOUT_MS)
  }

  const plan = planKeepalive({ state, health, version: PLUGIN_VERSION, port, disabled })
  if (plan.action === 'idle') {
    // 「已显式停止」+ 天枢配置仍指向我们 = 每个请求都注定失败。这个组合不是
    // 正常路径，值得说一句 —— 否则现象是「模型突然用不了」，而没人知道为什么。
    if (disabled !== undefined && configuredPortStillOurs()) {
      warn(
        '网关已被显式停止，但天枢配置仍指向它，模型请求会失败。'
        + '要恢复请在天枢里执行 workbuddy_connect；要彻底断开请执行 workbuddy_logout。',
      )
    }
    return
  }

  logLine('keepalive', `${plan.reason} → ${plan.action}`)
  const gateway = await ensureGateway({ port, version: PLUGIN_VERSION })
  const after = await probeGateway(gateway.port, gateway.token, PROBE_TIMEOUT_MS)
  if (after?.marker !== HEALTH_MARKER) {
    warn(
      `网关未能在 127.0.0.1:${gateway.port} 上恢复（${plan.reason}）。`
      + '本轮模型请求可能失败；在天枢里执行 workbuddy_doctor 可获得逐环诊断。',
    )
    return
  }
  // 换了端口就等于天枢配置里的 URL 已经失效：请求会打在旧端口上。这种情况必须
  // 说出来，否则现象是「模型用不了」而配置看起来完全正常。
  if (port !== undefined && gateway.port !== port) {
    warn(
      `网关已改在 127.0.0.1:${gateway.port} 上运行，而天枢配置里写的是 ${port}`
      + '（原端口被别的实例占用）。请在天枢里执行 workbuddy_connect 重新对齐配置。',
    )
  }
}

try {
  await Promise.race([
    main(),
    new Promise(resolve => setTimeout(resolve, SELF_TIMEOUT_MS)),
  ])
} catch (error) {
  // 保活是旁路：失败只留痕，不影响对话。
  try { logLine('keepalive', `failed: ${error?.message ?? error}`) } catch { /* 日志不可写 */ }
}
process.exit(0)
