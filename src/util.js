/**
 * 通用工具：天枢数据目录解析、原子写入、日志、回环判定。
 *
 * 不依赖任何第三方包 —— 插件与核心同进程运行，依赖越少加载越快、冲突越少。
 *
 * @module tianshu-workbuddy-connect/util
 */

import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 天枢数据根目录，与核心 `src/config/paths.ts` 的解析优先级保持一致。 */
export function rivetHome() {
  if (process.env.RIVET_HOME) return process.env.RIVET_HOME
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), '.rivet')
  }
  return join(homedir(), '.rivet')
}

/** 天枢用户级配置文件路径，遵循 `RIVET_CONFIG_PATH` 覆盖。 */
export function rivetConfigPath() {
  return process.env.RIVET_CONFIG_PATH || join(rivetHome(), 'config.json')
}

/** 插件自有的状态目录（凭据副本、网关令牌、日志）。 */
export function workbuddyDir() {
  return join(rivetHome(), 'workbuddy')
}

/** 确保目录存在（递归），已存在时为无操作。 */
export function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

/** 读取并解析 JSON；缺失、不可读或非法时返回 undefined，绝不抛出。 */
export function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 原子写入：先写同目录临时文件，再 rename 覆盖。
 *
 * rename 在同文件系统内是原子操作，因此崩溃只会留下完整旧文件或完整新文件，
 * 不会出现被截断的 config.json —— 那是让用户的 provider 配置整体失效的
 * 典型事故形态。
 */
export function writeFileAtomic(path, contents, mode) {
  ensureDir(dirname(path))
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, contents, mode === undefined ? {} : { mode })
  if (mode !== undefined && process.platform !== 'win32') {
    try { chmodSync(tmp, mode) } catch { /* 权限位在部分文件系统上不可用 */ }
  }
  renameSync(tmp, path)
}

/** 原子写入 JSON（两空格缩进，与天枢自身写 config.json 的风格一致）。 */
export function writeJsonAtomic(path, value, mode) {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}

/** 覆盖前先留一份带时间戳的备份；返回备份路径（无原文件时返回 undefined）。 */
export function backupFile(path) {
  if (!existsSync(path)) return undefined
  const backup = `${path}.bak-${Date.now()}`
  try {
    writeFileSync(backup, readFileSync(path))
    return backup
  } catch {
    return undefined
  }
}

/** 只在文件存在时返回其大小，用于诊断输出。 */
export function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

/** 删除文件，缺失视为成功。 */
export function removeFileIfExists(path) {
  try {
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}

/** 生成可直接用作本地网关 apiKey 的随机令牌。 */
export function randomToken(bytes = 24) {
  return `wb-${randomBytes(bytes).toString('hex')}`
}

/** 稳定短 id，用于按 keyId 缓存解密密钥等场景。 */
export function shortId(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** 回环主机名判定，与核心 `isLoopbackBaseUrl` 同口径。 */
export function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === '0.0.0.0'
}

/** 请求 Host 头是否指向回环（含端口形式）。 */
export function hostHeaderIsLoopback(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0]
  return isLoopbackHostname(hostname)
}

/**
 * 浏览器 Origin 是否属于回环。
 *
 * 缺失 Origin 视为通过（非浏览器客户端，如天枢自身的 fetch）。存在但非回环的
 * Origin 一律拒绝 —— 这正是 DNS rebinding 页面会带上的形态。
 */
export function originIsLoopback(originHeader) {
  if (originHeader === undefined || originHeader === '') return true
  try {
    return isLoopbackHostname(new URL(originHeader).hostname)
  } catch {
    return false
  }
}

/** 网关日志文件路径。 */
export function gatewayLogPath() {
  return join(workbuddyDir(), 'gateway.log')
}

/** 追加一行带时间戳的日志；日志失败绝不影响主流程。 */
export function logLine(scope, message) {
  try {
    ensureDir(workbuddyDir())
    appendFileSync(gatewayLogPath(), `${new Date().toISOString()} [${scope}] ${message}\n`)
  } catch { /* 日志不可写时静默降级 */ }
}

/** 把任意错误渲染成一行可读文本。 */
export function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 截断超长文本，避免错误体灌进模型上下文。 */
export function clip(text, max = 300) {
  const value = typeof text === 'string' ? text : String(text)
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** 生成一个未监听的回环端口候选序列。 */
export function parsePort(value, fallback) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback
}
