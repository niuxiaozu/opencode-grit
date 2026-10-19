# OpenCode 工作环境复现手册（新机器对齐版）

> 生成时间：2026-10-19（本机 = 源机器）
> 目标：把这台机器上整套 OpenCode 工作环境，在另一台**只装了 OpenCode V2 + OpenChamber** 的机器上完整复现。
> 维护位置：本文件随 grit 仓库走（`docs/ENV-REPLICATION.md`），也在仓库里一起提交；另一台机器 `git clone` 后直接读它。
> 本文件是**快照 + 操作手册**：附录里内嵌了所有本机自研/本地文件的全文，所以只靠这一个文件 + 几个公开仓库就能重建整套环境。

---

## 0. 怎么用这份文档

| 你的情况 | 看哪几节 |
|---|---|
| 全新机器，只有 OpenCode V2 + OpenChamber | §3 从头按顺序做，附录 A–D 提供全部要粘贴的文本 |
| 想搞懂这套环境为什么这么设计 | §2 |
| 本机升级/维护、拉最新代码 | §5，配合 §7 附录 G 的坑 |
| 想知道有哪些密钥、哪些东西不能跨机复制 | §6 + §3.9 |
| 出问题了 | 附录 G（故障排查） |

三条硬事实先记住：

1. **OpenCode 的一切都挂在 `~/.config/opencode`**（Windows 是 `C:\Users\<你>\.config\opencode`）。新机器把这个目录搭出来，环境就复现了大半。
2. **插件代码来自 git 仓库**，装法是把仓库里的文件复制进 `~/.config/opencode/plugins/`（grit / worktime 都自带安装脚本）。本机自研的 3 个小插件没有仓库，全文在附录 B，直接粘贴即可。
3. **密钥不能跨机复制**（DPAPI 加密绑定当前 Windows 用户），新机器必须用 `sec set` 逐条重建；清单见 §3.9。

---

## 1. 环境总览

### 1.1 组件清单

