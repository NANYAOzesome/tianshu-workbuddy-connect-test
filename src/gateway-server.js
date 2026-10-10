/**
 * 网关守护进程入口。
 *
 * 由 `ensureGateway()` 以 `detached + unref` 派生的独立 Node 进程 —— 它的生命
 * 周期**不绑定**任何一个会话：天枢的子代理 / worker 是独立进程，网关若只活在
 * 主会话里，它们一发请求就会打到已经消失的端口。
 *
 * 令牌从环境变量 `WORKBUDDY_GATEWAY_TOKEN` 传入（不回落到命令行参数，避免
 * 出现在进程列表里）。
 *
 * @module tianshu-workbuddy-connect/gateway-server
 */

import { createGatewayServer, DEFAULT_GATEWAY_PORT, readGatewayState, VariantSources, writeGatewayState } from './gateway.js'
import { errorText, logLine, parsePort } from './util.js'

const HELP = `用法：node gateway-server.js [--port <n>] [--variant <workbuddy|workbuddy-ai>]

环境变量：
  WORKBUDDY_GATEWAY_TOKEN   必填，网关令牌（由 ensureGateway 生成并传入）
  WORKBUDDY_GATEWAY_PORT    可选，默认 ${DEFAULT_GATEWAY_PORT}
`

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') options.port = parsePort(argv[++i], undefined)
    else if (arg === '--variant') options.variant = argv[++i]
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const port = args.port ?? parsePort(process.env.WORKBUDDY_GATEWAY_PORT, DEFAULT_GATEWAY_PORT)
const token = process.env.WORKBUDDY_GATEWAY_TOKEN

if (typeof token !== 'string' || token === '') {
  process.stderr.write('缺少 WORKBUDDY_GATEWAY_TOKEN，拒绝启动\n')
  process.exit(2)
}

// 版本号从 package.json 读回，healthz 与配置写入共用同一个值。
const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const { dirname, join } = await import('node:path')
let version = '1.0.0'
try {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
  if (typeof pkg.version === 'string') version = pkg.version
} catch { /* 版本仅用于展示，读不到不致命 */ }

const sources = new VariantSources({
  preferred: args.variant,
  ...(process.env.WORKBUDDY_AUTH_FILE === undefined ? {} : { authFileCN: process.env.WORKBUDDY_AUTH_FILE }),
  ...(process.env.WORKBUDDY_AI_AUTH_FILE === undefined ? {} : { authFileAI: process.env.WORKBUDDY_AI_AUTH_FILE }),
})

const server = createGatewayServer({ sources, token, version })

server.on('error', error => {
  logLine('gateway-server', `listen failed on ${port}: ${errorText(error)}`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  writeGatewayState({ version: 1, port, token, pid: process.pid, mode: 'daemon', startedAt: Date.now() })
  logLine('gateway-server', `listening on 127.0.0.1:${port} pid=${process.pid}`)
  startOwnershipWatchdog()
})

/**
 * 归属看门狗：一旦「状态文件记的不再是自己」，就退出。
 *
 * 解决的是守护进程最难看的一种残留：状态文件被删掉（用户清过数据目录、跨机器
 * 迁移、`logout` 与 `stop` 竞态）之后，进程还在、端口还占着，而插件再也无从
 * 得知它的 pid —— 于是既停不掉也认不出，只能等重启。让它自己发现「我已经不是
 * 被记录的那个实例了」并退出，比事后靠 OS 工具清理可靠得多。
 *
 * 三种退出条件：状态文件消失 / pid 不是自己 / 令牌不是自己。
 * 第三种同时兜住了「另一世代先写了状态文件」的情形 —— 谁被记录，谁留下。
 */
function startOwnershipWatchdog() {
  const INTERVAL_MS = 30_000
  const timer = setInterval(() => {
    try {
      const state = readGatewayState()
      if (state === undefined) {
        logLine('gateway-server', '状态文件已消失，本实例不再是记录中的网关，退出')
        shutdown('watchdog')
        return
      }
      if (state.pid !== process.pid) {
        logLine('gateway-server', `状态文件记录的 pid=${state.pid} 不是本进程 ${process.pid}，退出`)
        shutdown('watchdog')
        return
      }
      if (state.token !== token) {
        logLine('gateway-server', '状态文件记录的令牌与本实例不一致，退出')
        shutdown('watchdog')
      }
    } catch { /* 状态文件暂时读不到（正在被替换）不足以判定，等下一轮 */ }
  }, INTERVAL_MS)
  // 看门狗绝不能成为「进程不退出」的理由。
  timer.unref?.()
}

/** 优雅关闭：先把监听释放掉，再退出。状态文件由 stopGateway 负责清理。 */
function shutdown(signal) {
  logLine('gateway-server', `received ${signal}, shutting down`)
  server.close(() => process.exit(0))
  server.closeAllConnections?.()
  // 极端情况下 close 回调不来（有挂起连接），兜底强制退出。
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
