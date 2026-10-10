/**
 * 天枢插件工具集。
 *
 * 每个工具的输出都是给**模型**读的紧凑 Markdown：先结论、再事实、最后下一步。
 * 工具永远不抛异常 —— 接入链路的每一环失败都转成 `isError` 加可执行的建议，
 * 这样模型能自己决定下一步，而不是收到一段堆栈。
 *
 * @module tianshu-workbuddy-connect/tools
 */

import { connect, disconnect, status } from './connect.js'
import { diagnose } from './doctor.js'
import { DEFAULT_GATEWAY_PORT, ensureGateway, gatewayStatus, VariantSources } from './gateway.js'
import { VARIANTS } from './variants.js'
import { clip, errorText } from './util.js'

/** 统一的结果构造。 */
function result(content, isError = false) {
  return { content, ...(isError ? { isError: true } : {}) }
}

/** 把一条失败报告渲染成可执行文本。 */
function renderFailure(report) {
  const lines = [`工作流在 **${report.stage}** 阶段中断。`, '', report.message]
  if (report.hint !== undefined) lines.push('', `下一步：${report.hint}`)
  if (Array.isArray(report.variants) && report.variants.length > 0) {
    lines.push('', '各桌面 App 的账号状态：')
    for (const variant of report.variants) {
      lines.push(`- ${variant.displayName}：${variant.signedIn === true ? `已登录（${variant.uid ?? '未知账号'}）` : `未登录${variant.reason === undefined ? '' : `（${variant.reason}）`}`}`)
    }
  }
  return lines.join('\n')
}

/**
 * 接入报告里「Key 池」那半句话。
 *
 * 天枢实际发出的凭据取自 `provider-keys.json`（同级于 config.json），它是
 * **权威来源**；`config.json` 的 `apiKey` 只是显示值。两者不一致时现象是稳定
 * 401，而配置页看起来完全正常 —— 所以这一行必须出现在接入结果里，不能只写
 * 「配置已写入」。
 */
function describeKeyPool(report) {
  const where = report.keyPoolPath === undefined ? '' : `（${report.keyPoolPath}）`
  switch (report.keyPoolAction) {
    case 'created': return `已新建并对齐${where}`
    case 'updated': return `已对齐${where}`
    case 'unchanged': return `已是最新${where}`
    case 'blocked': return '⚠️ 未改动 —— 该 provider 用的是 keyRef（指向 secrets.json），不由本插件管理'
    default: return `未涉及${where}`
  }
}

/** 千分位与毫秒两种时间表达。 */
function describeExpiry(expiresAtMs) {
  if (typeof expiresAtMs !== 'number' || expiresAtMs <= 0) return '未知'
  const minutes = Math.round((expiresAtMs - Date.now()) / 60000)
  const stamp = new Date(expiresAtMs).toISOString().replace('T', ' ').slice(0, 16)
  if (minutes <= 0) return `已过期（${stamp} UTC）`
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  const human = days > 0 ? `${days} 天 ${hours} 小时` : hours > 0 ? `${hours} 小时 ${rest} 分` : `${rest} 分`
  return `${human}后过期（${stamp} UTC）`
}

/* ------------------------------------------------------------------ *
 * 工具定义
 * ------------------------------------------------------------------ */

