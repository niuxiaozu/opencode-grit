# 更名公告

> **更名公告**：本项目已更名为 **grit**（原名 omo-lite，2026-09-20）。下文的 omo-lite/omo 字样为历史记录，一律指本套件。

# omo-lite 需求与决议记录（REQUIREMENTS）

> 本文件是用户在多轮设计讨论中的**全部拍板决议**，是设计文档的唯一需求来源。
> 事实性背景一并记录。设计自由度不在本文件约束范围内。

## 0. 背景事实

- 前身项目 foreman-buddy（工头小弟）：OpenCode 插件，17+ 轮迭代，5 类钩子的状态机（代理注入/ULW 续跑注入/关键字拦截/handoff/挣扎计数）。已被用户放弃并卸载。痛点见 R1。
- 参考项目 oh-my-openagent（OmO，code-yeongyu/oh-my-openagent dev 分支，本地克隆 `C:\Users\ADMINI~1\AppData\Local\Temp\opencode\omo`）与 oh-my-opencode-slim（`C:\Users\ADMINI~1\AppData\Local\Temp\opencode\omo-slim`）。研究结果见 `docs/OMO-RESEARCH.md`。
- 现有项目 omo-lite（D:\workspace\selfProjects\agent-worktemp\omo-lite）：讨论期间产出的 v0.1 初稿（纯 markdown 代理 + 4 工具插件，已部署）。**用户裁定推倒重谈**：v0.1 只当参考，从需求重新设计。
- 环境：OpenCode 1.18.23 / Windows / 模型 zhipuai-coding-plan/glm-5.3-flash 与 glm-5.3 / 共存栈：OpenChamber（goal/schedule/会话管理）、opencode-worktime 插件、auto-handoff 用户技能。
- opencode 硬约束（源码/文档验证过）：`chat.params` 钩子不能改模型本体（只能 temperature/topP 等）；agent 注册表启动时加载，配置非热加载；原生 Task 工具参数无 model（子代理模型来自 agent 定义）；agent md 文件 frontmatter 支持 description/mode/model/permission 等。

## 1. 核心痛点（R1，全选）

1. 太复杂改不动（foreman-buddy 式状态机看不懂、维护累）
2. 误触发不可控（关键字/事件误触发、误报）
3. 循环失控（持续工作停不下来/虚跑）
4. token 成本（注入太多、重复注入、缓存失效）

## 2. 轻量化的定义（R2）

**轻量化 ≠ 代码行数少/零插件**，而是四个维度：token 轻量、工具轻量、机制轻量、agent 数轻量。
**用插件方式动态切换 agent 的提示词或设定是被明确允许的。**
机制数量不设硬上限，"需要的就可以加"，但整体必须比 omo 轻量。

## 3. 代理阵容（R3）

功能命名 6 个：`build`（主编排）/ `plan` / `explore` / `general` / `expert` / `factory`（造假数据+测试）。
不要变体代理方案（否决了"explore-strong 挂强模型"的思路）；子代理模型切换接受重启生效。
主代理模型切换：用户在界面 Tab 手切，可接受不热切。

## 4. ULW（持续工作模式）设计决议

- **开启方式**：仅斜杠命令 `/ulw <目标>`（R4）。不要关键词触发。
- **契约注入策略**：omo 式（R5）——全量契约只注入一次（追加进用户消息，成为历史持久部分）；之后每轮只注入一行激活标记；compaction 后检测标记丢失并重新全量恢复；`/stop-continuation` 或等价命令清除状态。
- **续跑机制**：todo 驱动 + 全套护栏（R6）。会话 idle 且有未完成 todo 时注入续跑提示，护栏全套：注入前 2 秒倒计时（给用户插话/喊停窗口）、冷却期指数退避、连续失败上限（超限暂停）、turn-boundary pause（注入后若模型回复了但 todo 没进展→停；真实用户消息打断→停）、abort 窗口、上下文超限跳过。
- **契约内容七项**（R9）：① 校准段 ② 场景契约 ③ 双证据（见 R13 去 TDD 化）④ 审查门 ⑤ MANUAL QA 矩阵 ⑥ 零容忍清单 ⑦ 完成判定清单。**明确不要 TDD 流程**（不强制先写测试）。
- **分层**（R10，已确认）：七项纪律全部放 ULW 注入层；build 常驻提示词保持轻量（identity/检索规则/升级规则/委派/验证/hard-blocks/风格），验收证据制在常驻层只提一句。

