# 更名公告

> **更名公告**：本项目已更名为 **grit**（原名 omo-lite，2026-09-20）。下文的 omo-lite/omo 字样为历史记录，一律指本套件。

# omo-lite 设计稿 A（助手版）

> 需求来源：`docs/REQUIREMENTS.md`（用户全部决议）。omo 机制事实：`docs/OMO-RESEARCH.md`。
> 本稿为两份独立设计之一，供综合评判。

## 1. 设计原则（从痛点推导）

| 痛点 | 设计对策 |
|---|---|
| 太复杂改不动 | 机制封顶四件、每件独立可关；纪律/契约/代理全部外置文件；插件不含任何提示词文本 |
| 误触发不可控 | 唯一入口是斜杠命令；注入带 marker 幂等防护；续跑被 turn-boundary pause 与真实用户消息打断 |
| 循环失控 | 续跑七道门 + 2 秒倒计时 + 失败上限 + 回复无进展即停；完成判定以场景契约为合同 |
| token 成本 | 全量契约 1 次 + 每轮 1 行标记 + 压缩后恢复；行为参数热读不注入；占用率按需查询不注入 |

## 2. 总体架构

```
~/.config/opencode/
├── agents/*.md                      # 6 代理（md 层=基础设定，文件即配置）
├── commands/{ulw,handoff,profile,stop-continuation}.md
├── plugins/omo-lite.ts              # 唯一插件：四机制 + 五工具
└── omo-lite/                        # 本项目专属外置配置（插件读取）
    ├── profiles/{default,glm,deepseek,strict}.json
    ├── profiles/.active             # 激活指针（内容=profile 名，文本文件）
    └── contracts/
        ├── ulw.md                   # 静态纪律七项（去校准段）
        └── calibration/{default,glm,deepseek}.md
```

项目仓库（D:\...\omo-lite）为源，install 脚本把 agents/commands/plugins 复制到配置目录，把 contracts/profiles 复制或链接到 `~/.config/opencode/omo-lite/`。

## 3. 代理层（6 个 md）

frontmatter：description/mode/model/permission。build 常驻提示词七段：identity / search-rule / struggle-rule / delegate（6 段式契约） / verify（V1-V3 + "验收=证据制"一行） / hard-blocks / style。**不含 ULW 纪律**（分层决议 R10）。

## 4. 命令层（4 个 md）

| 命令 | 模板职责 |
|---|---|
| `/ulw <目标>` | 触发器：正文很短（"开启持续工作模式，目标：$ARGUMENTS"）；契约由插件注入（非命令文本），因为校准段要按 profile 动态拼 |
| `/stop-continuation` | 停续跑+清 ULW 状态（正文指令 + 插件 chat.message 识别清除状态） |
| `/handoff` | 立即交接指令 + 摘要模板（静态，无需插件参与） |
| `/profile <名字>` | 触发器："切换到 profile：$ARGUMENTS"——插件识别后调内部切换逻辑（写 .active），并告知生效边界 |

## 5. 插件四机制（每件独立可关，环境变量或 profile.behavior 均可关停）

### M1 契约注入器（chat.message + event）

- `/ulw` 前缀识别 → 会话状态 ulwOn=true → **本次消息追加全量契约**（contracts/ulw.md + calibration/<profile.calibration>.md 拼接，剥掉 marker 已存在的情况）；追加进用户消息 text part → 持久化为历史，缓存安全。
- 后续每条用户消息（ulwOn 且非 /stop）：追加一行 `<ulw-mode>active</ulw-mode>`（幂等：消息已含则不注）。
- `session.compacted` → needsRestoration=true → 下条消息重新全量注入。
- `/stop-continuation` 或含"停止ulw"类显式短语 → ulwOn=false（仅精确命令与 /stop 前缀，不做子串匹配——零误触发）。
- token 快照缓存照旧（message.updated/step-finish，拒全 0）。

### M2 续跑器（event：session.idle 等；todo 驱动 + 全套护栏）

