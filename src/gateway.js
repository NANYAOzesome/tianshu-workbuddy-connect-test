/**
 * 本地回环网关：把 WorkBuddy 上游翻译成一个标准的 OpenAI 兼容端点。
 *
 * 为什么必须有这一层：天枢的 provider 只认 `openai | anthropic |
 * openai-responses | gemini` 四种线协议，而 WorkBuddy 上游既不是其中任何一种
 * 的干净实现 —— 它强制流式、拒绝 `developer` 角色、`tool_choice` 只收字符串、
 * 认证头是私有约定。网关把这套怪癖收在一处，天枢侧就只是一个普通的
 * OpenAI provider，且**永远不需要知道 WorkBuddy 的令牌**。
 *
 * 绑定只到 127.0.0.1。回环绑定本身不构成信任边界（本机任意进程、以及
 * DNS-rebinding 页面都能打到 127.0.0.1），因此每个请求还必须满足：
 * Host 头指向回环、浏览器 Origin 必须是回环、且携带网关令牌。
 *
 * @module tianshu-workbuddy-connect/gateway
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { CredentialStore, variantForCredential } from './credential.js'
import { ModelCatalog, fallbackModels } from './models.js'
import { AI_VARIANT, CN_VARIANT, VARIANTS } from './variants.js'
import {
  ErrorKind, UpstreamClient, enrichCredential, statusForKind,
} from './upstream.js'
import {
  clip, ensureDir, errorText, hostHeaderIsLoopback, logLine, originIsLoopback,
  parsePort, randomToken, readJsonSafe, removeFileIfExists, rivetHome, workbuddyDir,
  writeFileAtomic, writeJsonAtomic,
} from './util.js'

/** 默认网关端口。固定值是有意的：天枢配置里存的是绝对 URL，端口漂移会让配置失效。 */
export const DEFAULT_GATEWAY_PORT = 17871

/**
 * 进程内的端口覆盖。
 *
 * 存在的意义是让「接入之前」就能指定端口 —— 单纯读 `WORKBUDDY_GATEWAY_PORT`
 * 不够，因为 `ensureGateway` 既可能被首次接入调用（此时该用覆盖值），也可能被
 * 保活调用（此时该用**配置里那个已生效的端口**，否则会把配置指到一个没人的
 * 端口上）。把覆盖放在显式的设置函数里，两种场景就不会互相串。
 */
let portOverride

/** 设置本进程的网关端口覆盖。传非整数即清除。 */
export function configurePort(port) {
  portOverride = Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
  return portOverride
}

/** 读当前端口覆盖（供测试与诊断）。 */
export function configuredPortOverride() {
  return portOverride
}

/** 端口被占用时最多顺延几个。 */
const PORT_SCAN_LIMIT = 8

/** 请求体上限（与源插件一致，足以容纳长上下文 + 图片）。 */
const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/** 目录缓存有效期。 */
const CATALOG_TTL_MS = 5 * 60 * 1000

/** healthz 里的标记，用来确认「这个端口上跑的确实是本插件」。 */
const HEALTH_MARKER = 'tianshu-workbuddy-connect'

/** 网关状态文件（端口 + 令牌 + pid）。 */
export function gatewayStatePath() {
  return join(workbuddyDir(), 'gateway.json')
}

/** 读取网关状态。 */
export function readGatewayState() {
  const state = readJsonSafe(gatewayStatePath())
  if (typeof state !== 'object' || state === null) return undefined
  if (typeof state.port !== 'number' || typeof state.token !== 'string' || state.token === '') return undefined
  return state
}

/** 写入网关状态（0600：令牌在里面）。 */
export function writeGatewayState(state) {
  ensureDir(workbuddyDir())
  writeJsonAtomic(gatewayStatePath(), state, 0o600)
  // 「我在写状态」本身就是「网关应当在线」的证据，因此顺手撤销「已停止」标记。
  // 否则版本漂移重启那条路径会留下一个标记，把刚起来的网关又判成「已停止」。
  clearGatewayDisabled()
}

/** 清除网关状态。 */
export function clearGatewayState() {
  return removeFileIfExists(gatewayStatePath())
}

/**
 * 「已显式停止」标记的路径。
 *
 * 存在的理由：`preTurn` 保活会在每轮对话前把网关拉回来，而它不能凭空判断
 * 「网关不在」是因为用户 `stop` 了、还是因为状态文件丢了。没有这个标记的话
 * `stop` 会变成空操作 —— 用户停掉，下一秒第一轮对话就又把它拉起来。
 *
 * 反过来，标记也**不能**只靠状态文件推断：`stop` 会删掉状态文件，清理数据
 * 目录、跨机器迁移同样会。所以用一个独立的、语义明确的哨兵文件来区分这两件事。
 */
export function gatewayDisabledPath() {
  return join(workbuddyDir(), 'gateway.disabled')
}

/** 读取「已显式停止」标记；不存在时返回 undefined。 */
export function gatewayDisabled() {
  const raw = readJsonSafe(gatewayDisabledPath())
  if (typeof raw !== 'object' || raw === null) return undefined
  return raw
}

/** 记下「用户显式停止了网关」。 */
export function markGatewayDisabled(reason = 'stop') {
  ensureDir(workbuddyDir())
  writeJsonAtomic(gatewayDisabledPath(), { version: 1, reason, at: Date.now() }, 0o600)
  return gatewayDisabledPath()
}

/** 清除「已显式停止」标记（任何一次成功接入/启动都意味着用户要它在线）。 */
export function clearGatewayDisabled() {
  return removeFileIfExists(gatewayDisabledPath())
}

