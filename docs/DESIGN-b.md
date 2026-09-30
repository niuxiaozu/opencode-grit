# 更名公告

> **更名公告**：本项目已更名为 **grit**（原名 omo-lite，2026-09-20）。下文的 omo-lite/omo 字样为历史记录，一律指本套件。

# omo-lite 设计稿 B（专家独立版）

> 本稿由专家 agent 在仅知悉 `docs/REQUIREMENTS.md`（用户决议）与 `docs/OMO-RESEARCH.md`（omo 事实）的条件下独立产出，未接触设计稿 A。

# omo-lite v2.0 设计文档

> 版本：v2.0（推倒重谈版）｜需求基线：`docs/REQUIREMENTS.md`（2026-09 拍板决议）｜参考：`docs/OMO-RESEARCH.md`、omo 源码（todo-continuation-enforcer / keyword-detector / prompts-core）
> 部署目标：OpenCode 1.18.23 @ Windows，模型 zhipuai-coding-plan/glm-5.3-flash（快档）与 glm-5.3（贵档），与 OpenChamber / opencode-worktime / auto-handoff 技能共存。

---

## 0. 需求决议映射表（R1–R14 逐条着落）

| 决议 | 内容摘要 | 本设计着落 |
|---|---|---|
| R1 | 四痛点：改不动/误触发/循环失控/token 成本 | §1 设计原则 P1–P4 逐条对应；§5 纯函数决策核 + 日志 |
| R2 | 轻量化四维度；允许插件动态切 agent 设定 | §1.5 轻量化预算表；§8 profile 物化机制 |
| R3 | 6 代理，无变体代理，模型切换重启生效 | §3；变体=提示词追加段，不是新代理 |
| R4 | ULW 唯一入口 = `/ulw` 斜杠命令 | §7 契约注入器：首行哨兵精确匹配，无任何关键词正则 |
| R5 | omo 式注入：全量 1 次 + 每轮 1 行标记 + 压缩后恢复 + stop 命令清除 | §7.3–7.6 |
| R6 | todo 驱动续跑 + 全套护栏 | §6 完整状态机（G1–G12 门序列） |
| R7/R8 | profile 一级概念：模型映射/提示词变体/行为参数/权限；外置 JSON、命令+LLM 可切、部分热生效 | §8 |
| R9 | 契约七项 + 校准段三份（default/glm/deepseek），校准段由 profile 指定 | §9.2、§9.3 |
| R10 | 分层：七项纪律只在 ULW 注入层，build 常驻层轻量 | §3.3 build.md 段落范围 |
| R11 | 契约文本外置文件，插件只读与拼装 | §9.1；插件源码零提示词 |
| R12（待定项） | 激活指针/变体组织/命令文本/机制清单/工具去留/安装形态 | §8.2、§8.4、§4、§5、§10、§13 |
| R13/R14 | 验收证据制，去 TDD 化 | §11 |
| —（落地） | 定稿后直接重构插件项目 | §13 部署与迁移 |

---

## 1. 设计原则（逐条对应四个痛点）

**P1 可改性 ——「纯函数决策核 + 薄 IO 壳」（反 foreman-buddy）**
foreman-buddy 的死因是 5 类钩子各自持状态、互相纠缠。omo-lite 的铁律：**所有机制的状态机是纯函数** `decide(state, event) → {action, newState}`，挂在插件 default 导出对象上可单测；钩子函数只做三件事：取数（client API/文件）→ 调纯函数 → 执行动作（注入/写状态/写日志）。任何一次跳过/注入都写一行结构化日志（`log/omo-lite.log`），出问题时看日志即可复盘，不需要读代码推演。

**P2 零误触发 ——「入口唯一化 + 哨兵精确匹配」**
- ULW 的唯一入口是 `/ulw` 命令展开后的**首行整行精确匹配**哨兵（§7.2），不存在关键词正则、不存在子串匹配、不存在事件推断。
- 所有插件自身的注入物（续跑提示、标记）都带内部哨兵前缀，任何钩子看到自己的哨兵一律跳过——**防回声是协议级的，不是启发式的**。
- 文本匹配只有两处（/ulw 与 /stop-continuation 的首行哨兵），且都要求整行相等。

**P3 循环可控 ——「门序列 + 多重熔断」**
续跑器的每次注入必须通过 12 道门（§6.2），任何一道不过即跳过并记日志。熔断有五层：冷却指数退避、连续失败上限、停滞计数、用户打断暂停、abort/上下文超限即停。所有熔断都可被 `/stop-continuation` 或 `/ulw` 重开显式复位。

**P4 token 意识 ——「注入三问：注什么/多少/何时」**
每个注入点在设计中强制标注三问（§5.4 汇总表）。结构性手段：① 常驻提示词瘦身（build 常驻层 ~1.1K tokens，七项纪律不进常驻层）；② 全量契约只持久化一次（成为缓存前缀的一部分）；③ 每轮标记只有一行（尾部增量）；④ 压缩恢复插入在**固定早位置**（紧跟压缩摘要之后），保持前缀缓存命中；⑤ 一切注入只追加尾部或稳定位置，**永不改写历史消息**——不破坏缓存。

**P5 比 omo 轻量（量化）**
omo：100 个 hook 目录、~30 个活跃机制、内置 337 行契约。omo-lite：**4 个机制 + 6 个工具 + 0 行内嵌提示词**，每个机制一个 profile 开关独立可关。

---

## 2. 总体架构与目录结构

### 2.1 分层总览

```
┌─────────────────────────────────────────────────────────┐
│  静态层（opencode 原生，插件零参与，重启加载）              │
│  agents/*.md（物化产物）  commands/*.md                   │
├─────────────────────────────────────────────────────────┤
│  插件层 plugins/omo-lite.ts（单文件，纯函数决策核 + 薄壳）  │
│  机制A contract-injector   机制B todo-continuation        │
│  机制C profile-engine      机制D token-snapshot（被动）    │
│  工具：context_usage/system_time/clone_repo/handoff/profile│
├─────────────────────────────────────────────────────────┤
│  数据层 ~/.config/opencode/omo-lite/                      │
│  contracts/（外置契约） profiles/（含 active 指针）        │
│  variants/（提示词追加段） state/（会话运行态） log/        │
└─────────────────────────────────────────────────────────┘
```

