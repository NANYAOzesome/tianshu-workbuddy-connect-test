/**
 * 启动自举 —— 让「装上即可用」成立的那一步。
 *
 * 背景：本插件不是宿主内的 provider（天枢的扩展契约只有工具插件），而是把
 * WorkBuddy 上游包成一个**本地回环 OpenAI 网关**。网关随会话进程一起启动，
 * 会话结束也就该结束 —— 它只是这个进程伸出去的一只代理手，不是一个需要独立
 * 存活的常驻服务。
 *
 * 这件事必须在**每次会话启动时**做一遍，理由不是「忘了装」，而是：
 *
 *   - 网关跟着会话进程走，进程一停就没有了（这是**有意**的：会话结束即释放
 *     端口，不留后台残留）；
 *   - 但 `provider` 配置里存的是 `http://127.0.0.1:<port>/v1` 这个**绝对 URL**，
 *     它不会因为进程退出而消失。于是新会话的第一条消息会打在空端口上；
 *   - `config.json` 只在**宿主启动时**读取一次，所以端口一旦漂走，改配置也没用
 *     —— 必须保证每次会话里那个端口上**始终有人**。
 *
 * 天枢为此提供了唯一的启动时机：manifest 的 `hooks.preTurn`
 * （`spawnSync` 阻塞执行），以及插件模块被 `import` 本身。本模块服务于后者 ——
 * 模块加载发生在宿主读取 provider 配置**之前**，因此这里起的网关，端口天然与
 * 配置里那一个对齐。
 *
 * 三种输入状态，对应三种动作：
 *
 * | 输入 | 动作 |
 * | --- | --- |
 * | 配置已指向我们 + 网关在线 | `idle`（一次回环探活，1ms 级） |
 * | 配置已指向我们 + 网关没了 | 只把网关拉回来（**不重写配置**，端口取配置里那个） |
 * | 从未接入 + 本机有已登录的桌面 App | 自动完成一次完整接入 |
 * | 从未接入 + 没有可用登录态 | `skip`，如实返回原因，什么都不做 |
 *
 * 最后一行是安全阀：装个插件不该凭空多一个常驻进程，也不该替用户决定「接入」。
 * 没有可用账号时起网关毫无意义（它只会对每个请求回 401），因此明确不做。
 *
 * @module tianshu-workbuddy-connect/autoconnect
 */

import { configurePort, scheduleIdleShutdown, stopGateway } from './gateway.js'
import { portOfGatewayUrl } from './rivet-config.js'
import { clip, errorText } from './util.js'

/** 自举结果的动作枚举。 */
export const AUTOCONNECT_ACTIONS = Object.freeze([
  'idle', // 已接入且网关在线
  'started', // 已接入但网关掉了，只把它拉回来
  'connected', // 首次自动接入（或配置有变更需要重写）
  'skip', // 没有可用登录态，什么都不做
  'failed', // 出错，已记录原因
])

/**
 * 把「当前该做什么」抽成纯函数，好让单测穷举（hook 与模块加载两条路径共用）。
 *
 * 判定必须**同时**看两处：
 *   - `drift.ok`：配置里是否已有一条指向我们的 provider，端口是多少；
 *   - `state`：网关状态文件，用来判断端口上那个实例是谁、是不是这份代码。
 *
 * 只看配置会在「配置在、网关没了」时去重写一遍配置（多一次无谓的写盘与备份）；
 * 只看状态文件会在状态文件被人删掉后（`stop`、清理数据目录、换机器）判定「尚未
 * 接入」，而配置里的绝对 URL 还在 —— 故障于是永久化。
 *
 * @param {object} input
 * @param {{ok:boolean, port?:number, reason?:string}} input.drift 配置漂移检测结果
 * @param {object|undefined} input.state 网关状态文件内容
 * @returns {{action:'idle'|'restart'|'connect', port:number|undefined, reason:string}}
 */
export function planAutoconnect({ drift, state }) {
  // 端口**只能**从 `baseUrl` 反解 —— `detectDrift` 的成功返回里没有 `port` 字段
  // （它给的是整条 `baseUrl`）。这里曾经假设 drift 直接带 port，于是永远拿到
  // undefined、永远判成「尚未接入」，自动接入于是每次都重新挑端口、把配置里那个
  // 已经写好的 URL 漂到一个没人监听的端口上。这是「配好了却用不了」的病根。
  const configuredPort = typeof drift?.baseUrl === 'string' ? portOfGatewayUrl(drift.baseUrl) : undefined

  // 已接入：端口以**配置**为准（它才是宿主实际会去连的那个）。
  // 状态文件缺失不影响判定 —— 那正是「网关跟着会话没了」的常态。
  if (drift?.ok === true && configuredPort !== undefined) {
    if (state?.port === configuredPort) {
      return { action: 'idle', port: configuredPort, reason: `已接入，网关状态已记录（127.0.0.1:${configuredPort}）` }
    }
    return { action: 'restart', port: configuredPort, reason: `已接入但网关状态缺失，按配置在 127.0.0.1:${configuredPort} 上重建` }
  }

  // 未接入（或配置指向别处）：尝试补一次完整接入。真正的可用性判定交给
  // `connect()` —— 它会先起网关、再问上游要账号，没有登录态就在 account 阶段
  // 干净地失败，不会留下半个配置。
  return { action: 'connect', port: configuredPort, reason: '尚未接入，尝试自动完成' }
}

