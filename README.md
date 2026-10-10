# Tianshu WorkBuddy Connect

把 **WorkBuddy 桌面 App** 内置的模型接入 [天枢 Tianshu Harness](https://tianshuharness.com/)。
复用 App 的登录态，**装上即可用、零配置、不需要 API Key**。

> 本项目由 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)
> （DeepSeek Harness 插件）改写而来，面向天枢的插件与 provider 契约重新适配。
> 原始协议调研、线上怪癖记录与免责声明同样适用于本项目。
> 遵循 MIT 许可，原始版权声明已在 [LICENSE](./LICENSE) 中保留。

国内版 **WorkBuddy** 与国际版 **WorkBuddy AI** 都支持：装哪个 App 就认哪个，
两个都装时国内版优先。

## 它做了什么（以及为什么这样做）

源插件是 DeepSeek Harness 的 cordis 插件，直接向宿主内核注册 LLM provider 适配器
（`cordis.patch.yml` + `inject` 宿主模块），所以 DSH 能一眼装上、模型选择器里直接
出现分组 —— **没有中间层**。

天枢的扩展契约不同：

- 天枢的插件是**工具插件**（导出 `tools` 数组），**不提供注册 provider 的接口**；
- 模型接入走 `config.json` 的 `provider.providers.<name>` 配置。

因此本插件必须多走一跳：

```
天枢 ──(标准 OpenAI 协议)──▶ 本地回环网关 127.0.0.1 ──(WorkBuddy 私有协议)──▶ WorkBuddy 上游
                                 │
                                 └─ 凭据来自桌面 App，只在本机流转
```

**为什么需要中间这一层**：WorkBuddy 上游不是任何一种干净的标准协议 —— 它强制流式、
拒绝 `role: "developer"`（返回 400/11128）、`tool_choice` 只接受字符串、认证头是私有约定。
网关把这套怪癖收敛在一处，天枢侧就只是一个普通的 OpenAI provider。

顺带得到两个性质：天枢**永远不需要知道 WorkBuddy 的令牌**；令牌只在
`127.0.0.1` 上流转，不出本机。

**用户视角的代价已经被抹平**：这一层网关由插件在**宿主加载它的时候**自动拉起
（早于宿主读 provider 配置），端口与配置里那个严格对齐；会话进程退出时自动释放。
你装完插件，新开一个会话，模型就在那里 —— 跟 DSH 上的体验一致。

## 安装

```bash
git clone https://github.com/NANYAOzesome/tianshu-workbuddy-connect.git
```

然后**两步**（顺序不能颠倒）。完整的图文步骤、排障与 FAQ 见 **[INSTALL.md](./INSTALL.md)**。

### 第 1 步：把插件装进天枢（桌面端）

天枢桌面端 → **设置 → 插件 → 从本地路径安装**，填入**本插件的绝对路径**。

> ⚠️ **最常见的失败点**：路径**不要带引号**。
>
> 从资源管理器复制路径时，有的工具会自动加引号。天枢看到 `"D:\...\tianshu-workbuddy-connect"`
> 时，`isAbsolute()` 返回 `false`（首字符是 `"`），于是它把整串当**相对路径**处理，
> 拼出一个不存在的路径，报错形如：
>
> ```
> Cannot resolve relative path "C:\...\package.json" (tried <天枢安装根>\"C:\...")
> ```
>
> **修法**：填进去的路径必须以盘符开头（`C:\...` / `D:\...`），首尾不能有引号。

安装器会把这个目录复制到天枢的插件目录：

```
<天枢数据根>/plugins/tianshu-workbuddy-connect/
```

其中 `<天枢数据根>` 由 `%APPDATA%\app.tianshu.desktop\launcher.json` 的
`rivetHome` 决定（**不是** `%LOCALAPPDATA%\.rivet` —— 那是 CLI 的默认值，
桌面端常常在别处）。

### 第 2 步：完成接入（通常不需要这一步）

插件在**被天枢加载的那一刻**就会自己完成接入 —— 起网关、读账号、写配置，你
不需要说任何话。新开一个会话，直接在模型列表里选 WorkBuddy 分组即可。

首次启动会多花一两秒（拉一次模型目录），之后每次启动都只是一次本地探活。

**插件不会在你没登录桌面 App 时擅自接入** —— 那种情况下它什么都不做（不会凭空
多一个常驻进程），你在 App 里登录后重开会话即可。

