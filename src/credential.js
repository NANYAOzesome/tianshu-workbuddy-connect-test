/**
 * WorkBuddy 桌面凭据读取层。
 *
 * 职责：定位桌面 App 的认证文件 → 判定明文/加密形态 → 解密被 `$wbEncrypted`
 * 包裹的字段 → 产出归一化凭据 → 按需刷新令牌并落到插件自留副本。
 *
 * WorkBuddy 5.6+ 把 `accessToken` / `refreshToken` 加密落盘，密钥材料在
 * 同机可取：运行 App **自己的** Electron 二进制一次（`ELECTRON_RUN_AS_NODE=1`），
 * 调用其私有的 `workbuddyStorage` 绑定拿到 `{version:1, atRestSecretKey}`，
 * 再 `sha256(secret, utf8)` 得到 AES-256-GCM 的 protector key。
 *
 * 安全纪律：
 * - 令牌、密钥、payload 一律不进日志；诊断只输出长度、keyId 与退出码。
 * - 明文 token 只写插件自留副本（0600），从不回写桌面 App 的文件。
 *
 * @module tianshu-workbuddy-connect/credential
 */

import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { AI_VARIANT, CN_VARIANT } from './variants.js'
import { clip, ensureDir, workbuddyDir, readJsonSafe, removeFileIfExists, writeJsonAtomic } from './util.js'

/** 认证文件在共享认证目录下的相对片段。 */
const DESKTOP_AUTH_RELATIVE = ['CodeBuddyExtension', 'Data', 'Public', 'auth']

/** 插件自留副本的格式版本。 */
const OWN_FORMAT_VERSION = 1

/** Electron 密钥助手脚本 —— 只打印 payload，不做任何其它事。 */
const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

/** 密钥助手与注册表查询的超时。 */
const HELPER_TIMEOUT_MS = 10_000
const REGISTRY_TIMEOUT_MS = 4_000

/** 打开注册表发现策略的环境变量（默认关闭，见 `registryLookupEnabled`）。 */
const REGISTRY_ENV_FLAG = 'WORKBUDDY_ELECTRON_REGISTRY'

/** 认证文件可被读成的四种形态。 */
export const AuthFormat = {
  ABSENT: 'absent',
  PLAINTEXT: 'plaintext',
  ENCRYPTED: 'encrypted',
  UNRECOGNIZED: 'unrecognized',
}

/* ------------------------------------------------------------------ *
 * 路径发现
 * ------------------------------------------------------------------ */

/** 依据平台拼出共享认证目录（可能是多个候选）。 */
function authDirCandidates() {
  const home = homedir()
  const out = []
  if (process.platform === 'darwin') {
    out.push(join(home, 'Library', 'Application Support', ...DESKTOP_AUTH_RELATIVE))
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    out.push(join(local, ...DESKTOP_AUTH_RELATIVE))
    out.push(join(roaming, ...DESKTOP_AUTH_RELATIVE))
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config')
    const dataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share')
    out.push(join(configHome, ...DESKTOP_AUTH_RELATIVE))
    out.push(join(dataHome, ...DESKTOP_AUTH_RELATIVE))
  }
  return [...new Set(out)]
}

/** 某变体在所有平台默认位置下的认证文件候选（按探测顺序）。 */
export function desktopAuthCandidates(variant) {
  return [...new Set(authDirCandidates().map(dir => join(dir, variant.desktopFilename)))]
}

/** 插件自留副本路径。 */
export function ownAuthPath(variant) {
  return join(workbuddyDir(), variant.ownFilename)
}

/**
 * 该变体是否已登录过（存在桌面认证文件或插件自留副本）。
 *
 * 只做存在性检查，不读内容 —— 状态与列表接口需要它来区分「未安装/未登录」
 * 与「装了但读不出来」。
 */
export function looksSignedIn(variant, configPath) {
  if (configPath && existsSync(configPath)) return true
  if (existsSync(ownAuthPath(variant))) return true
  return desktopAuthCandidates(variant).some(candidate => existsSync(candidate))
}

