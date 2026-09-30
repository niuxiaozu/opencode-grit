# 更名公告

> **更名公告**：本项目已更名为 **grit**（原名 omo-lite，2026-09-20）。下文的 omo-lite/omo 字样为历史记录，一律指本套件。

# omo-lite v2.0 最终设计文档（终稿）

> 版本：v2.0-final｜需求基线：`docs/REQUIREMENTS.md` 全部决议（R1–R14），不可违背｜参考：`docs/OMO-RESEARCH.md`、omo 源码、v0.1 遗产、设计稿 A（`docs/DESIGN-a.md`）与设计稿 B（`docs/DESIGN-b.md`）
> 本文是 implementation-ready 规格书：所有阈值、文件名、字段名、哨兵字符串均为**最终值**，实现者直接照抄。
> 产出流程：设计稿 A（助手独立）+ 设计稿 B（专家独立，仅见需求）→ 专家综合评判 → 本终稿。

---

## 0. 综合评判结论（A/B 逐模块取舍）

| 模块 | 结论 |
|---|---|
| 架构分层 | **以 B 为骨架**（state/ 持久化 + log/ 决策日志是 R5"重载存活"与痛点 1 的硬需求，A 缺失）；吸收 A 的环境变量总开关。 |
| 代理层 | **B 的物化方案**胜 A 的 config 钩子改注册表：产物是可 diff 的 md 文件，可确定性测试，避开钩子时序无文档保证的风险；A 的"md 自带 model/permission 默认值"被否——与 profile 双源冲突。 |
| 命令层 | **B**：/profile 走工具调用而非 A 的命令文本前缀识别——不给插件增加任何文本匹配面（零误触发优先）。 |
| 插件机制 | **B 的 transform 尾部标记**胜 A 的"每条用户消息持久追加标记"：A 方案在纯续跑期（消息源为插件注入）可能收不到 chat.message，标记恰在最需要时缺席；且持久标记污染历史。吸收 A 的 `OMO_LITE_DISABLE` 环境开关。 |
| 续跑状态机 | **B 的 13 门 + stop/pause 二级语义**（A 仅 9 门且未定义 abort 语义）；A 的"主会话检查"并入 G2 说明（子代理会话无 ULW state，天然被滤除）。 |
| 契约注入 | **B 的哨兵协议**（首行整行精确匹配 + 版本号）；A 的"compacted→下条消息重注"依赖注入消息是否过 chat.message（不确定），B 的"transform 固定早位置重插"确定且缓存友好。 |
| profile 系统 | **B**：A 的 `agents/variants/build.strict.md` 会被 opencode 当作名为 `build.strict` 的代理注册（违背"agent 数轻量"），改用 B 的 `omo-lite/variants/`；变体语义取 B 的**追加**（基线改进自动继承）否 A 的替换；吸收 A"生效边界写进 profile 工具返回值"。 |
| 契约文本 | **B 按 R9 七项编号**（A 挪动了七项构成，可追溯性差）；吸收 A 的"全文行数上限"纪律（定 ≤90 行）。 |
| 工具面 | **B**：profile 工具用 action 枚举（list/show/switch）覆盖 A 的单一 switch；其余同 v0.1 四件保留。 |
| 验收证据制 / 生效边界 / 安装验证 | **B 为准**，吸收 A 的 tsc/frontmatter/JSON 解析检查与"边界信息进工具返回值"。 |

两稿无根本路线冲突（同为：命令哨兵入口 + 插件四机制 + 外置契约/profile），终稿为 B 骨架 + A 的三个局部改进。

---

## 1. 需求映射表（R1–R14 逐条着落）

| 决议 | 摘要 | 着落 |
|---|---|---|
| R1 | 四痛点 | §2 原则 P1–P4；§5 纯函数决策核 + 逐决策日志 |
| R2 | 轻量四维度；允许插件动态切 agent 设定 | §2.5 预算表；§7 机制 C 物化 |
| R3 | 6 代理、无变体代理、模型切换重启生效 | §3；变体=提示词追加段，代理恒 6 个 |
| R4 | ULW 唯一入口 `/ulw` | §7.2 首行哨兵精确匹配，全项目无关键词正则 |
| R5 | 全量 1 次 + 每轮 1 行 + 压缩恢复 + stop 清除 | §7.3–§7.6 |
| R6 | todo 驱动续跑 + 全套护栏 | §7.7 门序列 G1–G13 |
| R7/R8 | profile：模型映射/提示词变体/行为/权限；外置 JSON、命令+LLM 可切、部分热生效 | §8 |
| R9 | 契约七项 + 校准段三份（default/glm/deepseek），profile 指定 | §9.2、§9.3 |
| R10 | 七项纪律只在注入层；常驻层轻量 | §3.3 |
| R11 | 契约外置，插件只读与拼装 | §9.1；插件源码零提示词 |
| R12（待定项） | 指针/变体组织/命令文本/机制清单/工具去留/安装形态 | §8.2、§8.4、§4、§7、§10、§13 |
| R13/R14 | 验收证据制、去 TDD | §11 |
| 落地 | 重构现有插件项目 | §16 实现顺序 |

---

## 2. 设计原则

**P1 可改性——纯函数决策核 + 薄 IO 壳**（反 foreman-buddy）
所有状态机是纯函数 `decide(state, event) → {action, newState}`，挂在插件 default 导出对象上可单测；钩子只做"取数→调纯函数→执行"。每次跳过/注入写一行日志。物化产物是可直接打开看的 md 文件——出问题不需要读代码推演。

**P2 零误触发——入口唯一 + 哨兵精确匹配**
ULW 唯一入口是 `/ulw` 展开后的**首行整行精确匹配**。全项目文本匹配仅两处（/ulw、/stop-continuation 首行哨兵），无子串、无正则、无事件推断。插件自身一切注入物带内部哨兵，钩子见自己的哨兵一律跳过（协议级防回声）。

**P3 循环可控——门序列 + 多重熔断**
续跑注入必过 13 道门；熔断五层（冷却退避/失败上限/停滞/打断暂停/abort与超限即停）；终态与暂停二级语义明确（§7.7.3）；`/ulw` 或 `/stop-continuation` 显式复位。

**P4 token 意识——注入三问（注什么/多少/何时）**
每个注入点在 §5.4 台账标注。结构手段：常驻层瘦身、全量契约持久化一次、每轮标记一行且非持久、压缩恢复插在固定早位置保前缀缓存、一切注入只追加尾部或稳定位置**永不改写历史**。

**P5 比 omo 轻量（量化承诺）**
机制 4 个 + 工具 6 个 + 内嵌提示词 0 行（omo：100 个 hook 目录、30+ 机制、337 行内嵌契约）；每机制一个 profile 开关独立可关，另加环境变量总开关。