想手动触发、或想看接入细节的话，在对话里说：

```
接入 WorkBuddy
```

天枢会调用 `workbuddy_connect` 工具，完成：起本地网关 → 拉取模型目录 →
写入 provider 配置 → 对齐 Key 池。

看到 `✅ 已接入 WorkBuddy，共 N 个模型` 就成功了。

> 也可以用命令行完成同一步（需先设 `RIVET_HOME` 指向同一个数据根）：
>
> ```bash
> RIVET_HOME="D:\Tianshu" node <插件目录>/bin/cli.js install
> ```

#### 网关的寿命

网关**跟着会话进程走**，不是常驻服务：天枢开着的时候它就在（会话空闲一段时间后
自动下线，把端口让出来）；下次启动天枢，插件加载时会自动把它拉回来，**并且保证
端口与配置里那个一致**。

这一点很重要 —— 天枢的 `provider` 配置里存的是 `http://127.0.0.1:17871/v1` 这样
的**绝对 URL**，而 `config.json` 只在**宿主启动时**读一次。端口一旦漂走，后面怎么
改配置都不会被重新读取，表现就是「模型突然不响应」。插件的做法是：主机加载插件
（早于读配置）时就把网关起在**配置里那个端口**上，必要时把被旧实例占住的端口
抢回来。

### 第 3 步（可选）：设为默认 provider

```bash
RIVET_HOME="D:\Tianshu" node <插件目录>/bin/cli.js install --default
```

不加 `--default` 就不会改动你原有的默认模型，只在切换时用到 `workbuddy`。

### 前置条件

- 已安装并**登录** WorkBuddy 桌面 App（国内版或国际版，装哪个认哪个）
- 天枢桌面端已安装并能正常启动（自带 Node 运行时，**无需**额外装 Node.js）
- 对本机天枢数据根有写权限

### 装完没反应？先查这一条

天枢的 `config.json` 里有一个开关会**静默跳过**插件加载：

```json
{ "plugins": { "enabled": { "tianshu-workbuddy-connect": false } } }
```

值是 `false` 时，插件被完全跳过，**日志里不报错**，表现就是「工具不见了」。
删掉这条（或改成 `true`）即可 —— 键不存在时默认就是启用。