/**
 * 令牌的持久家：**与端口状态分开存放**（0600）。
 *
 * 为什么必须分开：天枢的配置层里，这个令牌会被复制到多处 —— `config.json` 的
 * `providers.<name>.apiKey`、以及 `provider-keys.json` 的 key 池（后者是**权威**
 * 来源，见 `provider-keys-store.ts` 头注的「A′：keys 移出 config.json」）。任何
 * 一次「顺手换掉令牌」都会让这些副本立刻过期，而症状是 401 —— 看起来像上游
 * 鉴权失败，实际是网关不认自己的旧令牌。
 *
 * 反过来看收益也就清楚了：令牌一旦稳定，副本之间就不存在能发散的值。轮换留成
 * 显式动作（`workbuddy_refresh --rotate-token`），而不是每次接入的副作用。
 */
export function gatewayTokenPath() {
  return join(workbuddyDir(), 'gateway-token')
}

/** 读持久令牌；格式不对按没有处理。 */
export function readStoredToken() {
  try {
    const value = readFileSync(gatewayTokenPath(), 'utf8').trim()
    return value.startsWith('wb-') && value.length >= 16 ? value : undefined
  } catch {
    return undefined
  }
}

function storeToken(token) {
  try {
    ensureDir(workbuddyDir())
    writeFileAtomic(gatewayTokenPath(), `${token}\n`, 0o600)
  } catch { /* 写不进去只影响下次的稳定性，不影响本次可用 */ }
}

/** 令牌是否是我们自己发的那种形态。 */
function looksLikeToken(value) {
  return typeof value === 'string' && value.startsWith('wb-') && value.length >= 16
}

/**
 * 取（必要时生成）持久化网关令牌。
 *
 * 优先级：已持久化的 → 调用方给的（状态文件里的历史值）→ 新生成。
 * 「持久化的优先」是有意的：状态文件会被 `stop` / `logout` 清掉，而配置层里
 * 散落的副本不会。令牌跟着状态文件走，就等于每次清理都让副本失效一次。
 */
export function ensureGatewayToken(existing) {
  const stored = readStoredToken()
  if (stored !== undefined) return stored
  if (looksLikeToken(existing)) {
    storeToken(existing)
    return existing
  }
  const fresh = randomToken(24)
  storeToken(fresh)
  return fresh
}

/** 显式轮换令牌（会调用方负责把新令牌写回配置层）。 */
export function rotateGatewayToken() {
  const fresh = randomToken(24)
  storeToken(fresh)
  return fresh
}

/* ------------------------------------------------------------------ *
 * 凭据源：一个网关可同时持有两个变体的存储，按谁已登录自动选主
 * ------------------------------------------------------------------ */

/**
 * 多变体凭据源。
 *
 * 选主顺序：显式指定 → 国内版 → 国际版。只装了一个 App 的用户无需任何配置；
 * 两个都装时国内版优先，且可以通过配置显式指定。
 */
export class VariantSources {
  constructor(options = {}) {
    this.client = options.client ?? new UpstreamClient()
    this.preferred = options.preferred
    this.sources = VARIANTS.map(variant => {
      const store = new CredentialStore({
        variant,
        authFile: variant.id === CN_VARIANT.id ? options.authFileCN : options.authFileAI,
        refresh: credential => this.client.refreshToken(enrichCredential(credential, variant)),
      })
      return { variant, store, catalog: new ModelCatalog(variant), catalogFetchedAtMs: 0 }
    })
  }

  /** 按选主顺序返回各源。 */
  ordered() {
    if (this.preferred === undefined) return this.sources
    const index = this.sources.findIndex(source => source.variant.id === this.preferred)
    if (index <= 0) return this.sources
    return [this.sources[index], ...this.sources.filter((_, i) => i !== index)]
  }

  /**
   * 取当前生效的源。
   *
   * 「已登录」以凭据可解析为准，而不是以文件存在为准 —— 文件存在但解不开
   * 的情况（换过安装、密钥分叉）必须走「未登录」分支并给出诊断，而不是
   * 让每个请求都失败在网关里。
   */
  async active() {
    let firstFailure
    for (const source of this.ordered()) {
      try {
        const credential = await source.store.resolve()
        return { ...source, credential: enrichCredential(credential, source.variant) }
      } catch (error) {
        firstFailure ??= error
      }
    }
    return { error: firstFailure }
  }

  /** 取当前生效源的一份新鲜目录（带 TTL 缓存）。 */
  async catalogFor(source, force = false) {
    const stale = force || Date.now() - source.catalogFetchedAtMs > CATALOG_TTL_MS
    if (!stale && source.catalog.source === 'live') return source.catalog
    try {
      const document = await this.client.fetchCatalog(source.credential)
      const { parseCatalog } = await import('./models.js')
      const parsed = parseCatalog(document)
      if (parsed.models.length === 0) {
        source.catalog.fail('上游目录为空')
        return source.catalog
      }
      source.catalog.set(parsed.models, 'live')
      source.catalogFetchedAtMs = Date.now()
      return source.catalog
    } catch (error) {
      source.catalog.fail(clip(errorText(error), 240))
      // 首次拉取失败时不要留一个空名册：退回内置兜底，并如实标注来源。
      if (source.catalog.source !== 'live') {
        source.catalog.models = fallbackModels(source.variant)
        source.catalog.source = 'fallback'
      }
      return source.catalog
    }
  }