---

## 3. 总体架构与目录结构

### 3.1 分层

```
┌────────────────────────────────────────────────────────────┐
│ 静态层（opencode 原生，重启加载，插件零参与）                  │
│ agents/*.md（物化产物）  commands/*.md                        │
├────────────────────────────────────────────────────────────┤
│ 插件层 plugins/omo-lite.ts（单文件：纯函数核 + 薄壳）           │
│ A contract-injector   B todo-continuation                    │
│ C profile-engine      D token-snapshot（被动）                │
│ 工具：context_usage/system_time/clone_repo/handoff/profile    │
├────────────────────────────────────────────────────────────┤
│ 数据层 ~/.config/opencode/omo-lite/                           │
│ contracts/ profiles/(含 active 指针) variants/ scripts/       │
│ state/ log/                                                  │
└────────────────────────────────────────────────────────────┘
```

共存边界：OpenChamber（goal/schedule/会话）、opencode-worktime（暂停恢复）、auto-handoff 技能——不动不复建。omo-lite 只管会话内代理阵容、ULW 契约与续跑、profile 切换。互斥约定见 §15-Q1。

### 3.2 仓库布局（D:\workspace\selfProjects\agent-worktemp\omo-lite）

```
omo-lite/
├── agents/                          # 6 个基线代理 md（原料，frontmatter 只写 description+mode）
│   ├── build.md  plan.md  explore.md  general.md  expert.md  factory.md
├── commands/
│   ├── ulw.md  stop-continuation.md  handoff.md  profile.md
├── contracts/
│   ├── ulw.md                       # 七项纪律 + {{calibration}} + {{handoff_template}} 槽位
│   ├── handoff-template.md          # 交接摘要模板（单一来源）
│   └── calibration/{default.md, glm.md, deepseek.md}
├── profiles/
│   ├── default.json  glm-max.json  strict.json  bare.json
├── variants/
│   └── strict/agents/build.md       # strict profile 给 build 的追加段
├── plugin/
│   └── omo-lite.ts                  # 唯一插件文件
├── scripts/
│   ├── materialize-core.mjs         # 物化纯函数核（唯一定义点，插件与 CLI 共用）
│   ├── materialize.mjs              # CLI 壳：node materialize.mjs [--profile <name>]
│   └── install.mjs                  # 安装/卸载
├── harness/                         # 确定性测试（§13.3）
├── docs/  package.json  tsconfig.json  README.md
```

### 3.3 部署后布局（~/.config/opencode/）

```
~/.config/opencode/
├── opencode.json                    # 不含 agent 块（md 是唯一来源）；install 只删不写
├── agents/{build,plan,explore,general,expert,factory}.md   # ← 物化产物
├── commands/{ulw,stop-continuation,handoff,profile}.md
├── plugins/omo-lite.ts
└── omo-lite/                        # 插件数据根（卸载整目录删除）
    ├── contracts/…  profiles/…（含 active）  variants/…
    ├── scripts/{materialize-core.mjs, materialize.mjs}
    ├── state/<sessionID>.json       # ULW 会话状态
    └── log/omo-lite.log             # 逐决策日志（>2MB 截断）
```

插件定位数据根：`process.env.OMO_LITE_HOME ?? join(USERPROFILE ?? HOME, ".config", "opencode", "omo-lite")`（OMO_LITE_HOME 供测试覆写）。插件以相对路径 `import "../omo-lite/scripts/materialize-core.mjs"` 引物化核——**物化逻辑全项目唯一定义点**，插件内调用不 spawn 子进程，CLI/install/harness 与之共用。

---

## 4. 代理层

### 4.1 基线 md 与 frontmatter 约定

仓库 `agents/*.md` 是物化原料，frontmatter 仅两项：

```markdown
---
description: <英文，供 Task 工具路由——子代理被选中的唯一依据，含 use-when 语义>
mode: primary | subagent | all
---
<正文 = 基线提示词>
```

`model` 与 `permission` **不写在基线文件**——归 profile 管辖，由物化器注入（§8.4），杜绝"md 写死模型、profile 改不动"的双源冲突。

| 代理 | mode | default profile 模型 | 角色 |
|---|---|---|---|
| build | primary | zhipuai-coding-plan/glm-5.3-flash | 主编排（默认代理） |
| plan | all | zhipuai-coding-plan/glm-5.3 | 规划顾问，只产出计划 |
| explore | subagent | zhipuai-coding-plan/glm-5.3-flash | 只读检索（项目+依赖源码；经 clone_repo 覆盖 scout） |
| general | subagent | zhipuai-coding-plan/glm-5.3-flash | 并行执行器/研究员（叶子工人） |
| expert | all | zhipuai-coding-plan/glm-5.3 | 贵档升级顾问（只读咨询） |
| factory | subagent | zhipuai-coding-plan/glm-5.3-flash | 造假数据/fixture/数据驱动测试 |

R3 合规：无变体代理；"strict"是给既有代理的**追加段**，代理数量恒为 6。

### 4.2 权限基线（default/strict/glm-max profile 物化注入）

- build：`permission: { task: { "*": "deny", plan: "allow", explore: "allow", general: "allow", expert: "allow", factory: "allow" } }`（禁套娃，白名单收口）
- factory：`permission: { task: "deny" }`
- 其余代理不注入 permission。

### 4.3 build 常驻提示词段落范围（R10）

七段，`<ulw>` 常驻段从 v0.1 的 26 行缩为 4 行指针：

```
<identity>      档位自知 + 升级纪律摘要（沿用 v0.1）
<search-rule>   两类检索：穷举→explore / 定点→自读（沿用 v0.1）
<struggle-rule> expert 升级三条件 + 咨询上下文四件套（沿用 v0.1）
<delegate>      6 段式委派契约 + 分工表（沿用 v0.1）
<verify>        V1/V2/V3 分级 + "NO EVIDENCE = NOT COMPLETE"（验收证据制在常驻层只提这一句——R10）
<ulw-pointer>   4 行：ULW 契约由 /ulw 命令触发注入（七项纪律+校准段）；未注入时本节不适用；
                契约一旦出现在会话历史中即持续有效，无需重新确认
<hard-blocks> / <style>（沿用 v0.1）
```

其余 5 个代理沿用 v0.1 正文（factory 保留强终止条款"STOP after first successful verification. Maximum status checks: 2."）。

---

## 5. 插件机制总览与全局约定

### 5.1 四机制与钩子分配

