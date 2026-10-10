/**
 * 接入编排：把「拉起网关 → 取实时目录 → 写回天枢配置」串成一次幂等操作。
 *
 * 工具与 CLI 都只调用这里，因此「装上了但没生效」这类问题只可能有一个成因
 * 集合，也只需要在一处修。
 *
 * 设计取向：**不抛异常，返回结构化报告**。接入过程的每一步失败都携带可执行的
 * 下一步建议，交给工具把它渲染给模型/用户，而不是让一次失败的接入变成一段
 * 堆栈。
 *
 * @module tianshu-workbuddy-connect/connect
 */

import {
  ensureGateway, gatewayDisabled, gatewayStatus, readGatewayState, rotateGatewayToken, stopGateway,
  VariantSources, DEFAULT_GATEWAY_PORT,
} from './gateway.js'
import { detectDrift, installProvider, classifyBaseUrl, removeProvider } from './rivet-config.js'
import { AI_VARIANT, CN_VARIANT, VARIANTS } from './variants.js'
import { PLUGIN_VERSION } from './version.js'
import { clip, errorText } from './util.js'

/**
 * 接入 WorkBuddy 到天枢。
 *
 * @param {object} [options]
 * @param {number}  [options.port]          指定网关端口
 * @param {boolean} [options.setDefault]    是否同时设为天枢默认 provider
 * @param {boolean} [options.forceRefresh]  忽略目录 TTL 缓存，强制向上游拉一次
 * @param {boolean} [options.rotateToken]   换发网关令牌（旧令牌立即作废）
 * @param {string}  [options.expectedBaseUrl] 现有条目若指向此处则视为「自己人」，不告警
 * @returns {Promise<object>} 结构化报告
 */
