# grit 设计修订 3（DESIGN-v3）——面向 opencode v2 的重设计

> 状态：**方案定稿**（本文件为落地依据）。日期 2026-10-14。
> 落地仓库：`D:\workspace\selfProjects\agent-worktemp\grit`
> 引导式（自上而下、可下钻）阅读：同目录 `DESIGN-v3.html`。
> 依据：opencode `v2.0.25` 源码 + 官方文档 + 社区/同类实现调研 + 本仓库既有设计（`REQUIREMENTS.md`、`DESIGN.md`、`OMO-RESEARCH.md`）。

---

## 0. 30 秒结论

- **病根**：grit 的 agent 正文落在 `agent.system` 上 → 在 v2 里会①整段替换基础提示词 ②跳过 provider 变体 ③丢掉工具用法指导。
- **药方 = 分层组合**：opencode 原生层不动；grit 的纪律改为**运行时钩子追加**；agent 定义**薄覆盖**（只改 model/mode/permissions/description，不写 system）。
- **续跑（ULW）简化**：**不重做 todo 工具**；判活只看"ULW 激活 + 模型未声明完成 + 护栏允许"。完成由**模型自己根据目标判断**——**不引入判据库、不做独立验证、不用专家验证**（浪费）。
- **保留既有机制**：契约注入、会话交接 handoff、profile 引擎、token 快照、五个工具、命令、校准段。
- **注入格式**：一律用**独立、带标签的块/合成消息**，**不拼进用户原文**。

### 术语速查（之前容易看不懂的三个词）
- **触发器**：一个"事件时点"。grit 监听**会话空闲**这一时刻（模型说完、没有正在跑的工具/子代理），到点才检查"要不要接着推"。——不是定时轮询，也不是每步都检查。
- **续跑判定**：到点后判断"继续 / 停止"。v2.1 只有三条：未激活→不动；已激活且未声明完成→推一把；模型声明完成→停。
- **判据库（已删除）**：早期草案里那张"每条完成条件 + 证据 + pass/fail 状态"的表（也叫"仲裁文件"）。**本设计不引入**——分析认为它等于把脾气复杂的流程塞回上下文，违背省 token 与"让模型自己判断"的初衷。

---

## 0.1 修订记录（v3.1，2026-10-14）

在 v3 落地后按用户裁定做了四处修订（代码已改，本文件以下各节描述为 v3 原始设计，差异以此为准）：

1. **移除 `factory` 席**：名册 6 席（build/plan/explore/general/expert/browse）。造数/测试工作由 `general` 直接承担；`agents/index.json`、`profiles/*`、build 路由表、README 同步删除。
2. **哨兵统一改名为 `GRIT:ULW:*`**（自解释，去掉隐晦的动作词与 `v1` 后缀）：
   `[GRIT:ULW:START]`（原 `[grit:ulw:v1]`）、`[GRIT:ULW:STOP]`（原 `[grit:ulw-stop:v1]`）、`[GRIT:ULW:CONTINUE]`（原 `[grit:continue:v1]`）、`[GRIT:ULW:DONE]`（原 `[grit:done:v1]`）、`[GRIT:ULW:ACTIVE]`（原 `[grit:ulw-active]`）；契约块 `<!-- GRIT:ULW:CONTRACT -->`；纪律块 `<GRIT-ULW-DISCIPLINE agent="…">`。
3. **ULW 目标改由模型设定**：不再从 `/ulw` 命令消息文本里取目标（用户输入常混有指挥性内容、目标也可能在前几条消息里或由模型提出）；模型从会话上下文提炼并以单独一行 `[GRIT:ULW:GOAL] <一句话目标>` 声明，插件在空闲时抓取，用于每轮标记与续跑提示。§6A/§7 中"目标=命令参数"的表述作废。
4. **移除校准段机制**：删除 `contracts/calibration/*`、profile 的 `calibration` 字段与校验、插件 `familyOf`/`calibrationBlock` 与注入代码。理由：校准段难编写，且与 OpenCode 原生提示词机制冗余/冲突——交回原生机制承担，grit 不再注入。§6C/§8/§10/§11(V-8) 相关表述作废。

---

## 0.2 修订记录（v3.2，2026-10-14）

在 v3.1 基础上再修订：**ULW 改为工具进入/退出**（取代文本嗅探）。

