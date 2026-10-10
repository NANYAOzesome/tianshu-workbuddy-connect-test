/**
 * Tianshu WorkBuddy Connect — 天枢插件入口。
 *
 * 把 WorkBuddy 桌面 App 内置的模型（DeepSeek / GLM / Kimi / MiniMax / Hy3 / 混元 …）
 * 接入天枢 Tianshu Harness：复用 App 的登录态，零配置、无需 API Key。
 *
 * 形态说明（与源插件的关键差异）：
 *
 * 源插件是 DeepSeek Harness 的 cordis 插件，直接向宿主内核注册 LLM provider
 * 适配器。天枢的插件契约是**工具插件**（导出 `tools`），模型接入走
 * `~/.rivet/config.json` 的 provider 配置。因此这里的适配方式是：
 *
 *   天枢 ──(OpenAI 协议)──> 本地回环网关 ──(WorkBuddy 私有协议)──> WorkBuddy 上游
 *
 * 网关把 WorkBuddy 的线上怪癖（强制流式、拒绝 developer 角色、字符串
 * tool_choice、私有认证头）收敛在一处，天枢侧就只是一个干净的 OpenAI provider。
 * 这样既满足天枢的扩展契约，又不必把 WorkBuddy 的令牌交给任何外部服务。
 *
 * **用户视角**：装完插件就完事了。本模块在被 `import` 的那一刻（早于宿主读取
 * provider 配置）做一次幂等的自动接入 —— 起网关、读账号、写配置，全程无需
 * 用户再说一句话。详见 {@link ./src/autoconnect.js}。
 *
 * @module tianshu-workbuddy-connect
 */

import { tools } from './src/tools.js'
import { PLUGIN_VERSION } from './src/version.js'
import { applyPortOverride, autoConnect } from './src/autoconnect.js'
import { detectDrift } from './src/rivet-config.js'
import { DEFAULT_IDLE_SHUTDOWN_MS, ensureGateway, readGatewayState, setIdleShutdownMs } from './src/gateway.js'

/** 插件版本，取自 package.json，供漂移检测与展示共用。 */
export { PLUGIN_VERSION }

export { tools }

// 端口覆盖必须在任何网关操作之前生效：它只在「本进程新建网关」时起作用，因此
// 不会把已经生效的配置带偏（`ensureGateway` 的调用方总是显式给出端口）。
applyPortOverride()

// 会话内网关的回收策略：空闲太久就自己下线，把端口让出来。设 0 可彻底关闭。
setIdleShutdownMs(Number(process.env.WORKBUDDY_IDLE_SHUTDOWN_MS ?? DEFAULT_IDLE_SHUTDOWN_MS) || 0)

/**
 * 启动自举：让「装上即可用」成立。
 *
 * 本插件在这个宿主里走的是**本地回环网关**这条路（天枢的扩展契约只有工具插件，
 * 没有注册 provider 的接口；详见 README 的「为什么需要一个本地网关」）。网关本身
 * 很轻，但**它必须被拉起来**：provider 配置里存的是 `http://127.0.0.1:<port>/v1`
 * 这样的绝对 URL，端口上没人监听时，天枢的每个请求都会打在空气上。
 *
 * 因此这里做幂等的自动接入 —— 与用户在天枢里说一句「接入 WorkBuddy」、或手动跑
 * `cli.js install` **完全等价**，都是调用同一个 `connect()`：
 *
 *   - 已接入且网关在线 → 什么都不做（发一次回环探活，1ms 级）
 *   - 已接入但网关掉了（重启电脑 / 进程被回收）→ 只把网关拉回来，不重写配置
 *   - 从未接入，且本机有已登录的 WorkBuddy 桌面 App → 自动完成接入
 *   - 从未接入，且没有可用的桌面 App 登录态 → **什么都不做**，如实返回原因
 *
 * 最后一条是刻意的：装个插件不该凭空多一个常驻进程，也不该替用户决定「接入」。
 * 没有可用的登录态时，这里既不起网关也不改配置，把可见性留给用户主动调用
 * `workbuddy_connect`（以及随之而来的、指明「去哪个 App 登录」的报错）。
 *
 * 三条纪律：
 *
 * 1. **绝不抛错、绝不阻塞会话启动。** 自举是启动快路径上的旁路，任何失败都只
 *    留下结构化原因，进程照常起来。
 * 2. **绝不静默篡改配置。** 自动接入只是把用户迟早会点的那一下提前；它不设默认
 *    provider（`setDefault` 保持 false），原条目的备份与原子写由 `connect()` 保证。
 * 3. **失败可见。** 结果里带 `reason`，`workbuddy_status` / `workbuddy_doctor`
 *    会把它连同细节一起报出来，而不是让用户面对一个「模型突然不响应」的黑箱。
 *
 * 刻意不做 top-level await：宿主不 await 这个 Promise，加不加都一样，不如让它
 * 本身成为一个可被检查的对象。
 */
export const ready = autoConnect({ ensureGateway, detectDrift, readGatewayState, version: PLUGIN_VERSION })