| 机制 | 钩子 | 状态 | 持久化 | 开关 |
|---|---|---|---|---|
| **A contract-injector** | `chat.message`；`experimental.chat.messages.transform`；`event: session.compacted` | ULW 会话态 | `state/<sessionID>.json` | `features.contractInjector.enabled` |
| **B todo-continuation** | `event: session.idle / session.error / message.updated / message.part.updated`；`tool.execute.before/after`；查询 `client.session.todo / messages` | 护栏计数器（内存）+ ULW 态（盘） | ULW 态在盘 | `features.todoContinuation.enabled` + 全部阈值 |
| **C profile-engine** | `chat.params`；`config`（**仅启动自检，不改配置**）；`profile` 工具 | profile 缓存 3s TTL | `profiles/active` | `features.profileEngine.enabled` |
| **D token-snapshot** | `event: message.updated / message.part.updated`（只读缓存） | 内存 Map | 无 | 常开（无注入面；A/B 的数据源） |

开关优先级：`OMO_LITE_DISABLE=1`（环境变量，总闸，机制全关、工具保留）> profile `features.*.enabled`（3s TTL 热读）。独立关停效果：A 关 = /ulw 只剩命令短模板；B 关 = 回到纯提示级 ULW（v0.1 形态）；C 关 = chat.params 直通、profile 工具只读（list/show）；全关 = 插件退化为 v0.1 纯工具箱（bare.json 即此形态）。

### 5.2 防回声协议（全局）

插件产生的每类注入物有首行哨兵（下表）。任何钩子处理任何消息前先查：**首行整行精确等于**任一内部哨兵 → 跳过全部触发逻辑。消息中部引用、代码块内复述、子串变体一律不命中。

**哨兵总表（最终值，实现照抄）**

| 哨兵字符串 | 出现在 | 作用 |
|---|---|---|
| `[omo-lite:ulw:v1]` | /ulw 命令展开首行 | 触发全量契约注入 + 激活 state |
| `[omo-lite:ulw-stop:v1]` | /stop-continuation 展开首行 | state.active=false（stopReason=manual） |
| `[omo-lite:continue:v1]` | 续跑注入/建清单提醒首行（插件产生） | 自我识别防回声；真实用户消息判定依据 |
| `<!-- omo-lite:ulw-contract:v1 -->` | 契约块首行 | 压缩恢复探测标记 |
| `<!-- /omo-lite:ulw-contract -->` | 契约块尾行 | 契约块闭合（探测时二取一即可判定在场） |
| `[omo-lite:ulw-active]` | 每轮标记行 | 标记幂等 + 日志可辨 |

### 5.3 状态与持久化

`state/<sessionID>.json`（原子写：同目录 tmp 文件 + rename）：

```jsonc
{
  "schemaVersion": 1,
  "sessionID": "ses_xxx",
  "directory": "D:\\ws\\proj",
  "active": true,
  "objective": "完成 omo-lite v2 落地",
  "epoch": 3,                          // 每次 /ulw 重开 +1；内存计数器随 epoch 清零
  "activatedAt": 1726700000000,
  "contractFingerprint": "sha1:9f2c…",  // 已注入契约块指纹（恢复时比对）
  "stopReason": null,                   // manual|aborted|stagnated|completed|context-overflow|injection-budget|null
  "pauseReason": null,                  // user-interruption|max-failures|directive-response|null（active 保持 true）
  "totalInjections": 27,
  "missingTodoNudgeUsed": false
}
```

- **重载/重启存活**：所有钩子遇内存无此会话记录时懒加载 state 文件（R5 要求的持久化）。
- 护栏计数器（lastInjectedAt、consecutiveFailures、stagnationCount、awaitingProgress、responseObserved、countdown 定时器）**只在内存**——重载归零 = 冷却重来，是安全方向，且避免盘上状态机（foreman-buddy 之死）。
- 清理：按 mtime TTL 14 天清扫 state 文件；log 单文件 >2MB 截断。
- 日志格式：`<ISO8601> [a|b|c|d] s=<sessionID前8> <ACTION> k=v …`，例：`2026-09-19T14:03:11 [b] s=ses_1a2b3c4d SKIP reason=cooldown remainMs=12000`。

### 5.4 注入面 token 台账（P4 三问汇总，最终值）

| # | 注入物 | 内容 | 规模（估） | 何时 | 缓存性质 |
|---|---|---|---|---|---|
| 1 | build 常驻 system prompt | 七段骨架 | ~1.0–1.2K | 会话建立 1 次 | 缓存前缀 |
| 2 | 工具描述（6 工具） | description+schema | ~350 | 每会话常驻 | 缓存前缀 |
| 3 | /ulw 命令展开 | 哨兵+目标+首步指令 | ~150 | 敲命令 1 次 | 用户消息入前缀 |
| 4 | 全量契约 | ulw.md+校准段+handoff 模板 | ~1.4–1.8K | 每次 /ulw 1 次（追加进该用户消息，持久化） | 入缓存前缀，此后≈0 边际 |
| 5 | 每轮标记 | `[omo-lite:ulw-active] …` 一行 | ~35 | ULW 激活期每次模型请求（ephemeral） | 尾部增量 |
| 6 | 压缩恢复 | 全量契约块 | ~1.5K | 压缩后哨兵丢失期间每次请求（ephemeral，index 1 固定位置） | 稳定早位置，cache-read 计价 |
| 7 | 续跑提示/建清单提醒 | 哨兵+状态行+todo 快照 | ~120–200 | 每次过 13 门的注入 | 新用户消息入前缀 |

非注入面（profile/state/log）零 token。

---

## 6. 命令层（4 个命令，最终模板职责）

| 命令 | 形态 | 插件配合 | 理由 |
|---|---|---|---|
| `/ulw <目标>` | 短模板（首行哨兵 + 目标 + ~10 行首步指令） | **要**（机制 A） | 契约须按 profile 现读现拼（R11），静态模板做不到；插件在 chat.message 追加全量契约 |
| `/stop-continuation` | 短模板（首行哨兵 + 收尾指令） | **要**（机制 A 清 state） | 停止必须确定性（痛点 2）：模型忽略文本指令，state 也已被哨兵清除 |
| `/handoff` | 纯模板 + handoff 工具 | 不要 | v0.1 已验证；无状态 |
| `/profile <name>` | 短模板，指示模型调用 `profile` 工具 | **要**（工具即确定性路径） | 走工具调用而非插件识别命令文本——零新增匹配面；用户手敲或对话说"切 profile"同路 |

命令模板正文**不承载契约**（契约在 contracts/，插件拼装），与契约改动解耦。`/ulw` 模板最终形态：首行 `[omo-lite:ulw:v1]`；`目标：$ARGUMENTS`；空参时"从会话上下文提炼一条跨轮有效的方向性目标（一次性说明只进 todo 条目）"；随后指令：①立即 todowrite 建清单（唯一进度依据，单 in_progress，验证后才 completed，阶段性发现写进 todo 条目，不写项目内文件）②不停下等确认，完整纪律见随后注入的契约。`/profile` 模板正文：调用 `profile` 工具（action=switch, name=$ARGUMENTS；空参则 action=list），并把工具返回的生效边界复述给用户。