  /** 各变体的账号概览，供 healthz 与 doctor 使用。 */
  async summaries() {
    const out = []
    for (const source of this.ordered()) {
      const described = await source.store.describe()
      out.push({
        variant: source.variant.id,
        displayName: source.variant.displayName,
        ...described,
        models: source.catalog.models.length,
        catalogSource: source.catalog.source,
        catalogError: source.catalog.error,
      })
    }
    return out
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res, status, kind, message) {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/** 带体积上限读请求体；超限直接销毁连接。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('请求体超过上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 创建一个网关 HTTP 服务。
 *
 * @param {object} options
 * @param {VariantSources} options.sources 凭据源
 * @param {string} options.token           网关令牌
 * @param {string} [options.version]       版本号，用于 healthz
 * @returns {import('node:http').Server}
 */
export function createGatewayServer(options) {
  const { sources, token } = options
  const version = options.version ?? '1.0.0'

  /** 常量时间比较，避免用响应时间泄露令牌长度。 */
  const bearerOk = req => {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
    if (match === null) return false
    const presented = match[1]
    if (presented.length !== token.length) return false
    let diff = 0
    for (let i = 0; i < token.length; i += 1) diff |= presented.charCodeAt(i) ^ token.charCodeAt(i)
    return diff === 0
  }

  /** 令牌指纹：只用于「两边是不是同一个」的比对，不可逆推出原文。 */
  const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 8)

  /**
   * 鉴权失败时留下**可排查但不泄密**的痕迹。
   *
   * 「网关 401」最常见的两种情况是「令牌不一致」和「调用方根本没带令牌」，而
   * 这两者在现象上完全一样 —— 只看得到一句 unauthorized。因此这里只记录形态与
   * 指纹：头是否存在、scheme 是什么、长度多少、sha256 前 8 位、以及带没带别的
   * 认证类头。令牌原值不落盘（那是唯一不能写日志的东西）。
   */
  const diagnoseAuthFailure = req => {
    const header = req.headers.authorization
    const presented = typeof header === 'string' ? header.replace(/^\S+\s+/u, '') : undefined
    const alternatives = Object.keys(req.headers)
      .filter(key => /api[-_]?key|token|auth/iu.test(key) && key !== 'authorization')
    logLine('gateway', [
      `auth rejected path=${req.url}`,
      `authorization=${header === undefined ? 'absent' : 'present'}`,
      `scheme=${typeof header === 'string' ? (header.split(/\s+/u)[0] || '(empty)') : '-'}`,
      `presentedLen=${presented === undefined ? 0 : presented.length}`,
      `presentedFp=${presented === undefined ? '-' : fingerprint(presented)}`,
      `expectedLen=${token.length}`,
      `expectedFp=${fingerprint(token)}`,
      `otherAuthHeaders=${alternatives.length === 0 ? 'none' : alternatives.join(',')}`,
    ].join(' '))
  }

  const server = createServer((req, res) => {
    // 任何请求都算「会话还在用我」—— 空闲回收的计时由此重置。
    touchActivity()
    void handle(req, res).catch(error => {
      logLine('gateway', `unhandled: ${errorText(error)}`)
      if (!res.headersSent) writeOpenAIError(res, 500, 'internal', clip(errorText(error), 300))
      else res.end()
    })
  })

  async function handle(req, res) {
    // 入站加固：Host 必须指向回环，浏览器 Origin 也必须是回环。
    if (!hostHeaderIsLoopback(req.headers.host)) {
      writeOpenAIError(res, 403, 'host_not_allowed', 'Host 头必须指向回环地址')
      return
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin 必须是回环来源')
      return
    }

    const url = req.url ?? '/'
    const path = url.split('?')[0]
    const authorized = bearerOk(req)

    // `/healthz` 是唯一允许匿名的路由，且匿名时只回指纹（标记 + 版本）。
    // 存在的理由是**归属判定**：没有它，「本插件的另一个令牌世代占着端口」
    // 与「别人的服务占着端口」在调用方看完全相同，只能靠猜。指纹里不含账号、
    // 不含 uid、不含模型列表，也不含 pid（pid 若匿名暴露，就成了「让调用方
    // 去 kill 一个攻击者指定的进程」的把手）。
    if (path === '/healthz' || path === '/healthz/') {
      await healthz(res, authorized)
      return
    }
    if (!authorized) {
      diagnoseAuthFailure(req)
      writeOpenAIError(res, 401, 'unauthorized', '缺少或无效的 Authorization bearer')
      return
    }

    if (path === '/v1/models' || path === '/v1/models/') {
      await listModels(res)
      return
    }
    // 私有运维路由（要求令牌）：返回**完整**模型配置，供接入流程写配置用。
    // 这样「配置里写的模型」与「网关实际服务的模型」永远是同一份数据，而不是
    // 两次独立拉取后各自可能漂移的结果。
    if (path === '/_gw/models') {
      await detailedModels(res, url.includes('refresh=1'))
      return
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/chat/completions/')) {
      await chatCompletions(req, res)
      return
    }
    writeOpenAIError(res, 404, 'not_found', `没有这个路由：${req.method} ${path}`)
  }

  /**
   * 健康检查。
   *
   * `authorized=false` 时只回指纹；`authorized=true` 时回完整负载（账号、
   * 模型数、各变体概览、pid）。调用方拿不到令牌也能回答「这个端口是不是
   * 本插件的」，这正是 `ensureGateway` 避免重复绑定所需的唯一信息。
   */
  async function healthz(res, authorized) {
    if (authorized !== true) {
      writeJson(res, 200, { ok: true, marker: HEALTH_MARKER, version, anonymous: true })
      return
    }
    const active = await sources.active()
    if (active.error !== undefined) {
      writeJson(res, 200, {
        ok: true,
        marker: HEALTH_MARKER,
        version,
        pid: process.pid,
        signedIn: false,
        reason: clip(errorText(active.error), 300),
        variants: await sources.summaries(),
      })
      return
    }
    const catalog = await sources.catalogFor(active)
    writeJson(res, 200, {
      ok: true,
      marker: HEALTH_MARKER,
      version,
      pid: process.pid,
      signedIn: true,
      variant: active.variant.id,
      displayName: active.variant.displayName,
      uid: active.credential.uid,
      models: catalog.models.length,
      catalogSource: catalog.source,
      catalogError: catalog.error,
      variants: await sources.summaries(),
    })
  }

  async function listModels(res) {
    const active = await sources.active()
    if (active.error !== undefined) {
      writeOpenAIError(res, 401, 'not_signed_in', clip(errorText(active.error), 300))
      return
    }
    const catalog = await sources.catalogFor(active)
    writeJson(res, 200, {
      object: 'list',
      data: catalog.models.map(model => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: active.variant.id,
      })),
    })
  }

  /** 完整模型配置（含上下文窗口/思考档/视觉），供接入流程写配置使用。 */
  async function detailedModels(res, force) {
    const active = await sources.active()
    if (active.error !== undefined) {
      writeOpenAIError(res, 401, 'not_signed_in', clip(errorText(active.error), 300))
      return
    }
    const catalog = await sources.catalogFor(active, force === true)
    writeJson(res, 200, {
      variant: active.variant.id,
      displayName: active.variant.displayName,
      source: catalog.source,
      fetchedAtMs: catalog.fetchedAtMs,
      ...(catalog.error === undefined ? {} : { error: catalog.error }),
      account: {
        uid: active.credential.uid,
        nickname: active.credential.nickname,
        domain: active.credential.domain,
        enterpriseId: active.credential.enterpriseId,
        expiresAtMs: active.credential.expiresAtMs,
      },
      models: catalog.models,
    })
  }

  async function chatCompletions(req, res) {
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('application/json')) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type 必须是 application/json')
      return
    }

    let raw
    try {
      raw = (await readBody(req)).toString('utf8')
    } catch (error) {
      writeOpenAIError(res, 413, 'payload_too_large', clip(errorText(error), 200))
      return
    }

    const active = await sources.active()
    if (active.error !== undefined) {
      writeOpenAIError(res, 401, 'not_signed_in', clip(errorText(active.error), 300))
      return
    }

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const result = await sources.client.chatStream(active.credential, raw, controller.signal)
    if (!result.ok) {
      // 状态说明只在「不是会话失效」时附带：把 401/403 的字面量塞进错误文案，
      // 会让下游把它读成「API Key 无效」，从而盖住真实业务错误。
      const statusNote = (result.status === 401 || result.status === 403) && result.kind !== ErrorKind.SESSION_DEAD
        ? ''
        : ` （http ${result.status}）`
      logLine('gateway', `chat failed kind=${result.kind} status=${result.status}`)
      writeOpenAIError(
        res,
        statusForKind(result.kind),
        result.kind,
        `WorkBuddy 上游 ${result.kind}${statusNote}：${clip(result.message, 400)}`,
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    const body = Readable.fromWeb(result.response.body)
    body.on('data', chunk => {
      if (chunk.includes('[DONE]')) sawDone = true
    })
    body.on('error', error => {
      logLine('gateway', `stream failed mid-flight: ${errorText(error)}`)
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
    })
    body.pipe(res)
  }

  return server
}