1. **进入/退出改为工具**：新增 `ulw_enter({goal})` 与 `ulw_exit({reason?})`（工具面 7 个）。契约由 `ulw_enter` 的**返回值**携带（不再用合成消息）；`context` 钩子只负责压缩恢复与每轮标记。
2. **进入校验（防误触发，无状态）**：`ulw_enter` 校验「上一条用户消息」是否含授权标识 `[GRIT:ULW:START]`（`/ulw` 命令文本携带）；不含则拒绝并告知模型。插件不保存 armed 状态；`[GRIT:ULW:START]` 也不再是插件拦截哨兵（`/ulw` 按真实用户消息处理）。
3. **手动退出**：`/stop-continuation` 更名为 **`/ulw-exit`**（短且与 ULW 相关）；插件按首行哨兵 `[GRIT:ULW:EXIT]` **确定性**退出（不依赖模型）。
4. **完成判定改工具**：删除 `[GRIT:ULW:GOAL]`/`[GRIT:ULW:DONE]` 嗅探与 `goalOf`/`isCompleted`；`decideContinuation` 去掉 `completed` 输入（退出即 `active=false` → 不再续跑）。目标由 `ulw_enter` 的 goal 参数给出，且取**用户最近一次提出的任务**（在最近几轮里定位，未必是最后一条消息；非更早的全局目标；不一致时以最近为准）。
5. **纪律块改名**：`<GRIT-ULW-DISCIPLINE>`/`[GRIT:ULW:DISCIPLINE:*]` → `<GRIT-DISCIPLINE agent="…">`/`[GRIT:DISCIPLINE:*]`（它是 agent 角色纪律，非 ULW 专属）。
6. **多实例共享状态（修重复注入）**：插件会被 OpenCode 多次加载；实测**模块级变量在重复 import 时仍各一份**，导致同毫秒 8 份 COUNTDOWN、重复 INJECT。改为把 `stateCache/counters/countdownTimers/lastTokens/inflight` 挂到 **`globalThis`**（进程级唯一）；`loadState` 按 mtime 感知磁盘变化；`doInject` 注入前后都复核新鲜状态（防陈旧快照复活退出）；`handleIdle` 加 inflight + countdown-pending 双重去重；`exitUlw` early-return 也写日志。
7. **注入分两条通道（保护前缀缓存）**：**稳定内容**——角色纪律（不随会话变化）→ 追加到**系统提示词**（同内容同位置，前缀缓存不受影响）；**会话中触发的动态内容**——激活标记 / 授权与退出提醒 / 压缩后契约恢复 → 以独立带标签块（`<grit-inject>…</grit-inject>`、契约哨兵）追加到**消息通道**（末条 user 消息，只动尾部）。§7 中"合成消息/系统提醒块"的表述以本节为准。
8. **移除 profile 热参数（机制 C 的 `params`）**：删掉插件里写 `event.options.temperature/topP/variant` 的整段、6 个 profile 的 `params` 字段、`validateProfile` 的 params 校验，以及 README/DESIGN 相关描述。理由：①6 个 profile 的 `params.apply` 全为 `false` → 从未生效（死代码）；②`variant` 根本不是 v2 认的生成参数键（v2 只认 maxTokens/temperature/topP/topK/frequencyPenalty/presencePenalty/seed/stop）；③这类参数在 v2 有原生落点（`agents` 记录的 `request`）。`profile` 工具（list/show/switch）保留。

哨兵：`[GRIT:ULW:START]`（授权）、`[GRIT:ULW:EXIT]`（用户退出）、`[GRIT:ULW:CONTINUE]`（防回声）、`[GRIT:ULW:ACTIVE]`（每轮标记）、`[GRIT:ULW:ARMED]`（授权提醒）、`<!-- GRIT:ULW:CONTRACT -->`。§6A/§7 中"合成消息注入契约""目标=命令参数"等表述以本节为准。

---

## 1. 背景与目标

