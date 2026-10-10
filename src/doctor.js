/**
 * 接入链路诊断。
 *
 * 目标只有一个：**把「为什么用不了」定位到具体哪一环**。链路是
 * 凭据文件 → 解密 → 上游目录 → 本地网关 → 天枢配置 → 天枢 Key 池 → 真实对话，
 * 每一环独立判定并给出可执行的下一步，而不是笼统地说「接入失败」。
 *
 * @module tianshu-workbuddy-connect/doctor
 */

import { existsSync } from 'node:fs'
import {
  AuthFormat, CredentialStore, AtRestKeyProvider, desktopAuthCandidates, ownAuthPath, readDesktopCredential, resolveElectronPath,
} from './credential.js'
import { gatewayDisabled, gatewayStatus, ensureGateway } from './gateway.js'
import { PROVIDER_NAME } from './identity.js'
import { detectKeyPoolDrift, effectiveKeyOf, providerKeysPath, readProviderKeys } from './provider-keys.js'
import { detectDrift } from './rivet-config.js'
import { UpstreamClient, enrichCredential, probeChat } from './upstream.js'
import { CN_VARIANT, AI_VARIANT, VARIANTS } from './variants.js'
import { clip, errorText, workbuddyDir } from './util.js'

/** 单条检查结果。 */
function check(id, ok, summary, detail, hint) {
  return { id, ok, summary, ...(detail === undefined ? {} : { detail }), ...(hint === undefined ? {} : { hint }) }
}

/**
 * 逐变体检查凭据文件与解密能力。
 *
 * 「某个变体没登录」**不是**故障：插件只需要一个可用变体，国内版与国际版各有
 * 自己的用户群。把它报成 ❌ 会让 `doctor` 恒定为「未通过」，把真正的故障淹没在
 * 噪音里。因此这里只在「凭据存在却用不了」（加密但解不开、内容不认）时判失败；
 * 「一个可用变体都没有」由上游连通性那一环统一报出来。
 *
 * @returns {{checks: object[], byVariant: Map<string, {hasCredential: boolean, format: string}>}}
 */
async function checkCredentials() {
  const results = []
  const byVariant = new Map()
  for (const variant of VARIANTS) {
    const candidates = desktopAuthCandidates(variant)
    const present = candidates.find(path => existsSync(path))
    const own = existsSync(ownAuthPath(variant))
    const hasCredential = present !== undefined || own

    if (!hasCredential) {
      byVariant.set(variant.id, { hasCredential: false, format: AuthFormat.UNRECOGNIZED })
      results.push(check(
        `credential:${variant.id}`,
        true,
        `${variant.appName}：未登录（可忽略 —— 只要另一个变体可用即可）`,
        `已检查：${candidates.join('；')}`,
        `若确实要用它：打开并登录 ${variant.appName} 桌面 App；装在非默认位置时可用环境变量 ${variant.env} 指定认证文件路径`,
      ))
      continue
    }

    const read = await readDesktopCredential(variant)
    byVariant.set(variant.id, { hasCredential: true, format: read.format })
    if (read.format === AuthFormat.PLAINTEXT) {
      results.push(check(
        `credential:${variant.id}`,
        true,
        `${variant.appName}：凭据可读${read.decrypted === true ? '（已解密加密字段）' : ''}`,
        `文件：${read.path}`,
      ))
      continue
    }
    if (read.format === AuthFormat.ENCRYPTED) {
      results.push(check(
        `credential:${variant.id}`,
        false,
        `${variant.appName}：凭据是加密形态，但未能解密`,
        read.reason,
        `确认 ${variant.appName} 已安装且其 Electron 二进制可执行；可用 ${variant.electron.envVar} 显式指定路径`,
      ))
      continue
    }
    if (read.readError === true) {
      // 读不出来 ≠ 内容不认。前者去 App 重新登录不会有任何效果。
      results.push(check(
        `credential:${variant.id}`,
        false,
        `${variant.appName}：认证文件存在，但当前进程读不出来`,
        read.reason ?? `文件：${read.path ?? '（未定位到）'}`,
        '这通常是权限而非登录问题：确认本进程对该文件有读权限；在沙箱 / 受管终端里运行时，请在沙箱外重试',
      ))
      continue
    }
    results.push(check(
      `credential:${variant.id}`,
      false,
      `${variant.appName}：认证文件存在但内容不可识别`,
      read.reason ?? `文件：${read.path ?? '（未定位到）'}`,
      `在 ${variant.appName} 中退出登录后重新登录，让 App 重写认证文件`,
    ))
  }
  return { checks: results, byVariant }
}

/**
 * 检查 Electron 密钥助手是否可定位。
 *
 * 只有「该变体的凭据确实是加密形态」时它才是必需项，因此失败判定也用这个前提
 * 收紧：明文凭据、或该变体压根没登录时，定位不到 Electron 是正常的，不该报警。
 *
 * @param {Map<string, {hasCredential: boolean, format: string}>} credentialStates
 */