/* ------------------------------------------------------------------ *
 * 守护进程生命周期
 * ------------------------------------------------------------------ */

/**
 * 探测某端口上是否已经跑着本插件的网关。
 *
 * 两种调用形态，语义**刻意不同**：
 * - `probeGateway(port)` —— 不带令牌，只要端口上是本插件就返回**指纹**
 *   （`{ok, marker, version, anonymous: true}`）。用途是归属判定：「这个端口
 *   是不是本插件的」。
 * - `probeGateway(port, token)` —— 带令牌，只有令牌被接受时才返回**完整负载**；
 *   令牌不对返回 `undefined`。
 *
 * 第二条尤其要紧：如果带令牌也把指纹当成功，调用方就再也分不出「令牌对得上的
 * 自己人」和「同门但令牌不一致的残留实例」—— 而那正是「有时 401」的成因。
 */
export async function probeGateway(port, token, timeoutMs = 1200) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    if (body?.marker !== HEALTH_MARKER) return undefined
    // 令牌不对时服务端只回匿名指纹，这里必须把它当作「不是自己人」。
    if (token !== undefined && body.anonymous === true) return undefined
    return body
  } catch {
    return undefined
  }
}

/** 网关服务端脚本路径。 */
function serverEntry() {
  return join(dirname(fileURLToPath(import.meta.url)), 'gateway-server.js')
}

/**
 * Windows 双跳派生用的中转脚本路径。
 *
 * 它只做一件事：把网关派生出来，然后立刻退出 —— 详见 {@link spawnDaemon}。
 */
function relayEntry() {
  return join(dirname(fileURLToPath(import.meta.url)), 'gateway-relay.js')
}

/**
 * 端口上是否有任何监听者。
 *
 * 为什么不用「试着 bind 一下看报不报错」：Windows 上 `SO_REUSEADDR` 的语义与
 * POSIX 不同 —— 已有一个监听者时，第二次 bind **会成功**，于是「bind 失败即
 * 被占用」这个假设在 Windows 上直接失效。实测过一次真实事故：四个守护进程
 * 全部成功绑定 17871，连接被系统按不明规则分派给其中任意一个，表现为「有时
 * 能用、有时 401」。（能复现的关键是每次接入都换了令牌世代。）
 *
 * 反向探测（连一下看连不连得上）没有这层歧义：有人监听就连得上，没人就
 * ECONNREFUSED。
 */