/* ------------------------------------------------------------------ *
 * 加密字段解密
 * ------------------------------------------------------------------ */

/**
 * 复刻 App 自身的 AAD 构造。
 *
 * 字段不含序列号，末尾两字节（context 标记 2 与默认 context 0）在凭据字段上
 * 固定 —— 这与参考实现一致；改动这里会让所有 envelope 解不开。
 */
export function buildAad(keyId, suite) {
  const lengthPrefixed = value => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/** 解码 base64，可选校验精确字节长度。 */
function parseBase64(value, length) {
  if (typeof value !== 'string' || value === '') return undefined
  let decoded
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    return undefined
  }
  if (decoded.length === 0) return undefined
  if (length !== undefined && decoded.length !== length) return undefined
  return decoded
}

/** 解析一个 `{$wbEncrypted:1, envelope}` 包裹，得到可开锁的 envelope。 */
export function parseWrappedField(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const wrapped = value
  if (wrapped.$wbEncrypted !== 1 || typeof wrapped.envelope !== 'string') return undefined
  let inner
  try {
    inner = JSON.parse(Buffer.from(wrapped.envelope, 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined
  const nonce = parseBase64(inner.nonce, 12)
  const authTag = parseBase64(inner.authTag, 16)
  const ciphertext = parseBase64(inner.ciphertext)
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined
  if (!Number.isInteger(inner.suite)) return undefined
  // 目前只定义了 suite 1。未知 suite 一律不认领为「加密」，让文档落到
  // unrecognized 并给出诊断，而不是盲试。
  if (inner.suite !== 1) return undefined
  if (typeof inner.keyId !== 'string' || !/^[0-9a-f]{16}$/u.test(inner.keyId)) return undefined
  return { field: undefined, envelope: { suite: inner.suite, keyId: inner.keyId, nonce, authTag, ciphertext } }
}

/**
 * 用一个 protector key 打开一个 envelope；打不开返回 undefined。
 *
 * 接受的格式精确等于 WorkBuddy 5.6.x 写出的形态，因此失败的含义是
 * 「不是这个格式 / 密钥不对」，如实上报而不是换框架重试。
 */
export function openAuthField(key, envelope) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/** 从 payload 的 secret 派生 protector key（sha256 over utf8）。 */
export function deriveProtectorKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** 按 App 自身的规则校验助手的 payload。 */
export function parseAtRestPayload(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  if (parsed.version !== 1) return undefined
  const secret = parsed.atRestSecretKey
  if (typeof secret !== 'string' || secret === '') return undefined
  let decoded
  try {
    decoded = Buffer.from(secret, 'base64')
  } catch {
    return undefined
  }
  if (decoded.length !== 32) return undefined
  if (decoded.toString('base64') !== secret) return undefined
  if (decoded.every(byte => byte === 0)) return undefined
  return { atRestSecretKey: secret }
}

/**
 * 把一个认证文档归类。
 *
 * `encrypted` 分支同时带回字段尚未解开的 wrapper，调用方解密后重建文本文档
 * 再交给常规解析 —— 身份与过期时间字段因此无需第二条代码路径。
 */
export function classifyDesktopDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { format: AuthFormat.UNRECOGNIZED }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { format: AuthFormat.UNRECOGNIZED }
  }
  const auth = typeof parsed.auth === 'object' && parsed.auth !== null ? parsed.auth : undefined
  if (auth === undefined) {
    // 扁平面板形态：token 直接在顶层。有字符串就直接明文可用。
    if (typeof parsed.accessToken === 'string' && parsed.accessToken !== '') {
      return { format: AuthFormat.PLAINTEXT, document: parsed }
    }
    return { format: AuthFormat.UNRECOGNIZED }
  }
  if (typeof auth.accessToken === 'string' && auth.accessToken !== '') {
    return { format: AuthFormat.PLAINTEXT, document: parsed }
  }
  const fields = []
  for (const field of ['accessToken', 'refreshToken']) {
    const wrapped = parseWrappedField(auth[field])
    if (wrapped !== undefined) fields.push({ field, envelope: wrapped.envelope })
  }
  if (fields.length > 0) return { format: AuthFormat.ENCRYPTED, document: parsed, fields }
  return { format: AuthFormat.UNRECOGNIZED }
}

/** 规范化过期时间（秒或毫秒都接受）。 */
function expiryToMs(value) {
  if (typeof value !== 'number' || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 解析一个 WorkBuddy 认证文档（明文形态），产出归一化凭据。
 *
 * 同时接受插件 OAuth 的嵌套形态 `{auth:{...}, account:{...}}` 与扁平面板
 * 形态。无 accessToken 时返回 undefined。
 */
export function parseWorkBuddyAuth(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed
  const hasNested = typeof document.auth === 'object' && document.auth !== null
  const auth = hasNested ? document.auth : document
  const identity = hasNested && typeof document.account === 'object' && document.account !== null ? document.account : document
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
  if (accessToken === '') return undefined
  const enterpriseId = optionalString(identity.enterpriseId)
  const nickname = optionalString(identity.nickname)
  const refreshExpiresAtMs = expiryToMs(auth.refreshExpiresAt)
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: expiryToMs(auth.expiresAt),
    ...(refreshExpiresAtMs === 0 ? {} : { refreshExpiresAtMs }),
    domain: optionalString(auth.domain) ?? '',
    uid: optionalString(identity.uid) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    source: 'desktop',
  }
}

/* ------------------------------------------------------------------ *
 * Electron 二进制定位
 * ------------------------------------------------------------------ */

/** 从资源路径反推 Electron 二进制（App 给子进程设的环境变量）。 */
function electronFromResourcesPath(variant, resourcesPath) {
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return undefined
  if (process.platform === 'darwin') {
    // <Bundle>.app/Contents/Resources → <Bundle>.app/Contents/MacOS/Electron
    return join(dirname(dirname(resourcesPath)), 'MacOS', 'Electron')
  }
  if (process.platform === 'win32') {
    return join(dirname(resourcesPath), variant.electron.windows.exeBasename)
  }
  return undefined
}

/** 平台默认安装位置。 */
function electronDefaultPath(variant) {
  if (process.platform === 'darwin') return variant.electron.macOS.defaultPath
  if (process.platform !== 'win32') return undefined
  const segments = variant.electron.windows.defaultPathSegments
  if (segments === undefined) return undefined
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return undefined
  return join(localAppData, ...segments)
}

/** 从 repair-helper 日志里取 installRoot —— App 自己写的安装根目录。 */
function electronFromRepairLog(variant) {
  if (process.platform !== 'win32') return undefined
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return undefined
  const logDir = join(localAppData, 'workbuddy', 'logs')
  let files
  try {
    files = readdirSync(logDir).filter(name => name.startsWith('repair-helper-') && name.endsWith('.log'))
  } catch {
    return undefined
  }
  // 新日志在前：安装位置变更后旧日志会失效。
  files.sort().reverse()
  for (const name of files.slice(0, 5)) {
    let text
    try {
      text = readFileSync(join(logDir, name), 'utf8')
    } catch {
      continue
    }
    const match = /installRoot=(.+?)\s+manifest=/u.exec(text)
    if (match !== null) {
      const root = match[1].trim()
      const exe = join(root, variant.electron.windows.exeBasename)
      if (existsSync(exe)) return exe
    }
  }
  return undefined
}

/** 把常见安装根目录下的候选收敛为存在的 Electron 二进制。 */
function electronFromCommonRoots(variant) {
  if (process.platform !== 'win32') return undefined
  const exe = variant.electron.windows.exeBasename
  const roots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.LOCALAPPDATA,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
  ].filter(Boolean)
  const productDirs = variant.region === 'global'
    ? ['WorkBuddy AI', 'WorkBuddyAI', 'workbuddy-ai']
    : ['WorkBuddy', 'workbuddy']
  for (const root of roots) {
    for (const dir of productDirs) {
      const candidate = join(root, dir, exe)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** 已解析 Electron 路径的缓存文件。 */
export function electronCachePath() {
  return join(workbuddyDir(), 'electron-path.json')
}

/** 读取缓存的 Electron 路径；缺失或形态不对时返回 undefined。 */
function readElectronCache() {
  const doc = readJsonSafe(electronCachePath())
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined
  return typeof doc.path === 'string' && doc.path !== '' ? doc.path : undefined
}

/**
 * 记下解析成功的 Electron 路径。
 *
 * 为什么必须缓存：最可靠的那条线索（`WORKBUDDY_RESOURCES_PATH`）只存在于
 * **桌面 App 自己的进程环境**里。天枢里跑插件时它不在，于是同一台机器上
 * 「在 WorkBuddy 里能定位到、在天枢里定位不到」。把首次成功的结果落盘，等于
 * 把一次性的环境优势变成持续能力 —— 缓存失效（路径不存在）时自动回退到发现链。
 */
function writeElectronCache(path, strategy) {
  try {
    ensureDir(workbuddyDir())
    writeJsonAtomic(electronCachePath(), { version: 1, path, strategy, resolvedAtMs: Date.now() })
  } catch { /* 缓存写不进去只影响下次的定位速度，不影响本次结果 */ }
}

/**
 * 是否允许查询注册表来找 Electron 二进制。
 *
 * 默认**关闭**，必须显式打开（`WORKBUDDY_ELECTRON_REGISTRY=1`）。理由不是性能，
 * 是可控性：这一步会 spawn `reg.exe`，而 `reg.exe` 恰是托管终端与安全策略最常
 * 拉黑的可执行文件之一。被拉黑时子进程根本起不来 —— 这条路径本来就不可能成功，
 * 却会在宿主日志里留下一次「程序被策略阻止」告警。把不可控的副作用默认关掉、
 * 让确实需要它的人显式开启，比每次运行都赌一把更诚实。
 */
export function registryLookupEnabled(env = process.env) {
  return env[REGISTRY_ENV_FLAG] === '1'
}

/**
 * 查询 Windows 卸载注册表，从 DisplayIcon 取可执行文件。默认关闭，见上。
 */
function electronFromRegistry(variant) {
  if (process.platform !== 'win32') return Promise.resolve(undefined)
  if (!registryLookupEnabled()) return Promise.resolve(undefined)
  const reg = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  if (!existsSync(reg)) return Promise.resolve(undefined)
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  const pattern = variant.electron.windows.displayNamePattern
  const exeBasename = variant.electron.windows.exeBasename.toLowerCase()

  return new Promise(resolve => {
    // 逐 root 查询；任何一个失败都只是这条路走不通，不影响其它策略。
    let index = 0
    const next = () => {
      if (index >= roots.length) {
        resolve(undefined)
        return
      }
      const root = roots[index++]
      // execFile 在被策略拦截（沙箱 / 程序黑名单）时可能**同步**抛出，
      // 因此必须包在 try 里 —— 否则这条发现路径的失败会变成整条链路失败。
      let child
      try {
        child = execFile(reg, ['query', root, '/s'], { timeout: REGISTRY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
          if (error || typeof stdout !== 'string') {
            next()
            return
          }
          // 输出是「键路径 / 值名 / 值数据」三行一组；按空行切块后逐块判定，
          // 这样 DisplayName 与 DisplayIcon 永远来自同一块，不会串条目。
          for (const block of stdout.split(/\r?\n\r?\n/u)) {
            const nameMatch = /DisplayName\s+REG_SZ\s+(.+)/u.exec(block)
            if (nameMatch === null || !pattern.test(nameMatch[1].trim())) continue
            const iconMatch = /DisplayIcon\s+REG_SZ\s+(.+)/u.exec(block)
            const locationMatch = /InstallLocation\s+REG_SZ\s+(.+)/u.exec(block)
            const candidates = []
            if (iconMatch !== null) candidates.push(iconMatch[1].trim().replace(/^"|"$/gu, '').replace(/,\d+$/u, ''))
            if (locationMatch !== null) candidates.push(join(locationMatch[1].trim().replace(/^"|"$/gu, ''), exeBasename))
            for (const candidate of candidates) {
              if (candidate.toLowerCase().endsWith(exeBasename) && existsSync(candidate)) {
                resolve(candidate)
                return
              }
            }
          }
          next()
        })
      } catch {
        next()
        return
      }
      child.on?.('error', () => next())
    }
    next()
  })
}

/**
 * 定位某变体的 Electron 二进制。
 *
 * 顺序即契约：
 *   1. 显式配置 / 显式环境变量 —— 权威且互斥：指了就用它，用不了就报错，
 *      绝不改去找别的 App（用户说「用这个」的时候替他改主意是最坏的行为）。
 *   2. App 自己写下的资源路径环境变量 —— 只在 App 进程里存在，但最可靠；
 *      命中即落盘缓存。
 *   3. 缓存 —— 上次成功解析过的路径，弥补第 2 条在天枢进程里缺席的问题。
 *   4. 平台默认位置、repair 日志、常见安装根目录。
 *   5. 注册表（**需 `WORKBUDDY_ELECTRON_REGISTRY=1` 显式开启**）。
 *
 * 任何一条命中都会把结果写入缓存，下一次不必重跑整条链。
 *
 * @returns {Promise<{path: string, strategy: string} | undefined>}
 */
export async function resolveElectronPath(variant, options = {}) {
  const explicit = options.electronPath ?? process.env[variant.electron.envVar]
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return { path: explicit.trim(), strategy: 'explicit' }
  }
  if (options.discover === false) return undefined

  const resources = process.env.WORKBUDDY_RESOURCES_PATH ?? (process.env.WORKBUDDY_APP_PATH ? dirname(process.env.WORKBUDDY_APP_PATH) : undefined)
  const fromEnv = electronFromResourcesPath(variant, resources)
  if (fromEnv !== undefined && existsSync(fromEnv)) {
    // 此刻正处在「App 自己的环境」里，这是最好的落盘时机。
    writeElectronCache(fromEnv, 'app-env')
    return { path: fromEnv, strategy: 'app-env' }
  }

  // 上次成功解析过的路径。桌面 App 的资源路径环境变量在天枢进程里拿不到，
  // 没有这一层，同一台机器上就会出现「WorkBuddy 里能接入、天枢里定位不到」。
  const cached = readElectronCache()
  if (cached !== undefined && existsSync(cached)) return { path: cached, strategy: 'cache' }

  const defaults = [electronDefaultPath(variant), electronFromRepairLog(variant), electronFromCommonRoots(variant)]
  for (const candidate of defaults) {
    if (candidate !== undefined && existsSync(candidate)) {
      writeElectronCache(candidate, 'default')
      return { path: candidate, strategy: 'default' }
    }
  }

  const registered = await electronFromRegistry(variant)
  if (registered !== undefined) {
    writeElectronCache(registered, 'registry')
    return { path: registered, strategy: 'registry' }
  }

  return undefined
}

/* ------------------------------------------------------------------ *
 * protector key 解析（带缓存与单飞）
 * ------------------------------------------------------------------ */

/**
 * 内存态 protector key 解析器。
 *
 * 每个 keyId 只 spawn 一次，单飞，绝不落盘。缓存按 envelope 索要的 id 建键，
 * 密钥轮转后新 envelope 会恰好触发一次重新解析。
 *
 * 这一个实例同时服务多个变体：缓存条目带 variantId，避免把国内版的密钥
 * 用于国际版的 envelope。
 */
export class AtRestKeyProvider {
  constructor(options = {}) {
    this.spawn = options.spawn ?? defaultSpawnHelper
    this.cache = new Map()
    this.inflight = new Map()
  }

  /** 为请求的 keyId 之一解析 protector key；不匹配则抛出可读错误。 */
  async keyFor(variant, requestedKeyIds) {
    if (requestedKeyIds.length === 0) {
      throw new Error('加密的桌面凭据没有携带 keyId，无法解密')
    }
    const cacheKey = `${variant.id}:${requestedKeyIds.join(',')}`
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) return cached.key

    let inflight = this.inflight.get(variant.id)
    if (inflight === undefined) {
      inflight = this.resolve(variant).finally(() => { this.inflight.delete(variant.id) })
      this.inflight.set(variant.id, inflight)
    }
    const resolved = await inflight
    if (!requestedKeyIds.includes(resolved.keyId)) {
      throw new Error(
        `WorkBuddy 当前的静态密钥（id ${resolved.keyId}）与凭据 envelope（id ${requestedKeyIds.join(' 或 ')}）不匹配；`
        + '该凭据由另一次 WorkBuddy 安装密封，当前安装的密钥打不开它',
      )
    }
    // 同一 keyId 的来源固定，按每个 requested 组合缓存命中即可。
    this.cache.set(cacheKey, resolved)
    return resolved.key
  }

  async resolve(variant) {
    const located = await resolveElectronPath(variant)
    if (located === undefined) {
      throw new Error(
        `未能自动定位 ${variant.appName} 的 Electron 二进制，无法解密加密凭据；`
        + `请设置环境变量 ${variant.electron.envVar} 指向该二进制（Windows 通常是安装目录下的 `
        + `${variant.electron.windows.exeBasename}）后重启天枢`,
      )
    }
    const text = await this.spawn(located.path)
    const payload = parseAtRestPayload(text)
    if (payload === undefined) {
      throw new Error(`${variant.appName} 的密钥助手返回了不可用的 payload（期望 {version:1, atRestSecretKey}）`)
    }
    const key = deriveProtectorKey(payload.atRestSecretKey)
    return { key, keyId: createHash('sha256').update(key).digest('hex').slice(0, 16), electronPath: located.path }
  }
}

/** 默认助手：以 ELECTRON_RUN_AS_NODE 运行 App 自身的二进制一次。 */
function defaultSpawnHelper(electronPath) {
  return new Promise((resolve, reject) => {
    execFile(
      electronPath,
      ['-e', HELPER_SCRIPT],
      { timeout: HELPER_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (error, stdout) => {
        if (error) {
          reject(new Error(`运行 ${basename(electronPath)} 取静态密钥失败：${clip(error.message, 200)}`))
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

/* ------------------------------------------------------------------ *
 * 凭据解析与存储
 * ------------------------------------------------------------------ */

/**
 * 读一个认证文件并产出明文文档文本。
 *
 * `encrypted` 形态在这里解密后重建 JSON 文本，使下游只有一条解析路径。
 */
export async function readDesktopCredential(variant, options = {}) {
  const explicitPath = options.authFile ?? process.env[variant.env]
  const candidates = explicitPath !== undefined && explicitPath !== ''
    ? [explicitPath]
    : desktopAuthCandidates(variant)

  let found
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) { found = candidate; break }
    } catch { /* 不存在或不可读，试下一个 */ }
  }
  if (found === undefined) {
    return { format: AuthFormat.ABSENT, checkedPaths: candidates }
  }

  let text
  try {
    text = readFileSync(found, 'utf8')
  } catch (error) {
    // `readError` 与「内容不认」是两件事，处置也完全不同：前者是权限/沙箱问题
    // （换到沙箱外运行、或修 ACL 才有用），后者才需要去 App 里重新登录。混成一句
    // 「内容不可识别」会把用户引向一个不会有任何效果的处置。
    return {
      format: AuthFormat.UNRECOGNIZED,
      path: found,
      readError: true,
      reason: `认证文件不可读：${clip(error.message, 160)}`,
    }
  }

  const classified = classifyDesktopDocument(text)
  if (classified.format !== AuthFormat.ENCRYPTED) {
    return { ...classified, path: found }
  }

  const keyProvider = options.keyProvider ?? defaultKeyProvider
  const keyIds = [...new Set(classified.fields.map(field => field.envelope.keyId))]
  let key
  try {
    key = await keyProvider.keyFor(variant, keyIds)
  } catch (error) {
    return { format: AuthFormat.UNRECOGNIZED, path: found, reason: clip(error.message, 300) }
  }

  const rebuilt = { ...classified.document }
  const rebuiltAuth = { ...rebuilt.auth }
  for (const field of classified.fields) {
    const plaintext = openAuthField(key, field.envelope)
    if (plaintext === undefined) {
      return {
        format: AuthFormat.UNRECOGNIZED,
        path: found,
        reason: `凭据字段 ${field.field} 解密失败（keyId ${field.envelope.keyId}）；该文件可能由另一次 WorkBuddy 安装写入`,
      }
    }
    rebuiltAuth[field.field] = plaintext
  }
  rebuilt.auth = rebuiltAuth
  return { format: AuthFormat.PLAINTEXT, document: rebuilt, path: found, decrypted: true, text: JSON.stringify(rebuilt) }
}

/** 进程级共享的密钥解析器。 */
export const defaultKeyProvider = new AtRestKeyProvider()

/** 插件自留副本文档。 */
function ownDocument(credential) {
  return { version: OWN_FORMAT_VERSION, credential }
}

/** 解析插件自留副本；版本或形态不符即拒绝。 */
function parseOwnDocument(text) {
  const document = (() => {
    try { return JSON.parse(text) } catch { return undefined }
  })()
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined
  if (document.version !== OWN_FORMAT_VERSION) return undefined
  const stored = document.credential
  if (typeof stored !== 'object' || stored === null) return undefined
  if (typeof stored.accessToken !== 'string' || stored.accessToken === '') return undefined
  const enterpriseId = optionalString(stored.enterpriseId)
  const nickname = optionalString(stored.nickname)
  const refreshExpiresAtMs = typeof stored.refreshExpiresAtMs === 'number' ? stored.refreshExpiresAtMs : undefined
  return {
    accessToken: stored.accessToken,
    refreshToken: typeof stored.refreshToken === 'string' ? stored.refreshToken : '',
    expiresAtMs: typeof stored.expiresAtMs === 'number' ? stored.expiresAtMs : 0,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain: optionalString(stored.domain) ?? '',
    uid: optionalString(stored.uid) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    source: 'plugin',
  }
}

/** 凭据身份键：用于判断账号是否切换。 */
export function credentialIdentity(credential) {
  return `${credential.uid}:${credential.enterpriseId ?? ''}`
}

/**
 * 带按需刷新的只读凭据存储。
 *
 * 刷新策略：仅在访问令牌进入余量窗口（或已过期）时刷新，刷新结果写进插件
 * 自留副本，绝不回写桌面 App 的文件；刷新失败且令牌尚未过期时照常返回旧
 * 令牌，使刷新端点不可达不至于拖垮一个本来可用的会话。
 */
export class CredentialStore {
  /**
   * @param {object} options
   * @param {object} options.variant           变体描述符
   * @param {Function} [options.refresh]       刷新实现 (credential) => outcome
   * @param {number}  [options.refreshMarginMs] 提前刷新余量
   * @param {string}  [options.authFile]        显式认证文件路径
   */
  constructor(options) {
    this.variant = options.variant
    this.refreshImpl = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.authFile = options.authFile
    /** 上一次刷新未落盘的凭据，供进程内复用。 */
    this.pending = undefined
    /** 最近一次读取的诊断信息（供 doctor 使用）。 */
    this.lastRead = undefined
  }

  get ownPath() {
    return ownAuthPath(this.variant)
  }

  /** 读插件自留副本。 */
  own() {
    const document = readJsonSafe(this.ownPath)
    if (document === undefined) return undefined
    return parseOwnDocument(JSON.stringify(document))
  }

  /**
   * 取当前凭据，必要时刷新。
   *
   * 桌面凭据与自留副本按「更晚过期者优先」择一：App 重新登录会让桌面 token
   * 更新，而插件刷新过的副本可能更新 —— 取新的那份，并保证身份一致，
   * 避免在 A 账号的 uid 下发 B 账号的请求。
   */
  async current() {
    const desktopResult = await readDesktopCredential(this.variant, { authFile: this.authFile })
    this.lastRead = desktopResult
    const desktop = desktopResult.format === AuthFormat.PLAINTEXT && desktopResult.text !== undefined
      ? parseWorkBuddyAuth(desktopResult.text)
      : undefined
    const own = this.own()

    if (desktop === undefined && own === undefined) return undefined
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    if (desktop.uid !== own.uid || desktop.enterpriseId !== own.enterpriseId) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /** 取一个可用于发请求的凭据，必要时先刷新。 */
  async resolve() {
    const credential = await this.current()
    if (credential === undefined) {
      throw new Error(
        `还没有登录 ${this.variant.appName}。请打开 ${this.variant.appName} 并完成登录，然后重试。`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`${this.variant.displayName} 的登录已过期，请重新登录桌面 App`)
    }
    if (this.refreshImpl === undefined) return credential
    try {
      const outcome = await this.refreshImpl(credential)
      const next = {
        ...credential,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
        expiresAtMs: outcome.expiresInSec === undefined ? credential.expiresAtMs : Date.now() + outcome.expiresInSec * 1000,
        ...(outcome.domain === undefined ? {} : { domain: outcome.domain }),
        source: 'plugin',
      }
      this.persistOwn(next)
      return next
    } catch (error) {
      // 刷新失败不等于会话不可用：只要旧令牌还没过期就照常使用。
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`刷新 ${this.variant.displayName} 登录令牌失败：${clip(error instanceof Error ? error.message : error, 200)}`)
    }
  }

  /** 是否进入刷新窗口。 */
  needsRefresh(credential) {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  /** 把凭据写进插件自留副本（0600）。 */
  persistOwn(credential) {
    ensureDir(workbuddyDir())
    writeJsonAtomic(this.ownPath, ownDocument(credential), 0o600)
  }

  /** 删除插件自留副本；不动桌面 App 自己的登录。 */
  clearOwn() {
    return removeFileIfExists(this.ownPath)
  }

  /** 供状态/诊断使用的凭据概览，不含令牌本体。 */
  async describe() {
    const credential = await this.current().catch(error => ({ error: clip(error.message, 240) }))
    if (credential === undefined) {
      return { signedIn: false, path: this.lastRead?.path, format: this.lastRead?.format, reason: this.lastRead?.reason }
    }
    if (credential.error !== undefined) return { signedIn: false, reason: credential.error }
    return {
      signedIn: true,
      source: credential.source,
      domain: credential.domain,
      uid: credential.uid,
      enterpriseId: credential.enterpriseId,
      nickname: credential.nickname,
      expiresAtMs: credential.expiresAtMs,
      expiresInMinutes: credential.expiresAtMs > 0 ? Math.round((credential.expiresAtMs - Date.now()) / 60000) : undefined,
      hasRefreshToken: credential.refreshToken !== '',
      authFilePath: this.lastRead?.path,
      authFormat: this.lastRead?.format,
      decrypted: this.lastRead?.decrypted === true,
    }
  }
}

/** 若凭据属于国际版区域，返回国际版变体；否则返回国内版。 */
export function variantForCredential(credential) {
  return typeof credential?.domain === 'string' && credential.domain.endsWith('workbuddy.ai') ? AI_VARIANT : CN_VARIANT
}

export { CN_VARIANT, AI_VARIANT }