职责边界：OpenChamber 管 goal/schedule/会话；worktime 管暂停恢复；auto-handoff 管技能级交接提示。omo-lite 只管**会话内的代理阵容、ULW 契约与续跑、profile 切换**，不重复建设。

### 2.2 仓库布局（D:\workspace\selfProjects\agent-worktemp\omo-lite）

```
omo-lite/
├── agents/                     # 6 个基础代理 md（正文 = 基线提示词，物化原料）
│   ├── build.md  plan.md  explore.md  general.md  expert.md  factory.md
├── commands/                   # 4 个命令 md（模板，首行哨兵）
│   ├── ulw.md  stop-continuation.md  handoff.md  profile.md
├── contracts/                  # 外置契约文本（R11）
│   ├── ulw.md                  #   七项纪律静态文本（含 {{calibration}} 槽位）
│   ├── handoff-template.md     #   交接摘要模板（单一来源）
│   └── calibration/
│       ├── default.md  glm.md  deepseek.md
├── profiles/                   # profile JSON（R7）
│   ├── default.json  glm-flash.json  glm-max.json  strict.json
├── variants/                   # 提示词追加段（按 profile 组织）
│   └── strict/agents/build.md  #   例：strict profile 给 build 追加的段落
├── plugin/
│   └── omo-lite.ts             # 唯一插件文件（决策核纯函数挂在 default 对象上）
├── scripts/
│   ├── install.mjs             # 安装/卸载（扩自 v0.1）
│   └── materialize.mjs         # 物化：profile → agents/*.md（可独立执行）
├── harness/                    # 确定性测试（§13.3）
├── docs/  package.json  tsconfig.json  README.md
```

### 2.3 部署后布局（~/.config/opencode/）

```
~/.config/opencode/
├── opencode.json               # 不动 agent 块（md 是唯一来源）
├── agents/{build,plan,explore,general,expert,factory}.md   # ← 物化产物（基线+变体追加+frontmatter 注入）
├── commands/{ulw,stop-continuation,handoff,profile}.md
├── plugins/omo-lite.ts
└── omo-lite/                   # 插件运行时数据根（卸载即整目录删除）
    ├── contracts/…  profiles/…（含 active 指针文件）  variants/…
    ├── scripts/materialize.mjs # 随包部署，profile 工具运行时调用
    ├── state/<sessionID>.json  # ULW 会话状态（跨插件重载/重启存活）
    └── log/omo-lite.log        # 逐决策日志（≤2MB 截断）
```

---

## 3. 代理层（6 个代理）

### 3.1 md 组织与 frontmatter 约定

仓库中的 `agents/*.md` 是**基线原料**，frontmatter 只写两项：

```markdown
---
description: <供 Task 工具路由的英文描述——这是子代理被选中的唯一依据，须含 use-when 语义>
mode: primary | subagent | all
---
<正文 = 基线提示词>
```

**`model` 与 `permission` 不写在基线文件里**——它们属于 profile 管辖（模型映射、权限面都是 profile 字段，R7），由物化器（§8.4）在部署时注入 frontmatter。这样切 profile 不需要手改 6 个文件，且不存在"md 写死了模型、profile 改不动"的双源冲突。

| 代理 | mode | 模型档（default profile） | 角色 |
|---|---|---|---|
| build | primary | glm-5.3-flash | 主编排（默认代理） |
| plan | all | glm-5.3 | 规划顾问，只产出计划 |
| explore | subagent | glm-5.3-flash | 只读检索（项目+依赖源码，经 clone_repo 覆盖 scout） |
| general | subagent | glm-5.3-flash | 并行执行器/研究员（叶子工人） |
| expert | all | glm-5.3 | 贵档升级顾问（只读咨询） |
| factory | subagent | glm-5.3-flash | 造假数据/fixture/数据驱动测试 |

R3 合规：无变体代理（没有 explore-strong 之类）；"strict" 之类的变体是**给既有代理追加提示词段**，代理数量恒为 6。

### 3.2 权限基线（default profile 物化产物）

- build：`task: {"*": "deny", plan/explore/general/expert/factory: "allow"}`（禁止套娃委派，白名单收口）
- factory：`task: "deny"`（叶子）
- 其余：默认。

### 3.3 build 常驻提示词的段落范围（R10 分层）

常驻层保留 v0.1 验证有效的七段，**ULW 段从 ~26 行缩到 4 行指针**：

```
<identity>      档位自知 + 升级纪律摘要（3 句）
<search-rule>   两类检索：穷举→explore / 定点→自读（不变）
<struggle-rule> expert 升级三条件 + 委派上下文四件套（不变）
<delegate>      6 段式委派契约 + 分工表（不变）
<verify>        V1/V2/V3 分级验证 + "NO EVIDENCE = NOT COMPLETE"（不变；
                验收证据制在常驻层只提这一句 —— R10）
<ulw-pointer>   4 行：ULW 契约由 /ulw 注入（含七项纪律与校准段）；未注入时本节不适用；
                契约一旦在会话历史中出现即持续有效，不需要重新确认
<hard-blocks> / <style>（不变）
```

【注入】build 常驻 system prompt ≈ **1.0–1.2K tokens**，会话建立时 1 次，进入缓存前缀。v0.1 的 `<ulw>` 26 行常驻段删除——这是 R10 的直接落实（七项纪律只在注入层）。

---

## 4. 命令层（4 个命令的职责切分）