const connectTool = {
  definition: {
    name: 'workbuddy_connect',
    description:
      '把 WorkBuddy 桌面 App 内置的模型接入天枢：读取 App 的登录态、启动本地回环网关、'
      + '并把 provider 配置写入 ~/.rivet/config.json。复用 App 登录，不需要 API Key。幂等，可反复执行。',
    input_schema: {
      type: 'object',
      properties: {
        setDefault: { type: 'boolean', description: '是否同时把 workbuddy 设为天枢默认 provider（默认 false，不改变现有默认模型）' },
        forceRefresh: { type: 'boolean', description: '忽略目录缓存，强制向上游重新拉取一次模型列表' },
        port: { type: 'number', description: `指定本地网关端口（默认 ${DEFAULT_GATEWAY_PORT}）` },
        rotateToken: { type: 'boolean', description: '换发网关令牌（旧令牌立即作废），并把两处配置一起对齐到新令牌。仅在怀疑令牌泄漏、或端口上有残留实例不认当前令牌时才需要' },
      },
    },
  },
  isConcurrencySafe: () => false,
  requiresApproval: () => false,
  isEnabled: () => true,
  async execute(params = {}) {
    const report = await connect({
      setDefault: params.setDefault === true,
      forceRefresh: params.forceRefresh === true,
      rotateToken: params.rotateToken === true,
      ...(typeof params.port === 'number' ? { port: params.port } : {}),
    })
    if (report.ok !== true) return result(renderFailure(report), true)

    const lines = [
      `已接入 **${report.displayName}**，共 **${report.models}** 个模型。`,
      '',
      `- 账号：${report.account.nickname ?? report.account.uid ?? '未知'}${report.account.domain === undefined ? '' : `（${report.account.domain}）`}`,
      `- 网关：127.0.0.1:${report.port}${report.gatewayReused === true ? '（复用已有实例）' : '（已启动）'}${report.gatewayInProcess === true ? '，进程内模式' : ''}`,
      `- 令牌：${describeExpiry(report.account.expiresAtMs)}${report.tokenRotated === true ? '（本次已换发网关令牌）' : ''}`,
      `- 目录来源：${report.catalogSource === 'live' ? '本次实时拉取' : report.catalogSource}`,
      `- 配置：${report.configChanged === true ? '已写入' : '已是目标状态'} ${report.configPath}`,
      // 天枢真正读取凭据的地方。不写这一行的话，「配置写成功但请求 401」就没线索。
      `- Key 池（天枢实际取凭据处）：${describeKeyPool(report)}`,
      `- 默认 provider：${report.isDefault === true ? '已切换到 workbuddy' : '未改动'}`,
      '',
      `可用模型：${report.modelIds.join('、')}`,
    ]
    if (report.configNotes.length > 0) lines.push('', `配置变更：${report.configNotes.join('；')}`)
    if ((report.keyPoolNotes ?? []).length > 0) lines.push('', `Key 池变更：${report.keyPoolNotes.join('；')}`)
    if (report.configBackup !== undefined) lines.push('', `原配置已备份到：${report.configBackup}`)
    for (const warning of report.warnings) lines.push('', `⚠️ ${warning}`)
    lines.push('', '下一步：天枢在**启动时**读取 provider 配置，请新开一个会话（或重启天枢）后即可在模型列表中看到这些模型。')

    return result(lines.join('\n'))
  },
}

const statusTool = {
  definition: {
    name: 'workbuddy_status',
    description: '查看 WorkBuddy 接入状态：网关是否在线、桌面 App 账号与令牌有效期、模型数量、天枢配置与 Key 池是否对齐。',
    input_schema: { type: 'object', properties: {} },
  },
  isConcurrencySafe: () => true,
  requiresApproval: () => false,
  isEnabled: () => true,
  async execute() {
    try {
      const report = await status()
      const gatewayState = report.gateway.running === true
        ? `运行中（127.0.0.1:${report.gateway.port}，模式 ${report.gateway.mode ?? 'daemon'}，${report.gateway.models ?? 0} 个模型）`
        // 「端口上有本插件但不认当前令牌」不能简写成「未运行」：那会把人引去查
        // 启动失败，而实际要处置的是那个残留实例。
        : report.gateway.tokenAccepted === false
          ? `127.0.0.1:${report.gateway.port} 上有本插件的实例，但它不认当前令牌`
          : '未运行'
      const lines = [
        `接入状态：**${report.ready === true ? '就绪' : '未就绪'}**`,
        '',
        `- 网关：${gatewayState}`,
        `- 天枢配置：${report.config.ok === true ? `已指向网关（${report.config.modelCount} 个模型${report.config.isDefault === true ? '，默认 provider' : ''}）` : `未就绪 — ${report.config.reason}`}`,
        `- Key 池：${report.config.keyPool === undefined
          ? '未涉及'
          : `${report.config.keyPool.ok === true ? '与网关令牌一致' : `**不一致** — ${report.config.keyPool.reason}`}（权威来源：${report.config.keyPool.authoritative}）`}`,
        '',
        '桌面 App 账号：',
      ]
      for (const variant of report.variants) {
        if (variant.signedIn === true) {
          lines.push(`- ${variant.displayName}：已登录 · ${variant.nickname ?? variant.uid ?? '未知'} · 令牌${describeExpiry(variant.expiresAtMs)} · ${variant.models} 个模型（来源 ${variant.catalogSource}）`)
        } else {
          lines.push(`- ${variant.displayName}：未登录${variant.reason === undefined ? '' : `（${clip(variant.reason, 120)}）`}`)
        }
        if (variant.note !== undefined) lines.push(`    · ${variant.note}`)
      }
      for (const note of report.notes ?? []) lines.push(`    · ${note}`)
      if (report.ready !== true) {
        lines.push('', '下一步：执行 `workbuddy_connect` 完成接入；失败细节可用 `workbuddy_doctor` 定位。')
      }
      return result(lines.join('\n'))
    } catch (error) {
      return result(`读取状态失败：${clip(errorText(error), 300)}`, true)
    }
  },
}