### 1.1 用户诉求
- 「覆盖了原本的那些 agent……丧失了 opencode 原本的精心设计……需要重新考虑 v2 的 agent 设计、提示词、工具信息注入，重新设计 grit。」
- 「核心是**弱管强**、**省 token**。」
- 「V2 删了 todolist 有它的理由；研究为什么删、还需不需要类似机制；**不需要就重新设计不用 todo 工具的方式**；用 plan 代替不合适。」
- 「**验证不能与执行分离**（太浪费），**验证也不能用专家**（更浪费）——让大模型自己根据目标判断是否完成就足够了。」
- 「注入格式：OmO 会把信息包成块，我们之前好像只是拼接到用户消息开头，**不太好**。」
- 「不要丢掉 grit 现有的有用机制，比如**会话交接**。」

### 1.2 保留的「思想」
弱管强二元分档；信条"cheaply executing a wrong decision is the most expensive path"；6 段委派契约 + NO EVIDENCE = NOT COMPLETE；/ulw 单次全量注入 + 每轮一行标记 + 压缩恢复；idle 续跑 + 护栏；profile 一级概念 + 契约外置；**会话交接 handoff**；token 被动快照。

### 1.3 丢弃的「实现」
7 个 md 的全量自包含正文；v1 legacy frontmatter 名 `permission:`/`task:`；机制 B 的 todowrite 数据源（且**不重做** todo）；promptVariants 整文件替换；**judgement 判据库 / 独立验证器 / 专家验证**（本轮明确删除）。

---

## 2. opencode v2 机制事实（一等约束）

| # | 机制 | 事实 |
|---|---|---|
| 2.1 | system 组装 | `[ agent.system ? agent.system : 基础提示词, initial ]` → 设 system 即**整段替换**（`session/model-request.ts`；docs `agents.mdx` "System"） |
| 2.2 | provider 变体 | 自定义 system 时跳过；变体仅 6 个：anthropic/gpt/gpt-astra/kimi/meta/trinity（**无 glm/deepseek**）（`plugin/optimize.ts`、`plugin/system-prompt/`） |
| 2.3 | 工具用法指导 | `${OPENCODE_TOOL_GUIDANCE}` 仅随基础提示词渲染（`session/system-prompt.ts`） |
| 2.4 | identity | `# Your Model` splice 进 system[1]，独立于 agent.system（`plugin/identity.ts`） |
| 2.5 | instruction 基线 | 日期 / `<env>` / AGENTS.md / 技能清单 / CodeMode 目录 = system[1]（`session/context.ts`） |
| 2.6 | agent 契约 | `{id,name,model?,request,system?,description?,mode,hidden,color?,steps?,permissions}`；无 temperature/tools；`mode ∈ {subagent,primary,all}`（`schema/agent.ts`） |
| 2.7 | 加载/覆盖 | 配置在 `post` 合并；同名覆盖；**md 恒注入 system（空 body 会清掉内置 prompt）；`agents` 配置记录可省略 system 以保留内置 prompt**（`config/plugin/agent.ts`） |
| 2.8 | Plan 机制 | `plan` 是 **primary**；只读围栏（仅 `~/.opencode/plan` 可写）+ 进出提醒；独立于 system（`plugin/plan.ts`） |
| 2.9 | 内置角色 | build=默认代理（无 system）；general=执行器（拒 question/subagent，无 system）；explore=只读定位器（有 PROMPT_EXPLORE）（`plugin/agent.ts`） |
| 2.10 | 子代理工具 | **拒绝 mode=primary**；运行时渲染 "Available subagents:"（`tool/plugin/subagent.ts`） |
| 2.11 | v1→v2 改名/删除 | `bash→shell`、`task→subagent`、`apply_patch→patch`；**`REMOVED_TOOLS=["todowrite"]`**（`database/v1-migration.bun.ts:901`） |
| 2.12 | **v2 无 todo 机制** | core 未注册 todo 工具；schema 无 todo 消息类型；DB 的 `todo` 表无人读写（仅供 v1 历史/旧会话 UI） |
| 2.13 | 官方自定义提示词途径 | `ctx.session.hook("context", e => e.system.push({type:"text",text}), { providerID })`；作用域到 provider，精确到 model 需自查 `event.model.id`（docs `build/plugins`） |
| 2.14 | `instructions` 配置 | v2 **不解析**其文件/glob/URL（不生效）；只认 AGENTS.md（docs `instructions.mdx`） |
| 2.15 | 合成消息 | `ctx.session.synthetic({sessionID, text, resume:false})` 发"非用户"注入（v2 原生 `plan.ts` 用法）；`Message.system(...)` 为时序系统更新 |
| 2.16 | JS API | `SessionContext.system/messages/options/tools` 可变；`SystemPart` 形状 = `{type:"text",text}`（`@opencode/plugin@2.0.20`） |

