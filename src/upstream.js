/**
 * WorkBuddy 上游客户端：模型目录、流式对话、令牌刷新。
 *
 * 这一层只做三件事，且都不持有凭据 —— 凭据由调用方每次显式传入，使「谁在
 * 用谁的账号发请求」永远是显式的。
 *
 * 上游的线上怪癖（在源插件里逐条记录、这里原样保留，它们是实测结论而不是
 * 推断）：
 * - chat 端点**拒绝非流式**请求，因此必须强制 `stream: true`；
 * - `role: "developer"` 会被判为「未授权渠道」并返回 400/11128，需改写为
 *   `system`；
 * - `tool_choice` 只接受**字符串**形态，对象形态一律 400；
 * - chat 请求**绝不携带** refresh token（安全红线）。
 *
 * @module tianshu-workbuddy-connect/upstream
 */

import { clip } from './util.js'

/** 与源插件一致的 CLI 身份，用于目录与刷新接口。 */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** 桌面身份兜底版本 —— 桌面 App 未提供版本时的最后一道。 */
const FALLBACK_APP_VERSION = '5.5.6'

/** 目录与刷新请求的超时。 */
const JSON_TIMEOUT_MS = 30_000

/** 额度不足标记（ASCII 小写 + 原文中文），命中即判为硬性欠费。 */
const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough', 'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** 会话失效标记：上游把「登录态已死」既可能答成 401，也可能答成 403。 */
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']

/** 上游失败分类。 */
export const ErrorKind = {
  HARD_CREDIT: 'hard_credit',
  SOFT_RATE: 'soft_rate',
  SESSION_DEAD: 'session_dead',
  NOT_FOUND: 'not_found',
  SERVER: 'server',
  CLIENT: 'client',
}

/** 各失败分类对应的下游 HTTP 状态码。 */
const KIND_STATUS = {
  [ErrorKind.HARD_CREDIT]: 402,
  [ErrorKind.SOFT_RATE]: 429,
  [ErrorKind.SESSION_DEAD]: 401,
  [ErrorKind.NOT_FOUND]: 502,
  [ErrorKind.SERVER]: 502,
  [ErrorKind.CLIENT]: 400,
}

/** 由状态码与响应体判定失败分类。 */
export function classifyUpstreamError(status, body) {
  if (status === 402) return ErrorKind.HARD_CREDIT
  // 401 无论如何都是认证失败：这个上游没有别的语义承载它。会话失效标记只是
  // 额外信号（它们还能抓到被答成 403 的死会话）。
  if (status === 401) return ErrorKind.SESSION_DEAD
  const lower = typeof body === 'string' ? body.toLowerCase() : ''
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || (typeof body === 'string' && body.includes(marker))) {
      return ErrorKind.HARD_CREDIT
    }
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (typeof body === 'string' && body.includes(marker)) return ErrorKind.SESSION_DEAD
  }
  if (status === 429) return ErrorKind.SOFT_RATE
  if (status === 404) return ErrorKind.NOT_FOUND
  if (status >= 500) return ErrorKind.SERVER
  return ErrorKind.CLIENT
}

/** 该分类向下游暴露的状态码。 */
export function statusForKind(kind) {
  return KIND_STATUS[kind] ?? 502
}

/**
 * 从上游 JSON 错误体里提取面向用户的文案。
 *
 * 优先 WorkBuddy 的本地化 `displayMsg.zh` / `displayMsg.en`，退回 `msg`。
 * 这条路径的价值在于：业务错误（安全审查、非法请求）不该被下游的
 * 「API Key 无效」横幅掩盖。
 */
export function extractDisplayErrorMessage(body) {
  if (typeof body !== 'string') return undefined
  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return undefined
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const displayMsg = parsed.displayMsg
  if (typeof displayMsg === 'object' && displayMsg !== null && !Array.isArray(displayMsg)) {
    if (typeof displayMsg.zh === 'string' && displayMsg.zh.trim() !== '') return displayMsg.zh.trim()
    if (typeof displayMsg.en === 'string' && displayMsg.en.trim() !== '') return displayMsg.en.trim()
  }
  if (typeof parsed.msg === 'string' && parsed.msg.trim() !== '') return parsed.msg.trim()
  return undefined
}

