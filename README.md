# grit — 轻量多代理套件（v3，面向 OpenCode v2）

原创的轻量多代理套件：让普通档模型靠提示词设计、纪律契约与编排，干出高难度的事。按**四维轻量**构建：token 轻量、工具轻量、机制轻量、agent 数轻量。
不是"零插件"，而是"小而准的插件"：**机制只有 4 件、工具只有 7 个、插件源码 0 行提示词**——契约与代理纪律全部外置为可读可改的文件。

> 设计依据：**[docs/DESIGN-v3.md](docs/DESIGN-v3.md)**（面向 OpenCode v2 的重设计；引导版 [DESIGN-v3.html](docs/DESIGN-v3.html)）｜需求决议：[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)｜omo 研究：[docs/OMO-RESEARCH.md](docs/OMO-RESEARCH.md)。
> 演进：foreman-buddy → omo-lite（v0.1 纯 md / v2.0 四机制）→ **grit v3**：把 agent 正文从 `agent.system` 改为**运行时追加的纪律块**，恢复 OpenCode 原生提示词与工具指导。

## v3 相对 v2 的核心变化（为什么）

| 变化 | 原因（依据与验证状态见下方注） |
|---|---|
| agent 不再写 `system`，改为 **`agents` 配置记录**（只写 mode/description/model/permissions） | OpenCode v2 里设 `agent.system` 会【整段替换】基础提示词，并跳过 provider 变体与工具指导；省略 system 才能保留内置 prompt（如 explore 的 `PROMPT_EXPLORE`） |
| 纪律正文移到 `contracts/discipline/*.md`，由插件**追加到系统提示词**（稳定内容） | 不碰原生层；内容不随会话变化、位置固定 ⇒ 前缀缓存不受影响 |
| 注入分两条通道：**稳定内容**（角色纪律）→ 系统提示词；**会话中触发的动态项**（激活标记 / 授权与退出提醒 / 压缩后契约恢复）→ 消息通道的带标签块 | 动态项只追加到尾部消息，不动已缓存前缀；来源可区分（标签） |
| **ULW 由工具进入/退出**：`/ulw` 消息携带授权标识，模型调 `ulw_enter(goal)`（校验标识）进入、`ulw_exit` 退出 | 文本嗅探（正则抓 `[GRIT:ULW:GOAL]`/`[GRIT:ULW:DONE]`）蹩脚且有时序问题；工具是结构化通道，目标作参数、进出显式、可幂等 |
| **进入校验**：`ulw_enter` 校验「上一条用户消息」是否含授权标识（`/ulw` 命令携带 `[GRIT:ULW:START]`），无则拒绝并告知模型 | 防止模型误触发进入 ULW；进入必须由用户的 `/ulw` 消息触发，且插件不保存额外状态 |
| 哨兵统一为 **`GRIT:ULW:*`**（自解释） | 旧 `grit:done:v1` 这类 `动作:v1` 单看无含义；现为「命名空间:模式:动作」 |
| 机制 B **不再扫描 todo**，完成由模型自判（调用 `ulw_exit`） | v2 **已删除 todowrite 工具**（官方：拖慢 agent）；grit 不重做 todo |
| **移除校准段机制** | 校准段难编写，且与 OpenCode 原生提示词机制冗余/冲突；交由原生机制承担，grit 不再注入 |
| `plan` 交回 **OpenCode 原生 plan 模式** | 用户手动切到 plan 才用它；grit 不再物化它的记录、不注入纪律（原生自带 `edit:deny` 权限与 Plan-mode 提醒已经够） |
| 名册 **5 席**（`plan` 交回原生；早前已移除 `factory`） | 造数/测试工作由 `general` 直接承担，不再单设席位 |
| 子代理可回 **`<grit-request>`** 向 build 提要求 | 简报自足是目标不是假设：缺信息时"问"比"自己乱摸"便宜。build 收到请求 → 先满足（多为跑一次 `explore`）→ 重派同一单元，每单元最多 2 轮 |
| `sage` 只负责**事前定方案**，不做事后复审 | 改完再让贵模型复核一遍等于把成本翻倍；验证归建它的人，只有卡死的执行难题才按 `<failure_recovery>` 升级 |