/**
 * 组装自举任务。依赖以参数注入，因此本模块可被单测直接驱动，不需要真的起网关。
 *
 * @param {object} deps
 * @param {Function} deps.ensureGateway
 * @param {Function} deps.detectDrift
 * @param {Function} deps.readGatewayState
 * @param {Function} [deps.connect]  完整接入（延迟到真正需要时才加载，避免无谓的模块图）
 * @param {string}   deps.version
 * @param {number}   [deps.idleShutdownMs] 会话空闲后自动关网关的时长（0 = 不关）
 * @returns {Promise<object>} 自举报告
 */
export function autoConnect(deps) {
  const task = async () => {
    let state
    try {
      state = deps.readGatewayState()
    } catch (error) {
      // 状态文件读不动不该阻断自举：下面按「未接入」继续走，最终由 connect() 定论。
      state = undefined
    }

    let drift
    try {
      drift = deps.detectDrift({ port: state?.port })
    } catch (error) {
      return { ok: false, action: 'failed', reason: `读取天枢配置失败：${clip(errorText(error), 300)}` }
    }

    // 「配置里那个端口」必须比状态文件优先：状态文件可能记着上一世代的端口
    // （例如上次因冲突顺延过），而宿主只会去连配置里那个。
    const configured = typeof drift?.baseUrl === 'string' ? portOfGatewayUrl(drift.baseUrl) : undefined
    const plan = planAutoconnect({ drift, state })
    const targetPort = configured ?? plan.port

    // 快路径：网关在线时只付一次回环探活。
    if (plan.action === 'idle') {
      try {
        const gateway = await deps.ensureGateway({ port: targetPort, version: deps.version })
        return {
          ok: true,
          action: 'idle',
          port: gateway.port,
          mode: gateway.inProcess === true ? 'in-process' : 'daemon',
          reason: plan.reason,
        }
      } catch (error) {
        return { ok: false, action: 'failed', port: plan.port, reason: `网关不可用：${clip(errorText(error), 300)}` }
      }
    }

    // 已接入但网关掉了：只把网关拉回来。刻意**不**重写配置 —— 端口与令牌都还在
    // 配置里，重写只会平白多一次备份和一个可能失败的点。
    if (plan.action === 'restart') {
      try {
        const gateway = await deps.ensureGateway({ port: targetPort, version: deps.version })
        return {
          ok: true,
          action: 'started',
          port: gateway.port,
          mode: gateway.inProcess === true ? 'in-process' : 'daemon',
          reason: plan.reason,
        }
      } catch (error) {
        return { ok: false, action: 'failed', port: plan.port, reason: `网关拉起失败：${clip(errorText(error), 300)}` }
      }
    }

    // 首次接入：走与「用户说一句接入」完全相同的代码路径。
    let connect = deps.connect
    if (connect === undefined) {
      const mod = await import('./connect.js')
      connect = mod.connect
    }
    try {
      const report = await connect({
        // 端口必须显式传下去。`connect()` 不带端口时会退回「状态文件记忆」分支，
        // 而状态文件里的端口可能来自上一世代的实例（例如之前因端口冲突顺延过），
        // 于是自动接入又会漂到新端口上 —— 配置里那个 URL 于是永远对不上。
        // 以配置为准，是唯一能让「配好的东西继续有效」成立的选择。
        ...(targetPort === undefined ? {} : { port: targetPort }),
        version: deps.version,
      })
      if (report?.ok !== true) {
        // 「没有已登录的桌面 App」是最常见的失败，且**不是错误** —— 那是用户的
        // 正常状态（比如他还没装 WorkBuddy）。如实返回，不留下任何副作用。
        const benign = report?.stage === 'account'
        return {
          ok: false,
          action: benign ? 'skip' : 'failed',
          stage: report?.stage,
          message: report?.message,
          // 提示语用句号拼接而不是套括号：hint 本身就是完整句子，
          // 再包一层括号会变成「（请…。如果…。）」这种读起来别扭的形态。
          reason: [report?.message ?? '接入未完成', report?.hint].filter(v => typeof v === 'string' && v !== '').join('。'),
        }
      }
      return {
        ok: true,
        action: 'connected',
        port: report.port,
        models: report.models,
        displayName: report.displayName,
        reason: `已自动接入 ${report.displayName}，${report.models} 个模型`,
      }
    } catch (error) {
      return { ok: false, action: 'failed', reason: `自动接入失败：${clip(errorText(error), 300)}` }
    }
  }

  return task().then((report) => {
    // 会话内网关的生命周期在这里收口：宿主进程退出 = 会话结束 = 该释放端口。
    //
    // 这一步必须挂在**进程**上而不是 Promise 上 —— 进程退出事件触发时事件循环
    // 已经排空，能做的只剩同步释放（关监听、删状态文件），而正是这个动作让
    // 「`start` 之后端口立刻可用」成立。
    try {
      const { process: proc } = globalThis
      if (proc?.once !== undefined) {
        proc.once('exit', () => { try { stopGateway() } catch { /* 退出路径不报错 */ } })
        for (const signal of ['SIGINT', 'SIGTERM']) {
          proc.once(signal, () => { try { stopGateway() } catch { /* 同上 */ } })
        }
      }
    } catch { /* 非 Node 宿主（测试替身）忽略 */ }

    if (typeof deps.idleShutdownMs === 'number') scheduleIdleShutdown({ ms: deps.idleShutdownMs })
    return report
  })
}

/**
 * 允许宿主/用户显式指定端口。
 *
 * 存在的意义是让 `WORKBUDDY_GATEWAY_PORT` 这类约定能在**接入之前**生效：
 * `configurePort` 只影响本进程内新建的网关，不会去动已有配置。
 */
export function applyPortOverride(raw = process.env.WORKBUDDY_GATEWAY_PORT) {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  configurePort(port)
  return true
}

export default autoConnect