const modelsTool = {
  definition: {
    name: 'workbuddy_models',
    description: '列出当前 WorkBuddy 账号可用的模型，含上下文窗口、最大输出、推理档位与是否支持图片输入。',
    input_schema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: '强制向上游重新拉取，而不是使用缓存' },
      },
    },
  },
  isConcurrencySafe: () => true,
  requiresApproval: () => false,
  isEnabled: () => true,
  async execute(params = {}) {
    try {
      // 优先问正在运行的网关 —— 它服务的模型就是天枢会调用的模型。
      const gateway = await gatewayStatus()
      let payload
      if (gateway.running === true) {
        const response = await fetch(`http://127.0.0.1:${gateway.port}/_gw/models${params.refresh === true ? '?refresh=1' : ''}`, {
          headers: { Authorization: `Bearer ${gateway.token}` },
          signal: AbortSignal.timeout(20_000),
        })
        payload = await response.json()
        if (!response.ok) return result(`读取模型列表失败：${clip(payload?.error?.message ?? `http ${response.status}`, 300)}`, true)
      } else {
        // 网关没起就直接问上游，至少让用户能看到目录。
        const sources = new VariantSources()
        const active = await sources.active()
        if (active.error !== undefined) return result(`未取到可用凭据：${clip(errorText(active.error), 300)}`, true)
        const catalog = await sources.catalogFor(active, params.refresh === true)
        payload = { variant: active.variant.id, displayName: active.variant.displayName, source: catalog.source, models: catalog.models }
      }

      const models = payload.models ?? []
      if (models.length === 0) return result('当前账号没有可用模型。', true)
      const lines = [
        `${payload.displayName ?? 'WorkBuddy'} 当前可用 **${models.length}** 个模型（目录来源：${payload.source === 'live' ? '实时' : payload.source ?? '未知'}）：`,
        '',
        '| 模型 ID | 上下文 | 最大输出 | 推理档 | 图片 |',
        '| --- | --- | --- | --- | --- |',
      ]
      for (const model of models) {
        lines.push(
          `| \`${model.id}\` | ${Math.round((model.contextWindow ?? 0) / 1000)}K | ${Math.round((model.maxTokens ?? 0) / 1000)}K | ${model.reasoningEffort ?? '—'} | ${model.supportsVision === true ? '✓' : '—'} |`,
        )
      }
      lines.push('', '在天枢里用 `/model <id>`，或启动时 `--model <id>` 指定模型。')
      return result(lines.join('\n'))
    } catch (error) {
      return result(`读取模型列表失败：${clip(errorText(error), 300)}`, true)
    }
  },
}

const refreshTool = {
  definition: {
    name: 'workbuddy_refresh',
    description: '重新同步 WorkBuddy：刷新登录令牌、重新拉取模型目录，并把最新模型列表写回天枢配置。模型列表变化后用它。',
    input_schema: {
      type: 'object',
      properties: {
        setDefault: { type: 'boolean', description: '是否同时把 workbuddy 设为天枢默认 provider' },
      },
    },
  },
  isConcurrencySafe: () => false,
  requiresApproval: () => false,
  isEnabled: () => true,
  async execute(params = {}) {
    try {
      // 先让各变体的凭据存储做一次显式刷新，确保网关随后用的是新令牌。
      const { UpstreamClient, enrichCredential } = await import('./upstream.js')
      const { CredentialStore } = await import('./credential.js')
      const client = new UpstreamClient()
      const refreshed = []
      for (const variant of VARIANTS) {
        const store = new CredentialStore({ variant, refresh: c => client.refreshToken(enrichCredential(c, variant)) })
        const own = store.own()
        if (own === undefined) continue
        try {
          store.persistOwn(await store.resolve())
          refreshed.push(variant.displayName)
        } catch { /* 某个变体刷新失败不影响另一个 */ }
      }
      const report = await connect({ setDefault: params.setDefault === true, forceRefresh: true })
      if (report.ok !== true) return result(renderFailure(report), true)
      const lines = [
        `已重新同步：**${report.models}** 个模型（${report.catalogSource === 'live' ? '实时目录' : report.catalogSource}）。`,
        `- 令牌：${describeExpiry(report.account.expiresAtMs)}`,
        `- 网关：127.0.0.1:${report.port}`,
      ]
      if (refreshed.length > 0) lines.push(`- 已刷新登录令牌：${refreshed.join('、')}`)
      if (report.configNotes.length > 0) lines.push(`- 配置变更：${report.configNotes.join('；')}`)
      // 只报 config.json 是不够的：天枢取凭据的地方是同级的 provider-keys.json。
      lines.push(`- Key 池：${describeKeyPool(report)}`)
      lines.push('', '新模型在天枢**新会话**中可见。')
      return result(lines.join('\n'))
    } catch (error) {
      return result(`重新同步失败：${clip(errorText(error), 400)}`, true)
    }
  },
}

