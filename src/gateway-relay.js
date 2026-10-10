/**
 * 网关「双跳派生」中转进程（仅 Windows 需要）。
 *
 * 背景：天枢的 `killProcessTree` 在 Windows 走 `taskkill /F /T`，按**父子关系**
 * 整树击杀。本插件最常从 `preTurn` hook 里拉起网关，而 hook 是天枢用 `spawnSync`
 * 拉起的子进程 —— 于是网关落在 hook 的子树里，天枢回收 hook 时把网关一并带走。
 * 实测确认 `detached: true` 在 Windows **不改变父子关系**，挡不住 `taskkill /T`。
 *
 * 解法：多插这一跳。调用者派生本脚本（relay），relay 再把网关派生出来，
 * 然后**立刻退出**。网关的父进程随即失效，不再出现在调用者的父子链上，
 * 因而不再被 `taskkill /T` 牵连。
 *
 * 契约（由 `spawnDaemon` 保证）：
 *   argv[2]              —— gateway-server.js 的绝对路径
 *   argv[3..]            —— 透传给 gateway-server.js 的参数（如 --port 17871）
 *   WORKBUDDY_GATEWAY_TOKEN —— 令牌，经环境变量继承给网关
 *
 * 本脚本刻意**不自己校验参数**：它跑不通时最坏只是让网关退回单跳派生，
 * 由保活兜底，不该把失败放大成「网关起不来」。
 */

import { spawn } from 'node:child_process'

const serverEntry = process.argv[2]
const serverArgs = process.argv.slice(3)

if (typeof serverEntry === 'string' && serverEntry !== '') {
  try {
    const gateway = spawn(process.execPath, [serverEntry, ...serverArgs], {
      // 网关自己也要 detached：它不该被 relay 的退出牵连（relay 马上就走）。
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // env 原样继承 —— 令牌就在其中，不经过命令行。
      env: process.env,
    })
    gateway.unref()
  } catch {
    // 派生失败：静默退出。保活会在下一轮把网关拉起来。
  }
}

// 立刻退出，让网关的父链失效 —— 这正是「双跳」的意义所在。
process.exit(0)
