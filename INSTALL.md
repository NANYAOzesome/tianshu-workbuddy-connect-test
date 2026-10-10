# 安装 / 重装指南

把 WorkBuddy 桌面 App 的模型接入天枢。全流程约 3 分钟，**不需要 API Key**。

本指南同样适用于**重装**（插件被删掉、模型被删掉之后恢复）。

---

## 0. 拿一个插件副本

需要一个包含 `package.json` 的目录，里面 `package.json` 的 `tianshu.name` 是
`tianshu-workbuddy-connect`。这个目录就是后面要填的「插件绝对路径」。

假设它放在：

```
C:\Users\你的名字\Downloads\tianshu-workbuddy-connect
```

（任何位置都行，路径里可以有中文和空格，但**不能有引号**。）

---

## 1. 装插件进天枢

打开**天枢桌面端** → **设置 → 插件** → **从本地路径安装**。

在输入框里填插件目录的绝对路径：

```
C:\Users\你的名字\Downloads\tianshu-workbuddy-connect
```

### ⚠️ 这一步最常见的坑

**路径首尾不能带引号。**

天枢拿到 `"D:\...\tianshu-workbuddy-connect"` 时，第一个字符是 `"`，
它内部的 `isAbsolute()` 判断为 `false`，于是把整串当**相对路径**去拼，
最后报一个看起来完全不通的错：

```
Cannot resolve relative path "C:\...\package.json"
(tried <天枢安装根>\"C:\...\package.json")
```

注意报错里那个 `<天枢安装根>\"C:\...` —— 引号被当成了路径的一部分。

> **怎么确认自己填对了**：填进去的第一眼看过去，第一个字符应该是盘符（如 `D`），
> 最后一个字符应该是插件目录名（如 `connect`）。

安装成功后，插件会被复制到：

```
<天枢数据根>\plugins\tianshu-workbuddy-connect\
```

### 不知道「天枢数据根」在哪？

它由这个文件决定：

```
%APPDATA%\app.tianshu.desktop\launcher.json
```

看里面的 `rivetHome` 字段。例如：

```json
{ "rivetHome": "D:\\Tianshu" }
```

就表示插件目录是 `D:\Tianshu\plugins\`。

> **别用 `%LOCALAPPDATA%\.rivet`** —— 那是天枢 CLI 的默认值，桌面端往往把数据
> 放在别处（比如上面这个例子）。用错了会看到「插件明明装了却找不到」。

---

## 2. 确认插件没被禁用

天枢的 `config.json` 里有个开关会**静默跳过**插件加载，不报任何错：

```json
{
  "plugins": {
    "enabled": {
      "tianshu-workbuddy-connect": false
    }
  }
}
```

值是 `false` 时，插件会被直接跳过 —— 现象是「工具列表里没有它」。

**修法**：把这一条删掉（键不存在 = 默认启用），或改成 `true`。

### 一行命令检查

在 `<天枢数据根>` 目录下执行：

```bash
node -e "const c=JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log(c.plugins?.enabled?.['tianshu-workbuddy-connect'])"
```

输出 `undefined` → 默认启用，没问题。
输出 `false` → 被禁用，需要删掉这条。

---

## 3. 完成接入

**新开一个天枢会话**（天枢在启动时读 provider 配置，老会话不会自动加载新插件）。

### 通常什么都不用做

插件在**被天枢加载的那一刻**就会自己完成接入 —— 起网关、读账号、写配置，全程
不需要你说任何话。新开一个会话，直接在模型列表里选 WorkBuddy 的模型即可。

首次启动会多花一两秒（拉一次模型目录），之后就只是一次本地探活（1ms 级）。

### 如果没自动接上

两种可能，都好判断：

**① 没登录桌面 App。** 插件刻意**不会**在没有可用账号时起网关 —— 装个插件不该
凭空多一个常驻进程。打开 WorkBuddy 桌面 App 登录后，重开一个会话即可。

**② 想手动触发/看细节。** 在对话里说一句：

```
接入 WorkBuddy
```

天枢会调用插件的 `workbuddy_connect` 工具，完成：

1. 启动本地回环网关（`127.0.0.1:17871`）
2. 从 WorkBuddy 账号拉取可用模型目录
3. 写入天枢 `provider.providers.workbuddy` 配置
4. 对齐 `provider-keys.json`（Key 的**权威来源**）

成功时会看到：

```
✅ 已接入 WorkBuddy，共 17 个模型
```

### 也可以用命令行接入

如果习惯终端（Windows 上用 Git Bash 或 PowerShell）：

```bash
RIVET_HOME="D:\Tianshu" node "C:\Users\你的名字\Downloads\tianshu-workbuddy-connect\bin\cli.js" install
```

> `RIVET_HOME` 必须显式设置成第 1 步查到的那个数据根，否则会写到错误的目录里。

### 网关的寿命

网关**跟着会话进程走**，不是常驻服务：

- 天枢开着的时候它就在（会话结束后空闲一段时间自动下线，把端口让出来）；
- 下次启动天枢，插件加载时会自动把它拉回来，**端口与配置里那个保持一致**。

所以不需要你关心它 —— 重启电脑、关掉天枢再打开，模型都照常可用。

---

## 4. 验证

### 一键诊断（推荐）

```bash
RIVET_HOME="D:\Tianshu" node "<插件目录>\bin\cli.js" doctor
```

应当看到 **9 项全绿**，其中最后一项「真实对话验证通过」说明模型真的能用。

### 手动真实对话

```bash
cd "<天枢安装目录>\rivet-runtime\cli"
RIVET_HOME="D:\Tianshu" node entry.js -p "只回答两个字：收到" --provider workbuddy --model deepseek-v4.1-flash
```

输出 `收到` 即成功。

> 输出的开头会有几行 `[secure-store] ...` / `better-sqlite3 ...` 的提示，
> 那是**天枢 CLI 自身**的告警（代码索引功能），与插件无关，可以忽略。

---

## 5. 开始使用

在天枢里：

```
/model list                  # 看所有可用模型
/model deepseek-v4.1-flash   # 切换模型
```

或者启动时直接指定：

```bash
rivet --provider workbuddy --model glm-5.3
```

想让 workbuddy 成为默认 provider，接入时加 `--default`：

```bash
RIVET_HOME="D:\Tianshu" node "<插件目录>\bin\cli.js" install --default
```

---

## 完全卸载

**顺序很重要** —— 必须先停网关，否则插件目录删不掉（见下面的 EPERM）。

### 第 1 步：停网关 + 断开接入

```bash
RIVET_HOME="D:\Tianshu" node "<插件目录>\bin\cli.js" uninstall
```

这会停掉网关并移除 provider 配置。想连插件自留的凭据副本一起清掉，加 `--clear-credentials`。

> 卸载**不会**影响 WorkBuddy 桌面 App 自身的登录状态。

### 第 2 步：删插件目录

```
<天枢数据根>\plugins\tianshu-workbuddy-connect\
```

---

### ⚠️ 报 `EPERM, Permission denied` 删不掉？

```
Failed to remove plugin: EPERM, Permission denied:
\\?\D:\...\plugins\tianshu-workbuddy-connect
```

**原因**：网关进程还在运行。Windows 上正在被进程加载的 `.js` 文件**不能被删除** ——
天枢每轮对话前会跑 `preTurn` 钩子自动拉起网关，所以你上次开天枢时它又被启动了。

**修法**：先停网关，再删。

```bash
# 1) 停网关（二选一）
RIVET_HOME="D:\Tianshu" node "<插件目录>\bin\cli.js" stop

