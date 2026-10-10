#!/usr/bin/env node
/**
 * Tianshu WorkBuddy Connect 命令行入口。
 *
 * 与插件工具共享同一套编排代码，因此 CLI 与对话内工具的行为**不可能**漂移。
 * 命令行存在的意义是：脚本化安装（CI/容器/新机初始化）、以及在会话之外排查
 * 问题。
 *
 * 退出码：0 成功；1 业务失败；2 用法错误。
 *
 * @module tianshu-workbuddy-connect/bin/cli
 */

import { connect, disconnect, status } from '../src/connect.js'
import { diagnose } from '../src/doctor.js'
import { DEFAULT_GATEWAY_PORT, ensureGateway, stopGateway, VariantSources, gatewayStatus } from '../src/gateway.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const HELP = `tianshu-workbuddy-connect v${VERSION}

把 WorkBuddy 桌面 App 的模型接入天枢 Tianshu Harness（复用 App 登录，无需 API Key）。

用法：
  tianshu-workbuddy-connect <命令> [选项]

命令：
  install        接入：启动本地网关、拉取模型目录、写入天枢 provider 配置
  status         查看接入状态（网关 / 账号 / 配置 / Key 池是否对齐）
  models         列出当前账号可用的模型
  refresh        刷新登录令牌并重新同步模型目录到天枢配置
  rotate-token   换发网关令牌，并把两处配置一起对齐（旧令牌立即作废）
  doctor         诊断接入链路（含一次真实对话验证）
  serve          前台运行本地网关（调试用，Ctrl+C 退出）
  stop           停止后台网关
  uninstall      断开接入（停止网关 + 移除 provider 配置）
  version        打印版本
  help           显示本帮助

选项：
  --port <n>             网关端口（默认 ${DEFAULT_GATEWAY_PORT}）
  --default              同时把 workbuddy 设为天枢默认 provider
  --force-refresh        忽略目录缓存，向上游重新拉取模型列表
  --rotate-token         换发网关令牌（可与 install / refresh 连用）
  --no-probe             doctor：跳过真实对话验证
  --clear-credentials    uninstall：同时删除插件自留的凭据副本
  --json                 以 JSON 输出（status / models / doctor）
`

/** 极简参数解析：本 CLI 的参数是封闭集合，不引入依赖。 */
function parseArgs(argv) {
  const options = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--port': options.port = Number(argv[++i]); break
      case '--default': options.setDefault = true; break
      case '--force-refresh': options.forceRefresh = true; break
      case '--rotate-token': options.rotateToken = true; break
      case '--no-probe': options.probe = false; break
      case '--clear-credentials': options.clearCredentials = true; break
      case '--json': options.json = true; break
      case '--help': case '-h': options.help = true; break
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`未知选项：${arg}\n\n${HELP}`)
          process.exit(2)
        }
        options._.push(arg)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const command = options._[0] ?? (options.help === true ? 'help' : 'help')

/** JSON 或人类可读二选一输出。 */
function emit(value, humanRenderer) {
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  process.stdout.write(`${humanRenderer(value)}\n`)
}

/** 把键值对渲染成对齐的两列。 */
function kv(pairs) {
  const width = Math.max(0, ...pairs.map(([key]) => key.length))
  return pairs.map(([key, value]) => `  ${key.padEnd(width)}  ${value}`).join('\n')
}

function expireText(expiresAtMs) {
  if (typeof expiresAtMs !== 'number' || expiresAtMs <= 0) return '未知'
  const minutes = Math.round((expiresAtMs - Date.now()) / 60000)
  if (minutes <= 0) return '已过期'
  const days = Math.floor(minutes / 1440)
  if (days > 0) return `${days} 天后过期`
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours} 小时后过期` : `${minutes} 分钟后过期`
}