export async function connect(options = {}) {
  const version = PLUGIN_VERSION

  // 阶段零：令牌换代（可选）。
  //
  // 顺序很关键：先停掉旧实例再换令牌。反过来做的话，端口上那个还用着旧令牌的
  // 实例会变成「同门不同代」，`ensureGateway` 只能顺延到下一个端口 —— 配置里的
  // baseUrl 于是跟着漂，而用户只是想换一把令牌。
  let rotated = false
  if (options.rotateToken === true) {
    const previous = readGatewayState()
    await stopGateway()
    rotateGatewayToken()
    rotated = true
    if (options.port === undefined && previous?.port !== undefined) {
      // 保住原端口：配置里存的是绝对 URL。
      options = { ...options, port: previous.port }
    }
  }

  // 阶段一：网关。
  let gateway
  try {
    gateway = await ensureGateway({
      port: options.port,
      version,
      sourceOptions: options.sourceOptions ?? {},
    })
  } catch (error) {
    return {
      ok: false,
      stage: 'gateway',
      message: `启动本地网关失败：${clip(errorText(error), 300)}`,
      hint: '确认本机允许 Node 监听 127.0.0.1 端口；若端口被占用，可用 WORKBUDDY_GATEWAY_PORT 指定其它端口',
    }
  }

  const health = gateway.health ?? await (async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/healthz`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
      signal: AbortSignal.timeout(2000),
    }).then(r => r.json()).catch(() => undefined)
    return response
  })()

  // 阶段二：账号。网关在跑但没有账号时，这一步给出「去哪个 App 登录」。
  //
  // 这段话是**第一次用本插件的新手**最可能看到的唯一一句提示，因此必须自解释：
  // 说清「要做什么」（打开 App 并登录）、「登录后要不要重启」（不用）、
  // 「没有这个 App 怎么办」（给了下载入口）。不出现「认证文件」这类内部术语。
  if (health?.signedIn !== true) {
    return {
      ok: false,
      stage: 'account',
      port: gateway.port,
      message: `还没有登录 ${CN_VARIANT.appName}，暂时无法接入`,
      hint: `请打开 ${CN_VARIANT.appName} 并完成登录，然后回到天枢重试即可，不需要重启天枢。`
        + `如果还没安装，请先从 ${CN_VARIANT.appName} 官网下载安装（国际版请登录 ${AI_VARIANT.appName}）。`,
      variants: health?.variants,
    }
  }

  // 阶段三：实时目录。直接向刚起来的网关要 —— 它服务的模型与待写入配置的模型
  // 因此是**同一份数据**，不存在两次独立拉取后各自漂移的可能。
  let detailed
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/_gw/models${options.forceRefresh === true ? '?refresh=1' : ''}`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
      signal: AbortSignal.timeout(options.catalogTimeoutMs ?? 20_000),
    })
    detailed = await response.json()
    if (!response.ok) {
      return {
        ok: false,
        stage: 'catalog',
        message: `读取模型目录失败：${clip(detailed?.error?.message ?? `http ${response.status}`, 300)}`,
        hint: '确认桌面 App 中的登录仍然有效；必要时在 App 内重新登录',
      }
    }
  } catch (error) {
    return {
      ok: false,
      stage: 'catalog',
      message: `读取模型目录失败：${clip(errorText(error), 300)}`,
      hint: `确认网关仍在 127.0.0.1:${gateway.port} 上运行；可直接重跑接入`,
    }
  }

  const catalog = { models: detailed.models ?? [], source: detailed.source, error: detailed.error }
  if (catalog.models.length === 0) {
    return {
      ok: false,
      stage: 'catalog',
      message: `模型目录为空${catalog.error === undefined ? '' : `（${catalog.error}）`}`,
      hint: '在 WorkBuddy 桌面 App 里确认当前账号有可用模型后重试',
    }
  }
  const active = {
    variant: VARIANTS.find(variant => variant.id === detailed.variant) ?? CN_VARIANT,
    credential: detailed.account ?? {},
  }

  // 阶段四：写回天枢配置。
  let written
  try {
    written = installProvider({
      port: gateway.port,
      token: gateway.token,
      models: catalog.models,
      setDefault: options.setDefault === true,
    })
  } catch (error) {
    return {
      ok: false,
      stage: 'config',
      message: `写入天枢配置失败：${clip(errorText(error), 300)}`,
      hint: '检查 ~/.rivet/config.json 是否可写、是否为合法 JSON',
    }
  }

  const warnings = []
  const previousOwnership = classifyBaseUrl(written.previousBaseUrl, gateway.port)
  if (written.previousBaseUrl !== undefined && !previousOwnership.match) {
    warnings.push(
      `已覆盖原有的 \`providers.workbuddy\` 条目（原 baseUrl：${clip(written.previousBaseUrl, 80)}）。`
      + '如果那是一个你自建的转接服务，请把它改到别的 provider 名下再重启天枢。',
    )
  }
  if (catalog.source !== 'live') {
    warnings.push(`模型目录来自${catalog.source === 'fallback' ? '内置兜底名册' : '上次成功拉取'}，不是本次实时结果；网络恢复后可以再跑一次接入。`)
  }
  if (written.keyPool?.action === 'blocked') {
    warnings.push(
      `天枢的 Key 池（provider-keys.json）里 \`workbuddy\` 用的是 keyRef，本插件没有改动它。`
      + '请求实际使用的凭据取自那里，而不是 config.json —— 若模型报鉴权失败，请先在设置里删除该 provider 的 Key 再重新接入。',
    )
  }
  for (const encounter of gateway.encounters ?? []) {
    if (encounter.kind === 'stale') {
      warnings.push(
        `端口 ${encounter.port} 上有一个本插件的旧实例（版本 ${encounter.version ?? '未知'}）仍在监听，`
        + `它的令牌与当前不一致，因此本次改在 ${gateway.port} 上启动。重启电脑可回收那个进程。`,
      )
    }
  }

  return {
    ok: true,
    stage: 'done',
    version,
    port: gateway.port,
    gatewayReused: gateway.reused === true,
    gatewayInProcess: gateway.inProcess === true,
    variant: active.variant.id,
    displayName: active.variant.displayName,
    account: {
      uid: active.credential.uid,
      nickname: active.credential.nickname,
      domain: active.credential.domain,
      expiresAtMs: active.credential.expiresAtMs,
    },
    models: catalog.models.length,
    modelIds: catalog.models.map(model => model.id),
    catalogSource: catalog.source,
    configPath: written.path,
    configBackup: written.backup,
    configNotes: written.notes,
    configChanged: written.configChanged === true,
    keyPoolChanged: written.keyPoolChanged === true,
    keyPoolPath: written.keyPool?.path,
    keyPoolNotes: written.keyPool?.notes ?? [],
    keyPoolAction: written.keyPool?.action,
    tokenRotated: rotated,
    isDefault: options.setDefault === true,
    warnings,
  }
}