> **验证状态（2026-10-16 复审）**：`npx tsc --noEmit` 干净、`npm test`（`harness/smoke.ts`）全绿（DESIGN-v3 §11 的 V-9 已过）；V-4（省略 system 后 explore 内置提示词保留）、V-7（合成消息）、V-8（provider 作用域）**仍未做活体实测**——本表相关结论按「设计依据」读，不当「已验证」。
> 机制事实已按**安装版** `@opencode/schema` 2.0.20 的类型与事件清单核对（要点：v2 有 `session.idle`，**没有** `session.error`）。

## 组成

| 层 | 内容 | 说明 |
|---|---|---|
| 代理层 | 5 席（`agents/index.json` 定义 → opencode.json `agents` 记录） | build（主编排）/ explore（只读检索 + 放行 clone_repo）/ general（并行执行）/ **sage（顶级模型席位：判断力、世界知识、方案指定——总是交完整方案）** / browse（浏览器代理）。model/permissions 由 profile 物化。`plan` 不在名册里——它是 OpenCode 原生只读 plan 模式，用户手动切换使用 |
| 命令层 | `/ulw` `/ulw-exit` `/handoff` `/profile` | 原生斜杠命令。**命令正文只含哨兵 + 用户参数**（不混入 grit 模板文字）；指令由带标签块 `<grit-inject>` 注入**消息通道**（`/ulw-exit` 首行哨兵由插件识别，`/ulw` 按真实用户消息处理） |
| 契约层 | `contracts/ulw.md` + `contracts/discipline/*.md`（5 席各一份）+ `handoff-template.md` | 纪律正文外置；**运行时**追加，改文件即改纪律（无需重启）。注：原先还有一份共用的完成纪律 `_shared.md`，已于 2026-10-18 删除（那类"完成标准/不许删改判据"的强制规范归 ULW 模式，由契约承担） |
| profile 层 | `profiles/{default,opencode-go,deepseek,glm-max,strict,bare}.json` + `active` 指针 | 模型映射/纪律变体/行为参数/权限/机制开关，一键切换 |
| 插件层 | `plugins/grit.ts` 单文件 | 四机制 + 七工具，纯函数决策核 |

## 四机制（各自独立可关）

| 机制 | 干什么 | 开关 |
|---|---|---|
| A 契约注入器 | `/ulw` 授权 → 模型调 `ulw_enter` 进入（**契约作为一条真消息注入**，工具只回短确认）；之后注入 1 行激活标记（消息通道）；压缩完成后由 `session.compaction.ended` 事件重注入契约 | `features.contractInjector` |
| B 续跑器 | 仍处 ULW 时会话执行结束即自动"推一把"；护栏：2s 倒计时 / 指数退避 / 失败上限 / 停滞（响应指纹未变）/ 工具死循环 / 预算 / 用户打断 / abort 与超限即停 | `features.continuation` |
| C profile 引擎 | 启动自检；profile 工具（list/show/switch，改 opencode.json 的 agents 记录） | `features.profileEngine` |
| D token 快照 | 被动缓存，供占用率查询与续跑护栏 | 常开 |

总闸：环境变量 `GRIT_DISABLE=1`。全关 = 纯工具箱（`bare` profile 等价形态）。

**进入 / 退出 / 完成**：
- 进入：用户 `/ulw` → 该消息携带授权标识并指示模型设定目标 → 模型取「最近一次提出的任务」（在最近几轮里定位，未必是最后一条消息）调用 `ulw_enter({goal})`；插件校验「上一条用户消息」含授权标识才放行 → 插件用 `ctx.session.prompt` 把「契约 + 目标」作为一条真消息注入（落库，后续每轮都看得到），ULW 生效（无标识则拒绝并告知模型）。
- 完成：模型自判目标完成（每条判据都有真实证据）→ 调用 `ulw_exit({reason})` → 契约失效、续跑停止。
- 用户手动退出：`/ulw-exit`（插件**确定性**关闭，不依赖模型配合）。

## 哨兵命名

