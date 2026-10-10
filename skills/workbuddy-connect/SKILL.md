---
name: workbuddy-connect
description: 把 WorkBuddy 桌面 App 内置的模型接入天枢（Tianshu Harness）。当用户要在天枢里使用 WorkBuddy 的模型（DeepSeek / GLM / Kimi / MiniMax / 混元 Hy3 等）、询问「为什么 WorkBuddy 模型用不了」、或需要重新同步 WorkBuddy 模型列表时使用。
---

# WorkBuddy Connect

把 **WorkBuddy 桌面 App** 内置的模型接入天枢，复用 App 的登录态 —— 不需要 API Key，
不需要把令牌填进任何地方。

## 什么时候用

- 用户说「把 WorkBuddy 的模型接到天枢」「在天枢里用 WorkBuddy 的额度」
- 用户问「为什么 WorkBuddy 的模型报错 / 用不了」
- WorkBuddy 上新了模型，用户想在天枢里看到
- 装/卸 WorkBuddy Connect 插件之后的验收

## 基本用法

安装本身不产生任何配置，**必须显式接入**一次：

1. `workbuddy_connect` —— 接入（幂等，可反复执行）
2. 提示用户**新开一个天枢会话**：天枢在启动时读取 provider 配置，当前会话不会
   凭空出现新模型

接入后在天枢里用 `/model <id>` 切换模型，例如 `/model deepseek-v4.1-flash`。

## 工具一览

| 工具 | 用途 |
| --- | --- |
| `workbuddy_connect` | 接入 / 重新接入。参数：`setDefault`、`forceRefresh`、`port`、`rotateToken` |
| `workbuddy_status` | 网关、账号、天枢配置、天枢 Key 池是否对齐 |
| `workbuddy_models` | 列出可用模型（上下文窗口、输出上限、思考档、是否支持图片） |
| `workbuddy_refresh` | 刷新登录令牌并把最新模型列表写回天枢配置 |
| `workbuddy_doctor` | 逐环诊断 + 一次真实对话验证 |
| `workbuddy_logout` | 断开接入（需用户确认；不影响桌面 App 自身登录） |

`rotateToken: true` 会换发网关令牌（旧令牌立即作废），并把 `config.json` 与
`provider-keys.json` 一起对齐到新令牌，**端口保持不变**。只在怀疑令牌泄漏、或端口上
有残留实例不认当前令牌时才用；正常接入不要带它。

## 排障顺序

出问题先跑 `workbuddy_doctor`，它会按链路顺序给出结论：

```
凭据文件 → 加密字段解密 → Electron 助手 → 上游目录 → 本地网关 → 天枢配置 → 天枢 Key 池 → 真实对话
```

按返回结果里 `→` 指向的建议逐条处理，处理完再跑一次。常见成因与处置：

| 症状 | 成因 | 处置 |
| --- | --- | --- |
| `未发现登录凭据` | App 未登录，或安装在非默认位置 | 打开并登录 WorkBuddy；或用环境变量 `WORKBUDDY_AUTH_FILE` 指定认证文件路径 |
| `凭据是加密形态，但未能解密` | 定位不到 App 的 Electron 二进制 | 用 `WORKBUDDY_ELECTRON_BIN` 显式指定（Windows 一般是安装目录下的 `WorkBuddy.exe`） |
| `本地网关未运行` | 从未接入，或网关被清理 | 执行 `workbuddy_connect` |
| `本地网关已被显式停止` | 之前执行过 `stop` / `uninstall` | 重新执行 `workbuddy_connect`（保活**不会**自动撤销 `stop`） |
| `… 上有本插件的实例，但它不认当前令牌` | 换过令牌世代的残留实例占着端口 | 重新执行 `workbuddy_connect`，它会自动改用相邻端口重建 |
| `Key 池不一致` / 模型报 401 但配置看着正常 | `provider-keys.json` 与 `config.json` 的 Key 不同，**天枢用的是前者** | 重新执行 `workbuddy_connect`（两处一起对齐） |
| `providers.workbuddy 指向 …，但当前网关在 N 端口` | 端口漂移（曾用过别的桥接服务 / 手动改过配置） | 重新执行 `workbuddy_connect` |
| `真实对话验证失败` | 账号额度、会话过期、模型下架 | 用 `workbuddy_models` 确认模型仍在；必要时在桌面 App 重新登录 |
| 模型列表少了很多 | 账号可用的 CLI 名册本身变了 | `workbuddy_refresh`，然后新开会话 |

> **不要**只写 `config.json` 就当修好了。天枢实际发出的凭据取自同级的
> `provider-keys.json`，两者可以长期不一致而都不报错 —— 配置页显示前者，请求带后者。
> 这是「配置看着没问题、请求却稳定 401」的唯一成因，也是 `workbuddy_connect` 必须
> 两处一起写的原因。

## 需要遵守的边界

- **不要**把 WorkBuddy 的 `accessToken` / `refreshToken` 贴进对话、写进文件或传给
  任何外部服务。插件只在本机 127.0.0.1 上把令牌交给 WorkBuddy 官方上游。
- 接入会写 `~/.rivet/config.json`（自动备份），**不会**改动其它 provider，也
  **不会**擅自改默认模型 —— 只有 `setDefault: true` 才会。
- 「断线」类问题优先用 `workbuddy_refresh`，它同时刷新令牌与模型列表；只有
  令牌本身失效（桌面 App 退出登录）才需要用户去 App 里重新登录。
- 网关会被 `preTurn` 保活钩子自动拉回来，但**只有**在「用户接入过且没有显式停止」
  时才这么做。所以 `stop` 之后网关不会被神秘复活 —— 想恢复就得再接入一次。

## CLI 等价物

插件工具之外还有同源命令行，用于脚本化安装或会话外排查：

```bash
npx tianshu-workbuddy-connect install        # 接入
npx tianshu-workbuddy-connect status         # 状态
npx tianshu-workbuddy-connect doctor         # 诊断
npx tianshu-workbuddy-connect rotate-token   # 换发网关令牌
npx tianshu-workbuddy-connect uninstall      # 断开
```

CLI 与工具共享同一套编排代码，行为不会漂移。
