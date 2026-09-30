# grit — 轻量多代理套件（v2.0）

原创的轻量多代理套件：让普通档模型靠提示词设计、纪律契约与编排，干出高难度的事。按**四维轻量**构建：token 轻量、工具轻量、机制轻量、agent 数轻量。
不是"零插件"，而是"小而准的插件"：**机制只有 4 件、工具只有 5 个、插件源码 0 行提示词**——契约与代理设定全部外置为可读可改的文件。

> 更名：原名 omo-lite（早期参考过 omo/oh-my-openagent 的部分设计，现以原创功能为主，故更名 grit）。
> 演进史：前身 foreman-buddy（5 类钩子状态机，17+ 轮迭代仍误触发/循环失控/token 失控）→ v0.1（零插件纯 md，作参考）→ 本版（v2.0，由需求决议 + 双设计稿 + 专家综合评判的终稿实现）。
> 设计文档：**[docs/DESIGN.md](docs/DESIGN.md)**（终稿规格书）｜需求决议：[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)｜omo 研究：[docs/OMO-RESEARCH.md](docs/OMO-RESEARCH.md)

## 组成

| 层 | 内容 | 说明 |
|---|---|---|
| 代理层 | `agents/*.md` ×6（物化产物） | build（主编排，flash）/ plan（规划，强档）/ explore（只读检索）/ general（并行执行）/ expert（**决策与知识权威**：架构权衡/高爆炸半径评审/生态知识，先咨询后动工）/ **factory（造假数据+测试）**。frontmatter 的 model/permission 由 profile 物化注入 |
| 命令层 | `/ulw` `/stop-continuation` `/handoff` `/profile` | 原生斜杠命令；`/ulw` 首行哨兵由插件识别注入契约 |
| 契约层 | `contracts/ulw.md` + `calibration/{default,glm,deepseek}.md` + `handoff-template.md` | 七项纪律（场景契约/验收证据/审查门/QA矩阵/零容忍/完成判定/校准段）；校准段由 **profile 指定**；现读现拼，改文件即改契约 |
| profile 层 | `profiles/{default,glm-max,strict,bare}.json` + `active` 指针 | 模型映射/提示词变体/行为参数/权限/机制开关，一键切换 |
| 插件层 | `plugins/grit.ts` 单文件 | 四机制 + 五工具，纯函数决策核 |

## 四机制（各自独立可关）

| 机制 | 干什么 | 开关 |
|---|---|---|
| A 契约注入器 | `/ulw` → 全量契约注入 1 次（持久入历史）；之后每轮只加 1 行激活标记；上下文压缩后自动恢复 | `features.contractInjector` |
| B 续跑器 | 有未完成 todo 且会话空闲时自动续跑；**13 道门 + 2s 倒计时 + 五层熔断**（冷却指数退避/失败上限/停滞/用户打断/abort与超限即停） | `features.todoContinuation` |
| C profile 引擎 | chat.params 热切参数；启动自检；profile 工具（list/show/switch） | `features.profileEngine` |
| D token 快照 | 被动缓存，供占用率查询与续跑护栏 | 常开 |

总闸：环境变量 `GRIT_DISABLE=1`（兼容旧 `OMO_LITE_DISABLE`）。全关 = 纯工具箱（`bare` profile 等价形态）。

## profile 切换

```bash
/profile glm-max        # 会话内敲命令，模型会调 profile 工具切换
/profile                # 列出全部
```
**生效边界**：机制开关/阈值、params（temperature/topP/variant）、校准段 = **立即生效**；模型映射/权限/提示词变体 = **重启生效**（opencode 硬限制：chat.params 不能改模型本体、agent 注册表启动加载）。
终端方式（零 API，任意终端）：`grit profile`（列出）/ `grit profile <名字>`（切换；运行中会话 ≤3s 热感知热生效部分）。

## 日常使用

- 平时：正常对话，6 代理按需 Tab/@/Task（build 常驻提示词只管编排/验证/升级纪律）
- 持续工作：`/ulw <目标>` → 契约注入 → todowrite 清单 → 连续推进（空闲自动续跑，插话即打断）
- 停止：`/stop-continuation`（确定性落盘，模型忽略文本也会停）或 Esc
- 交接：`/handoff`，或契约内交接阶梯自动触发（≥45% 或压缩先到 → 立即；≥25% 且阶段性成果+下一阶段无关联 → 也交接；<25% 继续）
- 造假数据：`@factory` 或让 build 委派（确定性 fixture/种子数据/数据驱动测试）

## 安装 / 卸载

```bash
cd grit
node scripts/install.mjs            # 安装（备份 opencode.json → bak-grit；物化 agents）
node scripts/install.mjs uninstall # 卸载（还原配置 + 整删数据根）
node scripts/materialize.mjs --profile strict  # 手动按某 profile 重物化 agents
```

安装后**重启 OpenCode 生效**。回滚 = uninstall。

## QA（自吃狗粮：验收证据制）

```bash
npm run check   # tsc --noEmit
npm test        # 确定性冒烟（56 断言）：哨兵匹配/契约拼装/13门矩阵/事件分类/物化核/插件形态
```

活体 smoke（需重启后人工，见 DESIGN §13.4 七项）：`/ulw` 哨兵透传 → 契约注入 → 续跑注入 → Esc 停止 → `/stop-continuation` → `/profile` 切换 → 压缩恢复。

## 边界与互斥

- 与 OpenChamber / opencode-worktime / auto-handoff 技能共存，不重复建设。**约定互斥**：OpenChamber goal 驱动的会话不要敲 `/ulw`（两套续跑会叠加）；冲突时 `features.todoContinuation.enabled=false` 或切 `bare` 一键关。
- 明确不做：关键词触发、变体代理、代理动物园、TDD 强制、意图言语化、插件写 opencode.json（见 DESIGN §14）。

## 默认裁定（可改，见 DESIGN §15）

handoff 阈值 = 双阶梯（≥45% 立即；≥25% 条件交接——用户拍板恢复 auto-handoff 技能原语义）；max-failures 暂停 10min 自动解除；注入物 TUI 可见（透明可审计）；空清单首回给建清单提醒；契约中文。