门序列：主会话（非子代理）→ 非 ULW 关闭态 → 3s 内无 abort → 有未完成 todo → 无 in-flight → 冷却通过（5s 基数，失败指数退避，5min 窗口重置）→ 连续失败 <5 → 上下文占用 <85%（token 快照判断，超限跳过并等压缩）→ turn-boundary 未阻塞 → **2s 倒计时**（期间真实用户消息/会话活动/错误取消）→ 注入续跑提示（列实际未完成 todo + 提醒全部完成后干净收尾）。
turn-boundary pause：注入后若下一轮模型有回复但 todo 零进展 → blockReason=directive-response 停；续跑窗口内真实用户消息 → blockReason=user-interruption 停。由真实 todo 进展解除。

### M3 profile 渲染器（config + chat.params + tool）

- config 钩子：读 `omo-lite/profiles/.active` → 读对应 JSON → 只覆盖存在的字段：`agent.<name>.model`、`prompt` 变体（见下）、`permission`；不覆盖用户在 opencode.json 手写的同名显式配置（profile 优先级高于默认，低于用户手写？——**裁定：profile 即用户意图，覆盖 md 默认；opencode.json 显式项最高**）。
- 提示词变体组织：`agents/variants/<agent>.<variant>.md`（可选文件），profile.prompts={"build":"strict"} 指到 variants/build.strict.md 的正文替换默认 prompt。无 variants 目录则该字段忽略。
- chat.params 钩子：profile.params 的 temperature/variant/topP 每请求热应用。
- 行为参数（M1/M2 用）每次事件热读激活 profile 的 behavior + 环境变量覆盖。
- 校准段选择：M1 拼契约时读 profile.calibration。

### M4 工具箱（tool 钩子，5 个无状态工具）

`context_usage` / `system_time` / `clone_repo` / `handoff`（同 v0.1）+ `profile`（参数：name；写 .active 并读出该 profile 生效边界返回"立即生效项/需重启项"；LLM 可调用，`/profile` 命令正文也指示模型调用此工具）。

## 6. profile schema（外置 JSON）

```jsonc
{
  "name": "glm",
  "calibration": "glm",                      // M1 拼契约用
  "models":   { "build": "zhipuai-coding-plan/glm-5.3-flash", "expert": "zhipuai-coding-plan/glm-5.3" },
  "params":   { "temperature": 0.1, "variant": "high" },     // 热切
  "prompts":  { "build": "strict" },                          // variants 文件，config 时生效
  "permissions": { "build": { "task": { "*": "deny" } } },    // config 时生效
  "behavior": { "autoContinue": true, "maxConsecutiveFailures": 5,
                "cooldownMs": 5000, "countdownSec": 2,
                "contextCeiling": 0.85 }                      // 热读
}
```

## 7. 契约文本结构（contracts/ulw.md，静态纪律七项）

① 持续工作规则（todowrite 单 in_progress、不停顿等用户、七段记事本、context_usage≥45% 即 handoff、完成即干净收尾）② 场景契约 ③ 验收证据制（真实执行痕迹，无 TDD 顺序）④ 审查门 ⑤ MANUAL QA 矩阵（含清理即 QA）⑥ 零容忍清单 ⑦ 完成判定清单。目标与一次性说明的提炼规则写在开头（目标自设，同 foreman-buddy v17 裁定）。**全文控制在 ~120 行内**（omo 337 行是 token 反面教材，纪律密度优先）。

## 8. 会话内生效边界（写进 profile 工具返回值与 README）

热切：params（temperature/variant/topP）、behavior、校准段选择、模式纪律注入。
重启生效：models、prompts 变体、permissions。

## 9. 与共存栈边界

auto-handoff 技能 / OpenChamber goal / worktime 不动不复建。omo-lite 的续跑器与之天然兼容（OpenChamber 不注入时 omo-lite 兜底；若将来冲突，profile.behavior.autoContinue=false 一键关）。

## 10. 安装/验证

install.mjs：备份 opencode.json → 复制 agents/commands/plugins → 复制 omo-lite/{profiles,contracts} → 确认 opencode.json 无 agent 块 → 卸载可还原。
验证：tsc --noEmit；冒烟测试（纯函数：注入拼接/标记幂等/续跑门序列/护栏状态机/契约校准拼接/profile 解析）；frontmatter/JSON 解析检查；部署后文件到位断言。

## 11. 明确不做

关键词触发、挣扎计数、意图言语化、category 系统、代理动物园、变体代理、自建 spawn 引擎、TUI、TDD 强制流程、内嵌提示词文本。
