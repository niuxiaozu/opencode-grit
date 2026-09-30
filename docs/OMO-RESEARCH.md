# 更名公告

> **更名公告**：本项目已更名为 **grit**（原名 omo-lite，2026-09-20）。下文的 omo-lite/omo 字样为历史记录，一律指本套件。

# OmO（oh-my-openagent）设计研究笔记

> 研究对象：`code-yeongyu/oh-my-openagent` dev 分支（本地克隆 `C:\Users\ADMINI~1\AppData\Local\Temp\opencode\omo`）。
> 目的：为 omo-lite 吸收其代理设计与 ULW（ultrawork）机制精华。**只记结论与取舍，不做全景复述。**

## 1. 代理阵容（10 个）与设计模式

sisyphus（主编排）/ hephaestus（GPT 专属自主 worker）/ atlas（计划执行编排）/ prometheus（规划，只写 `.omo/*.md`）/ oracle（贵价只读顾问）/ explore（上下文 grep）/ librarian（外部引用 grep）/ metis（规划前顾问）/ momus（计划审查，"80% 清晰即批准"偏置）/ sisyphus-junior（类目生成的专注执行者）/ multimodal-looker。

**值得抄的设计：**

| 设计 | 原文位置 | omo-lite 取舍 |
|---|---|---|
| 8 段固定骨架：Role → Intent Gate → 委派检查 → 6 段委派 → 证据要求 → 失败恢复 → 完成清单 → Hard Blocks | `agents/sisyphus/default.ts` | ✅ 已体现在 build.md（Intent 言语化被否——foreman-buddy 结论：便宜模型念意图纯烧 token）|
| **6 段式委派契约**（TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT，"委派提示词少于 5 行=太含糊"） | sisyphus L370-389 | ✅ 已并入 build.md `<delegate>` |
| **证据要求**："NO EVIDENCE = NOT COMPLETE"（edit→lsp 干净；build→exit 0；test→真实通过输出；委派→已验证结果） | sisyphus L436-443 | ✅ 已并入 build.md `<verify>` |
| 执行者极小提示词 + **强终止条款**（"STOP after first successful verification. Maximum status checks: 2."） | sisyphus-junior | ✅ 已并入 factory.md；解决子代理过度自查/死循环 |
| 代理元数据（cost/useWhen/avoidWhen/keyTrigger）**动态渲染**进主代理提示词 | `dynamic-agent-core-sections.ts` | ❌ 不抄——阵容固定 6 个，写死更简单（轻量优先）|
| 声明式 permission（deny/allowlist 合并用户 override） | `shared/permission-compat.ts` | ✅ 已用 frontmatter `permission` 原生支持 |
| Hook 级门禁（prometheusMdOnly：规划代理只许写 `.omo/*.md`；noSisyphusGpt 型号配对门禁） | `src/hooks/` | ❌ 暂不加（需要插件钩子，违背"零钩子"目标；权限已够用）|

## 2. ULW（ultrawork）机制

三种载体：① 关键词触发（正则命中 `ulw`/`mass ulw` → messages.transform 注入契约；**先剥 code block 再匹配**防误触发）；② 契约文本本体（`packages/prompts-core/prompts/ultrawork/default.md`，337 行）；③ 结构化循环（ulw-loop：`.omo/ulw-loop/` 下 goals.json + append-only `ledger.jsonl` 证据账本 + **Stop hook 注入续跑 + 2 击熔断**；同一 criterion 连败 3 次或单 goal 5 轮无进展 → 标 failed 停）。

**契约核心（已吸收进 /ulw 与 build.md `<ulw>`）：**

- **绝对确定性开场**：不 100% 理解前不动手；计划里出现"大概/可能"= 没准备好。
- **场景契约（完成判定）**：动手前写 1-2（多面/高风险 3+）个场景，**二元可观察通过条件**，作为"完成合同"。
- **七段持久记事本**：`# 目标 / Plan / Scenarios / Now / Todo / Findings(file:line) / Learnings`，append-only，上下文丢失重读续跑。
- **双证据**：RED→GREEN 测试输出 **+** 真实表面工件（curl 状态/CLI 输出/DB diff/截图）；"测试通过"单独不算证据。
- **清理即 QA**：遗留进程/端口/临时目录 = 未完成。
- **零借口/零容忍**："简化版/骨架版/demo = 不可接受"（注：这条与"造假数据"诉求冲突——ULW 禁的是**交付** mock 冒充真实现，不禁止为**测试**制造 fake 数据，factory 代理守的就是这条边界）。
- **完成判定铁律**：ledger 全 pass 不等于完成——**用户问题是否在可观察行为上真正解决**才是决定性测试；满足即停，不加戏。

## 3. 其他功能速览（轻量版未抄，留档）

- **background-agent**：后台子代理独立 session + parent-wake（结果以 `<system-reminder>` 注入父会话，父代理绝不轮询）。❌ opencode 原生 Task 已够。
- **delegate-core**：委派模型 7 级兜底 + 9 类委派错误 → 生成纠错提示回注。❌ 单模型档二元制用不上。
- **category 系统**：每个类目 = 模型+variant+`promptAppend`+`callerGuidance`。❌ foreman-buddy 已裁定：两档模型塌缩成二元。
- **goal hook**：`.omo/goal/{sessionID}.json`，idle 续注推进提示，objective 包 `<untrusted_objective>` 防注入。✅ OpenChamber 已有等价物。
- **boulder-state / memory-core / rules-engine / team-core**：跨会话状态机 / git 即记忆 / 规则文件 glob 注入 / 多代理团队邮箱。均需插件基建，❌ 轻量版不引入。
- **fake data 相关**：**omo 没有专门的造假数据代理**（只有 QA 用的 omo-mock 假 provider 和 fakes-over-mocks 测试教义）——factory 代理是 omo-lite 的原创补充。

## 4. 对轻量版的最终取舍清单

| 吸收 ✅ | 拒绝 ❌ |
|---|---|
| 6 段式委派契约（build.md）| Intent 言语化（烧 token）|
| NO EVIDENCE = NOT COMPLETE（build.md）| 代理动物园（6 个够了）|
| 场景契约 + 双证据 + 清理即 QA（/ulw、build.md）| 契约全文注入（337 行 → 压缩成 ~15 行纪律）|
| 七段持久记事本（/ulw）| ulw-loop CLI/账本/Stop-hook 循环（OpenChamber 已管循环）|
| 强终止条款（factory.md）| hook 门禁/动态渲染/category/team/memory|
| fakes-over-mocks 教义（factory.md）| keyword 正则触发（原生命令 `/ulw` 已是确定性入口）|