---

## 3. 外部证据（为什么这么设计）

### 3.1 todo 为什么被删、还需不需要
- **官方唯一解释**（维护者 rekram1-node，issue #42421）："we removed it because it **slows agent down** and we haven't noticed significant performance improvements"；issue 已 reopen，"We may add a way to re-enable them"。
- **同类动作**：Claude Code 在 Opus 4.8 / Sonnet 5+ 默认禁用 `TodoWrite`/Task，理由"新模型内部自跟踪状态"+"工具定义与提醒占用上下文"（"unhobbling"）。
- **三方独立确认 v2 无 todo**：官方 tools 文档无 todo；`aiev/opencode-todolist` README 明写"V2 removed the built-in todo tools"；`zenox` README 表格同结论。
- **结论**：新一代模型下外部 todo 工具被认为**多余甚至拖慢** → grit **不重做 todo 工具**。

### 3.2 生态里"轻派"的共识做法（借鉴来源）
| 做法 | 出处 | grit 采用 |
|---|---|---|
| **静态策略进 system、动态状态只走工具返回/续跑提示** | `prevalentWare/opencode-goal-plugin` | ✅ 契约一次注入；状态不重写 system |
| **单行恒定注入**（会话内不变→不破坏 prompt cache） | `aiev/opencode-todolist` | ✅ 每轮一行标记 |
| **按需注入**（重程序只在关键词命中时注入一次） | `oh-my-opencode-slim` `council-inject` | ✅ 纪律只在 /ulw 时付 token |
| **判活=子会话终态**（children 无终态才算忙） | `oh-my-opencode-slim` v2 children-driven wake | ✅ 触发器的一条判据 |
| **触发器只认 idle/执行边沿，不认中间步完成** | `prevalentWare` | ✅ |
| **计数熔断**（无进展/失败/轮次/时长） | prevalentWare(25 轮 / 50 token×2 / 3 次)、`zenox`(并发 6 / 会话 50 / 超时 30min)、`hiai`(20 次相同调用) | ✅ 护栏 |
| **工具死循环护栏**（重复调用 warn3/block5） | `oh-my-opencode-slim` `tool-loop-guard` | ✅ 护栏 |
| **指纹未变即停**（连续唤醒无进展） | `oh-my-opencode-slim` 2-wake cap | ✅ 护栏 |
| **costRatio 写进编排协议**（fast1x/med5x/heavy20x；`min(cost,adequate)`；`if self is strongest: do locally`） | `marco-jardim/opencode-model-router` | ✅ 写进 build 协议 |
| **不强制流水线**（角色"有用才用"） | `agnusdei1207/opencode-orchestrator` | ✅ |
| 缓存安全注入（append-only 标记块 + 一条尾随易变消息，永不改写前缀） | `oh-my-opencode-slim` | ✅ 注入规范 |
| revive-by-id（续用同一子会话，不重开） | `oh-my-opencode-slim` | ✅（handoff/子代理语义） |

### 3.3 明确不抄（OmO 的教训，已被社区量化）
- 强制 todo 续跑、激进重试、38 个行为钩子、上下文偏执监控 → slim 全删；orchestrator 提示词 **1485 行 → 67 行（-95%）**。
- 每轮重灌 ~3K token 的横幅与指令；honor-system 完成（`<promise>DONE</promise>`）；强制 plan 门；"ZERO TOLERANCE / NO EXCUSES" 喊话。
- **判据库 / 证据账本 / 独立验证器 / 专家验证**：本轮**不采用**（用户裁定：验证不与执行分离、不用专家，模型自判即可）。

---

## 4. 目标架构：分层组合

```
system[0]  L0 opencode 原生：base prompt + 工具指导（provider 变体在此改写）   ← 不设 agent.system 即回流
system[1]  identity "# Your Model"
system[2]  initial 基线：日期 / <env> / AGENTS.md / 技能清单 / CodeMode
system[N]  L1 grit 纪律层：按 event.agent 追加（带标签的独立块）
              + 校准段：按 providerID 作用域追加
messages   ULW 模式块（一次）+ 每轮一行标记（非持久）+ 续跑提示（合成消息）
options    （无 grit 热参数：生成参数由 agents 记录 / 原生配置负责）
tools      5（context_usage/system_time/clone_repo/handoff/profile）
```