| 哨兵 | 含义 |
|---|---|
| `[GRIT:ULW:START]` | `/ulw` 命令首行：**授权标识**，`ulw_enter` 校验「上一条用户消息」含它才允许进入（插件不拦截，按真实用户消息处理） |
| `[GRIT:ULW:EXIT]` | `/ulw-exit` 命令首行，插件据此**确定性退出** |
| `[GRIT:ULW:CONTINUE]` | 续跑提示首行（防回声） |
| `[GRIT:ULW:ACTIVE]` | 激活标记（`<system-reminder>` 块内，携带目标） |
| `[GRIT:ULW:ARMED]` | 已授权未进入时的提醒（催模型调 `ulw_enter`） |
| `<!-- GRIT:ULW:CONTRACT -->` … `<!-- /GRIT:ULW:CONTRACT -->` | 契约块首尾哨兵（prompt 钩子据此识别"插件自己发的契约消息"，不当成用户插话） |
| `<GRIT-DISCIPLINE agent="build">` | 纪律段块（按 `event.agent` 追加；与 ULW 无关，常驻） |

## profile 切换

```bash
/profile opencode-go    # 会话内敲命令，模型会调 profile 工具切换
/profile                # 列出全部
```
**生效边界**（OpenCode v2）：机制开关/阈值 = **立即生效**；模型映射/权限 = **自动热生效（~3s）**——v2 监视配置目录，`agents` 记录被自动重载，**无需重启**。唯一例外：**已存在的会话保存着它自己的模型**，切 profile 不改当前会话模型，新子代理/新会话才取新模型。切换时会弹 TUI 提示框。
终端方式（零 API）：`grit profile`（列出）/ `grit profile <名字>`（切换）。

## 日常使用

- 平时：正常对话，6 代理按需 Tab/@/Subagent（build 常驻纪律只管编排/委派/升级/分档；验证标准、语气、禁止项已于 2026-10-18 移出到用户自己的 `AGENTS.md`）
- 持续工作：`/ulw [补充说明]` → 模型调 `ulw_enter` 声明目标 → 契约生效 → 连续推进（执行结束自动续跑，插话即打断）
- 退出：模型完成后自调 `ulw_exit`，或用户 `/ulw-exit`（确定性）
- 交接：`/handoff`，或契约内交接阶梯自动触发（≥45% 或压缩先到 → 立即；≥25% 且阶段性成果+下一阶段无关联 → 也交接；<25% 继续）
- 网页：`@browse`（开放研究/采集/驱动页面/UI 测试，URL+选择器+引文锚定）

## 安装 / 卸载

```bash
cd grit
node scripts/install.mjs            # 安装（备份 opencode.json → bak-grit；写 agents 记录；清理旧 md 代理）
node scripts/install.mjs uninstall # 卸载（还原配置 + 删 agents 记录 + 整删数据根）
grit profile strict                # 手动切某 profile（改 active 指针 + 更新 agents 记录）
```

安装后 agents 记录与插件由 OpenCode v2 自动热加载；个别未生效项（如命令注册表）再重启。回滚 = uninstall。

## QA（自吃狗粮：验收证据制）

```bash
npm run check   # tsc --noEmit
npm test        # 确定性冒烟：纯函数/哨兵/块/消息解析(指纹/工具循环)/续跑门矩阵/记录物化/插件形态(7 工具)
```

活体 smoke（人工，见 DESIGN-v3 §11 V-9）：`/ulw` → 模型调 `ulw_enter` 声明目标 → 契约以一条真消息注入（工具只回短确认）→ 纪律块与激活标记出现 → 执行结束自动续跑 → 模型调 `ulw_exit` 停止 → 用户 `/ulw-exit` 确定性停止 → `/profile` 切换（agents 记录热更新）→ 压缩完成后由 `session.compaction.ended` 重注入契约。

## 边界与互斥

- 与 OpenChamber / opencode-worktime / auto-handoff 技能共存，不重复建设。**约定互斥**：OpenChamber goal 驱动的会话不要敲 `/ulw`（两套续跑会叠加）；冲突时 `features.continuation.enabled=false` 或切 `bare` 一键关。
- 明确不做：重做 todo 工具、判据库/证据账本/独立验证器/专家验证、category、关键词触发 ULW、变体代理、per-家族双套正文、architect、把注入无标签地混进用户原文、把动态注入写进系统提示词、用 md 承载薄覆盖、改 v2 原生层（见 DESIGN-v3 §14）。

## 默认裁定（可改，见 DESIGN-v3 §15）

handoff 阈值 = 双阶梯（≥45% 立即；≥25% 条件交接）；max-failures 暂停 10min 自动解除；注入物 TUI 可见（透明可审计）；契约中文；进入 = 上一条用户消息含授权标识 + 模型调 `ulw_enter`；完成 = 模型调 `ulw_exit`。