async function runInstall() {
  const report = await connect({
    setDefault: options.setDefault === true,
    forceRefresh: options.forceRefresh === true,
    rotateToken: options.rotateToken === true,
    ...(Number.isFinite(options.port) ? { port: options.port } : {}),
  })
  if (report.ok !== true) {
    emit(report, value => `接入失败（阶段：${value.stage}）：${value.message}\n下一步：${value.hint ?? '运行 doctor 获取更多信息'}`)
    process.exitCode = 1
    return
  }
  emit(report, value => {
    const lines = [
      `✅ 已接入 ${value.displayName}，共 ${value.models} 个模型`,
      '',
      kv([
        ['账号', `${value.account.nickname ?? value.account.uid ?? '未知'}${value.account.domain ? `  (${value.account.domain})` : ''}`],
        ['网关', `127.0.0.1:${value.port}${value.gatewayReused ? '（复用）' : '（已启动）'}${value.gatewayInProcess === true ? '（进程内）' : ''}`],
        ['令牌', `${expireText(value.account.expiresAtMs)}${value.tokenRotated === true ? '｜本次已换发' : ''}`],
        ['目录', value.catalogSource === 'live' ? '本次实时拉取' : value.catalogSource],
        ['配置', `${value.configChanged ? '已写入' : '已是目标状态'}  ${value.configPath}`],
        ['Key 池', keyPoolText(value)],
        ['默认', value.isDefault ? '已切换为 workbuddy' : '未改动'],
      ]),
    ]
    if (value.configBackup) lines.push('', `原配置已备份：${value.configBackup}`)
    for (const note of value.keyPoolNotes ?? []) lines.push(`  · Key 池：${note}`)
    for (const warning of value.warnings) lines.push('', `⚠️  ${warning}`)
    lines.push('', `模型：${value.modelIds.join('、')}`)
    lines.push('', '下一步：新开一个天枢会话（或在 TUI 中重启），模型即可用。')
    return lines.join('\n')
  })
}

/**
 * Key 池一句话摘要。
 *
 * 「天枢实际用哪把 Key」取自 `provider-keys.json` 而不是 `config.json`，
 * 所以这一行必须出现在接入结果里 —— 它不一致时现象是稳定 401，而配置页看起来
 * 完全正常。
 */
function keyPoolText(value) {
  const action = value.keyPoolAction
  const label = {
    created: '已创建',
    updated: '已对齐',
    unchanged: '已是最新',
    blocked: '⚠️ 未改动（见下方说明）',
  }[action] ?? (action ?? '未涉及')
  return `${label}  ${value.keyPoolPath ?? ''}`.trim()
}

async function runStatus() {
  const report = await status()
  emit(report, value => {
    const lines = [
      value.ready ? '✅ 接入就绪' : '⚠️  接入未就绪',
      '',
      kv([
        ['网关', value.gateway.running
          ? `运行中 127.0.0.1:${value.gateway.port} (${value.gateway.mode ?? 'daemon'}, ${value.gateway.models ?? 0} 模型)`
          : value.gateway.tokenAccepted === false
            ? `端口 ${value.gateway.port} 上有实例但不认当前令牌（详见下方提示）`
            : '未运行'],
        ['天枢配置', value.config.ok
          ? `已指向网关 (${value.config.modelCount} 模型${value.config.isDefault ? ', 默认 provider' : ''})`
          : `未就绪 — ${value.config.reason}`],
        // 这一行是天枢侧的**权威凭据来源**；`config.json` 只是显示值。
        ['Key 池', value.config.keyPool === undefined
          ? '未涉及'
          : `${value.config.keyPool.ok ? '一致' : '不一致'}（权威来源：${value.config.keyPool.authoritative}）`],
      ]),
      '',
      '桌面 App 账号：',
    ]
    for (const variant of value.variants) {
      lines.push(variant.signedIn
        ? `  ✓ ${variant.displayName}：${variant.nickname ?? variant.uid ?? '未知'}｜令牌${expireText(variant.expiresAtMs)}｜${variant.models} 个模型（${variant.catalogSource}）`
        : `  ✗ ${variant.displayName}：未登录${variant.reason ? `（${variant.reason}）` : ''}`)
      if (variant.note) lines.push(`      · ${variant.note}`)
    }
    for (const note of value.notes) lines.push('', `提示：${note}`)
    if (!value.ready) lines.push('', '下一步：运行 `install` 完成接入，或用 `doctor` 定位问题。')
    return lines.join('\n')
  })
  if (report.ready !== true) process.exitCode = 1
}