三层：**L0 原封不动** / **L1 grit 追加** / **L2 profile 物化**（model/permissions/mode → `agents` 记录）。

### 4.1 决断
| 决策 | 裁定 |
|---|---|
| 组合架构 | 钩子追加，不设 agent.system |
| 名册 | 重建名册 + 适配 v2 角色（§5） |
| 路由分档 | 不引入 category；分档写进 profile/agents 记录 |
| 校准 | 保留精简校准，走 provider 作用域 context 钩子 |
| 机制 | A 保留微调 / **B 简化**（无 todo、模型自判完成）/ C 保留收缩 / D 保留 / handoff 保留 |

---

## 5. 名册与覆盖机制

| 席 | mode | v2 内置有 system？ | 覆盖方式 | 追加的纪律段 |
|---|---|---|---|---|
| `build` 主编排 | primary | 否 | 配置记录（省 system） | 路由表 · 委派契约 · **costRatio 分档** · 验证 · tone |
| `plan` | primary（v2 原生） | 否 | 配置记录（不覆盖权限） | 计划纪律段（可选） |
| `explore` 检索 | subagent | **是（PROMPT_EXPLORE）** | 配置记录（**必须省 system**） | 摘要契约 · 深读 · clone_repo 用法 |
| `general` 执行 | subagent | 否 | 配置记录（省 system） | 目标/完成纪律 · scope · 验证 · 报告 |
| `expert` 决策 | all | 无 | 配置记录（省 system） | 决策框架 · 输出契约 |
| `factory` 造数 | subagent | 无 | 配置记录（省 system） | 造数规则 · 工作流 · 输出契约 |
| `browse` 浏览 | subagent | 无 | 配置记录（省 system） | 任务 · 工具 · 锚点纪律 |

名额 **7**（不新增 architect）。

**关键判定（逐席）**
- `build`/`general`：v2 内置**无 system** → **天然兼容**，薄覆盖 + 追加纪律即可。
- `explore`：v2 是**只读定位器**（找位置、thoroughness 分级）；grit 是**理解/压缩器**（深读全链、只回 digest，正是"避免污染上下文、只留有用内容"）。**同槽合成**：取 v2 外壳（名/描述/只读权限/子代理目录呈现）+ grit 摘要契约；并**显式放行 `clone_repo`**（v2 的 `* deny` 会拒掉它）。
- `plan`：**采用 v2 原生 primary 模式**（只读围栏 + 提醒 + plan 目录）；**砍掉 grit 自建的可委派 plan 子代理**（与 expert 重叠）。
- `expert`：v2 无等价物；**保留**为唯一强档设计/决策顾问（简单设计 build 自做，复杂设计交 expert）。

**不强制流水线**：角色"有用才用"，不是必需管线（学 `opencode-orchestrator`）。

**覆盖机制**：载体 = `agents` 配置记录（**不写 system**）；md 无法省略 system（空 body 会清掉内置 prompt）。落点待验（V-3）。

---

## 6. 机制设计

### A — 契约注入（/ulw）◆ 保留、微调
- `/ulw <目标>` 触发：把**模式块**（纪律契约：场景契约 / 双证据 / 审查门 / MANUAL QA / 零容忍 / 完成判定 / 交接阶梯）注入一次（持久）。
- `context` 钩子负责**每轮一行标记**（非持久）；契约的注入点有两处，都用 `ctx.session.prompt` 发成**一条真消息**（持久）：进入（`ulw_enter`）与**压缩完成事件**（`session.compaction.ended`）。
- 微调：契约文本外置 `contracts/`；注入格式改为**独立块/合成消息**（§7）。

### B — 持续工作续跑 ◆ 简化（无 todo、无判据库、模型自判完成）
- **目的**：`/ulw` 激活后，若模型一轮结束停下但目标未完成，自动推一把，直到它自己判断完成或触发护栏。
- **触发器**：**会话空闲**这一时点（模型说完、无正在跑的工具/子代理；v2 侧为 idle / 执行边沿）。
- **续跑判定（继续/停止）**：
  1. ULW 未激活 → 不动。
  2. 已激活、且模型**未声明完成** → 护栏允许时注入一句"继续推进该目标"（携带目标）。
  3. 模型**声明完成**（回复里给出约定完成标记 `[grit:done:v1]`）→ 停。**完成由模型根据目标自行判断。**