| 命令 | 形态 | 是否需要插件配合 | 为什么 |
|---|---|---|---|
| `/ulw <目标>` | 短模板（~15 行）+ **插件契约注入** | **要** | 命令模板只负责：首行哨兵 + 目标（`$ARGUMENTS`）+ 目标自设规则 + todowrite 首步指令。全量契约（外置文件 + 按 profile 拼校准段，R11）必须由插件在 `chat.message` 钩子里追加——命令 md 是静态模板，无法动态读文件拼装。 |
| `/stop-continuation` | 短模板 + **插件状态清除** | **要** | 模板告诉模型"立即收尾总结"；但状态清除必须确定性（痛点 2：便宜模型可能忽略纯提示级停止）。插件在 `chat.message` 看到首行哨兵即写 state 文件 `active=false`——模型忽略指令也不会继续被续跑。 |
| `/handoff` | **纯命令模板** + 既有 handoff 工具 | 不要 | 模板 = 撰写摘要的指令 + 模板正文；handoff 工具（v0.1 已有）确定性建会话注入摘要。无状态、无新机制。 |
| `/profile <name>` | 短模板 + **profile 工具** | **要** | 用户敲命令 → 模板指示模型调用 `profile` 工具（action=switch）→ 工具做确定性三件事：校验 profile 存在、写 active 指针、调用物化器重写 agents/*.md，并提示"agent 变更重启生效"。这就是 R8 要求的"告诉大模型切 profile"的 LLM 途径；用户也可直接手敲让模型调工具，或手改 active 文件后手动跑物化器。 |

所有命令模板首行是机制哨兵（§7.2 表），正文极简——**命令文本不承载契约**（契约在 contracts/，由插件拼装），模板改动与契约改动解耦。

---

## 5. 插件机制详设（4 个机制，各自独立可关）

### 5.1 机制清单与钩子分配

| 机制 | 钩子 | 状态 | 持久化 | 独立开关（profile `features.*`） |
|---|---|---|---|---|
| **A. contract-injector** 契约注入器 | `chat.message`（全量注入+stop 清除）、`experimental.chat.messages.transform`（每轮标记+压缩恢复）、`event: session.compacted`（恢复触发） | 会话 ULW 态 | `state/<sessionID>.json`（重载存活） | `features.contractInjector.enabled` |
| **B. todo-continuation** 续跑器 | `event: session.idle / session.error / message.updated / message.part.updated`、`tool.execute.before/after`；查询 `client.session.todo / messages` | 续跑计数器（内存）+ ULW 态（盘） | ULW 态在盘；计数器内存（重载归零=安全侧） | `features.todoContinuation.enabled` + 全部阈值参数 |
| **C. profile-engine** | `chat.params`（热参数）；`config`（**仅启动自检**，不改配置）；`profile` 工具 | profile 缓存（3s TTL） | `profiles/active` 指针文件 | `features.profileEngine.enabled`（false 时 chat.params 直通） |
| **D. token-snapshot**（被动） | `event: message.updated / message.part.updated`（只读缓存 token 快照） | 内存 Map | 无 | 常开（无注入面，零风险；它是 context_usage 工具与续跑器上下文护栏的数据源） |

**独立性保证**：每个机制的处理器入口第一行查自己的 `features.*.enabled`（经 3s TTL 缓存读 active profile，热关热开）。A 关闭 = /ulw 只剩命令短模板、无标记无恢复；B 关闭 = 回到纯提示级 ULW（v0.1 形态）；C 关闭 = 参数直通、profile 工具只读；全关 = 插件退化为 v0.1 纯工具箱。机制间仅有的耦合是 D→B 的数据供给（B 用 D 的快照算占用率，无快照时该门放行）。

### 5.2 状态与持久化设计

`state/<sessionID>.json`（原子写：tmp + rename）：

```jsonc
{
  "schemaVersion": 1,
  "sessionID": "ses_xxx", "directory": "D:\\ws\\proj",
  "active": true,                 // ULW 是否在续跑管辖内
  "objective": "完成 omo-lite v2 落地",   // 目标（跨轮有效）
  "epoch": 3,                     // 第几次 /ulw（每次重开 +1，计数器清零依据）
  "activatedAt": 1726700000000,
  "contractFingerprint": "sha1:9f2c…",  // 已注入契约内容指纹（恢复时比对）
  "stopReason": null,             // manual | aborted | max-failures | stagnated | completed | context-overflow | null
  "totalInjections": 27,          // 本 epoch 累计续跑注入数（总量熔断用）
  "missingTodoNudgeUsed": false   // 每 epoch 一次的补清单提醒
}
```

- **插件重载/重启存活**：所有钩子在内存无该会话记录时懒加载 state 文件；ULW 跨重启继续有效（这正是 R5 要求持久化的部分）。
- 续跑护栏计数器（冷却基准、连续失败、停滞、turn-boundary 观察位）**只在内存**——重启归零等于冷却重来，是安全方向；且避免 foreman-buddy 式"盘上状态机改不动"。
- 清理：按 mtime TTL 14 天清扫 state 文件。

### 5.3 防回声协议（全局约定，P2 的实现）

插件产生的每一类注入物都有不可伪造度足够的首行哨兵（整行精确匹配，含版本号）。任何钩子处理任何消息前先查：消息**首行**命中任一内部哨兵 → 这是自己的注入物 → 跳过全部触发逻辑。模型在回复中间引用/复述哨兵行不会命中（不是首行）；用户粘贴完整命令正文与手动执行命令语义等价，视为显式意图，不算误触发。

### 5.4 注入面 token 台账（P4 三问汇总）

| # | 注入物 | 注什么 | 规模（估） | 何时 | 缓存性质 |
|---|---|---|---|---|---|
| 1 | build 常驻 system prompt | 七段骨架 | ~1.0–1.2K | 会话建立 1 次 | 缓存前缀 |
| 2 | 工具描述（6 工具） | description+args schema | ~350 | 每会话常驻 | 缓存前缀，恒定 |
| 3 | /ulw 命令展开 | 哨兵+目标+首步指令 | ~150 | 用户敲命令 1 次 | 用户消息，入前缀 |
| 4 | 全量契约（注入器追加） | ulw.md + 校准段 + handoff 模板 | ~1.4–1.8K | 每次 /ulw 1 次（追加进该用户消息，持久化） | 入缓存前缀，此后 ~0 边际 |
| 5 | 每轮激活标记 | 一行 `[omo-lite:ulw-active] …` | ~35 | ULW 激活期间每次模型请求（ephemeral，尾部追加） | 尾部增量 |
| 6 | 压缩恢复 | 全量契约再插入 | ~1.5K | 压缩后契约哨兵丢失期间每次请求（ephemeral，插在压缩摘要后固定位置） | 稳定早位置，前缀缓存命中，按 cache-read 计价 |
| 7 | 续跑提示 | 哨兵+状态行+剩余 todo 快照（≤10 条截断） | ~120–200 | 每次通过 12 道门的续跑注入 | 新用户消息，入前缀 |
| 8 | 子代理提示词 | 委派 6 段契约正文 | 按需 | 每次 Task 委派 | 子会话独立计 |

非注入面：profile/state/log 全在盘上，零 token。

---

## 6. 续跑器（机制 B）——精确状态机（R6 重点）

### 6.1 数据流

```
session.idle ─→ 取数（todos / messages / token快照 / state）
             ─→ decideContinuation(state, ctx)  ← 纯函数（可单测）
             ─→ {action: "countdown"|"skip:<reason>"|"stop:<reason>"|"nudge", newState}
非 idle 事件（message.updated / tool.execute.* / session.error / session.compacted）
             ─→ observeEvent(state, event)      ← 纯函数：分类用户打断/助手应答/abort
```

### 6.2 门序列（session.idle 时按序检查，任一不过即 skip 并记日志）

| 门 | 检查 | 不过的动作 |
|---|---|---|
| G1 | `features.todoContinuation.enabled` | skip:disabled |
| G2 | state.active && stopReason==null（懒加载盘） | 否则 skip:not-active / skip:stopped |
| G3 | 倒计时或注入 in-flight | skip:in-flight |
| G4 | abort 窗口：3s（`abortWindowMs`）内发生过 abort | 先消耗窗口；abort 本身已置 stop（见 §6.4） |
| G5 | turn-boundary：awaitingProgress && 模型已应答 && todo 无进展 | 置 pause(directive-response)；stagnation++ ≥3 → **stop:stagnated** |
| G6 | 存在未消化的真实用户消息 | pause(user-interruption)：取消一切待注入 |
| G7 | todos 为空 | 每 epoch 一次 missingTodoNudge（提醒建清单，不计失败）；再次空 → skip:no-todos |
| G8 | todos 全部 completed | **stop:completed**（state.active=false） |
| G9 | 冷却：`now-lastInjectedAt < cooldownBaseMs × 2^min(failures,5)` | skip:cooldown（5s→10s→…→160s 封顶） |
| G10 | 连续失败 ≥ `maxConsecutiveFailures`(5) | **pause:max-failures**（`failureResetWindowMs`=10min 后自动解除暂停并清零失败） |
| G11 | 上下文占用 ≥ `contextSkipPct`(85%)（token-snapshot 数据；无数据放行） | skip:context-high（一次性日志提醒 handoff） |
| G12 | token-limit 错误标记 | **stop:context-overflow** |
| G13 | 总注入数 ≥ `maxTotalInjections`(200/epoch) | **stop:injection-budget** |

全通过 → **2 秒倒计时 → 注入续跑提示**（`client.session.promptAsync`，不传 parentID）：

```
[omo-lite:continue:v1]
未完成任务仍在清单中，继续推进下一个待办项。
- 无需请示；完成并验证一项立即标记 completed
- 清单全部完成才收尾；若认为已全部完成，从怀疑角度逐项复核后再更新清单
[progress: 5/8 completed, 3 remaining]
- [pending] 实现 profile 物化器
- [pending] 安装脚本扩展
…（≤10 条，超出截断 + "…等 N 项"）
```

【注入】~120–200 tokens/次，仅此处产生。

### 6.3 倒计时窗口（R6「注入前 2 秒」）

`countdownSeconds`（默认 2，profile 可调）。窗口内任何事件发生即取消：真实用户消息（chat/message.updated 无哨兵）、abort、会话转 busy。这是用户"插话/喊停"窗口——**打字本身就是取消信号**，无需 UI 按钮。窗口无原生 toast API 则静默执行（风险清单 #4）；注入的提示首行哨兵在 TUI 可见，用户始终知道发生了什么（透明优先）。

### 6.4 非 idle 事件分类（纯函数 observeEvent）

| 事件 | 分类 | 效果 |
|---|---|---|
| message.updated/part.updated，role=user，首行无内部哨兵 | **真实用户消息** | 取消倒计时；置 pause(user-interruption)。解除条件：todo 真实进展（_completed 数增加或 id→status 快照变化）或 /ulw 重开。语义 = "停，等用户推动"（R6 的"真实用户消息打断→停"） |
| message.updated，role=assistant | 模型应答 | continuationResponseObserved=true（供 G5 判定"回复了但没进展"） |
| tool.execute.before/after | 模型活动 | 同上（活动也算应答） |
| session.error（abort/AbortError/MessageAborted） | **用户按 Esc** | **stop:aborted**（Esc = 显式停，最保守解释，零误续跑） |
| session.error（token limit / context overflow） | 上下文超限 | **stop:context-overflow** |
| session.compacted | 压缩 | 转交机制 A 置恢复标记；续跑计数器保留（epoch 不变） |

### 6.5 关键阈值汇总（全部 profile 可调，括号为默认值）

`countdownSeconds(2)｜cooldownBaseMs(5000)｜backoffPowCap(5)｜maxConsecutiveFailures(5)｜failureResetWindowMs(600000)｜maxStagnation(3)｜abortWindowMs(3000)｜contextSkipPct(85)｜maxTotalInjections(200)｜todoListMaxItems(10)`

数值依据：冷却/退避/失败窗/停滞/abort 窗口直接采用 omo 同名常量（生产验证过），仅把失败重置窗从 5min 调 10min（GLM flash 重试更慢热）、新增 G13 总量熔断（omo 无此门，属我们针对"循环失控"痛点的加码）。

---

## 7. 契约注入器（机制 A）——R4/R5/R11 重点

### 7.1 全量契约注入（一次，持久化）

触发：`chat.message` 钩子，消息**首行整行等于** `[omo-lite:ulw:v1]`（/ulw 命令模板首行，$ARGUMENTS 之前）。

动作：
1. 读 state：若同 session 已 active → 视为重开（epoch+1，计数器清零，日志注明 re-arm）。
2. **现读契约文件**（每次注入时新鲜读取——契约文本可改无需重启）：`contracts/ulw.md`，把 `{{calibration}}` 槽位替换为 `contracts/calibration/<activeProfile.calibration>.md` 内容，`{{handoff_template}}` 替换为 handoff-template.md。读 active profile 得 calibration 字段（profile 是一级概念，不按模型自动识别——R9）。
3. 组装契约块（首尾哨兵行包裹：`<!-- omo-lite:ulw-contract:v1 -->` … `<!-- /omo-lite:ulw-contract -->`），**追加到该用户消息尾部**返回——消息进入历史，成为持久部分（R5 原文语义）。
4. 提炼 objective（命令模板已指示模型把 `$ARGUMENTS` 原样放在哨兵行下一行；空参时 state.objective 留空，由首轮后补——目标自设规则在契约文本里）。写 state 文件（active=true，fingerprint=sha1(契约块)）。

【注入】~1.4–1.8K tokens，每次 /ulw 一次；因为追加发生在该消息**首次发送前**，直接进入缓存前缀，此后边际成本≈0。

### 7.2 哨兵一览（单一来源表，P2/P5 的物化）

| 哨兵（首行整行匹配） | 出现在 | 作用 |
|---|---|---|
| `[omo-lite:ulw:v1]` | /ulw 命令展开 | 触发全量契约注入 + 激活 state |
| `[omo-lite:ulw-stop:v1]` | /stop-continuation 展开 | state.active=false, stopReason=manual |
| `[omo-lite:continue:v1]` | 续跑注入（插件产生） | 自我识别，防回声；用户打断判定依据 |
| `<!-- omo-lite:ulw-contract:v1 -->` | 契约块首行 | 压缩恢复探测标记（transform 扫描用） |
| `[omo-lite:ulw-active]` | 每轮标记行 | 同上，兼防标记重复追加 |

### 7.3 每轮一行激活标记

`experimental.chat.messages.transform` 钩子（每次模型请求前回调，**非持久**）：
- 条件：state.active && stopReason==null（无 state 文件的会话零开销直接返回）。
- 动作：在**最后一条用户消息**尾部追加一行：

```
[omo-lite:ulw-active] 持续工作模式进行中（目标：<objective 首行，≤60 字>）。上方注入的纪律契约持续有效，按 todo 清单继续推进。
```

- 幂等：transform 看到的是原始历史（标记从未持久化），每次现拼现加，不会累积；同一消息内若已含标记行（防御性）不再加。

【注入】~35 tokens/轮，ephemeral 尾部增量，不污染历史。

### 7.4 压缩后恢复（R5）

探测（双保险，满足其一即恢复）：
1. `event: session.compacted` → 置会话恢复标记；
2. transform 时扫描消息数组：state.active 但**任何持久化消息里都找不到**契约哨兵行 → 契约已被压缩摘要吞掉。

恢复动作：在**压缩摘要消息之后**的固定位置插入完整契约块（ephemeral；内容按 fingerprint 现读现拼，与首注同源）。该位置在后续轮次保持稳定 → 整块落在缓存前缀内，逐轮只付 cache-read 价。恢复期间每轮 transform 都重插（非持久注入的本性），直到下一次 /ulw 或 stop——无需"恢复模式"标志位，探测条件本身即状态（少一个会卡死的标志，P1）。

【注入】~1.5K tokens/轮（仅压缩后），cache-read 计价。

### 7.5 /stop-continuation 清除

首行哨兵命中 → state：active=false，stopReason=manual，计数器随 epoch 失效。此后标记停、恢复停、续跑器 G2 拦截。等价途径：Esc（stop:aborted）、G5/G8/G10/G12/G13 的各类 stop。**清除永远是确定性的，不依赖模型服从文本**。

### 7.6 与续跑器的分工

注入器只管"契约在场"（全量/标记/恢复），续跑器只管"继续干活"（idle 门序列）。两者只通过 state 文件耦合（active/epoch/stopReason），各自可独立关闭：关 A 留 B → 续跑继续但无契约（退化为准 omo 纯 push）；关 B 留 A → 契约在场但无自动续跑（用户手敲"继续"驱动）。

---

## 8. profile 系统（机制 C）——R7/R8 重点

### 8.1 JSON schema（profiles/*.json）

```jsonc
{
  "name": "strict",                        // = 文件名去 .json
  "description": "贵档+严格纪律：重要落地工作",
  "model": {                               // 【重启生效】物化进 agents frontmatter
    "build":   "zhipuai-coding-plan/glm-5.3",
    "plan":    "zhipuai-coding-plan/glm-5.3",
    "explore": "zhipuai-coding-plan/glm-5.3-flash",
    "general": "zhipuai-coding-plan/glm-5.3-flash",
    "expert":  "zhipuai-coding-plan/glm-5.3",
    "factory": "zhipuai-coding-plan/glm-5.3-flash"
  },
  "calibration": "glm",                    // 【热】下次契约注入即绑定新校准段（注入期绑定，中途切换不追溯已注入契约）
  "promptVariants": { "build": "strict" }, // 【重启】→ variants/strict/agents/build.md 追加到基线正文尾部
  "params": {                              // 【热】chat.params 逐请求应用
    "apply": true,                         //   端点不接受 temperature 时置 false 直通
    "temperature": 0.2, "topP": 0.95,
    "variant": null                        //   模型 variant（chat.params 可热切的范围）
  },
  "permissions": {                         // 【重启】物化进 frontmatter（仅列覆盖项）
    "build": { "task": { "*": "deny", "plan": "allow", "explore": "allow",
                         "general": "allow", "expert": "allow", "factory": "allow" } }
  },
  "features": {                            // 【热】事件级热读（3s TTL 缓存）
    "contractInjector": { "enabled": true },
    "todoContinuation": {
      "enabled": true, "countdownSeconds": 2, "cooldownBaseMs": 5000,
      "backoffPowCap": 5, "maxConsecutiveFailures": 5,
      "failureResetWindowMs": 600000, "maxStagnation": 3,
      "abortWindowMs": 3000, "contextSkipPct": 85,
      "maxTotalInjections": 200, "todoListMaxItems": 10
    },
    "profileEngine": { "enabled": true }
  }
}
```

起步四份：`default.json`（flash 主力）、`glm-max.json`（贵档全量）、`strict.json`（贵档+build 追加严格纪律变体）、`bare.json`（全机制关=纯工具箱，救火用）。

### 8.2 激活指针（待定项 1 的答案）

`~/.config/opencode/omo-lite/profiles/active`——纯文本一行 profile 名。三个写入口：① `profile` 工具（LLM 可调，命令/对话均可触发）；② 手编文件（之后需手跑物化器）；③ 安装脚本写默认值。读方：插件（3s TTL 缓存，热项即时）；物化器（重启期）。选纯文本指针而非"写进 opencode.json"的理由：opencode.json 归宿主配置，插件写它有破坏用户配置的风险（foreman-buddy 教训）；独立文件可原子写、可 diff、卸载即删。

### 8.3 切换途径与生效时序

```
用户敲 /profile strict（或对模型说"切到 strict"）
 → 模型调 profile 工具 {action:"switch", name:"strict"}
 → 工具：校验 profiles/strict.json 存在且 schema 合法
        → 原子写 active 指针
        → spawn "node …/omo-lite/scripts/materialize.mjs --profile strict"（重物化 agents/*.md）
        → 返回文本注明："行为参数/校准段/机制开关已即时生效；agent 模型/权限/提示词变体需重启 OpenCode"
 → 用户重启（或不重启，享受热生效部分）
```

### 8.4 物化器（materialize.mjs，待定项 2 的答案）

输入 active profile，输出 6 个部署版 agent md：

```
deployed build.md = 基线 frontmatter(description, mode)
                  + 注入 model（profile.model.build）
                  + 注入 permission（profile.permissions.build ∪ 基线默认）
                  + 基线正文
                  + (变体) "\n\n" + variants/<p>/agents/build.md 全文追加
                  + 尾部物化标记注释 <!-- materialized: profile=strict v=sha1:… -->
```

**追加而非替换**：基线提示词的改进（检索规则/升级纪律迭代）自动被所有 profile 继承，变体只表达"该 profile 额外的纪律"；物化幂等（同输入同字节，尾部标记供启动自检比对）。`config` 钩子启动时只做自检（不改配置）：active 指针有效？契约文件齐全？物化标记与 active 一致？不一致写日志提示"需重物化/重启"——**fail loud, degrade soft**（缺契约文件时 /ulw 注入降级为"契约文件缺失+命令短模板"，不崩插件）。

### 8.5 为什么不用插件 config 钩子直接改 agent 注册表

① agent 注册表启动加载、无热更新，config 钩子改了也要重启，与物化等价；② config 钩子返回的 agent 定义与 md 文件同名冲突的合并顺序无文档保证（风险清单 #2）；③ 物化产物是**可读可 diff 的 md 文件**——出问题时用户打开就能看到"build 现在到底是什么提示词、什么模型"（P1 可改性的根本）。

---

## 9. 契约文本组织（R9/R11）

### 9.1 目录与拼装

```
contracts/
├── ulw.md                  # 静态纪律正文；两个槽位：{{calibration}}、{{handoff_template}}
├── handoff-template.md     # 五段交接模板（单一来源；/handoff 命令模板内嵌同一份文本的副本——命令无法读外部文件，副本在两文件头部互相锚定注释，改则同改）
└── calibration/{default,glm,deepseek}.md
```

插件源码**零契约文本**（R11）；拼装仅发生在 /ulw 注入时（现读）。

### 9.2 ulw.md 结构（七项纪律 + 目标自设规则）

```
<ulw-contract v1>
【0. 模式声明 + 目标自设规则】
    本模式由 /ulw 开启；目标 = 命令参数；参数为空时从上下文提炼一条跨轮有效的
    方向性目标（一次性说明只进 todo 条目，不充当目标）；目标写入记事本首行。
【1. 校准段】 ← {{calibration}}（profile 指定哪份）
【2. 场景契约】动手前写 1–3 个（多面/高风险 3+）现实场景，二元可观察通过条件
    （"返回 200 且 body 符合 schema"，禁"应该能行"）——它们是完成合同。
【3. 双证据（去 TDD 化）】每条判据完成必须附真实执行痕迹：命令输出/测试运行
    结果/HTTP 状态/DB 记录/截图，形式不限；有测试接缝就跑测试作证据，无接缝
    就真实操作；"看代码觉得对"不构成完成依据。不规定开发流程，不要求先写测试，
    无 RED→GREEN 顺序要求。
【4. 审查门】3+ 文件 / 碰安全·权限·迁移 / 单元超 30min / 用户要求严格 → 触发
    复查（expert 只读评审）；blocker 必须引用失败判据；最多回审 2 轮后上交用户。
【5. MANUAL QA 矩阵】按改动类型强制真实操作：CLI→跑命令贴输出；API→调端点
    贴状态；UI→截图；配置→加载验证；清理进程/端口/临时目录也算 QA。
【6. 零容忍清单】禁"简化版/demo/先做一部分/应该能行/下次再补"式收尾；
    禁交付 mock 冒充真实现（为测试造 fake 数据不在此列——那是 factory 的正当工作）；
    禁删/弱化失败判据来"通过"；禁对未读代码下结论。
【7. 完成判定清单】账面全绿≠完成。逐项自检：交付物在位/符合项目惯例/证据在手/
    未碰无关文件/残留风险明说。全真 → 简短总结收尾，结束回合；完成是自主决策，
    不等"停止"指令，也不发明新工作。
【附】工具与记事本纪律：todowrite 清单是进度唯一依据；七段持久记事本
    （.omo/plans/ulw-<date>.md，append-only）；context_usage ≥45% → 按
    {{handoff_template}} 调 handoff 工具，不问确认。
</ulw-contract>
```

【注入】正文 ≈ 1.4K tokens（中文紧凑版；omo 同类 337 行 → 我们 ~70 行，吸收其骨架去其冗余）。

### 9.3 校准段三份的内容要点

| 文件 | 针对 | 内容要点（每份 ~25–35 行，≈300–450 tokens） |
|---|---|---|
| `default.md` | 兜底，模型无关 | 反空谈四条：不过度计划（信息够即动手）；不叙述不会执行的选项；不以承诺代替执行（"接下来我会"→现在就做）；每个完成声明须能指向本轮工具结果。不确定时先用工具求证再问用户。 |
| `glm.md` | GLM 系（承 omo glm.md 精华，治其已知病） | ① 治过度计划：常规改动浅思考直接动手，架构/并发/迁移才深思考；② 治叙述不选择：禁止罗列方案不拍板——二选一时选最小可逆项实现验证；③ 治承诺式收尾："稍后/接下来会做"= 未完成，当场做或明说阻塞；④ 声明审计：汇报前逐条对照本轮工具输出，测试失败就说失败并贴证据；⑤ 便宜工具调用优于内心长辩论。 |
| `deepseek.md` | DeepSeek 系 | ① 治过度自信收敛：不轻易宣布"已完成/肯定是"，结论挂证据；② 治工具输出二次怀疑：工具已返回的事实不重新推导；③ 治长篇铺陈：结论先行，1–2 段聚焦，列表只用于判据/步骤；④ 边界纪律：只做要求的事，不顺手重构、不加未来兼容层。 |

校准段按 profile 的 `calibration` 字段引用（R9：profile 一级概念，非模型自动识别）。

---

## 10. 工具面（6 个工具）

| 工具 | 参数 | 保留/新增 | 实现要点 |
|---|---|---|---|
| `context_usage` | 无 | 保留（v0.1 雏形） | 读 token-snapshot 缓存 → `[context: 385K/1.0M (39%)]`。全 0 in-flight 占位拒收（v0.1 已修的坑）。续跑器 G11 同源取数。 |
| `system_time` | 无 | 保留 | 纯格式化；handoff 摘要/记事本时间戳用。 |
| `clone_repo` | url, ref? | 保留 | 浅克隆缓存；explore 的 scout 能力载体（避免另设 scout 代理——R3 阵容不膨胀）。 |
| `handoff` | summary? | 保留 | `session.create`（同目录、不传 parentID）+ `promptAsync` 注入摘要；`[HANDOFF]` 前缀强制；LLM 富摘要优先、瘦摘要兜底。契约 45% 阈值路径依赖它。 |
| `profile` | action: "list"/"show"/"switch", name? | **新增** | list=枚举 profiles；show=当前 active 详情（含哪些项热/重启）；switch=§8.3 三步。**合并为一工具多 action**：工具面少一个 schema 就轻一分（R2 工具轻量）。 |
| ~~专用 stop 工具~~ | — | 不加 | /stop-continuation 是确定性哨兵清除，不需要模型调工具（少一个能被误用的面）。 |

论证：v0.1 四工具全部保留（均无状态、均被契约/代理文本引用）；唯一新增是 profile（R8 的 LLM 途径硬要求）。删除候选项（如内部 status/debug 工具）一律不做——日志文件已覆盖调试需求。

---

## 11. 验收证据制规范文本要点（R13/R14）

契约第 3 项（§9.2）即规范本体，落地为可检查的文本约束：

1. **对象**：场景契约的每一条二元判据，完成后必须附**真实执行的痕迹**。
2. **形式开放**（列举降低模型找借口空间）：命令及其实际输出、测试运行的真实结果（含计数与失败项）、HTTP 状态码与响应体摘要、DB 查询记录、截图/trace、配置加载后的解析形状。
3. **红线**："应该行 / 看代码觉得对 / 我已经改了（无验证输出）"不构成完成依据；无测试接缝的工作必须真实操作取证，不得以"无测试"降级为"目视完成"。
4. **去 TDD 化**：不规定流程与顺序——先写测试、后写测试、不写测试均可，**只验收完成时的证据**；RED→GREEN 顺序要求删除。
5. **不可对冲**：删除/弱化判据来制造"通过"属零容忍项（第 6 项交叉引用）。
6. **清理即 QA**：遗留进程/端口/临时目录 = 未完成（第 5 项矩阵的固定行）。

---

## 12. 会话内生效 vs 重启生效边界表

| 配置项 | 生效时机 | 实现钩子/途径 |
|---|---|---|
| `params.temperature / topP / variant` | **会话内热**（逐请求） | `chat.params`（模型本体不可改——宿主硬约束，遵守） |
| `features.*`（机制开关与全部护栏阈值） | **会话内热**（3s TTL） | 各机制事件入口热读 |
| `calibration` | **热**（下一次 /ulw 注入绑定；已注入契约不追溯） | 注入器拼装时读 |
| active 指针切换本身 | 即时（热项立刻按新 profile 行为） | profile 工具原子写 |
| `model.*`（含子代理模型） | **重启**（R3 已接受） | 物化器写 agent md frontmatter |
| `permissions.*` | **重启** | 物化器写 agent md frontmatter |
| `promptVariants.*`（提示词变体） | **重启** | 物化器追加正文段 |
| 契约文本（contracts/*.md）编辑 | 下次 /ulw 注入即新文本（现读现拼） | 注入器 |
| 命令模板（commands/*.md）编辑 | 重启 | opencode 命令注册表 |

---

## 13. 安装/卸载与验证方案

### 13.1 install（`node scripts/install.mjs`，扩自 v0.1）

1. 备份 opencode.json（沿用 v0.1 首次备份不覆盖策略）；删除 `agent` 块（md 唯一来源）。
2. 部署：`agents→~/.config/opencode/agents`、`commands→commands`、`plugin/omo-lite.ts→plugins`、`contracts+profiles+variants+scripts/materialize.mjs→~/.config/opencode/omo-lite/`。
3. 写默认 active 指针（已存在则保留）→ 跑物化器 → 打印物化摘要（每代理：模型/有无变体）。
4. 提示重启。

### 13.2 uninstall

还原 opencode.json 备份；删 agents/commands/plugins 中本套文件；**整删 ~/.config/opencode/omo-lite/**（state/log 一并清除，无残留）；提示重启。

### 13.3 确定性测试（harness，不依赖活体 opencode；决策核全是纯函数所以全可测）

| 覆盖对象 | 用例要点 |
|---|---|
| `decideContinuation` 门矩阵 | 13 道门逐门 true/false 的行为断言（skip 原因字符串精确匹配）；退避序列 5s→160s 数值表；失败 5 次→暂停→10min 窗口解除；stagnation 3 次→stop；todos 全完成→stop:completed 并落盘 active=false |
| `observeEvent` | 真实用户消息（无哨兵）→pause；带 `[omo-lite:continue:v1]` 首行的→不算用户；assistant/tool 事件→observed=true；abort→stop:aborted |
| 哨兵匹配 | 首行精确等于才命中：消息中部出现哨兵行、代码块内引用、子串（如 `[omo-lite:ulw-v1]` 拼错）全部不命中 |
| 契约注入 | ulw 哨兵→追加块含 calibration 正确拼装（按 active profile）；已 active→epoch+1；stop 哨兵→active=false 落盘；state 文件写后重读往返（schemaVersion 迁移钩子） |
| transform | active→尾部标记追加且幂等；非 active→原样返回；契约哨兵在持久消息中→不恢复；丢失→插入位置=压缩摘要后 |
| profile | schema 校验（缺字段/未知字段/不存在 calibration 文件的报错文本）；3s 缓存失效 |
| 物化器 | 幂等（跑两次字节相同）；变体追加位置（正文尾、frontmatter 后）；无变体 profile 不产生追加段；物化标记正确 |
| token 快照 | 全 0 占位拒收（v0.1 回归）；占用率计算 |

### 13.4 活体验证（手动 smoke，一次）

命令展开后 `chat.message` 收到的文本**首行哨兵原样透传**（关键假设，风险 #1）；/ulw → TUI 可见契约追加；idle 且有 todo → 2s 后续跑注入出现；Esc → state stop:aborted；/profile 工具切换 → active 文件变化 + 物化 md diff 正确；压缩触发 → 契约块恢复插入。

---

## 14. 明确不做清单

- ❌ 关键词/正则触发任何模式（omo keyword-detector 的路线整体拒绝）
- ❌ ULW 状态机的提示级停止（停止必须确定性落盘）
- ❌ 变体代理、动态代理元数据渲染、代理动物园（恒 6 个）
- ❌ 模型本体热切（宿主不可能）；子代理模型变体代理方案（R3 否决）
- ❌ profile TUI（R8 明确不要）
- ❌ ulw-loop 式 CLI/账本/Stop-hook 双证据流水（omo 的 ledger；OpenChamber 管编排，证据制在契约层解决）
- ❌ background-agent 父唤醒、delegate-core 7 级兜底、category/team/memory/rules/goal-hook（omo 其余机制；goal 由 OpenChamber 承担）
- ❌ TDD/RED→GREEN 强制（R13/R14 去 TDD 化）
- ❌ Intent 言语化（便宜模型念意图烧 token，OMO-RESEARCH 已否）
- ❌ 插件写 opencode.json（只写自己的 omo-lite/ 目录）
- ❌ 自动 profile 切换（R7：不自动，用户手动）

---

## 15. 风险与开放问题

### 已知风险（设计已含缓解，需实测确认）

1. **命令展开透传假设**：`/ulw` 展开后 `chat.message` 是否原样保留模板首行哨兵——整个注入器的关键假设。缓解：安装后 smoke 第一项验证；若首行被改写（如模板变量前置于正文），fallback 改为匹配"首行或第二行的整行哨兵"，仍是精确匹配。**落地第一件事验证它。**
2. **`experimental.chat.messages.transform` 的 experimental 属性**：omo 同版本线已在用，但升级 OpenCode 时此 API 最可能变。缓解：标记/恢复逻辑收在注入器一个函数里，坏了只丢"每轮标记+压缩恢复"，全量契约与续跑不受影响。
3. **chat.params 对 zhipuai 端点**：部分端点拒绝 temperature/topP（400）。缓解：`params.apply:false` 直通开关 + 首次生效 try/catch 记日志。
4. **2 秒倒计时无 UI**：无官方 toast API 时窗口静默。功能上打字即取消仍然成立，但用户感知弱。可选加码：注入提示首行附"（2s 倒计时后自动继续，可直接输入打断）"。
5. **state 并发**：多开 OpenCode 同 session 不可能，异 session 各自文件，风险可忽略；原子写兜底。

### 开放问题（需用户拍板）

1. **与 OpenChamber goal 的双驱动**：OpenChamber 的 idle 续注与 omo-lite 续跑器在同一会话叠加时（goal 驱动的会话里用户又敲了 /ulw），会出现两个注入源交替唤醒。方案 A：约定互斥（goal 会话不敲 /ulw，文档写死）；方案 B：续跑器 G 门加"最近 N 分钟内检测到 OpenChamber 注入特征则让路"（不可靠，违背零误触发取向）。**建议 A，请拍板。**
2. **handoff 阈值 45% 与 1M 上下文的匹配**：45%×1M=450K，通常早被 opencode 自动压缩截住，45% 的 handoff 可能永远到不了。是否改为"占用 45% 或压缩事件先到者触发 handoff 建议"？
3. **max-failures 暂停的解除语义**：现设计 10min 自动解除 + todo 进展/用户消息也可清零。是否要更保守（仅 /ulw 重开可解除）？
4. **续跑提示的 TUI 可见性**：现为可见的用户消息（透明可审计）。是否希望尝试更低调（若 API 支持隐藏）？
5. **missingTodoNudge**（todo 空时每 epoch 一次的建清单提醒）是我加的小机制（防 ULW 静默熄火），omo 没有。保留还是去掉（更纯粹但可能空转）？
6. **契约语言**：ulw.md 现按中文紧凑版设计（模型为 GLM，中文指令服从性好）；是否要像 omo 一样英文契约+中文校准？token 上英文略省，服从性上需实测。

---

*本设计不违背 REQUIREMENTS.md 任何一条决议；所有机制数为 4 + 工具 6 + 提示词内嵌 0，整体显著轻于 omo（100 hook 目录/30+ 机制/337 行内嵌契约）。落地方向：按 §13 顺序先验假设 1，再重构 `plugin/omo-lite.ts`（决策核纯函数先行、harness 同步写），随后物化器与安装脚本，最后契约与 profile 内容填充。*
