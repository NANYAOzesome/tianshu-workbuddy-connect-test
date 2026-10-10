/**
 * 网关保活决策。
 *
 * 为什么需要它：天枢的插件契约只有 `tools` —— 加载器读完 `tools` 就结束，
 * 从不 await 插件导出的 `ready` / `activate`（`plugin-loader.ts` 的
 * `loadOnePlugin` 全文可证）。而 provider 配置里存的是**绝对 URL**，
 * 指向 127.0.0.1 上的一个端口。重启电脑之后，那个分离式守护进程不会自己
 * 回来，天枢的第一个请求就会打在空端口上 —— 报错是 ECONNREFUSED，
 * 对用户完全不可见。
 *
 * 天枢支持的补救点是 manifest 的 `hooks`：`preTurn` 由 `spawnSync` 阻塞执行，
 * 因此它跑完时网关一定已经在线，本轮请求不会落空。
 *
 * 这里刻意把「该做什么」抽成纯函数：hook 脚本本身只负责读状态、调这里、
 * 执行动作，判定逻辑可被单测穷举。
 *
 * @module tianshu-workbuddy-connect/keepalive
 */

/** 动作：`idle` 什么都不做；`start` 拉起；`restart` 先停后拉。 */
export const KEEPALIVE_ACTIONS = Object.freeze(['idle', 'start', 'restart'])

/**
 * 决定本轮 preTurn 该做什么。
 *
 * 「端口从哪来」是这里的关键：**状态文件不是唯一线索**。`stop`、清理数据目录、
 * 跨机器迁移都会让状态文件消失，但 `config.json` 里的绝对 URL 还在 —— 那时天枢
 * 的每个请求都会打在空端口上，而保活如果只看状态文件就会判定「尚未接入」、
 * 什么都不做，故障于是永久化。因此端口取 `state.port ?? input.port`，后者由
 * 调用方从天枢配置里反解。
 *
 * 与之配套的是 `input.disabled`：`stop` 会留下一个显式的「已停止」标记。没有
 * 这个标记的话，`stop` 就会变成空操作 —— 下一轮对话立刻把它拉回来，用户失去
 * 「我说停就停」的能力。
 *
 * @param {object} input
 * @param {object|undefined} input.state   网关状态文件内容（无则视为尚未接入）
 * @param {object|undefined} input.health  `/healthz` 的响应体（不可达则 undefined）
 * @param {string|undefined} input.version 当前插件版本
 * @param {number|undefined} [input.port]  配置里本插件网关应在的端口（状态文件缺失时的兜底）
 * @param {object|undefined} [input.disabled] 显式「已停止」标记
 * @param {boolean} [input.neverStart]     只探活、不拉起（诊断场景用）
 * @returns {{action: 'idle'|'start'|'restart', reason: string}}
 */
export function planKeepalive(input = {}) {
  const { state, health, version } = input
  const neverStart = input.neverStart === true
  const port = state?.port ?? input.port

  // 用户显式停过就尊重它。否则 `stop` 会被下一轮对话立即撤销。
  if (input.disabled !== undefined && input.disabled !== null) {
    return { action: 'idle', reason: '已显式停止（gateway.disabled）' }
  }
  // 状态文件与配置都指不出来 = 用户从没执行过接入。装个插件不该凭空多一个常驻进程。
  if (port === undefined || port === null) {
    return { action: 'idle', reason: '尚未接入（没有网关状态文件，配置里也没有本插件的 provider）' }
  }
  if (health !== undefined) {
    // 版本一致 = 端口上跑的确实是这份代码。版本不一致时守护进程用的是旧逻辑，
    // 表现为「代码改了却没生效」，必须换掉而不是将就。
    if (version === undefined || health.version === version) {
      return { action: 'idle', reason: '网关在线' }
    }
    return {
      action: neverStart ? 'idle' : 'restart',
      reason: `网关版本 ${health.version} 与插件 ${version} 不一致`,
    }
  }
  return {
    action: neverStart ? 'idle' : 'start',
    reason: `端口 ${port} 上没有存活的网关`,
  }
}

export default planKeepalive