export async function portBusy(port, timeoutMs = 800) {
  return await new Promise(resolve => {
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const socket = netConnect({ port, host: '127.0.0.1' })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 判定一个端口上是什么。
 *
 * - `free`    没人监听 → 可以拉起
 * - `ours`    本插件且令牌匹配 → 可直接复用
 * - `stale`   本插件但令牌不匹配（换过令牌世代 / 状态文件丢过）→ **必须换端口**：
 *             它会把连接抢走，而复用不了（它只认旧令牌）
 * - `foreign` 别人的服务 → 换端口
 *
 * `stale` 与 `foreign` 的区分只靠匿名指纹。没有指纹时两者无法分辨，那也正是
 * 「有时 401」最容易被误判成「网络问题」的场景。
 */
export async function inspectPort(port, token) {
  const fingerprint = await probeGateway(port)
  if (fingerprint !== undefined) {
    const full = await probeGateway(port, token)
    return full === undefined
      ? { kind: 'stale', health: fingerprint }
      : { kind: 'ours', health: full }
  }
  return { kind: await portBusy(port) ? 'foreign' : 'free' }
}

/**
 * 确保网关在线。
 *
 * 顺序：已有健康实例 → 直接复用；端口空闲 → 拉起分离式守护进程；端口被别的
 * 程序占用 → 顺延到下一个候选端口。分离式（detached + unref）是有意的：子代理
 * 与 worker 是**独立进程**，若网关只活在某个会话进程里，它们一发起请求就会
 * 打到一个已经消失的端口上。
 *
 * 复用之前必须先确认「这个端口上跑的确实是同一份代码、同一个令牌世代」——
 * 判定细节见 `inspectPort`。宁可换端口，也绝不与一个身份不明的监听者共用
 * 同一个端口：那会变成随机 401，是最难查的一类症状。
 *
 * @returns {Promise<{port: number, token: string, reused: boolean, health?: object, encounters?: Array}>}
 */
/**
 * 确保网关在线，返回 `{port, token, reused, inProcess?, health, encounters}`。
 *
 * 末尾统一撤销「已显式停止」标记：这个函数只在「用户要它在线」的语境下被调用
 * （`install` / `refresh` / 保活），因此一次成功调用就等于撤销先前的 `stop`。
 * 放在这里而不是各个 return 点上，是为了不依赖「将来新增分支时记得清标记」。
 */
export async function ensureGateway(options = {}) {
  const result = await ensureGatewayInner(options)
  clearGatewayDisabled()
  return result
}

async function ensureGatewayInner(options = {}) {
  const desiredPort = parsePort(options.port ?? portOverride ?? process.env.WORKBUDDY_GATEWAY_PORT, DEFAULT_GATEWAY_PORT)
  const previous = readGatewayState()
  const token = ensureGatewayToken(options.token ?? previous?.token)
  const wantVersion = options.version

  /** 版本一致 = 端口上跑的确实是这份代码；否则是「改了代码却没生效」的经典形态。 */
  const versionOk = health => wantVersion === undefined || health.version === wantVersion

  /** 记住一路上遇到的东西，让「为什么换端口了」在报告里有据可查。 */
  const encounters = []
  const note = outcome => {
    if (outcome.kind === 'free') return
    if (encounters.some(entry => entry.port === outcome.port)) return
    const entry = { port: outcome.port, kind: outcome.kind, version: outcome.health?.version }
    encounters.push(entry)
    if (outcome.kind === 'stale') {
      logLine('gateway', `port ${outcome.port} 被本插件的另一令牌世代占用（v${outcome.health?.version}），改用下一个端口`)
    } else if (outcome.kind === 'foreign') {
      logLine('gateway', `port ${outcome.port} 被其它程序占用`)
    }
    return entry
  }

  /** 拉起（守护进程优先，受限环境下退回进程内）。 */
  const launch = async port => {
    const spawnResult = await spawnDaemon({ port, token, options })
    if (spawnResult.spawned) {
      const health = await waitForHealth(port, token, options.startTimeoutMs ?? 8000)
      if (health !== undefined) return { port, token, reused: false, health, encounters }
      // 守护进程起来了但没通过健康检查：把日志线索带上，便于诊断。
      throw new Error(`WorkBuddy 网关已在 ${port} 端口启动但未通过健康检查，详见 ${join(workbuddyDir(), 'gateway.log')}`)
    }
    if (options.allowInProcess !== false) {
      const inProcess = await startInProcess({ port, token, options })
      if (inProcess !== undefined) return { port, token, reused: true, inProcess: true, health: inProcess, encounters }
    }
    throw new Error(`无法启动 WorkBuddy 网关：${spawnResult.reason ?? '进程派生与进程内启动都不可用'}`)
  }

  // 1) **已生效的端口先试一次** —— 优先复用它。
  //
  // 顺序上必须让 `options.port`（= 天枢配置里那个端口）**压过**状态文件里的
  // 记忆值。反过来会出现一种很难查的故障：状态文件被上一次会话写成了别的端口
  // （例如上一轮因为端口被占而顺延过），而配置里仍是原来的端口 —— 于是这次
  // 起在新端口上，宿主的每个请求都打在配置里的旧端口上。
  //
  // 判据是「宿主的配置指向哪儿」，不是「我们上次用过哪儿」。状态文件只是快照。
  const preferred = options.port !== undefined ? options.port : previous?.port
  if (preferred !== undefined) {
    const outcome = { port: preferred, ...(await inspectPort(preferred, token)) }
    if (outcome.kind === 'ours' && versionOk(outcome.health)) {
      return { port: preferred, token, reused: true, health: outcome.health, encounters }
    }
    if (outcome.kind === 'ours') {
      // 同门不同版本：先停掉再用同一端口重拉，配置里的 URL 不用变。
      logLine('gateway', `version drift ${outcome.health.version} -> ${wantVersion}, restarting`)
      await stopGateway()
      return await launch(preferred)
    }
    // 同门但令牌世代不同（stale）：端口上那个实例不认我们的令牌，而它恰恰占着
    // 宿主会去连的那个端口。留着它 = 每个请求随机 401。因此这里主动清掉它，
    // 再把端口抢回来 —— 这是唯一能让「配置不用改」继续成立的处置。
    if (outcome.kind === 'stale' && options.port !== undefined) {
      logLine('gateway', `port ${preferred} 上有一个不认当前令牌的同门实例（v${outcome.health?.version}），停掉它并复用该端口`)
      const stopped = await stopForeignGeneration(preferred, outcome.health)
      if (stopped) return await launch(preferred)
    }
    note(outcome)
  }

  // 2) 顺延挑一个可用端口。
  let port = desiredPort
  for (let attempt = 0; attempt < PORT_SCAN_LIMIT; attempt += 1) {
    const outcome = { port, ...(await inspectPort(port, token)) }
    if (outcome.kind === 'ours') {
      if (versionOk(outcome.health)) {
        return { port, token, reused: true, health: outcome.health, encounters }
      }
      logLine('gateway', `version drift ${outcome.health.version} -> ${wantVersion}, restarting`)
      await stopGateway()
      return await launch(port)
    }
    note(outcome)
    if (!(await portBusy(port))) break
    port += 1
    if (attempt === PORT_SCAN_LIMIT - 1) {
      throw new Error(`连续 ${PORT_SCAN_LIMIT} 个端口都被占用，无法启动 WorkBuddy 网关`)
    }
  }

  // 3) 拉起守护进程。
  return await launch(port)
}

/**
 * 派生分离式守护进程。
 *
 * **Windows 上必须走「双跳派生」**（relay）：天枢的 `killProcessTree` 在 Windows
 * 走 `taskkill /F /T`，按**父子关系**遍历整棵树。而本函数最常被 `preTurn` hook
 * 调用 —— hook 是天枢用 `spawnSync` 拉起的子进程，于是网关落在 hook 的子树里，
 * 天枢回收 hook 时会把网关一起带走。
 *
 * 实测（probe/ppid-test.mjs）：`detached: true` 在 Windows **完全不改变父子关系**
 * —— 子进程的父 pid 依然是调用者，所以照样被 `taskkill /T` 连带杀死。
 * POSIX 的 detached（自成进程组）语义在 Windows 上没有对应物。
 *
 * 因此 Windows 上多插一跳：调用者 → relay → 网关。relay 派生完网关后**立刻退出**，
 * 网关的父进程随即失效，不再出现在 hook 的父子链上。
 *
 * relay 通过环境变量传参（不进命令行，避免令牌出现在进程列表里），
 * 且 relay 自身只做「派生 + 退出」这一件事，失败也不影响主流程 —— 最坏退化成
 * 原来的单跳派生，由保活负责兜底。
 */
function spawnDaemon({ port, token, options }) {
  const useRelay = process.platform === 'win32'
  const args = useRelay
    ? [relayEntry(), serverEntry(), '--port', String(port)]
    : [serverEntry(), '--port', String(port)]

  return new Promise(resolve => {
    let child
    try {
      child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, WORKBUDDY_GATEWAY_TOKEN: token, ...(options.env ?? {}) },
      })
    } catch (error) {
      resolve({ spawned: false, reason: errorText(error) })
      return
    }
    child.once('error', error => resolve({ spawned: false, reason: errorText(error) }))
    child.once('spawn', () => {
      child.unref()
      resolve({ spawned: true, pid: child.pid })
    })
  })
}

