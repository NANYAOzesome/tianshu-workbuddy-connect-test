/**
 * 全量语法自检。
 *
 * 插件是被宿主用 `import()` 直接加载的 —— 任何一个文件里的语法错误都不会在
 * 构建期暴露，而是表现为「天枢里那个插件静默没生效」（加载失败被降级成一条
 * 警告）。所以每个 `.js` 都要在提交前过一遍，包括测试与 hook 脚本。
 *
 * 解析在**本进程内**通过 `vm.SourceTextModule` 完成，而不是逐个 spawn
 * `node --check`：后者在受限/托管环境里连续派生二十多个子进程会被策略拦成
 * EBUSY，检查脚本本身反而成了不可靠的一环。构造 SourceTextModule 只解析、
 * 不执行，正是这里需要的语义。
 *
 * 用法：node --experimental-vm-modules scripts/syntax-check.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const targets = ['index.js', 'bin', 'hooks', 'src', 'tests', 'scripts']

/** 递归收集所有 `.js` / `.mjs` 文件。 */
function collect(relative) {
  const absolute = join(root, relative)
  if (statSync(absolute).isFile()) return [absolute]
  return readdirSync(absolute)
    .flatMap(name => collect(join(relative, name)))
    .sort()
}

const files = targets.flatMap(collect)
const Module = vm.SourceTextModule
if (Module === undefined) {
  process.stderr.write('需要 --experimental-vm-modules 才能做无副作用的模块解析检查\n')
  process.exit(2)
}

let failed = 0
for (const file of files) {
  try {
    // 只构造不链接：解析语法，不触发任何 import 或顶层副作用。
    new Module(readFileSync(file, 'utf8'), { identifier: file })
  } catch (error) {
    failed += 1
    process.stderr.write(`语法错误：${file}\n  ${error.message}\n`)
  }
}

if (failed > 0) {
  process.stderr.write(`\n${failed} / ${files.length} 个文件未通过语法检查\n`)
  process.exit(1)
}
process.stdout.write(`语法检查通过：${files.length} 个文件\n`)
