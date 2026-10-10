/**
 * 插件版本号 —— 单一来源。
 *
 * 版本号被三处用来做「代码是否同一份」的判定：网关 `healthz` 上报的版本、
 * 插件启动预热时带上的版本、以及 preTurn 保活 hook 比对守护进程版本。
 * 三者必须永远一致，所以只从 package.json 读一次，任何调用方都不许各写一份。
 *
 * @module tianshu-workbuddy-connect/version
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 读取失败时退回 `0.0.0-dev`：宁可让漂移检测显式报不一致，也不要静默瞒过。 */
function readVersion() {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0-dev'
  } catch {
    return '0.0.0-dev'
  }
}

export const PLUGIN_VERSION = readVersion()

export default PLUGIN_VERSION