/** 改写 `role: "developer"` 为 `role: "system"`（上游拒绝 developer）。 */
function normalizeDeveloperRole(obj) {
  if (!Array.isArray(obj.messages)) return
  for (const message of obj.messages) {
    if (typeof message === 'object' && message !== null && !Array.isArray(message) && message.role === 'developer') {
      message.role = 'system'
    }
  }
}

/** 把 `tool_choice` 压成上游唯一接受的字符串形态。 */
function normalizeToolChoice(obj) {
  const suppress = () => {
    delete obj.tools
    delete obj.functions
  }
  if (!('tool_choice' in obj)) return
  const choice = obj.tool_choice
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj.tool_choice
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj.tool_choice
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj.tool_choice = type
    } else if (type === 'function') {
      const fn = typeof choice.function === 'object' && choice.function !== null ? choice.function : undefined
      let name = typeof fn?.name === 'string' ? fn.name : ''
      if (name === '' && typeof choice.name === 'string') name = choice.name
      name = name.trim()
      obj.tool_choice = name !== '' ? name : 'auto'
    } else {
      delete obj.tool_choice
    }
    return
  }
  delete obj.tool_choice
}

/**
 * 归一化一个 OpenAI chat-completions 请求体。
 *
 * 非 JSON 输入原样返回 —— 上游会用 400 拒绝它，这里没有可改的东西。
 */
export function prepareChatBody(source) {
  let body
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  body.stream = true
  delete body.stream_options
  normalizeDeveloperRole(body)
  normalizeToolChoice(body)
  return JSON.stringify(body)
}

/** 国际版端点的额外请求要求。 */
export const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.'

