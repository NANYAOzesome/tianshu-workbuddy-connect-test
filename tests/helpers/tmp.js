/**
 * 测试用临时目录：创建与「尽力而为」的清理。
 *
 * 为什么不直接写一行 `rmSync(dir, { recursive: true, force: true })`：
 *
 * 宿主会在 Node 启动时注入一个 safe-delete 垫片（`node-safe-delete-shim.cjs`）
 * 用它自己的实现替换 `fs.rmSync` / `fs.rmdirSync` / `fs.unlinkSync`，目的
 * 是把删除改成「先进回收站」。该实现是**递归自实现**的：它先把子项一个个
 * 处理掉，再对父目录调用 `fs.rmdirSync`。而 `fs.rmdirSync` 同时也被它换掉了，
 * 于是父目录的删除会走回原生 rmdir，并偶发地在子项真正消失之前执行，
 * 抛出 `ENOTEMPTY: directory not empty, rmdir '<tmpdir>'`。
 *
 * 实测：整个套件跑 3 次约有 1 次变红，报错位置恒定在临时目录的 `rmdir`，
 * 而不是任何断言 —— 这种红是环境噪声，却会掩盖真正的断言失败，也会让
 * 「全部通过」这个信号失去意义。
 *
 * 因此这里的清理分两层，都不改变被测代码的语义：
 *
 *   1. 交给 Node 内建的 rimraf 重试：`rmSync` 的 `maxRetries` / `retryDelay`
 *      正是为 `EBUSY | EMFILE | ENFILE | ENOTEMPTY | EPERM` 这类「晚一拍」
 *      的错误准备的（默认 `maxRetries: 0`，所以原生调用一次就抛）。垫片会把
 *      这两个选项原样透传给原生 rmSync，因此重试确实会发生。
 *   2. 仍然失败就退让：临时目录留在 `%TEMP%` 由系统回收。清理失败**不应**
 *      把断言全过的用例变成失败，这是测试卫生问题而不是产品缺陷。
 *
 * @module tests/helpers/tmp
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 建一个带前缀的隔离临时目录。
 * @param {string} prefix 便于在 `%TEMP%` 里辨认归属，如 `'wb-keys-'`
 * @returns {string} 绝对路径
 */
export function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * 尽力删除临时目录：先让 Node 内建 rimraf 重试，再单次兜底，最后放弃。
 *
 * 刻意不抛出 —— 见文件头说明。返回值只用于调用方决定是否要提示。
 *
 * @param {string} dir 要删除的目录
 * @returns {boolean} 是否确认已删除
 */
export function cleanupTmpDir(dir) {
  for (const options of [{ maxRetries: 10, retryDelay: 25 }, { maxRetries: 10, retryDelay: 50 }]) {
    try {
      rmSync(dir, { recursive: true, force: true, ...options })
      return true
    } catch { /* 垫片的延迟删除；换一档参数再试一次 */ }
  }
  return false
}

/** 进程退出时统一回收的临时目录。 */
const tracked = []

/**
 * 登记一个临时目录，在进程退出时统一回收。
 *
 * 适用于「一个目录服务多个用例」的形态（每次 `test()` 单独清理反而更啰嗦）：
 * 登记一次，退出时一起删，既不泄漏 `%TEMP%` 残留，也不需要在每个用例里
 * 重复 try/finally。
 *
 * @param {string} dir 由 {@link makeTmpDir} 建出的目录
 * @returns {string} 原样返回 `dir`，便于链式使用
 */
export function trackTmpDir(dir) {
  tracked.push(dir)
  return dir
}

process.on('exit', () => {
  for (const dir of tracked) cleanupTmpDir(dir)
})

/**
 * 在隔离的数据根下跑一段逻辑的通用壳。
 *
 * 天枢的插件状态目录由 `RIVET_HOME` 决定，因此「换 home」是这一层最常见的
 * 前置动作；把它收在这里，避免每个测试文件各写一遍 try/finally 而漏掉还原。
 *
 * @param {string} prefix 临时目录前缀
 * @param {(home: string) => any} fn 被测逻辑（可返回 Promise）
 */
export async function withTmpHome(prefix, fn) {
  const home = makeTmpDir(prefix)
  const previous = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previous
    cleanupTmpDir(home)
  }
}