/** 轮询等待健康检查通过。 */
async function waitForHealth(port, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const health = await probeGateway(port, token, 1500)
    if (health !== undefined) return health
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return undefined
}

/**
 * 本进程内启动的网关句柄。
 *
 * 必须留住这个引用：`startInProcess` 的实例用**当前进程**持有监听 socket，
 * 也就是说进程的事件循环被它吊着。早先的实现只清状态文件、不关服务，
 * 于是任何「起了进程内网关又不想继续跑」的路径都永远退不出去 ——
 * `process.once('exit')` 也救不了，因为 exit 恰恰要等事件循环空下来才会触发。
 * 测试里表现为整个套件挂死到超时。
 */
let inProcessGateway

/** 关闭一个监听中的 http 服务，等待句柄真正释放。 */
function closeServer(server) {
  return new Promise(resolve => {
    try {
      server.close(() => resolve(true))
      // 空闲连接（keep-alive）会让 close 一直等下去，主动断开。
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
    } catch {
      resolve(false)
    }
  })
}

/** 受限环境下在当前进程内启动网关（不跨会话存活，但会话内可用）。 */
async function startInProcess({ port, token, options }) {
  const sources = options.sources ?? new VariantSources(options.sourceOptions ?? {})
  const server = createGatewayServer({ sources, token, version: options.version })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } catch (error) {
    logLine('gateway', `in-process listen failed: ${errorText(error)}`)
    return undefined
  }
  inProcessGateway = { server, port, token }
  writeGatewayState({ version: 1, port, token, pid: process.pid, mode: 'in-process', startedAt: Date.now() })
  // 进程退出时释放端口，避免留下一个「半死」的监听。
  const shutdown = () => { try { server.close() } catch { /* 已在关闭中 */ } }
  process.once('exit', shutdown)
  return probeGateway(port, token, 2000)
}

/**
 * 关闭进程内网关（若存在）。
 *
 * 与 {@link stopGateway} 分开是因为调用方的诉求不同：这里只问「当前进程里的
 * 那个监听还在不在」，不看状态文件，因此可以在环境已被改动（如测试换过
 * `RIVET_HOME`）之后安全收尾。
 */
export async function stopInProcessGateway() {
  const handle = inProcessGateway
  if (handle === undefined) return { stopped: false, reason: '本进程内没有网关实例' }
  inProcessGateway = undefined
  await closeServer(handle.server)
  return { stopped: true, port: handle.port, mode: 'in-process' }
}

/**
 * 关闭网关。
 *
 * 分两种形态，都必须真的关掉：
 *   - **进程内**：本进程持有监听，直接 close（`stopInProcessGateway`）；
 *   - **分离式守护进程**：按状态文件里的 pid 发 SIGTERM。
 *
 * 终止用的是**状态文件里的 pid** —— 那是我们自己写下的，可信。刻意不从网络
 * 响应里取 pid：那等于让一个本机任意进程通过伪造指纹来指定「请去 kill 这个
 * pid」。拿不到可信 pid 时如实报告无法安全终止，不猜。
 *
 * 成功（或「本来就没在跑」）时留下 `gateway.disabled` 标记：`preTurn` 保活会在
 * 每轮对话前把网关拉回来，没有这个标记的话 `stop` 立刻会被下一轮对话撤销。
 */