| 组件 | 是什么 | 来源 | 本机位置（源机器） | 新机器怎么来 |
|---|---|---|---|---|
| OpenCode CLI V2 | 整个运行时/服务/TUI | npm 全局 `@opencode/cli` | `C:\Users\Administrator\AppData\Roaming\npm` | `npm i -g @opencode/cli` |
| OpenChamber | OpenCode 的图形前端（可选） | 你已有的安装 | 本机未装（新机器已装） | 用你现有的装法；它读同一份 `~/.config/opencode` |
| **grit** | 五代理多代理套件（build/explore/general/sage/browse）+ ULW 持续工作模式 + profile 分档 | GitHub `niuxiaozu/opencode-grit`（分支 `opencode-v2`） | 仓库 `D:\workspace\selfProjects\agent-worktemp\grit`；部署 `~/.config/opencode/{plugins/grit.ts, plugins/grit-tui/tui.ts, grit/, scripts/, commands/}` | `git clone -b opencode-v2` → `npm i` → `node scripts/install.mjs` |
| **opencode-worktime** | 定时暂停/恢复会话、定时发消息；模型工具 `worktime_*` | GitHub `niuxiaozu/opencode-worktime`（分支 `opencode-v2`） | 仓库 `D:\workspace\selfProjects\agent-worktemp\opencode-worktime`；部署 `~/.config/opencode/plugins/opencode-worktime.ts` + `~/.worktime/worktime.json` | `git clone -b opencode-v2` → `powershell -File scripts/install.ps1` |
| **secret-redact** | 把金库里的密钥值从每次请求里抹掉（防泄漏给模型/日志） | 本机自研（无仓库） | `~/.config/opencode/plugins/secret-redact.ts` | 粘贴附录 B-1 |
| **secret-ui** | TUI 里敲 `/secret <名字>` 安全录入密钥；给模型一个 `secret_list` 工具（只列名字） | 本机自研（无仓库） | `~/.config/opencode/plugins/secret-ui/{index.ts,tui.ts}` | 粘贴附录 B-2、B-3 |
| **grit-tui** | TUI 里 profile 切换的提示/toast | grit 仓库 `plugin/tui.ts` | 部署到 `~/.config/opencode/plugins/grit-tui/tui.ts` | grit 的 install 脚本自动同步 |
| **browser-skill** | 用 `bsk` 驱动你已登录的 Chromium（研究/采集/UI 测试） | 本地目录 `browser-skill-setup`（**不是 git 仓库**，含 `bsk.exe` 12MB + 浏览器扩展） | 目录 `D:\workspace\selfProjects\agent-worktemp\browser-skill-setup`；CLI shim `AppData\Roaming\npm\bsk.exe`；技能文件 `~/.agents/skills/browser-skill/SKILL.md` | 拷整个目录 → 把 `bsk\` 加进 PATH → Chromium 里加载 `extension\` |
| **openscad-cad** | OpenSCAD 参数化 3D 建模技能 | 本机自研技能（无仓库） | `~/.config/opencode/skills/openscad-cad/SKILL.md` | 粘贴附录 D-2 + 安装 OpenSCAD |
| **opencode-mem** | 长期记忆（向量库 + 自动抓取 + 每轮注入） | npm 插件 `opencode-mem`（opencode.json 的 `plugins` 项） | 配置 `~/.config/opencode/opencode-mem.jsonc`；数据 `~/.opencode-mem/`（`data/` 是向量库） | 见 §3.8（插件安装 + 配置 + 数据可选迁移） |
| **sec 金库** | 密钥管家：DPAPI 加密，值只在子进程环境里出现 | 本机自研（无仓库） | 脚本 `C:\Users\Administrator\bin\sec.ps1`、`sec.cmd`；数据 `~/.secrets/{vault.json,access.log}` | 粘贴附录 C + 重建密钥 |
| opencode-tui-tunnel（可选） | 把 OpenCode TUI 通过浏览器远程用（tmux 后端 + 通知插件） | npm 全局 `@igovet/opencode-tui-tunnel` | 配置 `~/.config/opencode-tui-tunnel/`；另有旧插件 `~/.opencode/plugins/opencode2-tui-notify.js` | 可选，见 §3.10 |
| Caddy / psmux / cred（可选） | 反向代理（Basic Auth）+ tmux 类多路复用 + 凭据工具 | 本机 `tools\` 目录 | `C:\Users\Administrator\tools\{caddy,psmux,cred}` | 可选，见 §3.10 |
| frx-director MCP（可选，已禁用） | Firefox 反检测浏览器控制 MCP | 本机 `tools\frx-director-mcp` | opencode.json 里配置但 `disabled: true` | 可选，见 §3.10 |

### 1.2 目录地图（源机器）

```text
C:\Users\Administrator\
├─ .config\opencode\                 ← 环境核心（≈130MB，主要是 node_modules）
│  ├─ AGENTS.md                      总是生效的规则：成本纪律 + 文风 + 密钥红线
│  ├─ opencode.json                  主配置：shell、权限、MCP、plugins、5 条 agents 记录
│  ├─ opencode-mem.jsonc             记忆插件配置
│  ├─ package.json / package-lock.json  plugins/*.ts 的运行时依赖（@opencode/plugin）
│  ├─ service.json                   本机服务口令（机器本地；别外传，见 §6）
│  ├─ plugins\
│  │  ├─ grit.ts                     ← 由 grit 仓库安装脚本同步（别手改这里）
│  │  ├─ grit-tui\tui.ts             ← 同上
│  │  ├─ opencode-worktime.ts        ← 由 worktime 安装脚本同步
│  │  ├─ secret-redact.ts            自研（附录 B-1）
│  │  └─ secret-ui\{index.ts,tui.ts} 自研（附录 B-2/B-3）
│  ├─ commands\{ulw.md,ulw-exit.md,handoff.md,profile.md}   ← grit 安装脚本同步
│  ├─ skills\openscad-cad\SKILL.md   自研技能（附录 D-2）
│  ├─ scripts\{install.mjs,grit.mjs,materialize-core.ts}    ← grit 安装脚本同步
│  ├─ agents\、state\、log\           运行时产生（agents 目录已空，记录在 opencode.json）
│  └─ grit\                          grit 数据根：contracts\ profiles\ variants\ agents\ state\ log\
├─ .agents\skills\browser-skill\SKILL.md   技能（browser-skill）
├─ .opencode-mem\                    记忆数据（data\ 向量库；日志）
├─ .secrets\{vault.json,access.log}  金库（DPAPI 加密，机器绑定）
├─ .worktime\worktime.json           worktime 时间表
├─ .bsk\                             browser-skill 后台服务状态/日志
├─ memory\                           手写记忆便签（如 2026-09-30.md）
├─ bin\{sec.ps1,sec.cmd,_canary.ps1} 金库脚本 + 自检
├─ tools\{caddy,psmux,cred,firefox-reverse,frx-director-mcp}  可选配件
├─ .config\opencode-tui-tunnel\      可选：远程 TUI（Caddyfile、config.json、start-all.ps1…）
└─ AppData\Roaming\npm\              全局 CLI shim：opencode / bsk / grit
```

仓库（建议放同一个工作目录，路径可自定）：

```text
D:\workspace\selfProjects\agent-worktemp\
├─ grit\                  → github.com/niuxiaozu/opencode-grit      分支 opencode-v2
├─ opencode-worktime\     → github.com/niuxiaozu/opencode-worktime  分支 opencode-v2
└─ browser-skill-setup\   本地目录（无 git）：bsk\bsk.exe + extension\ + package.json
```

### 1.3 版本与关键事实

| 项 | 本机取值 |
|---|---|
| OS / Shell | Windows 10/11；PowerShell 7（`C:\Program Files\PowerShell\7\pwsh.exe`） |
| Node / npm | v24.14.0 / 11.9.0 |
| git | 2.39.1.windows.1（credential.helper = manager） |
| OpenCode CLI | **v2.0.25**（npm 全局 `@opencode/cli`） |
| 插件运行时依赖 | `@opencode/plugin ^2.0.20`（装在 `~/.config/opencode/node_modules`） |
| 已登录的模型 provider（`opencode auth list`） | OpenCode Go / DeepSeek / Zhipu AI Coding Plan（三个都是 stored） |
| grit 当前档（`grit/profiles/active`） | `opencode-go`：build/explore/general/browse = `opencode-go/deepseek-v4.1-flash`，sage = `opencode-go/glm-5.3`（plan 归原生，不映射） |
| bsk | 0.2.0 |
| OpenSCAD | **本机未安装**（技能里写的是 `C:\Program Files\OpenSCAD\openscad.exe`，新机器要装） |
| 记忆插件 | `opencode-mem`（embedding 用 `Xenova/nomic-embed-text-v1`，本地推理） |
| 工作目录 | 会话默认在 `C:\Users\Administrator`；外部目录访问已放行 |

---

## 2. 设计理念（为什么这么搭）

### 2.1 一句话

用 OpenCode V2 原生的能力（插件、agents、commands、skills、MCP）**轻量地**搭出一支"五人小队"：一个编排者（build）在便宜模型上干活，遇到难判断才升级到贵模型（sage），需要"只讨论计划"时手动切到 OpenCode 原生 plan 模式；搜索靠 explore 压缩摘要，动手靠 general，上网靠 browse，云端不要一键全自动、而是**用户说一句干完一整个阶段**。

### 2.2 ULW 持续工作模式（这套环境的核心体验）

**它就是"模型可以自主进入/退出的一种工作状态"**，不是外挂的严格模式：

- 用户敲 `/ulw` 只是**引导**：那条命令文本带一个授权标识，等于"我允许你进入这个状态"。
- 进入决策**在模型手里**：模型判断这是要一口气干完的活，就调用 `ulw_enter` 工具（插件校验上一句用户消息里有没有那个授权标识，防"模型自己乱进"）。
- 进入后，插件把**纪律契约作为一条真实消息**发进会话（落库、以后每轮都看得到），并开始"一轮结束就推一把"的续跑，直到模型自己判断干完、调用 `ulw_exit`；用户随时可以 `/ulw-exit` 一刀切断（不用等模型配合）。
- 契约内容（场景契约 / 双证据 / 审查门 / 手动 QA / 零容忍 / 完成判定 / 交接阶梯）在 `grit/contracts/ulw.md`，可随时改文件、不用重启。
- 上下文压缩完成后，插件会自动把契约重发一次（`session.compaction.ended` 事件），并有一道 60 秒节流的兜底。
- 护栏：2 秒倒计时让人有机会插话、指数退避、连败暂停、原地打转停止、工具死循环停止、推送预算上限、上下文占比过高不推。
- 不依赖 todo 工具（V2 没有），进度靠模型自己维护。

### 2.3 五代理与分档（+ 原生 plan）

| 代理 | 干什么 | 本机档位（opencode-go） |
|---|---|---|
| build | 编排：自己干 / 派活 / 升级 / 分档 | deepseek-v4.1-flash（便宜档） |
| explore | 只读搜索，回摘要 + 文件行号锚点 | deepseek-v4.1-flash |
| sage | 顶级模型席位（弱模型干不了的那些）：判断力、世界知识、**方案指定**——**动手前**定方案，**总是交完整方案**（决策完备模板）；**对用户不可见**（`mode: subagent` + `hidden: true`，不进 Tab/@ 列表，也不进模型的子代理目录；build 按名字调用，已实测可用）；不做事后复审 | glm-5.3（贵档） |
| general | 多步执行 | deepseek-v4.1-flash |
| browse | 真实浏览器研究/采集 | deepseek-v4.1-flash |

分档靠 `profiles/*.json`（改 `agents` 记录里的 model 与权限），`opencode-go` 是日常档；切档用 `/profile <名字>`（会话内）或终端 `grit profile <名字>`，v2 监视配置目录，约 3 秒热生效（当前会话已选的模型不变）。

**子代理描述只写"能干什么"**：`agents/index.json` 里的 `description` 只陈述能力，不写"什么时候用我"——"什么时候用谁"只写在 build 的路由表（`contracts/discipline/build.md` 的 `<routing_table>`）与 `<sage_policy>` 里，避免子代理自我推销导致乱派活。`plan` 是 OpenCode 原生只读模式（`opencode.plan`，自带 `edit:deny` 权限与 Plan-mode 提醒）：grit 不物化它的记录、不注入纪律，用户手动切到 plan 就用原生那套。去掉 plan 之后，"需要顶级模型指定方案"这活由 `sage` 承担：它的纪律文件里合并了原 plan 的成熟度分类与计划标准，输出契约是"**总是**交完整方案"；它是**动手前**定方案的席位，不做事后复审（复审/验证归建它的人）。

### 2.4 规则与优先级

- `AGENTS.md`（用户自己的）**权威最高**，跟环境强相关：成本纪律（一轮消息里把已知的工具调用全并行发出去）、面向用户的文风、密钥红线。
- 插件的角色纪律（`grit/contracts/discipline/*.md`）保持**通用、可分发**，只讲这个角色该怎么干。
- 非 ULW 的普通工作**不加强制完成规范**——"OpenCode 原本什么样就什么样"。

### 2.5 记忆与密钥

- **记忆**：`opencode-mem` 插件本地跑 embedding，把历史会话/偏好存成向量库，每轮自动注入少量相关记忆；手动可用 `memory` 工具（add/search/profile…）。
- **密钥**：全部进 `sec` 金库（DPAPI 加密）。明文只允许出现在最终命令的子进程环境里；模型看到的名字靠 `secret_list`，值由 `secret-redact` 插件在每次请求前抹掉。

### 2.6 错峰与远程（可选）

- `opencode-worktime` 可以按时间表"暂停/恢复会话"或定时发消息（例如凌晨自动暂停、早上恢复），用来避开模型 API 高峰。
- `opencode-tui-tunnel` + Caddy 可以把 TUI 通过浏览器远程用（tmux 后端、手机也能开）。

### 2.7 v2 代理协作事实（按官方文档核对，2026-10-19）

复现这台机器时会用到，省得再翻文档：

- **两种代理**：`primary`（主对话，Tab 切换）与 `subagent`（"Runs only in a child session through the `subagent` tool"，也可用户 `@` 点名）。**新自定义代理的 `mode` 默认 `primary`**。
- **子代理跑在全新上下文的子会话里**（前台或后台）；父代理的 `subagent` 权限决定它能启动谁；**子代理用自己配置的权限**（不继承父的）；子代理没配 `model` 时**继承父会话的 model**。
- **子会话可导航**（TUI 键位）：`session_child_first`（Leader+Down）进第一个子会话、`session_child_cycle`(Right) / `_reverse`(Left) 在子会话间切、`session_parent`(Up) 回父会话。
- **兄弟互调默认禁止**：`experimental.subagent_depth` 默认 **1**（子代理不能再派子代理），超了报 `Subagent depth limit reached (1). Increase "subagent_depth" to allow nested subagents.`（v1 的顶层 `subagent_depth` 在 v2 被忽略并告警）。
- **`hidden: true`**：从常规列表、交互发现、**以及"模型可见的子代理目录"（Task 工具描述里那份 Available subagents）**里移除；**但不拦"按名字调用"**——本机实测 `subagent(agent="sage")` 正常返回。只在 `mode: subagent` 时有意义。本机 `sage` 就用的这招（用户列表里看不到，build 靠纪律点名调它）。
- **权限 action 名**：`task → subagent`、`bash → shell`、`write/patch → edit`；v2 用有序 `permissions` 数组（后匹配者胜）。
- **v2 没有内置 `scout`**：外部仓库/依赖研究要么用 `explore`（本机就是给它放行 `clone_repo` 补这个位），要么用 `references` 配置。
- **v2 不跑 LSP**：接受 `lsp` 配置但不启动语言服务器、不暴露 LSP 工具、不产诊断 → 完成标准要写"项目自己的 lint/typecheck/build/test"（本机 `general.md` 已按此改）。
- 其它：`external_directory` 默认放行（v1 会问）；终端客户端配置是 `~/.config/opencode/cli.json`（不再是 `tui.json`）；命令委派 `subtask → subagent`，且委派出去的命令在后台跑、结果报回父会话。

---

## 3. 新机器复现步骤（按顺序照做）

### 3.0 前置软件

必装：

- **Windows 10/11**（这套东西都按 Windows 路径写；Linux 需自己改路径）
- **PowerShell 7**（很多脚本按 `C:\Program Files\PowerShell\7\pwsh.exe` 写）
- **Node.js 24.x + npm**（`winget install OpenJS.NodeJS.LTS` 或 nvm-windows）
- **git**
- **OpenCode CLI V2**（见 3.1）
- **OpenChamber**（你已有）

可选：

- **OpenSCAD**（用 openscad-cad 技能时）：`winget install OpenSCAD.OpenSCAD`，确认 `C:\Program Files\OpenSCAD\openscad.exe`
- **Python 3.12**（个别脚本/工具用）
- **Chromium 系浏览器**（browser-skill 用）

### 3.1 安装 OpenCode V2 并登录模型

```powershell
npm install -g @opencode/cli
opencode --version          # 期望 v2.x（本机 v2.0.25）

opencode auth login         # 逐个登录：OpenCode Go / DeepSeek / Zhipu AI Coding Plan
opencode auth list          # 期望三行都是 stored
```

> 需要哪些 provider，取决于你要用哪些档：`opencode-go` 档要 OpenCode Go（deepseek/glm 都在这个 provider 下）；`strict`/`default` 档用 Zhipu AI Coding Plan；记忆插件的自动抓取用 DeepSeek。
> API key 走 `opencode auth login` 存进 OpenCode 自己的凭据库即可（不要写进任何仓库文件）。

### 3.2 克隆仓库

```powershell
mkdir D:\workspace\selfProjects\agent-worktemp        # 或你喜欢的任何目录
cd D:\workspace\selfProjects\agent-worktemp

git clone -b opencode-v2 https://github.com/niuxiaozu/opencode-grit.git
git clone -b opencode-v2 https://github.com/niuxiaozu/opencode-worktime.git
```

`browser-skill-setup` 不是 git 仓库，直接**拷目录**（或者在你用 browser-skill 时再拷）：

```text
browser-skill-setup\
├─ bsk\bsk.exe            独立二进制，加进 PATH 即可用
├─ extension\             Chromium 解压版扩展（chrome://extensions → 开发者模式 → 加载已解压）
└─ package.json / package-lock.json
```

### 3.3 搭 `~/.config/opencode` 骨架

```powershell
$cfg = "$env:USERPROFILE\.config\opencode"
mkdir $cfg, "$cfg\plugins", "$cfg\commands", "$cfg\skills", "$cfg\agents", "$cfg\state" -Force
```

把附录 A 的四个文件写到 `$cfg` 下：

| 文件 | 附录 | 说明 |
|---|---|---|
| `AGENTS.md` | A-1 | 规则（成本纪律/文风/密钥红线） |
| `opencode.json` | A-2 | 主配置（权限、plugins、agents 记录；`agents` 那 5 条稍后由 grit 安装脚本重写） |
| `opencode-mem.jsonc` | A-3 | 记忆配置 |
| `package.json` | A-4 | 插件运行时依赖宿主 |

然后装依赖：

```powershell
cd $cfg
npm install            # 装 @opencode/plugin（plugins/*.ts 的运行时）
```

### 3.4 安装 grit（多代理套件）

```powershell
cd D:\workspace\selfProjects\agent-worktemp\grit
npm install
node scripts/install.mjs
```

这个脚本会：把 `plugin/grit.ts`、`plugin/tui.ts`、`contracts/`、`profiles/`、`variants/`、`agents/index.json`、`scripts/`、`commands/` 同步进 `~/.config/opencode`（并清理陈旧残留），然后按 `grit/profiles/active` 把 **5 条 agents 记录**写进 `opencode.json`（只写 mode/description/model/permissions，绝不写 system）。

验证：

```powershell
cd D:\workspace\selfProjects\agent-worktemp\grit
npx tsc --noEmit          # 期望无输出
node harness/smoke.ts     # 期望 "NNN passed, 0 failed"
(Get-Content "$env:USERPROFILE\.config\opencode\grit\profiles\active" -Raw).Trim()
# 切档（可选）：
node scripts/grit.mjs profile opencode-go
```

改档 = 改 `grit/profiles/<名字>.json` 里的 `model` / `permissions` / `features`，切档后约 3 秒热生效。

### 3.5 安装 opencode-worktime（定时器）

```powershell
cd D:\workspace\selfProjects\agent-worktemp\opencode-worktime
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

装完：插件在 `$cfg\plugins\opencode-worktime.ts`，数据在 `~\.worktime\worktime.json`（附录 A-5 是本机的初始内容）。用法见 §4。

### 3.6 落地两个自研小插件（无仓库，粘贴）

| 文件 | 附录 | 作用 |
|---|---|---|
| `$cfg\plugins\secret-redact.ts` | B-1 | 把密钥值从每次请求里抹掉 |
| `$cfg\plugins\secret-ui\index.ts` | B-2 | `secret_list` 工具（只列名字，不取值） |
| `$cfg\plugins\secret-ui\tui.ts` | B-3 | TUI 命令 `/secret <名字>`（安全录入）、`/secrets`（列表） |

注意 B-2/B-3 里写死了 `C:\Users\Administrator\bin\sec.ps1`——新机器的用户名不同就改这一行。

### 3.7 技能（browser-skill / openscad-cad）

**browser-skill**：

```powershell
# 1) 拷目录（见 3.2），把二进制加进 PATH（会话级示例）
$env:Path = "D:\workspace\selfProjects\agent-worktemp\browser-skill-setup\bsk;$env:Path"
bsk --version              # 期望 0.2.0（要写进用户 PATH 就永久加一次）

# 2) 技能文件
mkdir "$env:USERPROFILE\.agents\skills\browser-skill" -Force
# 把附录 D-1 的内容写到该目录的 SKILL.md

# 3) Chromium 里加载扩展：chrome://extensions → 开发者模式 → 加载已解压 → 选 extension\ 目录
```

**openscad-cad**：

```powershell
winget install OpenSCAD.OpenSCAD
mkdir "$env:USERPROFILE\.config\opencode\skills\openscad-cad" -Force
# 把附录 D-2 写到 SKILL.md
& "C:\Program Files\OpenSCAD\openscad.exe" --version
```

### 3.8 记忆（opencode-mem）

```powershell
# 1) 插件本体（OpenCode 会在首次加载时把它装进缓存；也可预装）
#    opencode.json 里已有 "plugins": ["opencode-mem"]
# 2) 配置：附录 A-3 写到 $cfg\opencode-mem.jsonc
# 3) 数据（可选，想带走历史记忆就拷）：~\.opencode-mem\  （本机 data\ 约 149MB）
```

已知问题与修复（本机就中招）：记忆的本地 embedding 依赖 `@huggingface/transformers`，缺了会报
`Cannot find module '@huggingface/transformers'`（表现：`memory add` 失败、启动时装 shim 失败）。修法：

```powershell
cd "$env:USERPROFILE\.cache\opencode\npm\opencode-mem@latest\<版本目录>\node_modules\opencode-mem"
npm install @huggingface/transformers
```

### 3.9 密钥金库（sec）

密钥**不能跨机复制**（DPAPI 绑定 Windows 用户）。新机器：

```powershell
# 1) 写脚本：附录 C-1 → C:\Users\<你>\bin\sec.ps1 ；附录 C-2 → _canary.ps1（自检用）
# 2) 保证 bin 在 PATH（本机 PATH 见 §3.11）
# 3) 逐条重建（交互输入值，别用命令行带值）
sec set caddy.basic      # Caddy Basic Auth
sec set router.admin     # 路由器管理口令（小米 BE6500）
sec set canary.value     # 金库自检用

# 4) 日常用法
sec list                                         # 只看名字/备注
sec exec --env PWD=router.admin -- <你的命令>      # 值只进子进程环境
```

自检：`sec exec --env CANARY=canary.value -- pwsh -File C:\Users\<你>\bin\_canary.ps1`（只会打印值长度，不回显值）。

### 3.10 可选项

- **远程 TUI（opencode-tui-tunnel）**：`npm i -g @igovet/opencode-tui-tunnel`；配置目录 `~\.config\opencode-tui-tunnel`（`config.json`、`Caddyfile`、`start-all.ps1`）。依赖 Caddy（`~\tools\caddy\caddy.exe`）和 psmux（`~\tools\psmux`）。本机配置监听 `127.0.0.1:4096`，用 tmux 后端。注意：该目录的 `config.json` 里有 push 用的 VAPID 私钥——**别外传**，新机器让它重新生成。
- **MCP（frx-director）**：`opencode.json` 里已配置但 `disabled: true`；要用再装 `~\tools\frx-director-mcp` 并把 `disabled` 改成 `false`。
- **cred / firefox-reverse / psmux**：本机 `~\tools\` 下的自用工具，按需拷。
- **旧插件残留**：`~\.opencode\plugins\opencode2-tui-notify.js`（+ `opencode2-tui-config.json`）是早期 V2 实验件，**没被 opencode.json 加载**；不需要可以不管。

### 3.11 PATH / 环境变量 / shim

用户 PATH（本机，作为参考；新机器照抄需要的）：

```text
C:\Users\<你>\AppData\Roaming\npm      ← opencode / bsk / grit 三个 shim
C:\Users\<你>\bin                      ← sec.cmd / sec.ps1
C:\Users\<你>\tools\psmux
C:\Users\<你>\tools\cred
C:\Users\<你>\AppData\Local\pnpm       ← pnpm 全局
```

另外用户环境变量：`TMP/TEMP`、`NO_PROXY=127.0.0.1,localhost`（有代理时必须留）。

`grit` 命令 shim（`AppData\Roaming\npm\grit.cmd`，由 grit 安装脚本生成，指向配置目录里的脚本）：

```text
@echo off
node "C:\Users\Administrator\.config\opencode\scripts\grit.mjs" %*
```

### 3.12 验收清单

| # | 命令 | 期望 |
|---|---|---|
| 1 | `opencode --version` | `v2.x` |
| 2 | `opencode auth list` | 需要的 provider 都是 stored |
| 3 | `Get-ChildItem $cfg\grit` | agents/ contracts/ profiles/ variants/ state/ log/ |
| 4 | `(Get-Content $cfg\grit\profiles\active).Trim()` | `opencode-go`（或你要的档） |
| 5 | `npx tsc --noEmit`（grit 仓库） | 无输出 |
| 6 | `node harness/smoke.ts`（grit 仓库） | `NNN passed, 0 failed` |
| 7 | 新会话里敲 `/ulw 冒烟测试` | 模型调用 `ulw_enter`，会话里出现一条带契约的提醒消息，随后被自动续跑推着干活 |
| 8 | 新会话里敲 `/ulw-exit` | 立刻退出（不用等模型），下一轮出现"已退出"提醒 |
| 9 | `/profile` | 列出可用档，当前档带 `*` |
| 10 | `/worktime` | 显示时间表状态 |
| 11 | `/secrets` | 列出刚重建的密钥名 |
| 12 | `bsk --version` → `bsk doctor` | 0.2.0；doctor 无致命项 |
| 13 | 浏览器里再点开一次 Agent Window 流程 | 扩展已连接（详见附录 D-1） |

---

## 4. 日常使用速查

### 4.1 命令

| 命令 | 作用 |
|---|---|
| `/ulw [补充说明]` | 引导模型进入持续工作模式（模型据此调 `ulw_enter`，契约成为一条真消息，之后自动续跑） |
| `/ulw-exit` | 立刻退出（插件确定性执行，不依赖模型配合） |
| `/handoff` | 把当前会话交接给一个新会话（注入交接摘要；也由契约里的交接阶梯自动触发） |
| `/profile [名字]` | 列出/切换档（改 model 与权限，约 3 秒热生效；当前会话模型不变） |
| `/worktime …`、`/wt …` | `pause`/`resume`/`at HH:MM [消息]`/`sleep HH:MM`/`wake HH:MM`/`add`/`once`/`rm <id>`/`clear`/`reload`/`status` |
| `/secret <名字>` | 在 TUI 里安全录入/覆盖一个密钥（值不出本机、不进对话） |
| `/secrets` | 列出密钥名 |

模型侧工具：`ulw_enter`、`ulw_exit`、`handoff`、`profile`、`context_usage`（上下文占用）、`system_time`、`clone_repo`、`memory`、`secret_list`、`worktime_*`。

### 4.2 三种典型玩法

```text
# 一口气干完一个阶段
/ulw 把 X 功能做完并自测通过
（模型进入 → 连续干活 → 自己判断完成后 ulw_exit；你随时可以插话，插件会先按住再恢复）

# 只想要"能派活的小队"
直接正常对话；遇到要搜的用 @explore，难判断的它自己会找 sage

# 省钱的错峰
/worktime sleep 23:30      # 每天 23:30 自动暂停（连 agent 也停）
/worktime wake 08:00       # 每天 08:00 自动恢复
```

### 4.3 改提示词改哪里

| 想改什么 | 改哪 |
|---|---|
| 角色纪律（六份说明书） | `~\.config\opencode\grit\contracts\discipline\<角色>.md`（改文件即生效，无需重启） |
| ULW 契约 | `~\.config\opencode\grit\contracts\ulw.md`（末行 `{{handoff_template}}` 会被替换） |
| 交接摘要模板 | `grit\contracts\handoff-template.md`（同时要同步 `commands/handoff.md` 里的内嵌副本） |
| 全局规则（成本/文风/密钥） | `~\.config\opencode\AGENTS.md` |
| 档位/模型/权限 | `~\.config\opencode\grit\profiles\<档>.json` |
| 工具清单/agent 描述 | grit 仓库 `agents/index.json` + `profiles/*`，重跑 `node scripts/install.mjs`（描述只写能力，不写"什么时候用我"；plan 是原生模式，不在名册里） |

> 改仓库里的东西要**从仓库改**（改完 `node scripts/install.mjs` 同步）——直接改 `~\.config\opencode` 里那份，下次安装会被覆盖。

### 4.4 记忆

- 自动：每轮开头注入少量相关记忆；会话结束/压缩时自动抓取新事实。
- 手动：`memory` 工具（`add` / `search` / `profile` / `list` / `forget`）。
- 数据在 `~\.opencode-mem\data\`；坏了先看 `~\.opencode-mem\*.log`。

### 4.5 密钥

```powershell
sec list
sec exec --env TOKEN=<名字> -- <命令>
```

代码里引用：OpenCode 配置用 `{env:NAME}`；自建模板用 `{{secret:name}}`。**禁止** `sec get` / `sec export` / 读 `vault.json` / `echo $env:VAR`。

---

## 5. 维护与更新

### 5.1 更新 grit

```powershell
cd D:\workspace\selfProjects\agent-worktemp\grit
git pull
npm install
node scripts/install.mjs      # 同步到 ~/.config/opencode + 重写 agents 记录
npx tsc --noEmit ; node harness/smoke.ts
```

`opencode.json` 被安装脚本改写前会自动留一份 `opencode.json.bak-switch`（单槽备份）；脚本对带注释/坏 JSON 的配置会**中止不覆盖**。

### 5.2 更新 worktime

```powershell
cd D:\workspace\selfProjects\agent-worktemp\opencode-worktime
git pull
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

### 5.3 升级 OpenCode

```powershell
npm install -g @opencode/cli@latest
opencode --version
```

升级后先跑一遍 grit 的 `npx tsc --noEmit` + `node harness/smoke.ts`（V2 API 有变动时冒烟会先报警）。

### 5.4 生效边界

| 改动 | 何时生效 |
|---|---|
| 契约/纪律/便签文本 | 立即（每次请求现读现拼） |
| profile 的 features/阈值 | 立即 |
| profile 的 model/permissions（agents 记录） | 约 3 秒热生效；**当前会话已选模型不变**，新子代理/新会话才用新模型 |
| 插件源码 | 约 3 秒热加载（个别情况重启 OpenCode 服务） |

---

## 6. 安全红线

- **永远不要把明文密钥写进**：聊天回复、命令或工具参数、配置文件、脚本源码、记忆库、git 提交。
- 本机这几个文件属于**机器本地、不外传**：
  - `~\.config\opencode\service.json`（本机服务口令）
  - `~\.secrets\vault.json`（DPAPI 密文；换了 Windows 用户也解不开）
  - `~\.opencode-mem\.auth-token`（记忆 Web 服务的令牌）
  - `~\.config\opencode-tui-tunnel\config.json`（含 VAPID 私钥）
  - OpenCode 自己的凭据库（`opencode auth` 管理的那些）
- git 仓库里只提交**代码/配置/文档**，不提交密钥；本机 `AGENTS.md` 里的规矩已经写明"发现明文密钥 → 提醒轮换 + 迁入金库"。
- 传给新机器时，用 `git clone`（公开仓库）+ 这份文档（附录全文）+ 手动重建密钥，就够了。

---

## 7. 附录

### 附录 A：配置文件全文

#### A-1 `~/.config/opencode/AGENTS.md`

```markdown
# Cost Rules — apply on EVERY turn, no exceptions

## 1. One message = ALL known tool calls
If you already know the next N actions, emit ALL of them as parallel tool calls
in ONE message. Never emit one, wait for results, then emit the next.

- Edits to DIFFERENT files that you already know → all in one message:
  BAD:  edit A → (wait) → edit B → (wait) → edit C
  GOOD: [edit A, edit B, edit C] in a single message

## 2. Multiple changes to the SAME file = ONE write
Rewrite the file once with `write` (full content), or use ONE `apply_patch`
containing ALL hunks. Never a chain of sequential `edit` calls on one file.

## 3. Fetch everything in one parallel burst
Before acting, list every piece of information you need, then fetch it all at
once (read + grep + glob + bash together, or the batch tool with up to 25 calls).

## 4. Keep working in the same turn
After tool results return, continue immediately. Do NOT stop to summarize,
report progress, or ask for confirmation between steps.

## 5. Trust the context
Never re-read a file or re-run a command whose result is already in context.

## 6. Todo lists and these rules — two separate layers
- Todo discipline (one todo in_progress at a time, mark completed when done) governs the PLAN layer ONLY.
- The batching rules above govern the EXECUTION layer INSIDE each todo.
- One todo = one complete work unit (e.g. "add login endpoint"), NOT one file edit.
  Finish each todo in as few LLM turns as possible: 2-3 turns packed with parallel
  tool calls is GOOD; one tool call per turn is WASTE.

## End condition
Stop only when the whole task is done. Every extra turn costs money.

# 面向用户内容的写作风格（聊天式）

适用范围：回答、说明、讨论、方案、汇报——凡是用户要读的内容，默认使用如下规则。

- **大白话为主**：把道理用日常话讲清楚，用完整句子展开，不为了短而掐掉内容——过度简练会抬高理解成本。
- **术语只做点缀**：一段里一两个足够，随手带过即可，让用户慢慢对术语有印象；不解释术语定义，不写"术语上叫 X（英文 Y）"这类板书，不用教学腔。
- **用常见词**：不用生僻、方言化的说法；不用不常见的缩写，要缩写先给中文全称。
- **比喻**：不要滥用比喻，解释事物时先把话讲清楚，可以再补一句简单的比喻。
- **尽量不堆术语、不列名词解释、不学术腔**。


## Secrets / credentials (MANDATORY)
- 绝不把明文密钥/口令写进:聊天回复、命令或工具参数、配置文件、脚本源码、记忆库。
- 密钥统一存本地 DPAPI 金库,用 `sec`(在 C:\Users\Administrator\bin,可直接调用):
  - 列名(安全): `sec list`
  - 用密钥跑命令: `sec exec --env VAR=<name> -- <cmd>`(值只进子进程环境)
  - 代码/配置里用引用: `{env:NAME}`(opencode)/ `{{secret:name}}`(自建模板)
- 禁止回显密钥: `sec get` / `sec export` / 读取密钥文件 / `echo $env:VAR`。需要某个值就交给 `sec exec`。
- 新增密钥: `sec set <name>`(交互输入,勿用 --stdin 带值);生成随机: `sec gen <name>`。
- 已知密钥名与用途见记忆库(检索 "sec 金库")。
- 发现任何明文密钥 → 提醒用户轮换,并迁入金库。
```

#### A-2 `~/.config/opencode/opencode.json`

> 注意：新机器上第一次 `node scripts/install.mjs` 会用当前档重写其中 `agents` 那 6 条记录，其余字段保持不变。`permissions` / `websearch` / `mcp` / `plugins` 按这份保持。**`agents` 里的 model 会随档变化**，下面是本机（`opencode-go` 档）的值。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "shell": "C:/Program Files/PowerShell/7/pwsh.exe",
  "permissions": [
    {
      "action": "external_directory",
      "resource": "*",
      "effect": "allow"
    },
    {
      "action": "read",
      "resource": "*.env",
      "effect": "allow"
    },
    {
      "action": "read",
      "resource": "*.env.*",
      "effect": "allow"
    },
    {
      "action": "webfetch",
      "resource": "*",
      "effect": "allow"
    },
    {
      "action": "websearch",
      "resource": "*",
      "effect": "allow"
    }
  ],
  "websearch": {
    "provider": "random"
  },
  "mcp": {
    "servers": {
      "frx-director": {
        "type": "local",
        "disabled": true,
        "command": [
          "node",
          "C:\\Users\\Administrator\\tools\\frx-director-mcp\\dist\\index.js"
        ],
        "environment": {
          "FRX_AUTOLAUNCH": "1",
          "FRX_FIREFOX_BIN": "C:\\Users\\Administrator\\tools\\firefox-reverse\\firefox\\firefox.exe",
          "FRX_PROFILE": "C:\\Users\\Administrator\\tools\\firefox-reverse\\profile"
        }
      }
    }
  },
  "plugins": [
    "opencode-mem"
  ],
  "agents": {
    "build": {
      "mode": "primary",
      "description": "Orchestrator agent. Splits work into independent units, delegates to subagents, integrates their results, and implements small changes directly.",
      "model": "opencode-go/deepseek-v4.1-flash",
      "permissions": [
        {
          "action": "subagent",
          "resource": "*",
          "effect": "deny"
        },
        {
          "action": "subagent",
          "resource": "explore",
          "effect": "allow"
        },
        {
          "action": "subagent",
          "resource": "general",
          "effect": "allow"
        },
        {
          "action": "subagent",
          "resource": "sage",
          "effect": "allow"
        },
        {
          "action": "subagent",
          "resource": "browse",
          "effect": "allow"
        }
      ]
    },
    "explore": {
      "mode": "subagent",
      "description": "Read-only search agent. Locates code and configuration across the project and installed dependency source, then returns a condensed digest with absolute paths and line anchors.",
      "model": "opencode-go/deepseek-v4.1-flash",
      "permissions": [
        {
          "action": "clone_repo",
          "resource": "*",
          "effect": "allow"
        }
      ]
    },
    "general": {
      "mode": "subagent",
      "description": "General-purpose executor. Carries out one scoped unit of work end to end and reports the real output it produced.",
      "model": "opencode-go/deepseek-v4.1-flash"
    },
    "sage": {
      "mode": "subagent",
      "description": "Read-only senior advisor. Owns the team's judgment, world knowledge and approach specification: returns the decision-complete plan for how the work should be built (options, tradeoffs, one recommendation), and diagnoses failures that resisted other approaches.",
      "hidden": true,
      "model": "opencode-go/glm-5.3"
    },
    "browse": {
      "mode": "subagent",
      "description": "Browser automation agent. Drives a real Chromium browser to navigate pages, read and extract content, fill forms, click through flows, and capture screenshots; reports every finding anchored to URL + selector + quote.",
      "model": "opencode-go/deepseek-v4.1-flash"
    }
  }
}
```

#### A-3 `~/.config/opencode/opencode-mem.jsonc`

```jsonc
{
  "storagePath": "~/.opencode-mem/data",
  "userEmailOverride": "",
  "userNameOverride": "",

  "embeddingModel": "Xenova/nomic-embed-text-v1",
  "embeddingUseTaskPrefixes": false,

  "webServerEnabled": true,
  "webServerPort": 4747,
  "webServerHost": "127.0.0.1",

  "maxVectorsPerShard": 50000,
  "autoCleanupEnabled": true,
  "autoCleanupRetentionDays": 30,
  "deduplicationEnabled": true,
  "deduplicationSimilarityThreshold": 0.9,

  "memory": {
    "defaultScope": "project"
  },

  "compaction": {
    "enabled": true,
    "memoryLimit": 10
  },

  "chatMessage": {
    "enabled": true,
    "maxMemories": 3,
    "excludeCurrentSession": true,
    "injectOn": "first",
    "filterInjectedPrompts": true,
    "captureChildSessions": false
  },

  "opencodeProvider": "deepseek",
  "opencodeModel": "deepseek-flash",

  "autoCaptureEnabled": true,
  "memoryProvider": "openai-chat",
  "autoCaptureMaxIterations": 5,
  "autoCaptureIterationTimeout": 30000,
  "autoCaptureMaxRetries": 3,
  "autoCaptureMaxContextBytes": 131072,
  "aiSessionRetentionDays": 7,
  "memoryTemperature": 0.3,

  "showAutoCaptureToasts": true,
  "showUserProfileToasts": true,
  "showErrorToasts": true,

  "databaseEncryptionEnabled": false,
  "databaseEncryptionCipher": "aes256gcm",
  "autoUpdate": true,

  "userProfileAnalysisInterval": 10,
  "userProfileMaxContextBytes": 32768,
  "userProfileStaleDays": 2,
  "userProfileDisplayPreferences": 20,
  "userProfileDisplayPatterns": 15,
  "userProfileDisplayWorkflows": 10,
  "userProfileInjectPreferences": 5,
  "userProfileInjectPatterns": 5,
  "userProfileInjectWorkflows": 3,
  "userProfileConfidenceDecayDays": 30,
  "userProfileChangelogRetentionCount": 5,
  "userProfileEmbeddingThresholdSameCat": 0.8,
  "userProfileEmbeddingThresholdSameCatWeak": 0.5,
  "userProfileEmbeddingThresholdCrossCat": 0.9,
  "userProfileEmbeddingThresholdCrossCatWeak": 0.8,
  "userProfileCentroidDriftThreshold": 0.65,
  "userProfileEmbeddingMinDescriptionLength": 5,
  "userProfileMinEvidenceForRetention": 3,
  "userProfileAutoCleanupEnabled": true,
  "userProfileAutoCleanupInterval": 100,
  "userProfileValidationEnabled": false,

  "similarityThreshold": 0.6,
  "maxMemories": 10,
  "maxProfileItems": 5,
  "containerTagPrefix": "opencode",
  "injectProfile": true
}
```

#### A-4 `~/.config/opencode/package.json`

```json
{
  "name": "opencode-config-host",
  "private": true,
  "type": "module",
  "description": "Provides @opencode/plugin runtime deps for plugins/*.ts (grit, opencode-worktime)",
  "dependencies": {
    "@opencode/plugin": "^2.0.20"
  }
}
```

#### A-5 `~/.worktime/worktime.json`（安装 worktime 后生成，本机取值）

```json
{
  "mode": "strict",
  "tickSeconds": 5,
  "graceMinutes": 10,
  "schedule": []
}
```

#### A-6 `~/.agents/.skill-lock.json`（技能安装记录，参考）

```json
{
  "version": 3,
  "skills": {
    "browser-use": {
      "source": "browser-use/browser-use",
      "sourceType": "github",
      "sourceUrl": "https://github.com/browser-use/browser-use.git",
      "skillPath": "skills/browser-use/SKILL.md",
      "skillFolderHash": "687f45bd8b8fe0dbf172a615454e4a255f419172",
      "installedAt": "2026-03-10T06:19:25.307Z",
      "updatedAt": "2026-03-10T06:19:25.307Z"
    },
    "openclaw-self-healing": {
      "source": "ramsbaby/openclaw-self-healing",
      "sourceType": "github",
      "sourceUrl": "https://github.com/ramsbaby/openclaw-self-healing.git",
      "skillPath": "SKILL.md",
      "skillFolderHash": "",
      "installedAt": "2026-03-14T05:31:08.497Z",
      "updatedAt": "2026-03-14T05:31:08.497Z"
    }
  },
  "dismissed": {}
}
```

### 附录 B：本机自研插件全文

> 这三个文件没有 git 仓库，新机器把内容原样写到 `~/.config/opencode/plugins/` 对应位置即可。
> B-2/B-3 里 `C:\Users\Administrator\bin\sec.ps1` 是硬编码路径，用户名不同要改。

#### B-1 `plugins/secret-redact.ts`

```typescript
// secret-redact — 兜底:任何密钥值都不许进入模型上下文。
// 做法:插件启动时从本地 DPAPI 金库取全部密钥值(仅进本进程内存),
// 在每次模型请求前,把 system/messages 里的明文值替换为 ***secret***。
// 全程 try/catch 包裹:任何异常都退化为"不修改"(fail-open,绝不阻断会话)。
import { Plugin } from "@opencode/plugin";
import { execFileSync } from "node:child_process";

const PWSh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const SEC_PS1 = String.raw`C:\Users\Administrator\bin\sec.ps1`;
let SECRETS: string[] = [];

function loadSecrets(): string[] {
  try {
    const out = execFileSync(PWSh, ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", SEC_PS1, "export"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    const obj = JSON.parse(out);
    return Object.values(obj).filter((v): v is string => typeof v === "string" && v.length >= 6);
  } catch {
    return [];
  }
}

function redactString(s: string): string {
  let r = s;
  for (const sec of SECRETS) if (r.includes(sec)) r = r.split(sec).join("***secret***");
  return r;
}

function redactDeep(node: any, depth = 0): any {
  if (node == null || depth > 8) return node;
  if (typeof node === "string") return redactString(node);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = redactDeep(node[i], depth + 1);
    return node;
  }
  if (typeof node === "object") {
    for (const k of Object.keys(node)) {
      try {
        node[k] = redactDeep(node[k], depth + 1);
      } catch {}
    }
    return node;
  }
  return node;
}

export { loadSecrets, redactString };

export default Plugin.define({
  id: "secret-redact",
  async setup(ctx) {
    SECRETS = loadSecrets();
    try {
      await ctx.session.hook("context", (event: any) => {
        try {
          if (event?.system) redactDeep(event.system);
          if (event?.messages) redactDeep(event.messages);
        } catch {}
      });
    } catch {}
  },
});
```

#### B-2 `plugins/secret-ui/index.ts`

```typescript
// secret-ui / index.ts —— server 端入口。
// 只提供一个"查看密钥名"的工具;密钥的【现场输入】由 TUI 端 tui.ts 的斜杠命令完成:
//   /secret <名字>   弹框输入 -> 直接写入本地 DPAPI 金库(值不进对话上下文)
//   /secrets         列出密钥名
// 注意:插件弹框是 TUI 客户端的能力;其它 Web 客户端(如官方 Web UI)不支持。
// 教训(勿重蹈):不要在服务端插件里 spawn `opencode api` —— 会让 CLI 重启后台服务。
import { Plugin } from "@opencode/plugin"
import { execFileSync } from "node:child_process"

const PWSh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
const SEC = String.raw`C:\Users\Administrator\bin\sec.ps1`

export default Plugin.define({
  id: "secret-ui",
  async setup(ctx) {
    try {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "secret_list",
          description:
            "列出本地密钥库(sec 金库)里的密钥【名字】(不含值)。需要用某密钥:名字已存在 -> shell 执行 `sec exec --env VAR=<名字> -- <命令>`;不存在 -> 请让用户【在 TUI 里运行斜杠命令 /secret <名字>】输入(会弹框;值不进对话上下文)。切勿用 sec get/export。",
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            try {
              const out = execFileSync(
                PWSh,
                ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", SEC, "list"],
                { encoding: "utf8", timeout: 15000, windowsHide: true },
              )
              return { content: out.trim() || "（空）" }
            } catch (e) {
              return { content: "sec list 失败: " + String(e) }
            }
          },
        })
      })
    } catch {}
  },
})
```

#### B-3 `plugins/secret-ui/tui.ts`

```typescript
// secret-ui / tui.ts —— TUI 端入口:提供 /secret 斜杠命令,弹框输入密钥值,
// 直接把值写进本地 DPAPI 金库(sec)。值只在本进程 -> sec 子进程 stdin 之间流动,
// 绝不进入模型对话、日志或会话记录。
import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"

const PWSh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
const SEC = String.raw`C:\Users\Administrator\bin\sec.ps1`

function runSec(args: string[], stdinValue?: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(PWSh, ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", SEC, ...args], {
        windowsHide: true,
      })
    } catch (e) {
      resolve({ code: -1, out: String(e) })
      return
    }
    let out = ""
    child.stdout?.on("data", (d) => (out += String(d)))
    child.stderr?.on("data", (d) => (out += String(d)))
    child.on("error", (e) => resolve({ code: -1, out: String(e) }))
    child.on("close", (code) => resolve({ code, out: out.trim() }))
    if (stdinValue !== undefined) {
      try {
        child.stdin?.write(stdinValue)
        child.stdin?.end()
      } catch {}
    } else {
      try {
        child.stdin?.end()
      } catch {}
    }
  })
}

export default Plugin.define({
  id: "secret-ui",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "secret.set",
          title: "Secret: 输入并存入金库",
          group: "Secret",
          palette: true,
          slash: { name: "secret", arguments: true },
          enabled: () => true,
          run: async (input?: string) => {
            try {
              const name = (input ?? "").trim()
              if (!name) {
                context.ui.toast.show({ title: "Secret", message: "用法: /secret <名字>(如 /secret router.admin)", variant: "warning", duration: 4000 })
                return
              }
              const value = await context.ui.dialog.prompt({
                title: `输入密钥值: ${name}`,
                placeholder: "回车保存;值只进本地金库,不进对话",
              })
              if (!value) {
                context.ui.toast.show({ title: "Secret", message: "已取消", variant: "warning", duration: 2500 })
                return
              }
              const res = await runSec(["set", name, "--stdin"], value)
              const ok = res.code === 0
              context.ui.toast.show({
                title: "Secret",
                message: ok ? `${name} 已存入金库` : `失败(${res.out || res.code})`,
                variant: ok ? "success" : "error",
                duration: ok ? 2500 : 6000,
              })
            } catch (e) {
              try { context.ui.toast.show({ title: "Secret", message: String(e), variant: "error", duration: 6000 }) } catch {}
            }
          },
        },
        {
          id: "secret.list",
          title: "Secret: 列出密钥名",
          group: "Secret",
          palette: true,
          slash: { name: "secrets" },
          enabled: () => true,
          run: async () => {
            try {
              const res = await runSec(["list"])
              context.ui.dialog.alert({ title: "密钥库(仅名字)", message: res.out || "（空）" })
            } catch (e) {
              try { context.ui.toast.show({ title: "Secret", message: String(e), variant: "error" }) } catch {}
            }
          },
        },
      ],
      bindings: ["secret.set", "secret.list"],
    }))
  },
})
```

### 附录 C：`sec` 金库脚本全文

> 放在 `C:\Users\<你>\bin\`，并保证 `bin` 在 PATH。`sec.cmd` 是个一行转发器（指向 `sec.ps1`）。

#### C-1 `bin/sec.ps1`

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# sec — DPAPI(CurrentUser) 加密的本地密钥库。值只在本进程内存/子进程环境里流动。
$VaultDir  = Join-Path $HOME '.secrets'
$VaultPath = Join-Path $VaultDir 'vault.json'
$LogPath   = Join-Path $VaultDir 'access.log'
$Entropy   = [Text.Encoding]::UTF8.GetBytes('opencode-vault-v1')

try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop } catch {}
if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {
  [Console]::Error.WriteLine('DPAPI(ProtectedData) unavailable; run with powershell.exe (5.1)'); exit 3
}

function Fail([string]$msg, [int]$code) { [Console]::Error.WriteLine($msg); exit $code }
function ProtectStr([string]$p) {
  [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect(
    [Text.Encoding]::UTF8.GetBytes($p), $Entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
}
function UnprotectStr([string]$b) {
  [Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect(
    [Convert]::FromBase64String($b), $Entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
}
function EnsureVaultDir {
  if (-not (Test-Path $VaultDir)) {
    New-Item -ItemType Directory -Force $VaultDir | Out-Null
    & icacls.exe $VaultDir /inheritance:r /grant:r ("{0}:(OI)(CI)F" -f $env:USERNAME) | Out-Null
  }
}
function ReadVault {
  $h = @{}
  if (Test-Path $VaultPath) {
    $o = Get-Content -Raw -LiteralPath $VaultPath | ConvertFrom-Json
    foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = $p.Value }
  }
  $h
}
function WriteVault($h) {
  EnsureVaultDir
  $tmp = "$VaultPath.tmp"
  ($h | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -Force -LiteralPath $tmp -Destination $VaultPath
}
function Audit([string]$name, [string]$op) {
  try {
    $ppid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue).ParentProcessId
    $pn = (Get-Process -Id $ppid -ErrorAction SilentlyContinue).ProcessName
    EnsureVaultDir
    Add-Content -LiteralPath $LogPath -Value ("{0}`t{1}`t{2}`t{3}#{4}" -f (Get-Date -Format s), $op, $name, $pn, $ppid)
  } catch {}
}
function Usage {
@'
sec - DPAPI(CurrentUser) local secret vault
  sec list                                      list secret names (no values)
  sec set <name> [--stdin] [-m k=v ...]         add/update (value via prompt unless --stdin)
  sec get <name>                                print plaintext (for scripts only; agents must NOT use)
  sec rm  <name>                                delete
  sec gen <name> [-Length 32]                   generate+store a random secret, prints it once
  sec exec --env VAR=<name> [--env ...] -- <cmd> [args]   run cmd with secrets injected into child env
  sec export                                    JSON name->plaintext (for the redaction plugin only; agents must NOT use)
  sec audit                                     recent access log
'@
}

$all  = @($args)
$cmd  = if (@($all).Count -ge 1) { [string]$all[0] } else { 'help' }
$rest = @()
if (@($all).Count -gt 1) { $rest = @($all[1..(@($all).Count - 1)]) }

switch ($cmd) {
  'list' {
    $h = ReadVault
    if ($h.Count -eq 0) { '（空）' } else {
      foreach ($k in ($h.Keys | Sort-Object)) {
        $desc = ''
        try { $desc = (@($h[$k].meta.PSObject.Properties) | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', ' } catch { $desc = '' }
        if ($desc) { "{0}  [{1}]" -f $k, $desc } else { $k }
      }
    }
  }
  'set' {
    if ($rest.Count -lt 1) { Fail 'usage: sec set <name> [--stdin] [-m k=v]' 2 }
    $name = [string]$rest[0]
    $useStdin = $rest -contains '--stdin'
    $meta = @{}
    for ($i=1; $i -lt $rest.Count; $i++) {
      if ($rest[$i] -eq '-m' -and ($i+1) -lt $rest.Count) {
        $kv = [string]$rest[$i+1]; $eq = $kv.IndexOf('='); if ($eq -gt 0) { $meta[$kv.Substring(0,$eq)] = $kv.Substring($eq+1) }; $i++
      }
    }
    if ($useStdin) { $val = [Console]::In.ReadToEnd().TrimEnd("`r","`n") }
    else {
      $ss = Read-Host -AsSecureString "value for '$name'"
      $val = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))
    }
    if ([string]::IsNullOrEmpty($val)) { Fail 'empty value refused' 2 }
    $h = ReadVault
    $h[$name] = [pscustomobject]@{ v = (ProtectStr $val); meta = $meta; updated = (Get-Date -Format o) }
    WriteVault $h
    Audit $name 'set'
    "stored: $name"
  }
  'get' {
    if ($rest.Count -lt 1) { Fail 'usage: sec get <name>' 2 }
    $name = [string]$rest[0]
    $h = ReadVault
    if (-not $h.ContainsKey($name)) { Fail "unknown secret: $name" 4 }
    Audit $name 'get'
    UnprotectStr $h[$name].v
  }
  'rm' {
    if ($rest.Count -lt 1) { Fail 'usage: sec rm <name>' 2 }
    $name = [string]$rest[0]
    $h = ReadVault
    if ($h.ContainsKey($name)) { $h.Remove($name); WriteVault $h; Audit $name 'rm'; "removed: $name" }
    else { Fail "unknown secret: $name" 4 }
  }
  'gen' {
    if ($rest.Count -lt 1) { Fail 'usage: sec gen <name> [-Length 32]' 2 }
    $name = [string]$rest[0]; $len = 32
    for ($i=1; $i -lt $rest.Count; $i++) { if ($rest[$i] -eq '-Length' -and ($i+1) -lt $rest.Count) { $len = [int]$rest[$i+1] } }
    $bytes = New-Object 'byte[]' $len
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $val = ([Convert]::ToBase64String($bytes) -replace '[+/=]','')
    if ($val.Length -gt $len) { $val = $val.Substring(0,$len) }
    $h = ReadVault
    $h[$name] = [pscustomobject]@{ v = (ProtectStr $val); meta = @{ generated = 'true' }; updated = (Get-Date -Format o) }
    WriteVault $h
    Audit $name 'gen'
    UnprotectStr $h[$name].v
  }
  'export' {
    $h = ReadVault
    $o = [ordered]@{}
    foreach ($k in $h.Keys) { $o[$k] = (UnprotectStr $h[$k].v) }
    $o | ConvertTo-Json -Depth 4
  }
  'exec' {
    $pairs = [ordered]@{}
    $i = 0; $cmdStart = -1
    while ($i -lt $rest.Count) {
      if ($rest[$i] -eq '--') { $cmdStart = $i+1; break }
      elseif ($rest[$i] -eq '--env' -and ($i+1) -lt $rest.Count) {
        $kv = [string]$rest[$i+1]; $eq = $kv.IndexOf('='); if ($eq -lt 1) { Fail "bad --env: $kv" 2 }
        $pairs[$kv.Substring(0,$eq)] = $kv.Substring($eq+1); $i += 2
      }
      else { $cmdStart = $i; break }
    }
    if ($cmdStart -lt 0 -or $cmdStart -ge $rest.Count) { Fail 'usage: sec exec --env VAR=<name> -- <cmd> [args]' 2 }
    $h = ReadVault
    foreach ($k in $pairs.Keys) {
      $n = [string]$pairs[$k]
      if (-not $h.ContainsKey($n)) { Fail "fail-closed: undefined secret '$n'" 4 }
      [Environment]::SetEnvironmentVariable($k, (UnprotectStr $h[$n].v), 'Process')
      Audit $n 'exec'
    }
    $exe = [string]$rest[$cmdStart]
    $exeArgs = if ($rest.Count -gt $cmdStart+1) { @($rest[($cmdStart+1)..($rest.Count-1)]) } else { @() }
    & $exe @exeArgs
    exit $LASTEXITCODE
  }
  'audit' {
    if (Test-Path $LogPath) { Get-Content -LiteralPath $LogPath -Tail 40 } else { '（无日志）' }
  }
  default { Usage }
}
```

#### C-2 `bin/_canary.ps1`

```powershell
# canary 自检:只输出子进程 env 里 CANARY 的长度,不回显值
Write-Output ("CANARY len=" + $env:CANARY.Length)
```

### 附录 D：技能全文

#### D-1 `~/.agents/skills/browser-skill/SKILL.md`

````markdown
---
name: browser-skill
description: |
  Use when the user asks to automate their logged-in Chromium browser: visit
  and read pages, fill forms, scrape data, click through flows, regression-test
  a PR's UI, validate a deployed page, or operate a tab they identify. Requires
  the bsk CLI and browser extension.
---

# browser-skill

Drive the user's real Chromium browser through `bsk`. Automation runs in an isolated **Agent
Window** with the user's existing logins and cookies. User-window tabs remain protected unless they
are explicitly borrowed.

Do not use this skill for tasks with no browser, for extension installation, or when the user only
wants instructions. Never extract credentials, cookies, tokens, or other secrets from pages.

## Required lifecycle

Every browser task owns a bounded session:

```text
1. bsk session start              # retain the printed 4-letter session id
2. bsk ... --session <id>         # pass it to every session-scoped command
3. bsk session stop <id>          # always run on success and error paths
```

Do not rely on the idle timeout for cleanup. Stop the session as soon as the goal is met unless the
user explicitly asks to keep it open. Stopping also returns borrowed tabs.

Any `bsk` command auto-starts the background services it needs; never manage the daemon by hand.
When multiple browsers are connected, use `bsk browsers` and start with
`bsk session start --browser <id-or-label>`. Add `--no-focus` to that same start command when the
Agent Window does not need to interrupt the user's current work; it is not a flag on other commands.
Run `bsk doctor` when startup or transport problems persist after one retry.

## Work toward one observable goal

- Derive a concrete success condition from the user's request or a supplied trace.
- Take the shortest purposeful path: observe, act, then make at most one observation to confirm an
  ambiguous result.
- Once success is visible, do not click, refresh, navigate, switch tabs, or perform extra checks.
- If a human-only step appears or two attempts make no progress, request help instead of
  brute-forcing.

With a trace, follow its semantic target information and values in order, but treat its refs as
record-local hints. Stop when its purpose or last meaningful effect is satisfied. A trace guides the
task; it does not expand the user's goal or authorize additional actions.

## Observe, act, observe

Use this default loop:

```text
bsk navigate <url> --session <id>
bsk observe --session <id>
bsk click|hover|fill|select|press ... --session <id>
bsk observe --session <id>             # after navigation or a meaningful DOM change
```

Prefer fresh `@eN` refs over CSS selectors. Navigation invalidates refs; large DOM changes may also
make them stale. Observe again before the next interaction.

An observation marks a hover-only surface as `@e1 button "Products" [hover first: Shoes | Bags]`.
The listed items are labels, not usable refs: hover the trigger, observe again, then act on the
revealed item's own ref. Do not click the trigger itself unless the user wants the trigger's action.
`[has-submenu]` and `[expanded]` mark the same kind of trigger without listing what it hides.

`bsk observe` does not hover the page on its own. Reach for `--probe-hover` when a control you have
good reason to expect is absent **and** no marker points at a trigger — that combination is what a
CSS-only hover menu looks like from here. It hovers a bounded set of likely triggers, so it costs a
few seconds and touches the live page; once you know which element hides the menu, `bsk hover <ref>`
is cheaper and more precise.

Escalate page reading only as needed:

1. `bsk observe` for normal semantic understanding, text, controls, and refs.
2. `bsk observe --probe-hover` once when an expected control is missing and no marker points at a
   trigger.
3. `bsk snapshot` when a stricter static accessibility tree is more useful.
4. `bsk get-html` for exact markup or hidden metadata that semantic views cannot provide.
5. `bsk screenshot` for layout, styling, canvas, images, or requested visual evidence.

Do not start with raw HTML or screenshots merely to discover ordinary controls. When interaction is
needed, obtain a fresh observation before acting on screenshot or HTML findings.

## Respect the Agent Window boundary

Normal page writes affect only Agent Window tabs. To operate a user tab, first list it with
`bsk tab list --scope user --session <id>`, then `bsk tab borrow <tab-id>`. Return it immediately
after the relevant step with `bsk tab return <tab-id>`; never invent a tab id or keep a personal tab
borrowed across unrelated work.

## Ask the human when needed

Use `bsk request-help` for login, captcha, OTP, payment confirmation, consent, or another step the
user must complete. Give a precise prompt and pass fresh `--target` refs/selectors when concrete
controls can be highlighted. Use completion criteria only when the page has a clear stable success
signal.

The result `outcome` is one of `continued`, `completed`, `cancelled`, `timed_out`, or `disabled`
(`navigated` is deprecated — never treat navigation as a completion signal). Resume only after
`continued` or `completed`. Treat `cancelled` as rejection, and `timed_out` or `disabled` as a
blocker rather than a reason to retry. After control returns, run a fresh `bsk observe` before
reasoning about the page or using refs.

## Command inventory

This list of names is complete. Never invent a command outside it; read
`bsk <command...> --help` for flags instead of guessing them.

```text
session start|stop|list   browsers   status   doctor   update   logs
navigate   navigate-back   navigate-forward   reload   wait-for-navigation   wait-ms
observe   snapshot   get-html   screenshot   console   network
click   hover   fill   select   press   evaluate
tab list|create|close|select|borrow|return   window resize   emulate
upload   download   request-help   record start|stop
```

Required flags that are easy to get wrong:

```text
bsk fill <ref> --value <text>      bsk select <ref> --value <option-value>
bsk screenshot --out <path>        bsk emulate --device <preset-id>
bsk upload <ref> --file <path>     bsk download <ref> --out <path>
```

`select` matches an option's `value` attribute, not its visible label. Device preset ids are
lowercase and hyphenated, such as `iphone-14`.

- `console` and `network` provide bounded, read-only debugging evidence.
- `emulate` applies viewport, user-agent, and touch overrides to one tab; new tabs do not inherit
  them. Use `--off` to restore the real environment.
- `evaluate` is a last resort when observe plus normal interactions cannot complete the task. With
  `--json`, inspect `.ok`: a JavaScript exception may still have CLI exit code 0 because the RPC
  succeeded. Never evaluate credential surfaces to read storage, cookies, or auth data.
- `record` captures a user's actions for later replay. Read `bsk record start --help` before use,
  and never record banking, SSO, password-manager, or other sensitive pages.

## File transfer

`upload` and `download` stage files through the daemon; the agent never touches browser-internal
paths. Treat upload as disclosure to the website, download as accepting website-controlled bytes.

Upload has two independent mechanisms — choose explicitly, never rely on automatic fallback:

- **Default (input mode):** for upload buttons, file-input labels, or "upload from computer"
  actions. The command clicks the target and intercepts the native file chooser.
- **`--mode drop`:** for reliably identified attachment-receiving areas — an explicit drop zone,
  chat composer, email editor, or form attachment area. Do not target page whitespace, generic
  containers, or areas whose attachment ownership is ambiguous.

Decision sequence when uploading:

1. Try input mode (the default).
2. If it returns `reason=file_input_not_activated` with `effect_state=none`, re-observe. When a
   reliable attachment target exists, try `--mode drop` once against that target.
3. Otherwise fall back to `request-help`.
4. **Never** switch mechanisms or repeat when `effect_state` is `unknown` or `committed` — the
   browser may already have applied the file.

A successful drop means Chrome dispatched the native file-drop event; it does not prove the site
accepted the attachment. Observe the page once after the command.

Download default-refuses to overwrite; pass `--overwrite` when replacing an existing file is
intended. Read `bsk upload --help` and `bsk download --help` for all flags and error details.

## Recover without wandering

- Stale ref: observe again and retry the intended action once.
- Unknown tab or session: list current tabs/sessions; never guess identifiers.
- Timeout: inspect current page state before deciding whether one longer purposeful wait is useful.
- Unsupported command: continue with available capabilities; suggest updating only when the missing
  command is necessary.
- Unrecoverable failure: report the blocker and stop the session in a finally-style path.

The CLI's current help and error hints are authoritative for flags, parameters, and recovery
details.
````

#### D-2 `~/.config/opencode/skills/openscad-cad/SKILL.md`

```markdown
---
name: openscad-cad
description: 使用 OpenSCAD 进行参数化 3D 建模（结构件、3D 打印件、参数化几何）。当用户要求创建 3D 模型、STL 文件、参数化零件、结构件或 CAD 类几何时使用此技能。工作流：写 .scad 源码 → CLI 渲染 PNG 预览自检 → 迭代 → 导出 STL。
---

# OpenSCAD 参数化建模技能

## 何时使用

- 用户要 3D 模型 / STL / 结构件 / 参数化零件 / 3D 打印件 / 盒子·支架·外壳·齿轮等几何体
- 需要参数化、可复用、可进 git 的 CAD 产出（不是艺术雕刻——那类用雕刻类工具）
- 需要 B-rep 精确工程特征（复杂圆角/倒角/装配约束）超出了 OpenSCAD 能力时，提示用户可升级 CadQuery 路线

## 环境事实（本机）

- OpenSCAD 装在 `C:\Program Files\OpenSCAD\openscad.exe`（不在 PATH，命令里用完整路径并加引号）
- 渲染是 CPU 计算，与显卡无关

## 标准工作流（必须走完自检闭环）

1. **写源码**：把模型写到 `.scad` 文件（项目内或用户指定目录）。参数放文件顶部：
   ```scad
   // ---- params ----
   width  = 60;   // mm
   depth  = 40;
   height = 25;
   wall   = 2.5;
   $fn    = 64;   // 预览可 32，最终导出 64+
   ```
2. **渲染 PNG 预览**（不是 STL，先看图）：
   ```powershell
   & "C:\Program Files\OpenSCAD\openscad.exe" -o preview.png --imgsize 800,600 --projection p --colorscheme Tomorrow model.scad
   ```
   - `--imgsize W,H` 控制分辨率；`--projection o`=正交（工程件推荐，看得准）、`p`=透视
   - 需要固定视角时加 `--camera tx,ty,tz,rx,ry,rz,dist`（前三个是平移，后三个旋转，最后距离），常用：`--camera 0,0,0,60,0,25,0,150,0,0,0,120` 等距视角写法为 `--camera 0,0,0,55,0,25,300`
3. **自检**：用 read 工具打开渲染出的 PNG 亲眼看。检查：形状对不对、比例协不协调、有没有缺料/悬空/破面、壁厚是否合理。不满意就改源码重渲染。**禁止跳过看图直接交付**。
4. **导出交付物**：
   ```powershell
   # STL（3D 打印/下游软件）
   & "C:\Program Files\OpenSCAD\openscad.exe" -o model.stl model.scad
   # 也可以导 OFF/AMF/3MF/SVG(2D投影)/DXF
   ```
5. 汇报：告诉用户文件路径 + 渲染图路径 + 关键参数（方便用户自己改参数重新生成）。

## 语言要点速查

- 三大布尔：`difference() { 主体; 要减的; }`、`union()`、`intersection()`
- 变换：`translate([x,y,z]) rotate([rx,ry,rz]) scale([sx,sy,sz]) mirror([nx,ny,nz])`
- 2D→3D：`linear_extrude(height)`、`rotate_extrude()`；2D 图形：`circle(r)`、`square([w,h])`、`polygon(points)`
- 圆角/倒角技巧：`minkowski(){ 主体; sphere(r); }`（慢，慎用大 $fn）；2D 圆角用 `offset(r)`；倒角用 `hull()` 或旋转切割
- 光滑件用 `hull(){ A; B; }`（两件外包络）；阵列 `for (i=[0:step:n])`
- 模块化：`module screw_hole(d, h) {...}` + `screw_hole(3, 10);`；顶层建议一个 `main()` 模块方便注释切换
- **除零/负数壁厚防御**：参数相减时先 `assert(wall*2 < depth, "壁厚过大")`

## 高频坑

| 坑 | 处理 |
|---|---|
| difference 面重合出现破面（z-fighting） | 被减体比主体多伸出一截：`translate([0,0,-1]) cylinder(h=height+2)`，两端各多 1mm |
| 圆柱看着是多棱柱 | `$fn` 太小；预览 `$fn=32`，导出 `$fn=64`～`128`（越大越慢） |
| STL 导出很慢 | `difference` 触发 CGAL 全量布尔，正常现象；开发阶段用 PNG，确认后再 STL |
| Windows 路径报错 | 完整路径加引号 `& "C:\Program Files\..."`；.scad 里写文件路径用正斜杠 `/` |
| 模型跑出视野（PNG 全黑/全空） | 加 `--camera` 或先 `viewport()` 调整；PNG 空白多半是模型不在相机路径上 |
| F5 预览 vs F6 渲染差异 | CLI 的 PNG 导出等价 F6（完整渲染），与 IDE 里 F5 预览可能有差别，以 CLI 为准 |

## 交付约定

- 源码 `.scad` 永远交付（用户改参数复生成是核心价值），不要只给 STL
- 3D 打印件主动提醒：是否需要预留公差（配合件单边 0.2mm 常见）、悬空结构、壁厚≥1.2mm
- 尺寸单位一律 mm，注释里写清楚
```

### 附录 E：grit 仓库结构（git clone 就有，不需要手抄）

```text
grit/
├─ plugin/grit.ts           插件本体（多代理 + ULW 机制；V2 插件 API）
├─ plugin/tui.ts            TUI 提示插件（profile 切换 toast）
├─ contracts/ulw.md         ULW 契约（可改）
├─ contracts/handoff-template.md  交接摘要模板
├─ contracts/discipline/*.md      五份角色纪律（可改；plan 归原生，无文件）
├─ agents/index.json        五席的定义（mode/description/permissions；plan 不在名册）
├─ profiles/*.json          档位：opencode-go / default / deepseek / glm-max / strict / bare
├─ profiles/active          当前档指针
├─ variants/strict/discipline/build.md   严格档的纪律变体
├─ commands/{ulw,ulw-exit,handoff,profile}.md
├─ scripts/{install.mjs,grit.mjs,materialize-core.ts}
├─ harness/smoke.ts         确定性冒烟（纯函数 + 假 ctx 集成）
├─ docs/{DESIGN-v3.md,DESIGN-v3.html,PLUGIN-FLOW.html,REQUIREMENTS.md,ENV-REPLICATION.md,…}
└─ package.json / tsconfig.json
```

自检命令：`npx tsc --noEmit` + `node harness/smoke.ts`。

### 附录 F：数据文件与迁移策略

| 数据 | 位置 | 要不要带到新机器 |
|---|---|---|
| grit 运行状态（ULW 账本、计数） | `~\.config\opencode\grit\state\` | 不用带（14 天自动清理；带上也无害） |
| grit 日志 | `~\.config\opencode\grit\log\grit.log` | 不用带 |
| 记忆向量库 | `~\.opencode-mem\data\`（约 149MB） | 想延续历史记忆就带；否则新机器从零积累 |
| 记忆日志 | `~\.opencode-mem\*.log` | 不用带 |
| 时间表 | `~\.worktime\worktime.json` | 带（很小）；本机内容是空的 |
| 手写记忆便签 | `~\memory\*.md` | 带（很小）。本机 `2026-09-30.md` 就是当年 V1→V2 移植的关键结论，全文见下 |
| 密钥 | `~\.secrets\vault.json` | **带不了**（DPAPI），按 §3.9 重建 |
| browser-skill 后台状态 | `~\.bsk\` | 不用带（自动重建） |
| OpenCode 会话历史 | OpenCode 自己的存储目录 | 不用带（除非你想在新机器上翻旧会话） |

`memory/2026-09-30.md` 全文（当年 V1→V2 移植笔记，新机器上遇到 V2 API 疑问时很有用）：

```markdown
# 2026-09-30

## opencode Agent 环境重建（V1 手册 → V2 实机）

- 本机：opencode **v2.0.20**（npm 全局 `@opencode/cli`）、node v24.14.0、pwsh 7.6.6、git 2.39.1
- GitHub 认证：gh 2.101.0 装好后走**设备码登录**成功（niuxiaozu，repo scope）；
  `gh auth setup-git` 已配 git 凭据。**直连 github.com 超时，代理 `127.0.0.1:7890` 可用**（Clash 类，系统代理开关是关的，进程级 env 生效）
- 源码位置：`D:\workspace\selfProjects\agent-worktemp\`（grit + opencode-worktime + browser-skill-setup）

### 核心工作：两个插件手工移植 V1→V2 插件 API
- V1 插件在 V2 **不能直接跑**（唯一大的 breaking change；agents/commands/skills/AGENTS.md 全兼容）
- grit：chat.message→`ctx.session.hook("prompt")`；messages.transform+chat.params→`ctx.session.hook("context")`（**V2 消息是扁平 {type,text}，非 {info,parts}**）；event→`ctx.event.subscribe`（**载荷在 event.data，非 properties**；token 快照走 session.step.ended/session.usage.updated）；tool map→`ctx.tool.transform`（JSON Schema，去 zod，返回 {content}）
- V2 **没有 todo 事件**：grit 改为 idle 时经 `ctx.session.context()` 扫最新 todowrite 工具调用
- worktime：V1 的 command.execute.before+Respondable 抛错短路 → V2 `ctx.command.transform` 原生注册 /worktime+/wt（execute 不调 prompt 即不打扰模型，effect 依赖删除）
- 两仓库均已整理到独立分支 **`opencode-v2`** 并推送到 origin（main/master 保持 V1 原状）；部署与测试均从该分支执行
- grit `npm test`：**56 断言全绿**（smoke §9 改写为 V2 形态断言）

### 其他落盘
- `~/.config/opencode/opencode.json`（最小基座，grit 安装器要求存在）
- `~/.config/opencode/AGENTS.md`（Cost Rules）+ `skills/openscad-cad/SKILL.md`
- browser-skill：官方渠道=npm 包 `browser-skill`（v0.2.0），bsk.exe 已放 `%APPDATA%\npm`；
  `bsk install-skill --harness codex` 装到 `~/.agents/skills/`（bsk 不支持 opencode harness，但 opencode v2 兼容发现 ~/.agents/skills）
- **待用户手动**：Chrome 加载扩展 `D:\workspace\selfProjects\agent-worktemp\browser-skill-setup\extension`（chrome://extensions 开发者模式）；重启 opencode 使插件生效

### 教训
- grit install.mjs 假定 `~/.config/opencode/plugins/` 存在——新机器 ENOENT，已修（mkdir recursive）
- 事件结构实证法：抓 `/api/event` SSE（Basic auth `opencode:<service.json 密码>`）+ 二进制 strings 提取事件词汇表
- websearch 工具本机不可用（取消），用 gh search / npm search 替代

## 修复 opencode 插件加载失败（grit + opencode-worktime）
- 原因：V2 迁移后两个插件 import `@opencode/plugin`，但部署目录 `~/.config/opencode/plugins/` 及上级无 node_modules
- 修复：`~/.config/opencode/package.json` + npm 装 `@opencode/plugin@2.0.20`（官方机制：本地插件依赖放 config 目录）
- 关键知识：**Bun 进程内缓存失败的模块解析**（opencode loader.ts 注释），装好依赖后必须重启 opencode 进程才生效，watcher reload 无效
- 已固化：两个仓库 install 脚本新增 ensureHostDeps（grit install.mjs / worktime install.ps1），幂等验证通过；未 git commit
- 仓库：D:\workspace\selfProjects\agent-worktemp\{grit,opencode-worktime}

- 补充：换文件名重载也失败 → Bun 失败解析缓存按包名(specifier)进程级永久。opencode --auto 重启的只是客户端，server 是 serve --service 常驻进程(PID 35980)，必须杀掉它才算真正重启

- ✅ 已解决：杀掉旧 service 后客户端自动拉起新进程(14:50)，grit + opencode-worktime 加载成功（无 failed 日志，profile/worktime_* 工具已注册生效）

- V2 重启正确姿势：opencode service restart / stop / start / status（V1 exit=全退；V2 exit 只退客户端，server 常驻）。--standalone 可回到 V1 式私有 server 模式

## RustDesk 卡顿排查（远程会话）
- 症状：涉及本机的远程连接周期性卡 10~20 秒；换小米路由器后出现（旧 OpenWrt 有 FullCone/VPN）
- 根因：hbbs 与本机同内网，hbbs 把私网地址 192.168.5.101 发给远端客户端 → 打洞必死 → 等超时后回落中继（日志特征：Punch tcp hole / deadline has elapsed）
- 已做：本机 peers\6824003.toml 加 force-always-relay='Y'；路由器(BE6500 固件1.0.64, NAS=192.168.5.100)补 TCP 21115 转发并验证 hairpin OK
- 待办：niuxz 的远程设备（niu_work_pc=6824003 及手机）对 ID 1604418691 勾"强制走中继连接"
- 参考：rustdesk-server discussion #380（同内网注册私网IP是正常行为）；进阶方案=路由器 VPN 菜单开 WireGuard 组网直连
- 弃用 RustDesk（用户嫌坑多），已彻底卸载并备份配置到 C:\Users\Administrator\RustDesk-backup-20260930（75.8MB，可删）。远程改用网易UU远控（Netease\GameViewer，已装好）。路由器上 21115/21116/21117 转发已无用，待用户决定是否删除
```

### 附录 G：故障排查

| 现象 | 原因/解法 |
|---|---|
| `memory add` 报 `Cannot find module '@huggingface/transformers'` | 记忆插件缺本地 embedding 依赖 → 按 §3.8 在插件目录 `npm install @huggingface/transformers` |
| 切档后模型没变 | V2 里**当前会话已选模型不变**，新子代理/新会话才用新档；等约 3 秒再看 |
| `/ulw` 之后模型没进模式 | 进入靠模型主动调 `ulw_enter`；那条 `/ulw` 消息必须还在"上一条用户消息"的位置（中间插了别的话就会拒），重敲 `/ulw` 即可 |
| 退出后再进 ULW 被拒 | 授权校验看"上一条用户消息"；如果上一条是你自己敲的 `/ulw` 就一定放行，否则重敲一次 |
| `sec` 报 `DPAPI(ProtectedData) unavailable` | 必须用 Windows 的 PowerShell；`pwsh` 缺 `System.Security.Cryptography.ProtectedData` 时用 `powershell.exe` 跑 |
| 插件改动不生效 | 等约 3 秒热加载；仍不行重启 `opencode service`（本机有 `opencode service status/start`） |
| 装了新插件但模型看不到工具 | 检查 `opencode.json` 的 `plugins` 数组、插件文件是不是 `.ts`、`~\.config\opencode\node_modules` 里有没有 `@opencode/plugin` |
| `bsk` 卡住/连不上 | `bsk doctor`；确认 Chromium 里扩展已加载、Agent Window 没有被关；`~\.bsk\daemon.log.*` 有记录 |
| 代理环境下 git/npm 失败 | 直连 github 需要代理（本机是 `127.0.0.1:7890` 的 Clash 类工具；进程里 `NO_PROXY=127.0.0.1,localhost` 要保留） |
| 通过 OpenChamber/Web 用时某些 TUI 命令没有 | `/secret`、`/secrets` 这类只在 TUI 客户端有；Web/OpenChamber 里用不了（设计如此） |

### 附录 H：本机事实快照（迁移前的状态存档）

| 项 | 值 |
|---|---|
| 快照时间 | 2026-10-19 |
| OpenCode CLI | v2.0.25 |
| `@opencode/plugin`（部署依赖） | ^2.0.20 |
| Node / npm / git / pwsh | v24.14.0 / 11.9.0 / 2.39.1 / PowerShell 7 |
| bsk | 0.2.0 |
| grit 仓库分支 / origin | `opencode-v2` / github.com/niuxiaozu/opencode-grit |
| worktime 仓库分支 / origin | `opencode-v2` / github.com/niuxiaozu/opencode-worktime |
| 当前档 | `opencode-go`（build/explore/general/browse=opencode-go/deepseek-v4.1-flash；sage=opencode-go/glm-5.3；plan 归原生、不映射） |
| 部署副本与仓库一致性 | `plugins/grit.ts` 与仓库 `plugin/grit.ts` 哈希一致（`node scripts/install.mjs` 保证） |
| 冒烟基线 | `npx tsc --noEmit` 干净；`node harness/smoke.ts` 全过 |
| 密钥名字（值不在此） | `caddy.basic`、`router.admin`、`canary.value` |
| 已装全局 npm 包 | `@opencode/cli`、`@igovet/opencode-tui-tunnel`、`@anthropic-ai/claude-code`、`pnpm` |
| 可选 MCP | `frx-director`（disabled） |

---

## 8. 一页速通（TL;DR）

```powershell
# 1) 基础
npm install -g @opencode/cli ; opencode auth login
# 2) 仓库
mkdir D:\workspace\selfProjects\agent-worktemp ; cd D:\workspace\selfProjects\agent-worktemp
git clone -b opencode-v2 https://github.com/niuxiaozu/opencode-grit.git
git clone -b opencode-v2 https://github.com/niuxiaozu/opencode-worktime.git
# 3) 配置骨架
$cfg="$env:USERPROFILE\.config\opencode"; mkdir "$cfg\plugins","$cfg\skills","$cfg\commands","$cfg\agents","$cfg\state" -Force
#    → 写附录 A-1..A-4 四个文件 → cd $cfg ; npm install
# 4) grit
cd ..\grit ; npm install ; node scripts/install.mjs ; npx tsc --noEmit ; node harness/smoke.ts
# 5) worktime
cd ..\opencode-worktime ; powershell -ExecutionPolicy Bypass -File scripts/install.ps1
# 6) 自研插件（附录 B）→ $cfg\plugins\ ；sec 脚本（附录 C）→ ~\bin\ 并在 PATH
# 7) 技能（附录 D）→ ~\.agents\skills\browser-skill\ 与 $cfg\skills\openscad-cad\ ；装 OpenSCAD、配 bsk
# 8) 密钥：sec set caddy.basic / router.admin / canary.value
# 9) 验收：§3.12 表格逐条过
```