/** 状态汇总：网关 + 账号 + 配置三方对齐情况。 */
export async function status() {
  const gateway = await gatewayStatus()
  // 端口已知就用端口精确判定归属：本机可能同时跑着别的回环转接服务。
  // 网关令牌被接受时才拿它做「生效 Key」的基准；否则以 config.json 的内联值为准，
  // 免得把一个不可信的令牌当成事实源。
  const drift = detectDrift({
    port: gateway.port,
    ...(gateway.tokenAccepted === true ? { token: gateway.token } : {}),
  })
  const sources = new VariantSources()
  const variants = await sources.summaries()

  /**
   * 三方对齐：**网关**才是真正在发请求的那一方，它读得到凭据、说得清账号。
   * 本进程可能因为权限（沙箱策略、文件 ACL）读不到认证文件，此时若照本进程的
   * 结论汇报「未登录」，用户会看到一个和事实相反的结论。
   *
   * 因此网关已登录而本进程读不到时，以网关为准，并显式标注差异来源。
   */
  const activeVariantId = gateway.health?.signedIn === true ? gateway.health.variant : undefined
  const merged = variants.map(variant => {
    if (variant.variant !== activeVariantId) return variant
    if (variant.signedIn === true) return variant
    return {
      ...variant,
      signedIn: true,
      uid: gateway.health.uid,
      models: gateway.health.models ?? variant.models,
      catalogSource: gateway.health.catalogSource ?? variant.catalogSource,
      source: 'gateway',
      note: `本进程读不到认证文件（${clip(variant.reason ?? variant.format ?? '未知原因', 120)}），但网关已登录并正在服务；以网关为准`,
    }
  })

  const notes = []
  // 「端口上有本插件、但它不认当前令牌」单独说出来：现象是随机 401，
  // 而报错长得像上游鉴权失败，最容易查错方向。
  if (gateway.warning !== undefined) notes.push(gateway.warning)
  if (drift.note !== undefined) notes.push(drift.note)
  // 未就绪的原因也要能直接读到：`ready: false` 而不给理由，等于让人去猜。
  // 尤其是 Key 池不一致 —— 那是「配置看着没问题却用不了」最常见的一种。
  if (drift.ok !== true && drift.reason !== undefined) notes.push(drift.reason)
  if (drift.ok !== true && drift.hint !== undefined) notes.push(drift.hint)
  // 被显式停止 + 配置仍指向我们 = 每个请求都注定失败。这个组合必须点名，
  // 否则用户只会看到「模型用不了」，而配置页一切正常。
  const disabled = gatewayDisabled()
  if (disabled !== undefined && drift.ok === true) {
    notes.push('网关已被显式停止（执行过 stop / uninstall），而天枢配置仍指向它 —— 模型请求会失败。重新执行接入即可恢复。')
  }

  return {
    gateway: {
      running: gateway.running,
      port: gateway.port,
      mode: gateway.mode,
      pid: gateway.pid,
      signedIn: gateway.health?.signedIn,
      variant: gateway.health?.variant,
      models: gateway.health?.models,
      catalogSource: gateway.health?.catalogSource,
      tokenAccepted: gateway.tokenAccepted === true,
      ...(disabled === undefined ? {} : { disabled: true, disabledReason: disabled.reason, disabledAt: disabled.at }),
    },
    config: drift,
    variants: merged,
    notes,
    ready: gateway.running && gateway.health?.signedIn === true && drift.ok,
  }
}

/** 断开接入：停网关 + 移除配置条目 + 清理自留凭据副本。 */
export async function disconnect(options = {}) {
  const stopped = await stopGateway()
  let removed
  try {
    removed = removeProvider()
  } catch (error) {
    removed = { removed: false, reason: clip(errorText(error), 200) }
  }

  let clearedCredentials = []
  if (options.clearCredentials === true) {
    const { CN_VARIANT: CN, AI_VARIANT: AI } = await import('./variants.js')
    const { ownAuthPath } = await import('./credential.js')
    const { removeFileIfExists } = await import('./util.js')
    for (const variant of [CN, AI]) {
      if (removeFileIfExists(ownAuthPath(variant))) clearedCredentials.push(variant.id)
    }
  }

  return {
    gateway: stopped,
    config: removed,
    clearedCredentials,
    note: '这只是断开本插件的接入，不会影响 WorkBuddy 桌面 App 自身的登录状态。',
  }
}

export { DEFAULT_GATEWAY_PORT }