export async function stopGateway() {
  const state = readGatewayState()
  if (state === undefined) {
    // 状态文件没了，但本进程可能仍持有监听（例如状态文件被外部删掉）。
    const orphan = await stopInProcessGateway()
    markGatewayDisabled('stop')
    return orphan.stopped
      ? { stopped: true, mode: 'in-process', port: orphan.port }
      : { stopped: false, reason: '没有网关状态文件' }
  }
  if (state.pid === process.pid) {
    const closed = await stopInProcessGateway()
    clearGatewayState()
    markGatewayDisabled('stop')
    return { stopped: closed.stopped, mode: 'in-process', port: state.port }
  }

  // 令牌对不上也要能认出来：先匿名取指纹，避免把「同门但换过令牌的残留实例」
  // 误判成「端口上没有存活实例」而悄悄留下一个会抢连接的进程。
  const authorized = await probeGateway(state.port, state.token)
  const fingerprint = authorized ?? await probeGateway(state.port)
  if (fingerprint === undefined) {
    clearGatewayState()
    markGatewayDisabled('stop')
    return { stopped: false, reason: '端口上没有本插件的实例，已清理状态文件' }
  }

  const pid = Number.isInteger(state.pid) && state.pid > 0 ? state.pid : undefined
  if (pid === undefined) {
    return {
      stopped: false,
      port: state.port,
      reason: `端口 ${state.port} 上有本插件实例，但状态文件里没有可用的 pid，无法安全终止`,
    }
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    return { stopped: false, reason: `终止守护进程失败：${errorText(error)}` }
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (!(await portBusy(state.port, 400))) break
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  clearGatewayState()
  // 信号已经发出，「用户要它下线」这个意图已经成立，与端口是否立刻释放无关。
  markGatewayDisabled('stop')
  if (!(await portBusy(state.port, 400))) return { stopped: true, mode: 'daemon' }

  // 还在占用。这里刻意再分一次类再报告：直接说「仍被占用」会让人以为是自己
  // 的程序没关干净，而实际上多半是**另一个令牌世代的同门实例**还活着
  // （状态文件丢过、或并发起过两次接入）。两者的处置完全不同：后者 `install`
  // 会顺延端口并继续工作，不需要用户去手动 kill。
  const leftover = await inspectPort(state.port, stateToken(state))
  if (leftover.kind === 'stale' || leftover.kind === 'ours') {
    return {
      stopped: false,
      port: state.port,
      portOwner: leftover.kind,
      reason: `已发送终止信号，但端口 ${state.port} 上仍有本插件的实例（令牌世代不一致，pid ${pid} 可能已被另一进程取代）；再次 install 会自动改用下一个端口`,
    }
  }
  return {
    stopped: false,
    port: state.port,
    portOwner: leftover.kind,
    reason: `已发送终止信号，但端口 ${state.port} 仍被占用（${leftover.kind === 'foreign' ? '已被其它程序接管' : '原因未知'}）`,
  }
}

/** 取用于端口归属判定的令牌；拿不到就只做匿名判定。 */
function stateToken(state) {
  return typeof state?.token === 'string' && state.token !== '' ? state.token : undefined
}

/**
 * 停掉「占着我们端口、但不认我们令牌」的那个同门实例。
 *
 * 这个函数存在的理由是端口漂移的**传染性**：一旦端口被上一世代的实例占住，
 * `ensureGateway` 就只能顺延到下一个端口，而宿主配置里存的仍是旧端口 ——
 * 于是「配置对不上」这件事会被**固化**下来，每次启动都漂一次。
 *
 * 因此处置方式不是「躲开它」，而是「把端口抢回来」：只有当同一个端口上始终是
 * 我们自己时，`config.json` 里那个绝对 URL 才可能长期有效。
 *
 * 难点是**拿不到那个进程的 pid**：它属于另一个令牌世代，状态文件可能早被覆盖
 * 或删掉。因此按平台从「监听该端口的进程」反查：
 *
 *   - Windows：`netstat -ano` 找 `LISTENING` 行拿 pid。这里刻意不用 `taskkill`
 *     （会被路径转换破坏，见项目记忆），改用 `process.kill`。
 *   - POSIX：`lsof -ti:<port>`（缺失时静默失败，退回「不抢」）。
 *
 * **安全边界**：是否终止，取决于「端口上是本插件」这一判定 —— 由 `/healthz`
 * 的 `marker` 字段确认（匿名可读的指纹），而不是「端口上有东西就杀」。
 * 非本插件的占用者会被明确放过（`foreign`），交由 `note()` 记录并顺延端口。
 *
 * @param {number} port
 * @param {object|undefined} fingerprint 匿名探测到的 `/healthz` 响应体
 * @returns {Promise<boolean>} 是否已成功释放端口
 */
async function stopForeignGeneration(port, fingerprint) {
  if (fingerprint?.marker !== HEALTH_MARKER) return false
  const pid = await pidListeningOn(port)
  if (pid === undefined || pid === process.pid) return false
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return false
  }
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    if (!(await portBusy(port, 400))) return true
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  // 温和信号不够就强杀 —— 端口已经被确认是我们的，不释放等于持续故障。
  try {
    if (process.platform === 'win32') process.kill(pid, 'SIGKILL')
    else process.kill(pid, 'SIGKILL')
  } catch { /* 可能已退出 */ }
  const finalDeadline = Date.now() + 1500
  while (Date.now() < finalDeadline) {
    if (!(await portBusy(port, 400))) return true
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  return false
}

/**
 * 查「正在监听某端口」的进程 pid。
 *
 * 返回 `undefined` 表示查不出来 —— 调用方必须把这种情况当成「不能抢」而不是
 * 「没有进程」。查不出来时最坏的结果只是顺延端口（可恢复），而猜一个 pid 去杀
 * 是不可恢复的。
 *
 * 两个环境坑（实测）：
 *   1. `netstat` **不在被裁剪过的 PATH 里**（`execFile('netstat', ...)` 直接
 *      `ENOENT`），必须用 `%SystemRoot%\System32\netstat.exe` 绝对路径；
 *   2. 输出里同一个端口会有多行（`LISTENING` 一行 + 若干 `TIME_WAIT`/`ESTABLISHED`
 *      的对端连接），**必须**先按状态过滤，否则会把一个 TIME_WAIT 行的 pid 字段
 *      （是 0）当成答案。
 */
export function pidListeningOn(port) {
  return new Promise(resolve => {
    const parse = stdout => {
      for (const line of String(stdout).split(/\r?\n/u)) {
        if (!/LISTENING/iu.test(line)) continue
        const columns = line.trim().split(/\s+/u)
        // 形如：TCP  127.0.0.1:17871  0.0.0.0:0  LISTENING  52360
        const local = columns[1] ?? ''
        if (!local.endsWith(`:${port}`)) continue
        const pid = Number(columns[4])
        if (Number.isInteger(pid) && pid > 0) return pid
      }
      return undefined
    }

    const viaNetstat = () => {
      const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netstat.exe')
      execFile(exe, ['-ano', '-p', 'TCP'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error) return viaPowerShell()
        const pid = parse(stdout)
        if (pid === undefined) return viaPowerShell()
        return resolve(pid)
      })
    }

    // netstat 不可用时的兜底：Get-NetTCPConnection 是等价的权威来源。
    const viaPowerShell = () => {
      const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      execFile(ps, [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
      ], { timeout: 6000, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(undefined)
        const pid = Number(String(stdout).trim().split(/\s+/u)[0])
        return resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined)
      })
    }

    try {
      if (process.platform === 'win32') return viaNetstat()
      execFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { timeout: 5000 }, (error, stdout) => {
        if (error) return resolve(undefined)
        const pid = Number(String(stdout).trim().split(/\s+/u)[0])
        return resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined)
      })
    } catch {
      resolve(undefined)
    }
  })
}