async function checkElectronHelper(credentialStates) {
  const results = []
  for (const variant of VARIANTS) {
    const state = credentialStates.get(variant.id)
    const needed = state?.format === AuthFormat.ENCRYPTED

    // 定位过程会尝试派生进程、查注册表；在受限环境（沙箱、黑白名单策略）里
    // 这些都会失败。诊断的职责是**报告**失败，不是被失败带走。
    let located
    let failure
    try {
      located = await resolveElectronPath(variant)
    } catch (error) {
      failure = errorText(error)
    }
    const detail = located?.path ?? (failure === undefined ? undefined : clip(failure, 200))
    if (!needed) {
      results.push(check(
        `electron:${variant.id}`,
        true,
        located === undefined
          ? `${variant.appName}：未定位到 Electron 二进制（当前不需要）`
          : `${variant.appName}：Electron 二进制已定位（来源：${located.strategy}）`,
        detail,
        undefined,
      ))
      continue
    }
    results.push(check(
      `electron:${variant.id}`,
      located !== undefined,
      located === undefined
        ? `${variant.appName}：凭据为加密形态，但未定位到 Electron 二进制`
        : `${variant.appName}：Electron 二进制已定位（来源：${located.strategy}）`,
      detail,
      located === undefined
        ? `凭据是加密的，必须有它才能解密：设置 ${variant.electron.envVar} 指向 App 安装目录下的二进制`
        : undefined,
    ))
  }
  return results
}

/**
 * 天枢 Key 池检查环。
 *
 * 单独成环而不是并进配置环，是因为这是**唯一**能解释「配置看着没问题、请求却
 * 稳定 401」的地方：天枢实际发出的凭据取自同级的 `provider-keys.json`，它与
 * `config.json` 可以长期不一致，而两边都不会报错 —— 配置页显示前者，请求带
 * 后者。这一环存在的意义就是把这种分歧变成一句可读的话。
 */
async function checkKeyPool(gateway) {
  const path = providerKeysPath()
  const file = readProviderKeys(path)
  if (file === undefined) {
    return check('keypool', true, '没有 provider-keys.json —— config.json 里的内联 Key 即权威', path)
  }
  const pool = file.providers?.[PROVIDER_NAME]
  if (pool === undefined) {
    return check('keypool', true, `provider-keys.json 里没有 \`${PROVIDER_NAME}\` 条目 —— 不会覆盖配置`, path)
  }

  const effective = effectiveKeyOf(pool)
  const gatewayToken = gateway.running === true ? gateway.token : undefined
  const drift = detectKeyPoolDrift({
    path,
    ...(gatewayToken === undefined ? {} : { configKey: gatewayToken }),
  })

  if (drift.ok !== true) {
    return check(
      'keypool',
      false,
      `天枢实际使用的 Key 与网关不一致（权威来源：${drift.authoritative}）`,
      drift.reason,
      '重新执行接入会同时对齐 config.json 与 provider-keys.json',
    )
  }
  if (gatewayToken === undefined) {
    return check(
      'keypool',
      true,
      `provider-keys.json 里有 \`${PROVIDER_NAME}\` 条目（网关未运行，未核对实际取值）`,
      `生效方式：${effective?.kind ?? '（无凭据字段）'}｜${path}`,
    )
  }
  return check(
    'keypool',
    true,
    '天枢实际使用的 Key 与网关令牌一致',
    `权威来源：provider-keys.json｜生效方式：${effective?.kind}｜${path}`,
  )
}

/** 端到端探针：通过网关发一次最小对话。 */
async function checkRoundTrip(gateway, model) {
  if (gateway.running !== true) {
    return check('roundtrip', false, '未做真实对话验证（网关未运行）', undefined, '先执行接入，再运行本诊断')
  }
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gateway.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      const body = clip(await response.text(), 300)
      return check('roundtrip', false, `真实对话验证失败（http ${response.status}）`, body, '确认该模型在当前账号下可用；或在接入后重新登录桌面 App')
    }
    const reader = response.body.getReader()
    const { value } = await reader.read()
    await reader.cancel().catch(() => {})
    const bytes = value?.length ?? 0
    return check('roundtrip', bytes > 0, bytes > 0 ? '真实对话验证通过（已收到流式响应）' : '真实对话返回了空响应', `首块 ${bytes} 字节`)
  } catch (error) {
    return check('roundtrip', false, '真实对话验证失败', clip(errorText(error), 300), '确认网关端口可达且未被防火墙拦截')
  }
}

/**
 * 运行完整诊断。
 *
 * @param {object} [options]
 * @param {boolean} [options.probe] 是否做真实对话验证（默认做，但仅在网关已运行时）
 * @param {boolean} [options.startGateway] 是否在网关未运行时尝试拉起
 */