- **护栏（兜底，防跑飞）**：2s 倒计时（注入前给用户喊停窗口）、冷却指数退避、连续失败上限、注入预算上限、abort 窗口、上下文超限跳过、用户真实消息打断即暂停、**工具死循环护栏（重复调用 warn3 / block5）**、**指纹未变即停**。
- **状态**：仅 `grit/state/<sid>.json` 最小集（active / goal / 计时 / 计数）。**无逐条判据、无证据账本、无独立验证器。**
- **与旧状态机差异**：旧版靠"扫 todo 清单"判活（v2 已无此工具）；新版判活不依赖任何外部清单，判据只有"激活 + 未声明完成 + 护栏"。

### C — profile 引擎 + 校准 ◆ 保留、收缩
- `profile` 工具 list/show/switch 不变；`promptVariants` 降为纪律段级。（**热参数机制已移除**，见 §0.2-8）
- **校准**：以 **provider/model 作用域 context 钩子**追加极短校准段（glm/deepseek/default）。这是 v2 官方唯一自定义途径，且 v2 本身不覆盖这两个模型族。

### D — token 快照 ◆ 保留
- 事件源 `session.step.ended`/`session.usage.updated` 在位；`context_usage` 工具与上下文门同源。

### handoff（会话交接）◆ 保留（用户点名）
- `session.create`（新顶层会话）+ `session.prompt`（注入摘要）+ 本会话置停；摘要模板单一来源 `contracts/handoff-template.md`；`/handoff` 命令内嵌同文本。

### 工具面 ◆ 维持 5
context_usage · system_time · clone_repo · handoff · profile（**不新增 todo**）。

---

## 7. 注入格式规范（本轮修正）

- **原则**：任何 grit 注入都用**独立、带标签的块**；**绝不拼进用户原文、绝不当成用户说的话**。
- **两种载体**：
  1. **系统提醒块** `<system-reminder>…</system-reminder>`（v2 原生惯例，模型被训练为"这是 harness 指令"）——用于每轮标记。
  2. **独立合成消息** `ctx.session.synthetic({sessionID, text, resume:false})`（v2 原生 `plan.ts` 用法）或消息流里插独立 part——用于模式激活（契约）与续跑提示。
- **标签命名**：统一 `<grit:…>` 命名空间 + 首尾哨兵，例：`<grit:ulw-mode v1>…</grit:ulw-mode>`、`<grit:continue v1>…</grit:continue>`、`<grit:done v1>…</grit:done>`；既便于幂等检测与防回声，又能与用户内容区分。
- **为什么改**：OmO 把用户信息与注入都包成块，模型能清楚区分"用户在说"与"harness 在说"；grit 旧做法（`text + "\n\n" + appended` 直接拼到用户消息）混淆来源 → **改为块/合成消息**。
- **缓存纪律**：只追加尾部块/一条尾随易变消息，**永不改写已缓存前缀**。

---

## 8. 目录 / 部署布局

```
<repo>
├── contracts/         ulw.md, handoff-template.md, discipline/*
├── variants/<name>/discipline/*.md
├── profiles/*.json    （name/description/model/promptVariants/permissions/features）
├── plugin/            grit.ts, tui.ts
├── scripts/           materialize-core.ts（改合成 agents 记录）, install.mjs, grit.mjs
├── harness/           smoke.ts
└── docs/              DESIGN-v3.md/.html, DESIGN.md(旧), REQUIREMENTS.md, OMO-RESEARCH.md

<部署> ~/.config/opencode/  opencode.json(agents 记录) · commands/ · plugins/ · grit/{contracts,profiles,variants,state,log} · scripts/
```

---

## 9. 分档与"弱管强"·省 token

