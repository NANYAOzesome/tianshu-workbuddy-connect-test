/**
 * 分离式派生的回归测试。
 *
 * 守的是这样一类缺陷：代码改了、跑起来也对，但网关**挂在了调用者的进程树下**，
 * 于是天枢回收 preTurn hook 时（Windows 走 `taskkill /F /T`，按父子关系整树击杀）
 * 把网关一起带走。症状是「模型时不时用不了」，而日志里只看到网关被反复拉起 ——
 * 极难从现象反推原因。
 *
 * 关键事实（probe/ppid-test.mjs 实测）：Windows 上 `detached: true` **不改变
 * 父子关系**，子进程的父 pid 依然是调用者。POSIX 的「自成进程组」语义在 Windows
 * 没有对应物，因此只靠 `detached` 挡不住 `taskkill /T`。
 *
 * 修复方式（Windows）：**双跳派生** —— 调用者 → relay → 网关，relay 派生完立刻
 * 退出，网关的父进程随即失效、脱离调用者子树。本测试即验证该不变式：
 *
 *   网关的父进程必须**查不到**（已被回收），而不是「查得到且是调用者」。
 *
 * 这正是回归点：把 `spawnDaemon` 改回单跳（去掉 relay），父进程就会变成本测试
 * 进程，断言立刻变红。
 *
 * 非 Windows 平台没有这个问题（POSIX 的 detached 是真 detached），跳过。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { cleanupTmpDir, makeTmpDir } from './helpers/tmp.js'
import { ensureGateway, stopGateway, DEFAULT_GATEWAY_PORT } from '../src/gateway.js'

const IS_WINDOWS = process.platform === 'win32'

/** Windows 上必须用绝对路径；Bash 的相对调用会被路径转换破坏。 */
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * 查一个 pid 的父进程是否还在。
 *
 * 返回 `'gone'`（父链失效）/ `'alive:<name>'`（父进程仍在）/ `'unknown'`
 * （查询本身失败 —— 不能把它当成通过，测试会据 `unknown` 报错）。
 *
 * 为什么要用 PowerShell 子进程而不是进程内的系统调用：本仓库的运行环境里
 * `wmic` 已在新版 Windows 被移除、`tasklist` 经 `execSync` 会报 EBUSY，
 * 而 `taskkill /PID` 会被路径转换破坏。PowerShell 的 `Get-CimInstance` 是唯一
 * 在本环境里稳定可用的途径。
 */
function parentStatus(pid) {
  const script = `
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue
    if (-not $p) { 'GONE_SELF' } else {
      $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
      if ($pp) { "ALIVE:" + $pp.Name } else { "GONE_PARENT" }
    }
  `
  try {
    const out = execFileSync(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    ).trim()
    if (out === 'GONE_PARENT' || out === 'GONE_SELF') return 'gone'
    if (out.startsWith('ALIVE:')) return `alive:${out.slice(6)}`
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

test('Windows 上网关必须走双跳派生：父链失效，不再挂在调用者子树里', { skip: !IS_WINDOWS }, async () => {
  const home = makeTmpDir('wb-detach-test-')
  const previousHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = home

  let result
  try {
    // 用一个不常见的端口，避免和真实接入的 17871 打架。
    const port = DEFAULT_GATEWAY_PORT + 3
    result = await ensureGateway({ port, version: undefined, startTimeoutMs: 12_000 })

    // 进程内回退路径（受限环境）没有独立的网关进程 —— 那种情况下本测试
    // 无从检查父链，但也要如实报出来，不能假装通过。
    if (result.inProcess === true) {
      assert.fail('本测试需要真正的分离式守护进程，但 ensureGateway 回退成了进程内实例')
    }

    const state = result.health
    assert.equal(typeof state?.pid, 'number', '健康检查里应带网关自己的 pid')

    // 断言的核心：继承链上不该再有活的父进程。
    //
    // 为什么不是「父进程不是本测试进程」——relay 退出后父 pid 会被系统复用，
    // 那个 pid 可能恰好落在别的无关进程上。语义上要的是「原父进程已消失」，
    // 而 relay 的 pid 属于**短命进程**，测试跑完时必然已被回收，所以这里
    // 观察到 `gone` 就是双跳生效的充分证据。单跳时父进程是本测试进程，必然
    // 存活，断言会以 `alive:node.exe` 失败。
    const status = parentStatus(state.pid)
    assert.notEqual(status, 'unknown', '父进程查询失败，无法判定（不能当成通过）')
    assert.equal(
      status,
      'gone',
      `网关 pid=${state.pid} 的父进程仍存活（${status}）——双跳派生可能被改回了单跳，`
      + '网关会重新落进 preTurn hook 的子树、被 taskkill /T 连带杀死',
    )
  } finally {
    // 收尾必须在 finally：断言失败时若不清理，会留下一个监听中的网关，
    // 后续用例的端口探测被污染。
    try { await stopGateway() } catch { /* 尽力而为 */ }
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    cleanupTmpDir(home)
  }
})