---

## 7. 四机制详设

### 7.1 机制 C：profile-engine（先讲 C，因 A/B 依赖其热读）

- **chat.params**：`features.profileEngine.enabled && params.apply` 时，把 active profile `params` 中非 null 字段（temperature/topP/variant）合入返回值；任一都为 null 则直通。端点拒绝参数导致 400 时用户置 `params.apply=false`（README + 工具返回值注明）。
- **config 钩子（仅自检，不改配置）**：启动时依次检查并记日志——① `OMO_LITE_DISABLE`；② active 指针存在且 profile JSON 可解析（materialize-core 的 `validateProfile`）；③ contracts/ulw.md 与 `calibration/<calibration>.md` 存在（缺则 WARN，/ulw 时降级为"契约文件缺失"提示，不崩）；④ 部署 agents/*.md 尾部物化标记与 active 一致（不一致 WARN"运行 node …/materialize.mjs 并重启"）。fail loud, degrade soft。
- **profile 工具**：见 §10。

### 7.2 机制 A：contract-injector —— 全量契约注入

触发：`chat.message`，消息首行整行 === `[omo-lite:ulw:v1]`。

1. 读/建 state：已 active → 视为重开（epoch+1，计数器清零，日志 re-arm）；新建 → active=true，epoch=1。
2. 现读拼装：`contracts/ulw.md`，`{{calibration}}` ← `contracts/calibration/<activeProfile.calibration>.md`，`{{handoff_template}}` ← `contracts/handoff-template.md`。契约块首尾加包裹哨兵行（§5.2 表）。
3. **追加到该用户消息尾部**（首次发送前，直接入缓存前缀）；objective = 命令模板"目标："行的值（空则置空串，由首轮 todo 落定后日志补记）；`contractFingerprint = sha1(契约块)`；原子写 state。
4. 剥离防护：若消息已含契约首哨兵（异常路径）不重复追加。

【注入】#4：~1.4–1.8K，每次 /ulw 一次。

### 7.3 每轮一行激活标记

`experimental.chat.messages.transform`（每次模型请求前回调，非持久）：
- 前置：state.active && stopReason==null && pauseReason==null；无 state 的会话零开销直接返回原数组。
- 动作：最后一条消息是 user 角色 → 在其文本尾部追加一行；否则（如最后是 assistant）→ 追加一条仅含标记行的合成 user 消息。标记行最终文本：

```
[omo-lite:ulw-active] 持续工作模式进行中（目标：<objective 截 60 字>）。已注入的纪律契约持续有效，按 todo 清单继续推进。
```

- 幂等：transform 见到的是原始历史（标记从不持久化），每次现拼现加不累积；防御性检查目标消息已含标记行则不再加。
- 失效开放（fail-open）：transform 入参结构异常 → 原样返回 + 记日志（坏的是标记，不坏会话）。

【注入】#5：~35 tokens/请求。

### 7.4 压缩后恢复（R5）

探测（双保险）：① `event: session.compacted` → 置内存恢复标记；② transform 时扫描消息数组：state.active 但**任何持久化消息中既无契约首哨兵也无尾哨兵** → 契约已被压缩吞掉。
恢复动作：在消息数组 **index 1**（首条消息——压缩摘要——之后；数组空则 index 0）插入一条合成 user 消息，内容 = 现读现拼的契约块（按 fingerprint 与首注同源）。位置固定 → 整块落在缓存前缀，逐轮只付 cache-read 价。恢复期间每轮 transform 都重插（非持久本性），探测条件即状态——**没有会卡死的"恢复模式"标志**。

【注入】#6：~1.5K/请求，仅压缩后。

### 7.5 /stop-continuation 清除

`chat.message` 首行 === `[omo-lite:ulw-stop:v1]` → state：active=false、stopReason=manual、pauseReason=null，原子落盘。标记停、恢复停、续跑器 G2 拦截。等价终态途径：Esc（aborted）、G5 停滞、G8 完成、G12 超限、G13 预算。清除永远确定性。

### 7.6 机制 A 与 B 的分工

A 管"契约在场"（全量/标记/恢复），B 管"继续干活"（idle 门序列）。两者仅经 state 文件耦合（active/epoch/stopReason/pauseReason）。关 A 留 B：续跑继续但无契约；关 B 留 A：契约在场、用户手敲"继续"驱动。

### 7.7 机制 B：todo-continuation —— 续跑状态机（R6）

#### 7.7.1 数据流

```
session.idle ─→ 取数（todos/messages/token快照/state）
             ─→ decideContinuation(state, ctx)   纯函数 → {action, newState}
             ─→ action ∈ {countdown | inject-nudge | skip:<reason> | stop:<reason> | pause:<reason>}
非 idle 事件 ─→ observeEvent(state, event)        纯函数：分类用户打断/助手应答/abort/压缩
```

只处理持有 ULW state 的会话（即主会话——子代理会话从未收到 /ulw，天然被 G2 滤除；OpenChamber 子会话同理）。

#### 7.7.2 门序列（session.idle 时按序，任一不过即执行该行动作并记日志）

| 门 | 检查 | 不过的动作 |
|---|---|---|
| G1 | `features.todoContinuation.enabled`（且非 OMO_LITE_DISABLE） | skip:disabled |
| G2 | state.active（懒加载盘）且 stopReason==null | 否则 skip:not-active / skip:stopped |
| G3 | 无倒计时挂起、无注入 in-flight | skip:in-flight |
| G4 | abort 窗口：`abortWindowMs`=3000ms 内有 abort 事件（竞态防御；abort 本身已是终态） | skip:abort-window |
| G5 | turn-boundary：awaitingProgress && responseObserved && todo 无进展 | pause:directive-response 且 stagnation++；stagnation ≥ `maxStagnation`=3 → **stop:stagnated** |
| G6 | 存在未消化的真实用户消息 | **pause:user-interruption**（取消一切待注入） |
| G7 | todos 为空 | 本 epoch 未用过 → **inject-nudge**（建清单提醒，`missingTodoNudgeUsed=true`，计入冷却与总量）；用过 → skip:no-todos |
| G8 | todos 全部 completed | **stop:completed**（active=false） |
| G9 | 冷却：`now-lastInjectedAt < cooldownBaseMs × 2^min(consecutiveFailures, backoffPowCap)` | skip:cooldown（5000ms→10s→…→160s 封顶） |
| G10 | consecutiveFailures ≥ `maxConsecutiveFailures`=5 | **pause:max-failures**（`failureResetWindowMs`=600000 自动解除并清零） |
| G11 | 上下文占用 ≥ `contextSkipPct`=85%（token-snapshot；无快照放行） | skip:context-high（每 epoch 一次附带提醒 handoff 的日志） |
| G12 | token-limit 错误标记 | **stop:context-overflow** |
| G13 | totalInjections ≥ `maxTotalInjections`=200（本 epoch） | **stop:injection-budget** |

全过 → **倒计时 → 注入**。

#### 7.7.3 终态（stop）与暂停（pause）语义——最终裁定

| 类别 | 值 | 解除途径 |
|---|---|---|
| stop（active=false，一切停） | manual / aborted / stagnated / completed / context-overflow / injection-budget | 仅 `/ulw` 重开（epoch+1，计数清零） |
| pause（active=true，注入被阻） | user-interruption | 真实 todo 进展（completed 数增加或 id→status 快照变化）或 /ulw 重开 |
| pause | max-failures | `failureResetWindowMs`=10min 自动解除、真实 todo 进展、或 /ulw 重开 |
| pause | directive-response | 真实 todo 进展或 /ulw 重开（实际效果=等待用户推动） |

#### 7.7.4 倒计时（R6「2 秒窗口」）

`countdownSeconds`=2（可调）。窗口内任何事件即取消：真实用户消息（无哨兵）、abort、会话转 busy、session.error。打字即取消，无需 UI。无原生 toast API 则静默执行；注入物首行哨兵在 TUI 可见（透明优先，§15-Q4）。到期执行注入：`client.session.promptAsync`（**不传 parentID**，同目录主会话），消息文本最终形态：

```
[omo-lite:continue:v1]
未完成任务仍在清单中，继续推进下一个待办项。
- 无需请示；完成并验证一项后立即标记 completed
- 清单全部完成才收尾；若认为已全部完成，先从怀疑角度逐项复核再更新清单
[progress: <done>/<total> completed, <remaining> remaining]
- [pending] <todo 内容>
…（≤ todoListMaxItems=10 条，超出加"…等 N 项"）
```

建清单提醒（G7 nudge）文本：`[omo-lite:continue:v1]\n持续工作模式已激活但尚无任务清单——立即用 todowrite 创建清单并开始第一项。`
注入成功后：lastInjectedAt=now、awaitingProgress=true、responseObserved=false、totalInjections++、consecutiveFailures=0、pauseReason∈{directive-response} 清除。注入抛错：consecutiveFailures++（计入退避）；错误为 token-limit → 直接 stop:context-overflow。

#### 7.7.5 非 idle 事件分类（observeEvent，纯函数）

| 事件 | 分类 | 效果 |
|---|---|---|
| message.updated / message.part.updated，role=user，首行**无**任何内部哨兵 | 真实用户消息 | 取消倒计时；pause:user-interruption |
| 同上但首行命中任一哨兵 | 插件注入物 | 跳过（防回声） |
| message.updated，role=assistant | 模型应答 | responseObserved=true |
| tool.execute.before / tool.execute.after | 模型活动 | responseObserved=true |
| session.error（abort / AbortError / MessageAborted） | 用户按 Esc | **stop:aborted**（最保守解释，零误续跑） |
| session.error（token limit / context overflow） | 超限 | **stop:context-overflow** |
| session.compacted | 压缩 | 转机制 A 恢复；护栏计数器与 epoch 保留 |

todo 进展判定（omo 生产值采纳）：completed 计数增加 **或** `id→status` 快照变化；内容/priority 改动不算进展（不重置停滞计数）。

#### 7.7.6 阈值总表（最终值，全部 profile 可调）

`countdownSeconds=2｜cooldownBaseMs=5000｜backoffPowCap=5｜maxConsecutiveFailures=5｜failureResetWindowMs=600000｜maxStagnation=3｜abortWindowMs=3000｜contextSkipPct=85｜maxTotalInjections=200｜todoListMaxItems=10｜DEFAULT_CONTEXT_LIMIT=1_000_000｜handoff 提示阈值 45%（契约文本项，非插件参数）`
依据：冷却/退避/失败上限/停滞/abort 窗口取 omo 生产同名值；失败重置窗 5→10min（GLM flash 重试更慢热）；G13 总量熔断为本设计加码（治"循环失控"痛点）。

---

## 8. profile 系统（R7/R8）

### 8.1 schema（最终版，`profiles/*.json`）

```jsonc
{
  "name": "strict",                          // = 文件名去 .json，必填
  "description": "贵档+严格纪律：重要落地工作",
  "model": {                                 // 【重启】物化注入 frontmatter；缺某键 → 取 default.json 同键值
    "build": "zhipuai-coding-plan/glm-5.3",
    "plan": "zhipuai-coding-plan/glm-5.3",
    "explore": "zhipuai-coding-plan/glm-5.3-flash",
    "general": "zhipuai-coding-plan/glm-5.3-flash",
    "expert": "zhipuai-coding-plan/glm-5.3",
    "factory": "zhipuai-coding-plan/glm-5.3-flash"
  },
  "calibration": "glm",                      // 【热】下次 /ulw 注入时绑定；中途切换不追溯已注入契约
  "promptVariants": { "build": "strict" },   // 【重启】→ variants/strict/agents/build.md 追加到基线正文尾
  "params": {                                // 【热】chat.params 逐请求应用
    "apply": true,                           //   端点拒绝 temperature 时置 false 直通
    "temperature": null, "topP": null, "variant": null   // null = 不设置
  },
  "permissions": {                           // 【重启】物化注入；仅列覆盖项（§4.2）
    "build": { "task": { "*": "deny", "plan": "allow", "explore": "allow",
                         "general": "allow", "expert": "allow", "factory": "allow" } }
  },
  "features": {                              // 【热】事件级 3s TTL 热读
    "contractInjector": { "enabled": true },
    "todoContinuation": {
      "enabled": true, "countdownSeconds": 2, "cooldownBaseMs": 5000,
      "backoffPowCap": 5, "maxConsecutiveFailures": 5, "failureResetWindowMs": 600000,
      "maxStagnation": 3, "abortWindowMs": 3000, "contextSkipPct": 85,
      "maxTotalInjections": 200, "todoListMaxItems": 10
    },
    "profileEngine": { "enabled": true }
  }
}
```

`validateProfile(obj)`（materialize-core 导出）：name 非空且与文件名一致、model 值为合法 `provider/model` 串、calibration ∈ 三份文件名、features 数值字段为正数且在合理区间；未知字段 WARN 不拒收。

### 8.2 四份起步 profile（最终名单）

| 文件 | 定位 |
|---|---|
| `default.json` | flash 主力（§4.1 表的模型映射、calibration=glm、机制全开、无变体） |
| `glm-max.json` | 贵档全量（build/expert/plan=glm-5.3，calibration=glm） |
| `strict.json` | 贵档 + `promptVariants.build="strict"`（追加严格纪律段） |
| `bare.json` | 全机制关（features 全 false）——救火/纯净模式，等价 v0.1 工具箱 |

### 8.3 激活指针与切换途径

指针：`~/.config/opencode/omo-lite/profiles/active`——纯文本，内容 = profile 名 + 换行。选纯文本而非写 opencode.json：宿主配置归用户，插件只写自家目录（原子写、可 diff、卸载即删）。

切换三入口：① `profile` 工具（LLM 可调，/profile 命令或对话触发）——校验 → 原子写 active → 调 materialize-core 重物化 agents → 返回生效边界文本；② 手编 active 文件（之后手跑 `node …/materialize.mjs` 并重启）；③ install 写 default。

### 8.4 物化器（materialize-core.mjs，唯一定义点）

纯函数（无网络、确定性，同输入同字节输出）：

```
materializeAll({ agentsSrcDir, outDir, profilesDir, activeName, variantsDir })
deployed <name>.md =
  "---\n" + 基线 frontmatter（description, mode 原样）
  + "model: <profile.model[name] ?? default.model[name]>\n"
  + (profile.permissions[name] 存在 ? "permission:\n<YAML 序列化>" : "")
  + "---\n\n" + 基线正文
  + (promptVariants[name] 存在 ? "\n\n" + variants/<v>/agents/<name>.md 全文 : "")
  + "\n<!-- omo-lite:materialized profile=<name> sha1=<内容指纹> -->\n"
```

**追加而非替换**（裁定）：基线提示词的改进自动被所有 profile 继承，变体只表达额外纪律；替换式会让基线迭代与变体漂移。幂等：尾部物化标记供 config 自检比对与 harness 断言。CLI 壳 `materialize.mjs` 支持 `--profile <name>`（临时物化指定 profile，不写指针）。profile 工具在插件内直接 import core 调用（相对路径 `../omo-lite/scripts/materialize-core.mjs`，bun 解析），不 spawn 子进程。

**为什么不用 config 钩子改 agent 注册表**：注册表启动加载无热更新（改了也要重启，与物化等价）；config 返回定义与 md 同名 agent 的合并顺序无文档保证；物化产物是可读可 diff 的 md——P1 的根本。

---

## 9. 契约文本组织（R9/R11）

### 9.1 目录与拼装

```
contracts/
├── ulw.md                  # ≤90 行（吸收 A 稿行数上限纪律）；槽位 {{calibration}}、{{handoff_template}}
├── handoff-template.md     # 五段交接模板（单一来源；/handoff 命令模板内嵌同文本副本，
│                           #   两文件头部互锚注释：改则同改——命令无法读外部文件，此为唯一受控重复）
└── calibration/{default.md, glm.md, deepseek.md}   # 每份 25–35 行
```

插件源码零契约文本；拼装仅发生在 /ulw 注入时（现读，改契约无需重启）。契约语言：**中文**（§15-Q6）。

### 9.2 ulw.md 结构（七项按 R9 编号 + 模式前言 + 附录）

```
<ulw-contract v1>
【0. 模式声明与目标自设】本模式由 /ulw 开启；目标=命令参数；空参时从上下文提炼一条
    跨轮有效的方向性目标（一次性说明只进 todo 条目，不充当目标）；目标作为 todo 清单的总体方向。
【1. 校准段】{{calibration}}（profile.calibration 指定）
【2. 场景契约】动手前写 1–3 个（多面/高风险 3+）现实场景，二元可观察通过条件
    （"返回 200 且 body 符合 schema"，禁"应该能行"）——完成合同。
【3. 双证据（去 TDD 化）】每条判据完成必须附真实执行痕迹：命令输出/测试运行结果/
    HTTP 状态/DB 记录/截图，形式不限；有测试接缝就跑测试作证据，无接缝就真实操作；
    "看代码觉得对"不构成完成依据；不规定流程，不要求先写测试，无 RED→GREEN 顺序。
【4. 审查门】3+ 文件 / 碰安全·权限·迁移 / 单元超 30min / 用户要求严格 → expert 只读
    复查；blocker 必须引用失败判据；最多回审 2 轮后上交用户。
【5. MANUAL QA 矩阵】CLI→跑命令贴输出；API→调端点贴状态；UI→截图；配置→加载验证
    解析形状；清理进程/端口/临时目录也算 QA，未清理=未完成。
【6. 零容忍清单】禁"简化版/demo/先做一部分/应该能行/下次再补"式收尾；禁交付 mock
    冒充真实现（为测试造 fake 数据不在此列——factory 的正当工作）；禁删/弱化失败判据
    制造"通过"；禁对未读代码下结论。
【7. 完成判定清单】账面全绿≠完成。逐项自检：交付物在位/符合项目惯例/证据在手/
    未碰无关文件/残留风险明说。全真→简短总结收尾结束回合；完成是自主决策，不等
    "停止"指令，也不发明新工作。
【附·工具】todowrite 清单是进度唯一依据（单 in_progress，验证后立即标记）；阶段性发现
    与遗留问题写进 todo 条目，**不落任何项目内文件**；context_usage 查占用，**交接阶梯**：
    ≥45% 或压缩事件先到者 → 立即交接；≥25% 且（阶段性成果 + 下一阶段无关联/需大量
    新内容）→ 也交接；<25% 继续；暂无快照用定性信号兜底（全文见 contracts/ulw.md）。
</ulw-contract>
```

【注入】正文 ≈1.4K tokens（omo 同类 337 行 → ~80 行）。

### 9.3 校准段三份内容要点

| 文件 | 针对 | 要点（各 25–35 行） |
|---|---|---|
| `default.md` | 兜底 | 反空谈四条：信息够即动手不过度计划；不叙述不会执行的选项；不以承诺代替执行；每个完成声明指向本轮工具结果。不确定先工具求证再问用户。 |
| `glm.md` | GLM 系（承 omo glm.md，治已知病） | ①过度计划：常规改动浅思考直接动手，架构/并发/迁移才深思考；②叙述不选择：禁罗列方案不拍板，二选一取最小可逆项实现验证；③承诺式收尾："稍后/接下来会做"=未完成；④声明审计：汇报前逐条对照工具输出，失败就说失败并贴证据；⑤便宜工具调用优于内心长辩论。 |
| `deepseek.md` | DeepSeek 系 | ①过度自信收敛：不轻易宣布"已完成/肯定是"，结论挂证据；②工具输出二次怀疑：工具已返回的事实不重新推导；③长篇铺陈：结论先行，1–2 段聚焦；④边界纪律：只做要求的事，不顺手重构、不加未来兼容层。 |

---

## 10. 工具面（6 个工具，最终形态）

| 工具 | 参数（zod） | 来源 | 实现要点 |
|---|---|---|---|
| `context_usage` | 无 | v0.1 | 读 token-snapshot → `[context: 385K/1.0M tokens used (39%)]`；全 0 in-flight 占位拒收（v0.1 已修）；B 的 G11 同源取数 |
| `system_time` | 无 | v0.1 | 纯格式化 |
| `clone_repo` | `url: string`，`ref?: string` | v0.1 | 浅克隆缓存；explore 的 scout 载体 |
| `handoff` | `summary?: string` | v0.1 | session.create（同目录、不传 parentID）+ promptAsync 注入；`[HANDOFF]` 前缀强制；富摘要优先瘦摘要兜底 |
| `profile` | `action: z.enum(["list","show","switch"])`，`name?: string` | **新增** | list=枚举 name+description；show=active 详情+生效边界表；switch（需 name）=validateProfile → 原子写 active → materializeAll 重物化 → 返回"热生效项/需重启项"文本 |
| ~~stop 专用工具~~ | — | 不加 | /stop-continuation 哨兵已确定性清 state，不加可被误用的面 |

---

## 11. 验收证据制规范（R13/R14，契约第 3 项即规范本体）

1. **对象**：场景契约每条二元判据，完成后附**真实执行的痕迹**。
2. **形式开放（列举防找借口）**：命令及其实际输出、测试运行真实结果（含计数与失败项）、HTTP 状态与响应体摘要、DB 查询记录、截图/trace、配置加载后的解析形状。
3. **红线**："应该行 / 看代码觉得对 / 我已经改了（无验证输出）"不构成完成依据；无测试接缝必须真实操作取证，不得以"无测试"降级为目视完成。
4. **去 TDD 化**：不规定流程与顺序；RED→GREEN 要求删除。
5. **不可对冲**：删/弱化判据制造"通过"属零容忍（与第 6 项交叉引用）。
6. **清理即 QA**：遗留进程/端口/临时目录 = 未完成。

---

## 12. 会话内生效 vs 重启生效边界表（最终）

| 配置项 | 生效时机 | 途径 |
|---|---|---|
| `params.temperature/topP/variant` | **会话内热**（逐请求） | chat.params（模型本体不可改——宿主硬约束） |
| `features.*`（机制开关+全部阈值） | **会话内热**（3s TTL） | 各机制事件入口热读 |
| `calibration` | **热**（下次 /ulw 绑定；已注入契约不追溯） | 注入器拼装时读 |
| active 指针切换 | 即时（热项立刻按新 profile 行为） | profile 工具原子写 |
| `model.*`（含子代理模型） | **重启**（R3 已接受） | 物化器写 frontmatter |
| `permissions.*` | **重启** | 同上 |
| `promptVariants.*` | **重启** | 物化器追加正文 |
| 契约文本编辑（contracts/*.md） | 下次 /ulw 即新文本 | 注入器现读 |
| 命令模板编辑（commands/*.md） | 重启 | opencode 命令注册表 |
| `OMO_LITE_DISABLE` | 重启（环境变量） | config 自检读取 |

本表同时写入 profile 工具 show/switch 的返回值与 README（吸收 A 稿）。

---

## 13. 安装/卸载与验证方案

### 13.1 install（`node scripts/install.mjs`）

1. 备份 opencode.json → `opencode.json.bak-omo-lite`（首次，不覆盖旧备份）；删除 `agent` 块（md 唯一来源）。
2. 部署：`agents/commands/plugin` → `~/.config/opencode/{agents,commands,plugins}/`；`contracts+profiles+variants+scripts/{materialize-core,materialize}.mjs` → `~/.config/opencode/omo-lite/`；建 `state/`、`log/` 空目录。
3. 写默认 active（已存在则保留）→ 调 materializeAll → 打印物化摘要（每代理：模型/有无变体段）。
4. 提示重启。

### 13.2 uninstall

还原 opencode.json 备份并删备份；删 agents/commands/plugins 中本套文件；**整删 `~/.config/opencode/omo-lite/`**（state/log 无残留）；提示重启。

### 13.3 确定性测试（harness，不依赖活体 opencode；决策核全纯函数）

| 覆盖对象 | 用例要点 |
|---|---|
| `decideContinuation` 门矩阵 | G1–G13 逐门 true/false 断言（skip/pause/stop 原因字符串精确匹配）；退避序列 5000×2^n 数值表（n≤5 封顶 160s）；失败 5 次→pause→10min 解除；stagnation 3→stop:stagnated；全 completed→stop:completed 且落盘 active=false；G13 预算触顶 |
| `observeEvent` | 无哨兵 user 消息→pause:user-interruption；首行带 `[omo-lite:continue:v1]`→不算用户；assistant/tool 事件→responseObserved=true；abort→stop:aborted；token-limit→stop:context-overflow |
| todo 进展判定 | completed 增加算、id→status 变化算、仅 content/priority 改动不算 |
| 哨兵匹配 | 首行整行相等才命中：中部引用、代码块内复述、子串变体（`[omo-lite:ulw-v1]` 拼错）全不命中 |
| 契约注入 | ulw 哨兵→追加块含正确 calibration（按 active profile）；已 active→epoch+1；stop 哨兵→active=false 落盘；state 写读往返（schemaVersion 迁移钩子） |
| transform | active→标记追加且幂等（末条 user 追加行 / 末条 assistant 追加合成消息）；非 active→原样返回；持久消息含契约哨兵→不恢复；丢失→index 1 插入；结构异常→原样返回 |
| profile | validateProfile 全错误分支；3s TTL 失效；model 缺键回退 default.json |
| materialize-core | 幂等（两次字节相同）；变体追加位置（正文尾）；无变体无追加段；物化标记正确；frontmatter 注入 model/permission 正确 |
| token 快照 | 全 0 占位拒收；占用率计算 |
| 静态检查 | `tsc --noEmit`；全部 md frontmatter 可解析；全部 profile JSON 可解析（吸收 A） |

### 13.4 活体验证（手动 smoke，按序）

① **关键假设**：探针确认 `/ulw` 展开后 chat.message 收到的首行哨兵原样透传（若被改写：fallback = 哨兵改置于"首行或第二行"整行匹配，仍精确匹配）；② /ulw → TUI 可见契约追加且 calibration 正确；③ idle 有 todo → 2s 后续跑注入出现、无哨兵插话→取消；④ Esc → stop:aborted 落盘；⑤ /stop-continuation → active=false；⑥ /profile 工具切换 → active 变化 + agents md diff 正确 + 返回边界文本；⑦ 压缩触发 → 契约块恢复于 index 1。

---

## 14. 明确不做清单

- ❌ 关键词/正则触发任何模式（omo keyword-detector 路线整体拒绝）
- ❌ 提示级停止（停止必须确定性落盘）
- ❌ 变体代理、动态代理元数据渲染、代理动物园（恒 6 个）
- ❌ 模型本体热切（宿主不可能）；子代理模型变体代理（R3 否决）
- ❌ profile TUI（R8）
- ❌ ulw-loop 式 CLI/账本/Stop-hook 流水（OpenChamber 管编排，证据制在契约层）
- ❌ background-agent 父唤醒、delegate-core 兜底、category/team/memory/rules/goal-hook（omo 其余机制）
- ❌ TDD/RED→GREEN 强制（R13/R14）
- ❌ Intent 言语化（烧 token，已否）
- ❌ 插件写 opencode.json（只写自家目录）
- ❌ 自动 profile 切换（R7：手动）
- ❌ 变体提示词放 `~/.config/opencode/agents/` 目录（会被注册成代理——A 稿教训，固定放 `omo-lite/variants/`）

---

## 15. 默认裁定清单（用户不在场，按需求精神裁定，**用户可改**）

| # | 问题 | 裁定 | 一句话理由 |
|---|---|---|---|
| Q1 | 与 OpenChamber goal 双驱动 | **互斥约定（方案 A）**，写入 README：goal 驱动的会话不敲 /ulw；将来冲突时 `features.todoContinuation.enabled=false` 或 bare.json 一键关 | 零误触发取向不做注入源探测；文档约定 + 易关开关最简 |
| Q2 | handoff 阈值与 1M 上下文 | **用户拍板（2026-09-19）：双阶梯**——占用 ≥45% 或压缩事件先到者 → 立即交接；≥25% 且（阶段性成果 + 下一阶段无关联/需大量新内容）→ 也交接；<25% 继续；暂无快照用定性信号兜底。插件 G11 仍 85% 跳续跑 | 恢复 auto-handoff 技能原语义；45%×1M 常被自动压缩抢先，故保留"先到者"条款 |
| Q3 | max-failures 解除语义 | 自动解除（10min 窗口）+ 真实 todo 进展 + /ulw 显式复位三通道 | R6 原文即"超限暂停"，纯 sticky 违背"暂停"语义 |
| Q4 | 注入物 TUI 可见性 | 保持可见（续跑/契约/标记均带哨兵行，透明可审计） | 透明优先；可审计性属于 P1 |
| Q5 | missingTodoNudge | 保留（每 epoch 一次，计入冷却与总量） | 治静默熄火：模型没建清单时 ULW 不至于无声失效 |
| Q6 | 契约语言 | 中文（含校准段） | 用户模型 GLM、全程中文交流，中文指令服从性更好；英文省 token 的幅度不抵服从性风险 |
| Q7 | 记事本/notepad 与 `.omo` 目录 | **用户拍板（2026-09-19）：移除**——ULW 全程不写任何项目内文件（无记事本），阶段性发现/遗留问题一律写进 todo 条目；交接纯提示词（摘要直接随 promptAsync 注入）；`.omo` 目录不使用。插件的持久化仅在 `~/.config/opencode/omo-lite/`（state/log），与项目内 `.omo` 无关 | todo+交接摘要+契约压缩恢复已覆盖持久记忆需求；写项目文件是多余步骤且污染工作区 |
| Q8 | expert 的定位（用户拍板 2026-09-19） | 从"失败后升级收容所"改为"**决策与知识权威**"：①决策类问题（架构/方案权衡、高爆炸半径设计）→ build **先咨询后动工**，不等失败；②知识类问题（生态最佳实践/坑）→ 事实查 context7/websearch，需结合本库判断时问 expert；③执行类问题才走"多种不同思路失败后升级"。路由表/struggle-rule/plan 开放问题均已落地 | flash 执行准但决策与世界知识弱；便宜地执行错误决策是最贵路径，决策一次问对胜过错误方案执行三遍 |
| Q9 | 模糊需求的专家咨询门控（用户拍板 2026-09-19，经 expert 咨询裁定） | 触发 = **模糊信号 ∧ 后果条件**（合取）：模糊 = plan 形式化四件套（目标复述/候选选项/假设清单/开放问题）中出现关键自由度未指派、库内无先例的外部知识依赖、或翻转会改向的假设；后果 = 难逆转 ∨ 约束 ≥3 步 ∨ 产品级。流程 = plan 形式化 → 机械门检 → **每需求 ≤1 次批量咨询**（全部开放问题打包；含用户原话；答案不复诊）；咨询前分拣：库内先例抄之（免费）→ 纯事实查工具 → **纯偏好直接问用户**（绝不烧 expert）→ 知识×后果才进 expert；模糊但可逆 → 最简解读+声明假设继续；纯清晰但高危 → 走方案评审路径。已落地 build.md `<expert_policy>` 第三类 + plan.md 四件套 | flash 元认知自省不可靠 → 对形式化工件做机械检查；模糊单独不是花钱理由、后果才是；偏好类问题是 expert 解决不了的用户领域，烧了白烧 |

---

## 16. 实现顺序建议（重构现有 omo-lite 项目）

1. **探针验证关键假设**（§13.4-①）：临时插件打印 `/ulw` 展开后 chat.message 实收文本——决定哨兵匹配是否需要 fallback。这是全设计唯一无文档保证的假设，先钉死。（备注：用户不在场无法活体敲 /ulw 时，直接采用容错匹配实现——哨兵在**首行或第二行**整行相等即命中——无需探针也安全。）
2. `scripts/materialize-core.mjs`（materializeAll + validateProfile）+ harness 物化/校验用例（纯函数先行）。
3. 插件骨架：数据根解析（OMO_LITE_HOME）、日志、profile 3s TTL 读缓存、机制 D（token-snapshot）+ v0.1 四工具迁入（context_usage/system_time/clone_repo/handoff）。
4. 机制 A（契约注入器）：哨兵匹配 → 拼装 → state 落盘 → transform 标记/恢复；harness 用例。
5. 机制 B（续跑器）：decideContinuation/observeEvent 纯函数 + 钩子接线 + 倒计时；harness 门矩阵。
6. 机制 C：chat.params 热参数、config 启动自检、profile 工具（含 switch 调物化核）。
7. 内容填充：6 个基线 agents md（build 常驻层瘦身 + ulw-pointer 4 行）、4 个命令模板（哨兵首行）、contracts/（ulw.md ≤90 行 + 校准段三份 + handoff 模板）、profiles/ 四份、variants/strict。
8. install/uninstall 扩展（部署 materialize 脚本与 omo-lite/ 目录）→ 全量 harness → `tsc --noEmit` → 部署 → §13.4 活体 smoke 七项（用户回来后做）→ 交付。

每步完成标准即 §13.3 对应用例绿 + 决策日志可复盘——本套件自己先吃自己的验收证据制狗粮。