## 5. 校准段（R9 细化）

- 不止 GLM：需要 glm、deepseek、default 兜底，共三份起步，后续按需加。
- **归属**：校准段由 **profile 指定**（`calibration` 字段引用哪份），不是按模型自动识别——profile 是一级概念。

## 6. profile 系统（R7/R8）

- 抽象一层：**按 profile 切换**整套 agent 设定。不自动切换；用户创建 profile，手动切换。场景：按模型建 profile（换模型就切到对应 profile）、按工作模式建 profile（如严格模式）。
- **profile 管理范围（全都要）**：模型映射、提示词变体、行为设定（如 ULW 续跑开关/护栏参数）、权限/工具面。
- **存储与切换**：外置 JSON config；**不需要 TUI**；支持命令切换，且**要能"告诉大模型切到某个 profile"**（即 LLM 可调用的切换途径）；部分配置会话内生效。
- **会话内生效边界**（经研究确认的拆分）：行为参数/温度/variant/模式纪律 = 会话内热切（chat.params 钩子可热切参数；行为参数插件热读）；模型本体/权限 = 重启生效（opencode 硬限制）。子代理模型不搞变体代理，重启切。

## 7. 契约文件组织（R11）

契约文本**外置文件**，插件只负责读取与拼装（校准段按 profile 拼）。不内嵌在插件源码里。

> **2026-10-18 改判（收窄）**：契约（`contracts/ulw.md`）与角色纪律（`contracts/discipline/*.md`）**继续外置**——它们是纯文本、可自由改、改文件即生效。但**带变量拼接的便签/回话**（每轮标记、催办块、模式已关提醒、续跑提示、进入/拒绝/退出回话）**留在插件源码里**。理由：它们是**模板**而不是静态文本（如 `markerLine(目标)`、`continuationBlock(目标)`、契约 = `ulw.md` + 交接模板 + 首尾哨兵、纪律块 = 共用 + 角色 + 变体），外置需要自造占位符机制，而且照样不能随意改，得不偿失。

## 8. 验收证据制（R13/R14，去 TDD 化）

不规定开发流程（不强制先写测试），只规定**完成的证明方式**：
场景契约每条判据完成后必须附**真实执行的痕迹**（命令输出/测试运行结果/HTTP 状态/DB 记录/截图，形式不限）；"应该行/看代码觉得对"不构成完成依据。有测试接缝就跑测试作证据，无接缝就真实操作。RED→GREEN 顺序要求随 TDD 一并去掉。

## 9. 纪律项内容参考（来自 omo 的 ultrawork 契约，见 OMO-RESEARCH.md 第 2 节）

- 场景契约：动手前写 1-3（多面/高风险 3+）个场景，二元可观察通过条件，作为完成合同
- 审查门：3+ 文件/碰安全·权限·迁移/30min+/用户要求严格 → 触发复查；blocker 必须引用失败判据；最多回审 2 轮
- MANUAL QA：按改动类型强制真实操作（CLI 跑命令贴输出/UI 截图/配置加载验证）；清理进程/端口/临时目录也算 QA
- 零容忍：禁"简化版/demo/先做一部分/应该能行"式收尾
- 完成判定：账面全绿 ≠ 完成；逐项清单（交付物在位/符合惯例/证据在手/未碰无关/风险明说）
- 校准段参考 omo glm.md：治过度计划/叙述不选择/承诺式收尾，按模型族调措辞

## 10. 落地方式

用户指令：设计定稿后"开始进行代码落地，直接重构原本的插件项目"（按 omo-lite 项目理解），含验证与重新部署。

## 11. 待定项（设计阶段需给出方案）

- profile 的激活指针机制（放哪、怎么改、怎么被插件读取）
- 提示词变体的文件组织（profile 如何覆盖 agents/*.md 的提示词）
- /ulw 契约的准确文本结构、/profile、/stop-continuation 命令文本
- 插件机制清单与钩子分配（以"比 omo 轻量、每件独立可关"为原则）
- handoff/context_usage/system_time/clone_repo 等工具是否保留及形态
- 安装/卸载与部署形态