- 分档 = `agents` 记录 `model`。便宜档：build/explore/general/factory/browse；强档：plan/expert。
- **build 协议写入 costRatio 式分档**（学 model-router）：`fast=1x / medium=5x / heavy=20x`，规则 `min(cost, adequate)`、`if self is strongest: do locally`；简单设计 build 自做，复杂设计交 expert。
- 省 token 杠杆：契约只注一次；每轮一行标记；只追加尾部/固定位；契约外置；explore/browse 只回 digest；强终止条款；token 被动快照；context_usage 按需查询；**按需注入**（重纪律只在 /ulw 付 token）。
- v3 新增净成本：基础提示词 + identity 常驻（约数百 token/请求），是"恢复 opencode 设计"的定价。

---

## 10. 迁移映射

| 旧 | 新 |
|---|---|
| `agents/*.md`（7 全量正文） | 删除；正文移位到 `contracts/discipline/*.md`；定义移到 `agents` 配置记录 |
| frontmatter `permission:`/`task:` | `permissions`（action `subagent`/`edit`/`shell`） |
| 机制 B 扫描 todowrite | **简化续跑**（激活 + 未声明完成 + 护栏；模型自判完成） |
| grit 的 plan 子代理 | 删除；采用 v2 原生 plan primary 模式 |
| 校准段（独立机制） | 保留，改为 provider/model 作用域钩子追加 |
| explore 能力 | v2 外壳 + grit 摘要契约 + 放行 `clone_repo` |
| 契约/续跑注入（拼接到用户消息） | **独立块/合成消息**（§7） |
| `variants/<v>/agents/<n>.md` | `variants/<v>/discipline/<n>.md`（追加段） |

---

## 11. 验证矩阵

| # | 命题 | 状态 |
|---|---|---|
| V-1 | JS 侧 context 钩子可改 `event.system` | ✅ 源码 + 官方文档双确认 |
| V-2 | 追加段与 optimize/identity 的钩子执行顺序 | ⚠ UNKNOWN · 需实验 |
| V-3 | `agents` 配置记录落点 | ⚠ UNKNOWN · 需实验 |
| V-4 | 省略 system 后 explore 的 PROMPT_EXPLORE 保留 | ⚠ 待实测 |
| V-5 | SystemPart 构造形状 `{type:"text",text}` | ✅ 官方示例 |
| V-6 | v2 无 todo 机制 | ✅ 已确认 |
| V-7 | `ctx.session.synthetic` 可发非用户注入、不进用户消息 | ⚠ 待实测 |
| V-8 | provider 作用域钩子按 provider 生效、按 `event.model.id` 精确到 model | ⚠ 待实测 |
| V-9 | 确定性冒烟（`harness/smoke.ts`）改造后全绿 | ⚠ 待跑 |

**架构改动前必须先过 V-2 / V-3 / V-4。**

---

## 12. 风险与退路

| 风险 | 影响 | 退路 |
|---|---|---|
| 无 todo、模型自判完成 | 过早声明完成 / 永不言完成 | 护栏（预算 + 停滞 + 指纹）兜底 |
| #42421 可能加回"可重启用开关" | 未来 v2 自带 todo | 届时让位原生 |
| V-2/V-3 未知 | 接线错位 / 落点不可热重载 | 幂等哨兵 + 固定位；退回物化薄 md |
| 校准钩子作用域只到 provider | 同 provider 下别的模型被误加 | 钩子内按 `event.model.id` 再判 |
| explore 权限拒 `clone_repo` | grit 工具用不了 | 显式放行 |
| 注入块被当用户输入 | 语义混淆 | 用标签 + 合成消息（§7） |

---

## 13. 分阶段实施计划
1. **实验先行**（V-2/V-3/V-4/V-7/V-8）。未过不改架构。
2. **纪律段抽取**（去 todo 依赖、加"完成纪律"）+ 校准段（provider 作用域）。
3. **薄覆盖落地**（合成 agents 记录；删 `agents/*.md`；explore 放行 `clone_repo`）。
4. **追加通道**（按 `event.agent` / `providerID` 追加，独立块）。
5. **机制 B 简化**（激活 + 未声明完成 + 护栏；删 todo 依赖与任何判据库残留）。
6. **plan 回归原生**（删自建 plan 子代理 + 更新 build 路由表 + costRatio）。
7. **注入格式落地**（合成消息 / 标签块，替换字符串拼接）。
8. **harness 更新 + 验证矩阵全过 + 重新部署**。
9. **文档重写**（README 补 browse、消除模板双写与计数漂移）。