async function runModels() {
  const gateway = await gatewayStatus()
  let payload
  if (gateway.running) {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/_gw/models${options.forceRefresh === true ? '?refresh=1' : ''}`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
      signal: AbortSignal.timeout(20_000),
    })
    payload = await response.json()
    if (!response.ok) {
      process.stderr.write(`读取模型列表失败：${payload?.error?.message ?? response.status}\n`)
      process.exitCode = 1
      return
    }
  } else {
    const sources = new VariantSources()
    const active = await sources.active()
    if (active.error !== undefined) {
      process.stderr.write(`未取到可用凭据：${active.error.message}\n`)
      process.exitCode = 1
      return
    }
    const catalog = await sources.catalogFor(active, options.forceRefresh === true)
    payload = { displayName: active.variant.displayName, source: catalog.source, models: catalog.models }
  }

  emit(payload, value => {
    const lines = [`${value.displayName ?? 'WorkBuddy'}：${value.models.length} 个模型（来源：${value.source === 'live' ? '实时' : value.source}）`, '']
    for (const model of value.models) {
      const ctx = `${Math.round((model.contextWindow ?? 0) / 1000)}K`
      const out = `${Math.round((model.maxTokens ?? 0) / 1000)}K`
      lines.push(`  ${model.id.padEnd(24)} ctx ${ctx.padStart(6)}  out ${out.padStart(6)}  ${(model.reasoningEffort ?? '-').padEnd(7)} ${model.supportsVision ? '图片' : ''}`)
    }
    return lines.join('\n')
  })
}

async function runRefresh() {
  const report = await connect({
    setDefault: options.setDefault === true,
    forceRefresh: true,
    rotateToken: options.rotateToken === true,
  })
  if (report.ok !== true) {
    emit(report, value => `重新同步失败（阶段：${value.stage}）：${value.message}\n下一步：${value.hint ?? '运行 doctor'}`)
    process.exitCode = 1
    return
  }
  emit(report, value => `✅ 已重新同步：${value.models} 个模型，网关 127.0.0.1:${value.port}${value.tokenRotated === true ? '（令牌已换发）' : ''}。新模型在新会话中可见。`)
}

/**
 * 换发网关令牌。
 *
 * 与 `install --rotate-token` 是同一件事，单独给一个命令只是为了让它可被
 * 发现：令牌泄漏、或怀疑「端口上有个不认当前令牌的残留实例」时，这一步比
 * 手动删状态文件更可预期 —— 它会顺带把 `config.json` 与 `provider-keys.json`
 * 一起对齐到新令牌。
 */
async function runRotateToken() {
  options.rotateToken = true
  await runInstall()
}

async function runDoctor() {
  const report = await diagnose({ startGateway: true, probe: options.probe !== false })
  emit(report, value => {
    const lines = [value.ok ? '✅ 诊断全部通过' : `❌ 诊断未通过（${value.failed.length} 项）`, '']
    for (const entry of value.checks) {
      lines.push(`${entry.ok ? '✅' : '❌'} ${entry.summary}`)
      if (entry.detail) lines.push(`     ${entry.detail}`)
      if (!entry.ok && entry.hint) lines.push(`     → ${entry.hint}`)
    }
    lines.push('', `状态目录：${value.stateDir}`)
    return lines.join('\n')
  })
  if (report.ok !== true) process.exitCode = 1
}

async function runServe() {
  const { createGatewayServer } = await import('../src/gateway.js')
  const { readGatewayState, ensureGatewayToken, writeGatewayState } = await import('../src/gateway.js')
  const port = Number.isFinite(options.port) ? options.port : DEFAULT_GATEWAY_PORT
  const token = ensureGatewayToken(readGatewayState()?.token)
  const sources = new VariantSources()
  const server = createGatewayServer({ sources, token, version: VERSION })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  writeGatewayState({ version: 1, port, token, pid: process.pid, mode: 'foreground', startedAt: Date.now() })
  process.stdout.write(`网关已在 127.0.0.1:${port} 运行（前台模式）。令牌：${token}\nCtrl+C 退出。\n`)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)))
  }
}

async function runStop() {
  const result = await stopGateway()
  emit(result, value => (value.stopped ? `✅ 已停止后台网关（${value.mode}）` : `未停止：${value.reason ?? '没有运行中的实例'}`))
}

async function runUninstall() {
  const report = await disconnect({ clearCredentials: options.clearCredentials === true })
  emit(report, value => {
    const lines = [
      '已断开 WorkBuddy 接入。',
      '',
      kv([
        ['网关', value.gateway.stopped ? '已停止' : `未停止（${value.gateway.reason ?? '没有实例'}）`],
        ['配置', value.config.removed ? `已移除 providers.workbuddy${value.config.clearedDefault ? '，并清空默认 provider' : ''}` : `未移除（${value.config.reason}）`],
      ]),
    ]
    if (value.config.backup) lines.push(`  原配置已备份：${value.config.backup}`)
    if (value.clearedCredentials.length > 0) lines.push(`  已清理自留凭据：${value.clearedCredentials.join('、')}`)
    lines.push('', value.note)
    return lines.join('\n')
  })
}

const COMMANDS = {
  install: runInstall,
  status: runStatus,
  models: runModels,
  refresh: runRefresh,
  'rotate-token': runRotateToken,
  doctor: runDoctor,
  serve: runServe,
  stop: runStop,
  uninstall: runUninstall,
  version: async () => { process.stdout.write(`${VERSION}\n`) },
  help: async () => { process.stdout.write(HELP) },
}

const handler = COMMANDS[command]
if (handler === undefined) {
  process.stderr.write(`未知命令：${command}\n\n${HELP}`)
  process.exit(2)
}

try {
  await handler()
} catch (error) {
  process.stderr.write(`执行失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