# 若插件目录已部分删除、命令跑不了，直接杀进程：
#   先查 pid（Windows PowerShell）
#   Get-Content "<天枢数据根>\workbuddy\gateway.json"   # 看 pid 字段
#   再结束它
#   Stop-Process -Id <pid> -Force

# 2) 确认端口已释放（应无输出 / 连接被拒）
#   然后重试删除插件目录

# 3) 顺手清掉「已停止」标记，避免下次接入被误判
#   del "<天枢数据根>\workbuddy\gateway.disabled"   （存在才需要）
```

> 判断网关是否还在：`<天枢数据根>\workbuddy\gateway.json` 里记着 `pid`；
> 或看 `<天枢数据根>\workbuddy\gateway.log` 最后一行。

---

## 出问题时

按顺序查这三样，绝大多数问题都在这里：

| 现象 | 先查什么 |
|---|---|
| 安装报 `Cannot resolve relative path` | 路径带了引号 —— 去掉首尾引号（第 1 步） |
| 装完工具列表里没有它 | `plugins.enabled` 是否被设成 `false`（第 2 步） |
| 模型列表空 / 对话报 401 | 跑一遍 `doctor`，看是哪一环不过 |

### 保活机制（正常情况下无需关心）

天枢每轮对话前会跑一次插件的 `preTurn` 钩子，检查网关是否在线；不在就自动拉起来。
所以**重启电脑之后不需要重新接入** —— 第一轮对话会自动恢复。

想手动停掉网关：`... cli.js stop`。
想彻底断开：`... cli.js uninstall`。

### 日志在哪

```
<天枢数据根>\workbuddy\gateway.log
```

网关每次启动/停止都会记一行。连续看到大量 `listening` 而没有 `shutting down`，
说明网关被外部反复杀死，把这段日志连同 `doctor` 的输出一起反馈。

---

## 常见问题

**Q：需要额外装 Node.js 吗？**
不需要。天枢桌面端自带运行时。只有想用命令行工具时才需要系统里有 Node ≥ 20.11。

**Q：需要 WorkBuddy 的 API Key 吗？**
不需要。插件复用桌面 App 的登录态，凭据只在本机 `127.0.0.1` 上流转，不出网卡。

**Q：国内版和国际版都能用吗？**
都能。装哪个 App 就认哪个；两个都装时国内版优先。

**Q：接入后原来的默认模型会变吗？**
不会，除非显式加 `--default`。

**Q：为什么 `config.json` 里的 `apiKey` 是空的？**
这是**正常的**。天枢的 `saveConfig` 按设计不往 `config.json` 写明文密钥，
凭据由 `provider-keys.json` 供给 —— 后者才是权威来源。`doctor` 会验证两者一致。