每阶段验收证据（R13/R14）：真实执行痕迹。

---

## 14. 明确不做
不重做 todo；不引入判据库/证据账本/独立验证器/专家验证；不引入 category / 变体代理 / per-家族双套正文 / architect；不做关键词触发 ULW；**不把注入无标签地混进用户原文**；**不把动态注入写进系统提示词**（角色纪律这类稳定内容才放系统）；不用 md 承载薄覆盖；不改 v2 原生层。

---

## 15. 开放项（落地时如遇冲突，按此默认）
1. plan 是否追加 grit 计划纪律段 → 默认**追加极短一段**。
2. 纪律段粒度 → 默认 **7 席各一份 + `_shared.md`**。
3. `agents` 记录落点 → 先做 V-3 实验；默认写全局 `opencode.json`。
4. 完成标记文本 → 默认 `[grit:done:v1]`（整行哨兵）。

---

## 16. 2026-10-19 变更（ULW 进入/退出注入方式）——与前文冲突处以本节为准

覆盖：0.2 修订记录第 1 条（"契约由返回值携带"）、第 7 条（`<grit-inject>`）、§6A 的两条 bullet、§15 第 2/4 条。

1. **契约是"一条真消息"**：`ulw_enter` 校验授权后，用 `ctx.session.prompt({sessionID, text})` 把「契约 + 目标」注入成本会话的一条真实用户消息（`<system-reminder>` 包裹，契约块保留 `<!-- GRIT:ULW:CONTRACT -->` 首尾哨兵）。工具返回值只回一句短确认；只有 prompt 注入失败时才把契约退回工具结果兜底。理由：工具结果在上下文压缩后会丢，真消息不会。
2. **压缩恢复走事件**：删除 `context` 钩子里"扫哨兵 + 补契约"的恢复分支，改在 **`session.compaction.ended`** 重注入一次契约（多实例按会话 5 秒去重），并刷新续跑计时避免紧接着双推。**`session.compacted` 到不了插件**：插件事件流走 `@opencode/schema` 的 `ServerDefinitions`，其中只有 `session.compaction.{started,delta,ended,failed}`（`session.compacted` 只在内部 `Definitions` 里）。
3. **兜底**：`context` 钩子在账本 active 且历史里确实找不到契约时贴回一次（60 秒节流），覆盖 revert / 收件箱取消这类没有压缩事件的丢失路径。
4. **退出提醒由账本驱动**：`exitUlw` 置 `exitNoticePending=true`，下一次请求组装贴一次「已退出」提醒并清标记；不再扫用户消息里的 `[GRIT:ULW:EXIT]` 子串（用户正文提到该词会误判）。用户 `/ulw-exit` 与模型 `ulw_exit` 共用同一函数、同一段文本。
5. **prompt 钩子识别自己的注入**：`isPluginInjectedText()`（契约块 / 续跑块）直接跳过，否则刚注入的契约会被当成"用户插话"，把刚进入的账本打成暂停。
6. **同一批的其他清理**：`_shared.md` 已删（各角色说明书自带完成标准）；Dead 字段 `toolLoopWarn` 已从类型、默认值与 profile 中删除；`clone_repo` 增加 url/ref 参数注入防护（`--`、`--detach`、字符集与首字符校验 + 纯函数 `isSafeGitUrl`/`isSafeGitRef`）。
7. **子代理 `description` 只写能力**，不写"什么时候用我"——"什么时候用谁"只在 build 的 `<routing_table>` 与 `<expert_policy>` 里。（`plan` 归 OpenCode 原生，不动。）
8. **与原生提示词的分工**（实测 `opencode debug agents` + 扫 `opencode.exe`）：原生给 build 的提示词带 Communication/Truthfulness/**Verification**/Preciseness/Tool-Use 五节，给 explore 的提示词已含"只读、绝对路径、并行"，给 plan 的 `opencode.plan` 代理自带 `edit:deny` 权限与 Plan-mode 提醒。据此把 `explore.md` 去重（删掉与原生重复的绝对路径/只读/并行措辞），并**显式覆盖**一处与原生相抵的表述：原生"不得创建任何文件"会让 `clone_repo`（克隆到本机缓存）变成违规，故新增 `<write_exception>` 声明它是唯一被授权的写动作。build/plan 的纪律块与原生不重复，保持不动。