/**
 * 会话空闲后关闭网关。
 *
 * 为什么需要它：本插件的网关是**会话进程的一部分**，不是常驻服务。会话结束
 * （进程退出）时 `exit` 钩子会关掉它；但如果宿主进程活着而会话早已结束（用户
 * 开着窗口不动、或宿主把会话挂起），端口就会被一直占着 —— 下一个会话要起网关
 * 时只能顺延到别的端口，而配置里存的是旧端口，于是「昨天好好的，今天模型用不了」。
 *
 * 因此网关自己记录最后一次请求时间，空闲超过阈值就自己下线，把端口让出来。
 * 阈值取得比任何正常的人机交互间隔都长（默认见 `DEFAULT_IDLE_SHUTDOWN_MS`），
 * 且**任何一次请求都会重置计时**，所以正常使用中永远不会触发。
 *
 * 传 `ms <= 0` 即彻底关闭这个机制（`doctor`、`serve` 等场景需要长驻）。
 */
export const DEFAULT_IDLE_SHUTDOWN_MS = 30 * 60 * 1000

let idleTimer

export function scheduleIdleShutdown({ ms = DEFAULT_IDLE_SHUTDOWN_MS } = {}) {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer)
    idleTimer = undefined
  }
  if (!Number.isFinite(ms) || ms <= 0) return false
  // `unref` 是关键：定时器不能成为「进程还活着」的理由，否则它会反过来把会话
  // 吊住 —— 与我们要解决的问题正好相反。
  idleTimer = setTimeout(() => {
    idleTimer = undefined
    logLine('gateway', `空闲 ${Math.round(ms / 1000)}s，关闭网关并释放端口`)
    stopGateway().catch(() => { /* 退出路径不报错 */ })
  }, ms)
  idleTimer.unref?.()
  return true
}

/** 取消空闲回收（测试与长驻场景）。 */
export function cancelIdleShutdown() {
  if (idleTimer === undefined) return false
  clearTimeout(idleTimer)
  idleTimer = undefined
  return true
}

/** 有请求进来 = 有活动。由网关服务在每次请求时调用。 */
export function touchActivity() {
  if (idleTimer === undefined) return
  scheduleIdleShutdown({ ms: idleShutdownMs })
}

let idleShutdownMs = DEFAULT_IDLE_SHUTDOWN_MS

export function setIdleShutdownMs(ms) {
  idleShutdownMs = ms
  if (typeof ms === 'number' && ms > 0) scheduleIdleShutdown({ ms })
  else cancelIdleShutdown()
  return idleShutdownMs
}

/**
 * 供状态接口使用的网关概览。
 *
 * `tokenAccepted === false` 而指纹仍在，是最值得单独说出来的一种状态：端口上
 * 有本插件，但它不认当前令牌。此时请求会随机失败，而报错长得像网络问题。
 */
export async function gatewayStatus() {
  const state = readGatewayState()
  if (state === undefined) return { running: false, state: undefined }
  const base = { port: state.port, token: state.token, pid: state.pid, mode: state.mode }
  const health = await probeGateway(state.port, state.token, 1500)
  if (health !== undefined) {
    return { running: true, ...base, ...(health.pid === undefined ? {} : { pid: health.pid }), health, tokenAccepted: true }
  }
  const fingerprint = await probeGateway(state.port, undefined, 1500)
  if (fingerprint === undefined) return { running: false, ...base, tokenAccepted: false }
  return {
    running: false,
    ...base,
    tokenAccepted: false,
    fingerprint,
    warning: `127.0.0.1:${state.port} 上有一个本插件的网关实例，但它不认当前令牌`
      + '（多半是换过令牌世代的残留进程，或代码更新后端口未换）。'
      + '重新执行接入会在相邻端口上重建一个干净的实例。',
  }
}

export { HEALTH_MARKER, rivetHome }