export async function diagnose(options = {}) {
  const checks = []

  // 1) 凭据
  const credentialReport = await checkCredentials()
  checks.push(...credentialReport.checks)
  // 2) Electron 助手（只在凭据确实是加密形态时才是必需项）
  const electronChecks = await checkElectronHelper(credentialReport.byVariant)
  checks.push(...electronChecks)

  // 3) 上游目录可达性：用能解析出凭据的那一个变体去试。
  const client = new UpstreamClient()
  let activeVariant
  let credential
  for (const variant of VARIANTS) {
    const store = new CredentialStore({ variant, refresh: c => client.refreshToken(enrichCredential(c, variant)) })
    try {
      credential = await store.resolve()
      activeVariant = variant
      break
    } catch { /* 该变体不可用，试下一个 */ }
  }

  if (activeVariant === undefined) {
    checks.push(check('upstream', false, '未取到可用凭据，未做上游连通性检查', undefined, '先解决上面的凭据问题'))
  } else {
    try {
      const document = await client.fetchCatalog(enrichCredential(credential, activeVariant))
      const modelCount = Array.isArray(document?.models) ? document.models.length : 0
      checks.push(check(
        'upstream',
        modelCount > 0,
        `上游目录可达（${activeVariant.displayName}，返回 ${modelCount} 条模型记录）`,
        `域：${credential.domain || '（空）'}`,
      ))
    } catch (error) {
      checks.push(check('upstream', false, '上游目录不可达', clip(errorText(error), 300), '确认网络可用；若登录已过期，请在桌面 App 重新登录'))
    }
  }

  // 4) 网关
  let gateway = await gatewayStatus()
  // 「执行过 stop」与「从未接入」都会表现为「未运行」，但处置完全相反：
  // 前者要去掉显式停止标记（重新接入即可），后者才是从零开始。
  const disabled = gatewayDisabled()
  if (gateway.running !== true && options.startGateway === true) {
    try {
      await ensureGateway({ version: options.version })
      gateway = await gatewayStatus()
    } catch (error) {
      gateway = { running: false, error: clip(errorText(error), 300) }
    }
  }
  checks.push(check(
    'gateway',
    gateway.running === true,
    gateway.running === true
      ? `本地网关运行中（127.0.0.1:${gateway.port}，模式：${gateway.mode ?? 'daemon'}）`
      : gateway.tokenAccepted === false
        // 端口上有本插件但不认当前令牌：这**不是**「没运行」，报成未运行会把人
        // 引去查启动失败，而实际要处置的是那个残留实例。
        ? `127.0.0.1:${gateway.port} 上有本插件的实例，但它不认当前令牌`
        : disabled !== undefined
          ? '本地网关已被显式停止（执行过 stop / uninstall）'
          : '本地网关未运行',
    gateway.error ?? gateway.warning ?? (gateway.running === true ? `已登录：${gateway.health?.signedIn === true ? '是' : '否'}｜模型：${gateway.health?.models ?? 0}` : undefined),
    gateway.running === true
      ? undefined
      : gateway.tokenAccepted === false
        ? '重新执行接入会自动在相邻端口上重建一个干净的实例（也可先执行 `stop`）'
        : disabled !== undefined
          ? '这是你自己停的：重新执行接入即可恢复（保活不会自动撤销 stop）'
          : '执行 `workbuddy_connect` 或 CLI 的 `install` 启动网关',
  ))

  // 5) 天枢配置
  let drift
  try {
    drift = detectDrift({ port: gateway.port })
  } catch (error) {
    drift = { ok: false, reason: clip(errorText(error), 200) }
  }
  checks.push(check(
    'config',
    drift.ok === true,
    drift.ok === true
      ? `天枢配置已指向本地网关（${drift.modelCount} 个模型${drift.isDefault === true ? '，且为默认 provider' : ''}）`
      : '天枢配置未就绪',
    drift.ok === true ? drift.baseUrl : drift.reason,
    drift.ok === true ? undefined : '执行接入以写入 `providers.workbuddy` 配置',
  ))

  // 6) 天枢 Key 池：天枢实际发出的凭据取自这里，不一致是「稳定 401」的典型成因。
  checks.push(await checkKeyPool(gateway))

  // 7) 真实对话（可选）
  if ((options.probe !== false) && gateway.running === true && gateway.health?.signedIn === true) {
    const model = (await fetchDetailedModel(gateway)) ?? 'deepseek-v4.1-flash'
    checks.push(await checkRoundTrip(gateway, model))
  }

  const failed = checks.filter(entry => entry.ok !== true)
  return {
    ok: failed.length === 0,
    checks,
    failed: failed.map(entry => entry.id),
    stateDir: workbuddyDir(),
    ...(activeVariant === undefined ? {} : { variant: activeVariant.id }),
  }
}

/** 从网关取一个当前可用的模型 id。 */
async function fetchDetailedModel(gateway) {
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/_gw/models`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    return body?.models?.[0]?.id
  } catch {
    return undefined
  }
}

export { AtRestKeyProvider, CN_VARIANT, AI_VARIANT }