在同目录下执行一行检查：

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).plugins?.enabled)"
```

## 使用

接入之后，在天枢里：

```
/model deepseek-v4.1-flash     # 切换模型
/model list                    # 看所有可用模型
```

或启动时指定：

```bash
rivet --provider workbuddy --model glm-5.3
```

## 命令行

```bash
npx tianshu-workbuddy-connect install        # 接入：起网关、拉目录、写配置
npx tianshu-workbuddy-connect status         # 网关 / 账号 / 配置 / Key 池是否对齐
npx tianshu-workbuddy-connect models         # 列出可用模型
npx tianshu-workbuddy-connect refresh        # 刷新令牌并重新同步模型列表
npx tianshu-workbuddy-connect rotate-token   # 换发网关令牌，并把两处配置一起对齐
npx tianshu-workbuddy-connect doctor         # 逐环诊断 + 真实对话验证
npx tianshu-workbuddy-connect serve          # 前台运行网关（调试）
npx tianshu-workbuddy-connect stop           # 停止后台网关
npx tianshu-workbuddy-connect uninstall      # 断开接入
```

对 `status` / `models` / `doctor` 加 `--json` 可得到机器可读输出。
`install` / `refresh` 也可加 `--rotate-token`。

## 工作原理

### 凭据

#### 用的是「你自己的账号」，不是别人的

每位使用者接入的是**本机当前登录的那个 WorkBuddy 账号** —— 插件不含任何账号信息，
所有凭据路径都由运行环境实时解析：

| 平台 | 凭据位置 |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`、`%APPDATA%\...` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/` |
| Linux | `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` 下的同构路径 |

这三条分支互斥，各平台只用自己那一支；`homedir()` / `%LOCALAPPDATA%` 都是运行时
读取，**没有任何硬编码路径**。

推论：

- 张三装在你分享的插件上，读到的是**张三**的账号；
- 李四读到**李四**的；
- 若使用者没登录过 WorkBuddy 桌面 App，插件会如实报告「未登录」，而**不会**回落到
  任何其他人的账号。

同理，**网关令牌每个用户机器上都是独立的随机值**（`wb-` + 24 字节
`crypto.randomBytes`），不存在可被复用的共享密钥。

#### 凭据形态与解密

WorkBuddy 5.6+ 把 `accessToken` / `refreshToken` **加密**落盘，形如
`{"$wbEncrypted":1,"envelope":"<base64>"}`。密钥材料在同机可取：运行 App 自己的
Electron 二进制一次（`ELECTRON_RUN_AS_NODE=1`）调用其私有 `workbuddyStorage` 绑定，
拿到 `atRestSecretKey`，再 `sha256(secret, utf8)` 得到 AES-256-GCM 的 protector key。

本插件按以下顺序定位那枚二进制，找到即用：

1. 环境变量 `WORKBUDDY_ELECTRON_BIN`（国际版为 `WORKBUDDY_AI_ELECTRON_BIN`）
2. `WORKBUDDY_RESOURCES_PATH` / `WORKBUDDY_APP_PATH`（App 给自己子进程设的变量）
3. 插件自留缓存 `~/.rivet/workbuddy/electron-path.json`（上一次成功定位的结果）
4. 平台默认安装位置
5. `%LOCALAPPDATA%\workbuddy\logs\repair-helper-*.log` 里的 `installRoot=`
6. 常见安装根目录
7. Windows 卸载注册表的 `DisplayIcon` / `InstallLocation`

定位失败时 `doctor` 会明确告诉你该设置哪个变量。**明文凭据也可以**：老版本
WorkBuddy 直写明文 JSON，插件同样直接读。

> 第 7 步默认**关闭**：它会 `spawn reg.exe`，而 `reg.exe` 恰是安全策略与托管终端
> 最常拉黑的可执行文件 —— 一旦被拦，每次接入都会在宿主日志里留下一条「程序被策略
> 阻止」告警，而那条路径本来也几乎不可能成功（前面 6 步已经覆盖了实际安装位置）。
> 需要时用 `WORKBUDDY_ELECTRON_REGISTRY=1` 显式打开。

令牌只写插件自留副本（`~/.rivet/workbuddy/*.auth.json`，0600），从不回写桌面 App 的文件。

### 网关

固定端口 `127.0.0.1:17871`（可用 `WORKBUDDY_GATEWAY_PORT` 覆盖）。

固定端口是**有意的**：天枢配置里存的是绝对 URL，端口漂移会让配置直接失效。
被占用时顺延，并把实际端口写回配置。

网关以**分离式守护进程**运行，生命周期不绑定任何一个会话 —— 天枢的子代理与 worker
是独立进程，网关若只活在主会话里，它们一发请求就会打到已经消失的端口。

#### 保活：为什么是 preTurn hook 而不是启动钩子

天枢的插件契约只有 `tools` —— 加载器读完 `tools` 就返回，**从不 await** 插件导出的
`ready` / `activate`（见天枢 `plugin-loader.ts` 的 `loadOnePlugin`）。所以「启动时
预热」这条路口根本不存在。能挂上时机的唯一契约点是 manifest 的 `hooks`，本插件因此
声明了一个 `preTurn`：

```json
{ "event": "preTurn", "script": "hooks/preturn.js", "timeoutMs": 8000 }
```

天枢用 `spawnSync` **阻塞**执行它，所以它跑完时网关一定已经在线，本轮请求不会落空。
脚本自我限时 6s（留出余量）、正常路径完全不输出、任何异常都以退出码 0 结束 —— 保活
失败最多让模型请求报一次错，不能让整轮对话起不来。

判定逻辑抽成了纯函数 `planKeepalive`，可被单测穷举：

| 观察到的状态 | 动作 |
| --- | --- |
| 有「已显式停止」标记 | `idle` —— 尊重用户意图 |
| 状态文件与配置都给不出端口 | `idle` —— 从未接入，不该凭空多一个常驻进程 |
| 探活成功且版本一致 | `idle` |
| 探活成功但版本不一致 | `restart` —— 先停后拉，避免「改了代码却没生效」 |
| 探活失败 | `start` |

**端口取 `状态文件 ?? 天枢配置`**。只看状态文件是不够的：`stop`、清理数据目录、跨机器
迁移都会让它消失，而 `config.json` 里的绝对 URL 还在 —— 那时天枢的每个请求都会打在
空端口上，保活若只看状态文件就会判定「尚未接入」而什么都不做，故障于是永久化。
若恢复出来的端口与配置里写的不一致（原端口被别的实例占了），hook 会明确报出来。

#### 「已显式停止」标记

`stop` 会写下 `~/.rivet/workbuddy/gateway.disabled`。没有这个标记的话 `stop` 就是空
操作 —— 下一轮对话立刻把网关拉回来，用户失去「我说停就停」的能力。任何一次成功接入
（或守护进程写状态）都会撤销该标记。

#### 端口归属判定

Windows 上 `SO_REUSEADDR` 让「bind 失败即端口被占用」这种探测**完全失效**：已有监听者
时第二次 bind 也会成功，于是容易同时存在多个守护进程抢同一个端口。因此这里改用反向
探测（connect），并把端口上的东西分成四类：

| 判定 | 含义 | 处置 |
| --- | --- | --- |
| `free` | 没人监听 | 直接用 |
| `ours` | 有指纹且认当前令牌 | 复用 |
| `stale` | 有指纹但不认当前令牌（换过世代、状态文件丢过） | **绝不共用**，改用下一个端口并记进报告 |
| `foreign` | 端口被别的程序占用 | 改用下一个端口 |

「同门不同令牌却共用端口」正是实测里「配置看起来正常、请求却随机 401」的根因，
所以 `stale` 一律不将就。

端点：

| 路径 | 用途 |
| --- | --- |
| `GET /healthz` | 网关健康 + 账号 + 模型数 |
| `GET /v1/models` | OpenAI 形态模型列表 |
| `POST /v1/chat/completions` | 对话（流式） |
| `GET /_gw/models` | 完整模型配置（接入流程写配置用） |

入站加固：回环绑定本身**不构成**信任边界（本机任意进程、DNS-rebinding 页面都能
打到 127.0.0.1），因此每个请求还必须满足 —— Host 头指向回环、浏览器 Origin 是回环、
携带网关令牌（常量时间比较）。

`/healthz` 是唯一允许匿名的端点，且匿名时只回指纹（`marker` / `version` /
`anonymous: true`），**不含 pid、uid、模型清单** —— 否则「去 kill 某个 pid」就成了
本机任意进程都能触发的动作。鉴权失败时日志只记形态与指纹
（`presentedLen` / `presentedFp` / `expectedFp`），不记令牌原值。

### 网关令牌：持久化与轮换

令牌是**本机准入凭据**，不是上游凭据；它只对 `127.0.0.1` 上这一个端口有效，且该端口
本身还要求桌面 App 已登录。

它存在一个独立文件 `~/.rivet/workbuddy/gateway-token`（0600），而**不是**只放在
`gateway.json` 里。原因是这个令牌会被复制到天枢的配置层多处，而端口状态文件本身会被
`stop` 删掉 —— 一旦令牌只跟着状态文件走，`stop` + 接入就会换一个新令牌，历史配置随之
全部作废。独立存放让令牌在「停掉再接入」之间**保持稳定**。

需要换发时：

```bash
npx tianshu-workbuddy-connect rotate-token     # 等价于 install --rotate-token
```

它会**先停旧实例再换令牌，最后用原端口重拉**，并把 `config.json` 与 `provider-keys.json`
一起对齐到新令牌。顺序不能反：先换令牌的话，端口上那个还用着旧令牌的实例会变成
「同门不同代」，只能顺延到新端口，配置里的 URL 就跟着漂了 —— 而用户只是想换一把令牌。

### 天枢的 Key 权威在 `provider-keys.json`，不在 `config.json`

这是本次适配最容易踩空、后果又最难查的一处。天枢的配置层有一条明确的架构决定
（见其 `src/config/provider-keys-store.ts` 头注「A′：keys 移出 config.json」）：
**Key 池的权威来源是同级目录下的 `provider-keys.json`**。`loadConfig` 的行为是：

1. `migrateProviderToKeys()` —— `config.json` 没有 keys 时，用它的内联 `apiKey` 合成 `keys[0]`；
2. `injectProviderKeys()` —— **优先采用文件里的池**，并把池写回磁盘。

于是只要池落过一次盘，之后 `config.json` 里的 `apiKey` 就再也影响不了实际发出的凭据：
**配置页显示的是前者的值，客户端用的是后者的值，两者可以永远不同，而且都不报错。**

实测就是撞在这上面：插件每次接入换一个新令牌、只写 `config.json`，而池里留的是第一次的
令牌，表现是**稳定的 401**。日志取证的那一行是：

```
[gateway] auth rejected path=/v1/chat/completions authorization=present scheme=Bearer
          presentedLen=51 presentedFp=8393ebfb expectedLen=51 expectedFp=c9538cd0
```

因此本插件的做法是：

- 接入时**两处都写** —— `config.json` 的 `providers.workbuddy` 与键池里的 `workbuddy` 条目；
- 键池条目**刻意不写 `keyRef`**：`keyRef` 指向 `secrets.json`，一旦存在就会盖过内联
  `apiKey`，而网关令牌没有进 `secrets.json` 的理由。原条目若带着 `keyRef`，说明有别的
  机制在管这个 provider，此时插件**只报警不动手**（`blocked`）；
- 写盘同样是「只动自己那一条」：其它 provider 逐字节保留，覆盖前先备份，原子写；
- `doctor` 有一环专门回答「生效的到底是哪一个 Key」，`status` 会直接标出「不一致
  （权威来源：provider-keys.json）」。这是上述分歧唯一可见的地方。

### 配置写入

只动 `provider.providers.workbuddy` 这一条（以及键池里对应的那一条）：

- 其它 provider 与 `provider.default` 原样保留；
- 写入前自动备份 `config.json`；
- 原子写（临时文件 + rename），不会留下被截断的配置；
- 若原条目指向别处（例如你自建的另一个转接服务），回报里会**点名**，而不是默默覆盖。

`config.json` 与键池的改动分开汇报 —— 混成一个「配置已写入」会出现「其实只改了键池」
这种误导。

配置里的 `capabilities` 按**实测保守**填写。上游是否接受天枢的前缀缓存参数没有实测
结论，因此 `prefixCache: 'none'` —— 与其猜一个可能 400 的优化，不如先跑通再做性能取舍。

## 已知限制

- **不使用官方开放 API**：本插件驱动的是 WorkBuddy 客户端的私有接口。WorkBuddy 更新后
  可能需要随之调整。
- **国际版的模型目录**来自 App 界面接口，服务端按 User-Agent 分流，属私有实现；上游
  改动可能使其失效。届时降级为上次成功目录 → 内置兜底名册，并在状态里标明来源。
- **令牌刷新**走 `POST /v2/plugin/auth/token/refresh`。刷新失败且旧令牌尚未过期时会
  继续使用旧令牌（刷新端点不可达不该拖垮一个本来可用的会话）。
- **图片输入**按标准 OpenAI `image_url` 形态透传，未做形态转换。上游各模型对图片的
  支持以其 `supportsImages` 声明为准，已写入天枢的 `supportsVision`。
- 网络受限环境下守护进程无法派生时，网关会退化为**进程内模式**（会话内可用，
  不跨会话存活）。这种实例由当前进程持有监听，因此 `stop` 必须真的把它 close 掉
  —— 只清状态文件的话，事件循环会一直被吊着，进程永远退不出去
  （`process.once('exit')` 也救不了：exit 恰恰要等事件循环空下来才触发）。
- `preTurn` 保活每轮对话都要付一次 Node 启动（约 100ms；需要拉起网关时约 1.1s）。
  这是为「重启电脑后天枢仍可用」付的价钱。
- 在受管终端里运行天枢时，你仍可能看到一条 `reg.exe` 被安全策略阻止的告警 ——
  那条来自天枢内核自身的 `src/tools/resolved-env.ts`（启动时读注册表解析环境变量），
  与本插件无关。本插件的注册表发现默认关闭。

## 开发

```bash
npm run check                   # 语法检查 + 88 个单测，零依赖
node bin/cli.js doctor          # 对真实环境做全链路诊断
```

代码全部为 ESM + Node 内置模块，**零运行时依赖**。

单测里的临时目录清理走 `tests/helpers/tmp.js`：宿主的 safe-delete 垫片会接管
`fs.rmSync` 并把子项删除与父目录 `rmdir` 分开做，父目录的 `rmdir` 因而会偶发地跑在
子项消失之前，抛 `ENOTEMPTY`。那是环境噪声而不是产品缺陷，但会让套件随机变红、掩盖
真正的断言失败。因此清理分两层：交给 Node 内建 rimraf 重试（`maxRetries` /
`retryDelay`），仍失败就退让、由系统回收 `%TEMP%`。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用；
  请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果由使用者自行承担。
- 本项目与腾讯、WorkBuddy、天枢均无关联，未获其授权或认可。

## 许可证

[MIT](./LICENSE)