/** 国际版请求体预处理：补系统提示、剔除该端点拒绝的 `off` 档位。 */
export function prepareInternationalChatBody(source) {
  const prepared = prepareChatBody(source)
  let body
  try {
    body = JSON.parse(prepared)
  } catch {
    return prepared
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return prepared
  if (body.reasoning_effort === 'off') delete body.reasoning_effort
  if (!Array.isArray(body.messages)) return JSON.stringify(body)
  const first = body.messages[0]
  if (typeof first === 'object' && first !== null && !Array.isArray(first) && first.role === 'system') {
    return JSON.stringify(body)
  }
  body.messages.unshift({ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT })
  return JSON.stringify(body)
}

/* ------------------------------------------------------------------ *
 * 请求头
 * ------------------------------------------------------------------ */

function commonHeaders(credential) {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: credential.origin,
    Referer: `${credential.origin}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** chat 请求头：X-No-* 约定与桌面身份。 */
export function chatHeaders(credential, appVersion) {
  const version = appVersion ?? FALLBACK_APP_VERSION
  const product = credential.region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'
  return {
    ...commonHeaders(credential),
    'User-Agent': `WorkBuddy/${version} ${product}/${version}`,
    'Content-Type': 'application/json',
    ...(credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId }),
    ...(credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain }),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': version,
    'X-Product': 'SaaS',
  }
}

/** 刷新端点请求头 —— `X-Refresh-Token` 只在这里出现，别处一律不出现。 */
function refreshHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** 目录端点请求头（国内版用 CLI 身份，国际版用 App 身份）。 */
function catalogHeaders(credential, appVersion) {
  const international = credential.region === 'global'
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    Origin: credential.origin,
    Referer: `${credential.origin}/`,
    ...(international ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' } : {}),
    'User-Agent': international && appVersion !== undefined ? `WorkBuddyAI/${appVersion}` : CLIENT_UA,
  }
}

/** 把归一化凭据补上变体派生字段（基址、Origin、区域）。 */
export function enrichCredential(credential, variant) {
  return {
    ...credential,
    region: variant.region,
    origin: variant.origin,
    chatBase: variant.chatBase,
  }
}

/* ------------------------------------------------------------------ *
 * 客户端
 * ------------------------------------------------------------------ */

/** 上游 JSON 信封 `{code,msg,data}` 或裸文档，统一读出。 */
async function readEnvelope(response) {
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`WorkBuddy 上游返回了非 JSON 内容（http ${response.status}）：${clip(text, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`WorkBuddy 上游返回了无法识别的文档（http ${response.status}）`)
  }
  return {
    code: typeof parsed.code === 'number' ? parsed.code : 0,
    msg: typeof parsed.msg === 'string' ? parsed.msg : '',
    data: parsed.data,
    document: parsed,
  }
}

/** 为一个业务码非 0 的信封生成错误，分类口径与 HTTP 错误一致。 */
function envelopeError(status, envelope) {
  const kind = classifyUpstreamError(status, envelope.msg)
  return Object.assign(
    new Error(`WorkBuddy 上游 ${kind}（http ${status}）：${clip(envelope.msg, 200)}`),
    { kind, status },
  )
}

/** 把 AbortSignal 与超时合成为一个信号。 */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

export class UpstreamClient {
  /**
   * @param {object} [options]
   * @param {string} [options.appVersion] 桌面 App 版本，用于 chat UA
   */
  constructor(options = {}) {
    this.appVersion = options.appVersion ?? process.env.WORKBUDDY_APP_VERSION
    this.lastCatalog = undefined
  }

  /** 拉取 CLI 可用模型目录。 */
  async fetchCatalog(credential, signal) {
    const response = await fetch(`${credential.chatBase}/v3/config`, {
      headers: catalogHeaders(credential, this.appVersion),
      signal: withTimeout(signal, JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data
      : 'models' in envelope.document || 'agents' in envelope.document
        ? envelope.document
        : {}
    this.lastCatalog = { fetchedAtMs: Date.now(), source: `${credential.region}:cli` }
    return data
  }

  /**
   * POST chat 端点并返回原始 SSE 响应。
   *
   * 成功时返回未消费的 `Response`（body 是 ReadableStream），由调用方决定
   * 是转发给下游还是读完 —— 网关走前者，因此这里绝不能先 `text()`。
   */
  async chatStream(credential, bodyText, signal, options = {}) {
    const prepared = credential.region === 'global'
      ? prepareInternationalChatBody(bodyText)
      : prepareChatBody(bodyText)
    let response
    try {
      response = await fetch(`${credential.chatBase}/v2/chat/completions`, {
        method: 'POST',
        headers: {
          ...chatHeaders(credential, this.appVersion),
          Authorization: `Bearer ${credential.accessToken}`,
        },
        body: prepared,
        signal,
      })
    } catch (error) {
      // 网络层失败（DNS、连接重置、取消）在网关侧要能与上游 5xx 区分开。
      if (error?.name === 'AbortError') {
        return { ok: false, status: 499, kind: ErrorKind.CLIENT, message: '请求已取消' }
      }
      return { ok: false, status: 502, kind: ErrorKind.SERVER, message: `连接 WorkBuddy 上游失败：${clip(error?.message ?? error, 200)}` }
    }

    if (response.ok) return { ok: true, response }

    // 失败体不大（上限 4KB），读出来是为了分类与展示文案，不是为了转发。
    let body = ''
    try {
      body = clip(await response.text(), 4096)
    } catch { /* 读失败也要把状态如实报出去 */ }
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, body),
      message: extractDisplayErrorMessage(body) ?? clip(body, 400),
      ...(options.raw === true ? { body } : {}),
    }
  }

  /** 刷新访问令牌。 */
  async refreshToken(credential, signal) {
    const response = await fetch(`${credential.chatBase}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: withTimeout(signal, JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
    if (accessToken === '') {
      throw new Error('WorkBuddy 令牌刷新未返回 accessToken，请在桌面 App 重新登录')
    }
    return {
      accessToken,
      ...(typeof data.refreshToken === 'string' && data.refreshToken !== '' ? { refreshToken: data.refreshToken } : {}),
      ...(typeof data.expiresIn === 'number' && data.expiresIn > 0 ? { expiresInSec: data.expiresIn } : {}),
      ...(typeof data.domain === 'string' && data.domain !== '' ? { domain: data.domain } : {}),
    }
  }
}

/** 简便探针：一次最小 chat 请求，用于 doctor 的连通性检查。 */
export async function probeChat(client, credential, model, signal) {
  const result = await client.chatStream(
    credential,
    JSON.stringify({ model, stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
    signal,
  )
  if (!result.ok) return result
  try {
    const reader = result.response.body.getReader()
    const { value } = await reader.read()
    await reader.cancel().catch(() => {})
    return { ok: true, bytes: value?.length ?? 0 }
  } catch (error) {
    return { ok: false, status: 502, kind: ErrorKind.SERVER, message: `读取流失败：${clip(error?.message ?? error, 160)}` }
  }
}