const doctorTool = {
  definition: {
    name: 'workbuddy_doctor',
    description: '诊断 WorkBuddy 接入链路：凭据文件、加密解密、Electron 助手、上游连通性、本地网关、天枢配置、天枢 Key 池，并做一次真实对话验证。',
    input_schema: {
      type: 'object',
      properties: {
        startGateway: { type: 'boolean', description: '网关未运行时是否尝试自动拉起（默认 true）' },
        skipProbe: { type: 'boolean', description: '跳过真实对话验证（只做静态检查）' },
      },
    },
  },
  isConcurrencySafe: () => true,
  requiresApproval: () => false,
  isEnabled: () => true,
  async execute(params = {}) {
    try {
      const report = await diagnose({
        startGateway: params.startGateway !== false,
        probe: params.skipProbe !== true,
      })
      const lines = [`诊断结果：**${report.ok === true ? '全部通过' : `${report.failed.length} 项未通过`}**`, '']
      for (const entry of report.checks) {
        lines.push(`- ${entry.ok === true ? '✅' : '❌'} ${entry.summary}`)
        if (entry.detail !== undefined && entry.detail !== '') lines.push(`    · ${clip(entry.detail, 220)}`)
        if (entry.ok !== true && entry.hint !== undefined) lines.push(`    → ${entry.hint}`)
      }
      lines.push('', `插件状态目录：${report.stateDir}`)
      if (report.ok !== true) lines.push('', '按上面箭头的顺序处理，处理完再跑一次本诊断。')
      return result(lines.join('\n'), report.ok !== true)
    } catch (error) {
      return result(`诊断执行失败：${clip(errorText(error), 400)}`, true)
    }
  },
}

const logoutTool = {
  definition: {
    name: 'workbuddy_logout',
    description: '断开 WorkBuddy 接入：停止本地网关、从天枢配置中移除 workbuddy provider，可选清理插件自留的凭据副本。不会影响 WorkBuddy 桌面 App 自身的登录。',
    input_schema: {
      type: 'object',
      properties: {
        clearCredentials: { type: 'boolean', description: '是否同时删除插件自留的凭据副本（默认否；桌面 App 的登录不受影响）' },
      },
    },
  },
  isConcurrencySafe: () => false,
  // 会修改用户配置，因此需要显式确认。
  requiresApproval: () => true,
  isEnabled: () => true,
  async execute(params = {}) {
    try {
      const report = await disconnect({ clearCredentials: params.clearCredentials === true })
      const lines = [
        '已断开 WorkBuddy 接入。',
        '',
        `- 本地网关：${report.gateway.stopped === true ? '已停止' : `未停止（${report.gateway.reason ?? '没有运行中的实例'}）`}`,
        `- 天枢配置：${report.config.removed === true ? `已移除 \`providers.workbuddy\`${report.config.clearedDefault === true ? '，并清空了指向它的默认 provider' : ''}` : `未移除（${report.config.reason}）`}`,
      ]
      if (report.clearedCredentials.length > 0) lines.push(`- 已清理自留凭据副本：${report.clearedCredentials.join('、')}`)
      if (report.config.backup !== undefined) lines.push(`- 原配置已备份到：${report.config.backup}`)
      lines.push('', report.note)
      return result(lines.join('\n'))
    } catch (error) {
      return result(`断开接入失败：${clip(errorText(error), 400)}`, true)
    }
  },
}

/** 插件导出的全部工具。 */
export const tools = [connectTool, statusTool, modelsTool, refreshTool, doctorTool, logoutTool]

/**
 * 插件加载钩子。
 *
 * 天枢的插件契约只有 `tools`；这里额外做的唯一一件事是**在会话启动时确保网关
 * 在线**（幂等）。不做这一步的话，用户装完插件、重启天枢后，provider 配置指向
 * 的端口上什么都没有，第一个请求就会失败 —— 而失败原因（端口没人监听）对用户
 * 完全不可见。因此主动预热，且失败不阻塞会话启动。
 */
export async function activate() {
  try {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    let version = '1.0.0'
    try {
      const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
      if (typeof pkg.version === 'string') version = pkg.version
    } catch { /* 版本仅用于漂移检测 */ }
    await ensureGateway({ version })
  } catch {
    // 预热失败留给工具与诊断去报告：会话本身必须能正常起来。
  }
}
