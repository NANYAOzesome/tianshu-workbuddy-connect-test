/**
 * 两个 WorkBuddy 产品变体（国内版 / 国际版）。
 *
 * 两者是同一套客户端框架在不同区域的发行版，登录态写在**同一个**
 * `CodeBuddyExtension` 认证目录下，差异只在文件基名、上游域名、显示名与
 * Electron 身份。把差异收敛成一份描述符，任何模块都不再需要自带
 * `if (international)` 分支 —— 新增第三个变体将是数据变更而非重构。
 *
 * 与源插件的差异：天枢没有「provider 分组卡片」这个概念，因此这里不携带
 * 状态路由、探测路由等仅服务于 DSH 设置面板的字段，只保留协议层需要的部分。
 *
 * @module tianshu-workbuddy-connect/variants
 */

/** 一个 WorkBuddy 产品变体。 */
export const VARIANTS = [
  {
    /** 天枢 provider key，写入 `~/.rivet/config.json` 的 `provider.providers` 下。 */
    id: 'workbuddy',
    displayName: 'WorkBuddy',
    appName: 'WorkBuddy',
    /** 凭据所属区域，决定上游基址。 */
    region: 'cn',
    /** 覆盖认证文件位置的环境变量。 */
    env: 'WORKBUDDY_AUTH_FILE',
    /** 桌面 App 写在共享认证目录下的文件基名。 */
    desktopFilename: 'workbuddy-desktop.info',
    /** 插件自留凭据副本的文件基名。 */
    ownFilename: '.workbuddy-auth.json',
    /** 上游聊天与目录基址。 */
    chatBase: 'https://copilot.tencent.com',
    /** Origin / Referer 用的站点。 */
    origin: 'https://www.codebuddy.cn',
    /** Electron 可执行文件定位描述。 */
    electron: {
      productName: 'WorkBuddy',
      envVar: 'WORKBUDDY_ELECTRON_BIN',
      macOS: {
        bundleId: 'com.tencent.workbuddy.mac',
        defaultPath: '/Applications/WorkBuddy.app/Contents/MacOS/Electron',
      },
      windows: {
        displayNamePattern: /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
        exeBasename: 'WorkBuddy.exe',
        defaultPathSegments: ['Programs', 'WorkBuddy', 'WorkBuddy.exe'],
      },
    },
  },
  {
    id: 'workbuddy-ai',
    displayName: 'WorkBuddy AI',
    appName: 'WorkBuddy AI',
    region: 'global',
    env: 'WORKBUDDY_AI_AUTH_FILE',
    desktopFilename: 'workbuddy-desktop-ai.info',
    ownFilename: '.workbuddy-ai-auth.json',
    chatBase: 'https://www.workbuddy.ai',
    origin: 'https://www.workbuddy.ai',
    electron: {
      productName: 'WorkBuddy AI',
      envVar: 'WORKBUDDY_AI_ELECTRON_BIN',
      macOS: {
        bundleId: 'com.workbuddy.workbuddy-ai',
        defaultPath: '/Applications/WorkBuddy AI.app/Contents/MacOS/Electron',
      },
      windows: {
        // 与国内版互斥：CN 模式匹配不到 "WorkBuddy AI 5.6.2"（"AI" 不是版本号），
        // 本条也匹配不到 "WorkBuddy 5.6.2"（少了字面量 " AI"）。
        displayNamePattern: /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
        exeBasename: 'WorkBuddyAI.exe',
        // 国际版没有实测过的默认安装位置，只走注册表发现，绝不猜测。
      },
    },
  },
]

/** 国内版变体 —— 长期默认与兼容锚点。 */
export const CN_VARIANT = VARIANTS[0]

/** 国际版变体。 */
export const AI_VARIANT = VARIANTS[1]

/** 按 provider id 查找变体。 */
export function variantFor(id) {
  return VARIANTS.find(variant => variant.id === id)
}

/** 按区域查找变体（凭据的 `domain` 决定区域）。 */
export function variantForRegion(region) {
  return VARIANTS.find(variant => variant.region === region)
}

/**
 * 凭据登录域 → 区域。
 *
 * 国际版登录域以 `workbuddy.ai` 结尾；其余（含空域、`copilot.tencent.com`）
 * 一律按国内版处理，与源插件 `regionOf` 的兜底方向一致。
 */
export function regionOfDomain(domain) {
  return typeof domain === 'string' && domain.endsWith('workbuddy.ai') ? 'global' : 'cn'
}
