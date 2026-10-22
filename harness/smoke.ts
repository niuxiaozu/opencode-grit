/**
 * grit v3 确定性冒烟测试（无网络、无真实 LLM）：
 *   node harness/smoke.ts
 * 覆盖：纯函数回归、哨兵匹配、契约拼装、纪律块、消息解析（目标/完成/指纹/工具循环）、
 * 续跑门矩阵、agent 记录物化（含"绝不含 system"）、插件接线形态。决策核全纯函数 → 全可测。
 */

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import gritPlugin from "../plugin/grit.ts"
import { validateProfile, buildAgentRecord, buildAgentRecords, readAgentsIndex } from "../scripts/materialize-core.ts"

let passed = 0
let failed = 0
function ok(cond: boolean, name: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`)
  }
}

// ===================== 1. 基础纯函数 =====================
console.log("[pure basics]")
const S = gritPlugin.toSnapshot
ok(S({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }) === null, "toSnapshot 拒全 0 占位")
ok(S({ input: 100, output: 0, reasoning: 0, cache: { read: 900, write: 0 } }) !== null, "toSnapshot 收正数快照")
ok(gritPlugin.contextLine({ input: 385_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 1_000_000) === "[context: 385K/1.0M tokens used (39%)]", "contextLine 385K→39%")
ok(/^\d{4}-\d{2}-\d{2}/.test(gritPlugin.systemTimeLine()), "systemTimeLine 格式")
ok(gritPlugin.withHandoffMarker("正文", "兜底").startsWith("[HANDOFF]") && gritPlugin.withHandoffMarker("正文", "兜底").includes("正文"), "withHandoffMarker 补前缀")

// ===================== 2. 哨兵匹配（GRIT:ULW:* 命名） =====================
console.log("[sentinel]")
ok(gritPlugin.matchSentinel("[GRIT:ULW:EXIT]\n") === "[GRIT:ULW:EXIT]", "退出哨兵识别（/ulw_exit）")
ok(gritPlugin.matchSentinel("前言\n[GRIT:ULW:EXIT]\n") === "[GRIT:ULW:EXIT]", "第二行命中")
ok(gritPlugin.matchSentinel("[GRIT:ULW:CONTINUE]\n继续") === "[GRIT:ULW:CONTINUE]", "续跑哨兵识别（防回声）")
ok(gritPlugin.matchSentinel("[GRIT:ULW:START]\nhi") === null, "START 不再是拦截哨兵（按真实用户消息处理）")
ok(gritPlugin.matchSentinel("文中提到 [GRIT:ULW:EXIT] 不在首行") === null, "行中引用不命中")
ok(gritPlugin.matchSentinel("[GRIT:ULW:EXI]\n") === null, "子串变体不命中")
ok(gritPlugin.matchSentinel("[grit:ulw:v1]\n") === null, "旧命名不再命中")

// ===================== 3. 契约 / 纪律块 =====================
console.log("[blocks]")
const ct = gritPlugin.assembleContract("A\n{{handoff_template}}\nB", "HANDOFF模板")
ok(ct.startsWith("<!-- GRIT:ULW:CONTRACT -->") && ct.endsWith("<!-- /GRIT:ULW:CONTRACT -->"), "契约块首尾哨兵")
ok(ct.includes("HANDOFF模板") && !ct.includes("{{handoff_template}}"), "handoff 槽位替换")
const db = gritPlugin.disciplineBlock("build", "DO X")
ok(db.startsWith('<GRIT-DISCIPLINE agent="build">') && db.includes("[GRIT:DISCIPLINE:build]") && db.endsWith("</GRIT-DISCIPLINE>"), "纪律块带自解释标签")
ok(gritPlugin.markerLine("x".repeat(200)).includes("[GRIT:ULW:ACTIVE]") && gritPlugin.markerLine("").length < 500, "marker 行含激活哨兵")
ok(gritPlugin.markerLine("A".repeat(200)).includes("A".repeat(200)), "marker 不截断目标")
ok(gritPlugin.markerLine("").includes("ulw_exit"), "marker 指引调用 ulw_exit 退出")
const mArr: any[] = [{ id: "u", role: "user", content: [{ type: "text", text: "hi" }] }]
gritPlugin.appendInject(mArr, "<grit-inject>X</grit-inject>")
ok(gritPlugin.messagesContain(mArr, "X") === true && mArr[0].content.length === 2 && mArr[0].content[0].text === "hi", "appendInject 追加到末条 user 消息（不改前缀）")
const mArr2: any[] = []
gritPlugin.appendInject(mArr2, "Y")
ok(mArr2.length === 1 && mArr2[0].role === "user", "appendInject 无 user 消息时新建一条")
const cont = gritPlugin.continuationBlock("完成 X")
ok(cont.startsWith("<system-reminder>") && cont.includes("[GRIT:ULW:CONTINUE]") && cont.includes("ulw_exit") && cont.includes("完成 X"), "续跑块：system-reminder 包裹 + 哨兵/退出指引/目标")
ok(gritPlugin.matchSentinel(cont) === "[GRIT:ULW:CONTINUE]", "包裹后防回声仍生效（哨兵在第 2 行）")
ok(gritPlugin.markerLine("o").startsWith("<system-reminder>") && gritPlugin.markerLine("o").includes("[GRIT:ULW:ACTIVE]"), "标记块也改用 system-reminder 包裹（借原生背书）")

// ===================== 4. 消息解析（v2 扁平 {role,content:[...]} + session.context 形态） =====================
console.log("[messages]")
const ctxMsgs = [
  { id: "u1", role: "user", content: [{ type: "text", text: "do X" }], metadata: {} },
  { id: "a1", role: "assistant", content: [{ type: "reasoning", text: "think" }, { type: "text", text: "working" }] },
]
ok(gritPlugin.lastAssistantText(ctxMsgs) === "working", "lastAssistantText 取末条 assistant 文本")
ok(gritPlugin.lastUserTextOf(ctxMsgs) === "do X", "lastUserTextOf 取末条 user 文本")
ok(gritPlugin.lastUserTextOf([]) === "", "空消息 → 空串")
const otherMsgs = [...ctxMsgs, { id: "a2", type: "assistant", content: [{ type: "text", text: "different" }] }]
ok(gritPlugin.responseFingerprint(ctxMsgs) !== gritPlugin.responseFingerprint(otherMsgs), "指纹随响应变化")
const flat = [{ id: "u", time: {}, text: "hi", files: [], type: "user" }]
ok(gritPlugin.lastAssistantText(flat) === "", "session.context 扁平 user 形态不误判")
const toolMsgs = [{ content: [{ type: "tool", name: "shell", state: { input: { cmd: "ls" } } }, { type: "tool", name: "shell", state: { input: { cmd: "ls" } } }, { type: "tool", name: "shell", state: { input: { cmd: "ls" } } }] }]
ok(gritPlugin.maxToolRepeat(toolMsgs) === 3, "maxToolRepeat 统计重复工具调用")
ok(gritPlugin.maxToolRepeat([]) === 0, "空消息 → 0")

// ===================== 5. 续跑门矩阵 =====================
console.log("[continuation gates]")
const mkState = (over: Partial<Parameters<typeof gritPlugin.decideContinuation>[0]> = {}): Parameters<typeof gritPlugin.decideContinuation>[0] => ({
  schemaVersion: 2, sessionID: "s", directory: "d", active: true, objective: "o", epoch: 1,
  activatedAt: 0, contractFingerprint: null, stopReason: null, pauseReason: null, totalInjections: 0, exitNoticePending: false, ...over,
})
const mkCtr = (over: Partial<Parameters<typeof gritPlugin.decideContinuation>[1]> = {}): Parameters<typeof gritPlugin.decideContinuation>[1] => ({
  lastInjectedAt: 0, consecutiveFailures: 0, stagnationCount: 0, awaitingProgress: false, fingerprint: null, abortAt: null, ...over,
})
const mkIn = (over: Partial<Parameters<typeof gritPlugin.decideContinuation>[3]> = {}): Parameters<typeof gritPlugin.decideContinuation>[3] => ({
  occupancy: null, fingerprint: "fp", maxToolRepeat: 1, ...over,
})
const CFG = gritPlugin.DEFAULT_CONTINUATION
const NOW = 1_000_000_000_000

const r1 = gritPlugin.decideContinuation(mkState({ active: false }), mkCtr(), CFG, mkIn(), NOW)
ok(r1.kind === "skip" && r1.reason === "not-active", "非 active → skip:not-active")
const r2 = gritPlugin.decideContinuation(mkState({ stopReason: "manual" }), mkCtr(), CFG, mkIn(), NOW)
ok(r2.kind === "skip" && r2.reason === "stopped", "已停 → skip:stopped")
const r3 = gritPlugin.decideContinuation(mkState(), mkCtr({ abortAt: NOW - 1000 }), CFG, mkIn(), NOW)
ok(r3.kind === "skip" && r3.reason === "abort-window", "abort 3s 窗口内 → skip")
const r4 = gritPlugin.decideContinuation(mkState({ active: false, stopReason: "completed" }), mkCtr(), CFG, mkIn(), NOW)
ok(r4.kind === "skip" && r4.reason === "stopped", "模型已退出（active=false）→ 不再续跑")
const r5 = gritPlugin.decideContinuation(mkState({ pauseReason: "user-interruption" }), mkCtr({ fingerprint: "same" }), CFG, mkIn({ fingerprint: "same" }), NOW)
ok(r5.kind === "skip" && r5.reason === "paused:user-interruption", "用户打断暂停且响应未变 → skip")
const r6 = gritPlugin.decideContinuation(mkState(), mkCtr({ consecutiveFailures: 5, lastInjectedAt: NOW - 1000 }), CFG, mkIn(), NOW)
ok(r6.kind === "pause" && r6.reason === "max-failures", "连败 5 → pause:max-failures")
const r7 = gritPlugin.decideContinuation(mkState({ pauseReason: "max-failures" }), mkCtr({ consecutiveFailures: 5, lastInjectedAt: NOW - 600001 }), CFG, mkIn(), NOW)
ok(r7.kind === "countdown", "max-failures 超 10min 窗口 → 自动解除并继续")
const r8 = gritPlugin.decideContinuation(mkState(), mkCtr({ lastInjectedAt: NOW - 1000 }), CFG, mkIn(), NOW)
ok(r8.kind === "skip" && r8.reason === "cooldown", "冷却中 → skip:cooldown")
const r9 = gritPlugin.decideContinuation(mkState(), mkCtr({ lastInjectedAt: NOW - 19000, consecutiveFailures: 2 }), CFG, mkIn(), NOW)
ok(r9.kind === "skip" && r9.reason === "cooldown", "指数退避 5s×2²=20s 生效")
const r10 = gritPlugin.decideContinuation(mkState(), mkCtr(), CFG, mkIn({ occupancy: 90 }), NOW)
ok(r10.kind === "skip" && r10.reason === "context-high", "占用 90% → skip:context-high")
const r11 = gritPlugin.decideContinuation(mkState(), mkCtr(), CFG, mkIn({ maxToolRepeat: 5 }), NOW)
ok(r11.kind === "stop" && r11.reason === "tool-loop", "工具重复调用 5 次 → stop:tool-loop")
const r12 = gritPlugin.decideContinuation(mkState({ totalInjections: 200 }), mkCtr(), CFG, mkIn(), NOW)
ok(r12.kind === "stop" && r12.reason === "injection-budget", "预算触顶 → stop:injection-budget")
const r13 = gritPlugin.decideContinuation(mkState(), mkCtr({ awaitingProgress: true, fingerprint: "same", stagnationCount: 1 }), CFG, mkIn({ fingerprint: "same" }), NOW)
ok(r13.kind === "stop" && r13.reason === "stagnated", "注入后响应指纹未变（停滞上限 2）→ stop:stagnated")
const r14 = gritPlugin.decideContinuation(mkState(), mkCtr({ awaitingProgress: true, fingerprint: "old" }), CFG, mkIn({ fingerprint: "new" }), NOW)
ok(r14.kind === "countdown" && r14.counters.stagnationCount === 0, "响应有变化 → 清零停滞并继续")
const r15 = gritPlugin.decideContinuation(mkState(), mkCtr({ lastInjectedAt: NOW - 60000 }), CFG, mkIn(), NOW)
ok(r15.kind === "countdown", "全过 → countdown")

// ===================== 6. 事件分类 =====================
console.log("[event classify]")
ok(gritPlugin.classifyEvent({ errorText: "MessageAbortedError: user aborted" }) === "abort", "abort → 停止信号")
ok(gritPlugin.classifyEvent({ errorText: "prompt is too long: token limit exceeded" }) === "overflow", "超限 → 停止信号")

// ===================== 7. agent 记录物化（绝不含 system） =====================
console.log("[materialize-core]")
const vbad = validateProfile({ name: "x", model: { build: "badformat" } }, { expectedName: "x" })
ok(!vbad.ok && vbad.errors.length >= 1, "validateProfile 抓非法 model 格式")
const vok = validateProfile({ name: "x", model: { build: "p/m" } }, { expectedName: "x" })
ok(vok.ok && vok.errors.length === 0, "validateProfile 合法通过")
const vex = validateProfile({ name: "x", customField: 1 }, { expectedName: "x" })
ok(vex.ok && vex.warnings.some((w) => w.includes("customField")), "未知字段 → warning 不拒收")

const index = {
  build: { mode: "primary" as const, description: "b" },
  explore: { mode: "subagent" as const, description: "e", permissions: [{ action: "clone_repo", resource: "*", effect: "allow" as const }] },
}
const recB = buildAgentRecord("build", index.build, { model: { build: "p/strong" }, permissions: { build: [{ action: "subagent", resource: "*", effect: "deny" }] } }, {})
ok(recB.record.model === "p/strong" && recB.record.mode === "primary", "记录含 model/mode")
ok(recB.record.permissions?.some((p) => p.action === "subagent") === true, "profile permissions 注入")
ok(!("system" in recB.record), "记录绝不含 system（保留内置提示词）")
const recE = buildAgentRecord("explore", index.explore, { model: {} }, { model: { explore: "p/flash" } })
ok(recE.record.model === "p/flash", "缺 model 回退 default")
ok(recE.record.permissions?.some((p) => p.action === "clone_repo" && p.effect === "allow") === true, "explore 结构性放行 clone_repo")
const all = buildAgentRecords({ index, profile: { model: { build: "p/b", explore: "p/e" } }, defaultProfile: {} })
ok(Object.keys(all.records).length === 2 && all.records.build?.model === "p/b", "buildAgentRecords 全量物化")
ok(Object.values(all.records).every((r) => !("system" in r)), "全量记录均无 system")
ok(all.warnings.length === 0, "无缺 model 告警")

// readAgentsIndex 读真实仓库文件（交付保障）
const realIdx = readAgentsIndex(join(import.meta.dirname ?? ".", "..", "agents", "index.json"))
ok(Object.keys(realIdx).length === 5, `仓库 agents/index.json 含 5 席（实际 ${Object.keys(realIdx).length}）`)
ok(!("factory" in realIdx), "已移除 factory 席")
ok(!("plan" in realIdx), "plan 不在 grit 名册（由 OpenCode 原生 plan 模式承担）")
ok(realIdx.sage?.mode === "subagent", "sage 是 subagent（不进主代理列表；仍在子代理目录里，build 能调）")

// ===================== 8. 插件形态（V2） =====================
console.log("[plugin shape]")
const def = gritPlugin as unknown as { id?: unknown; setup?: unknown }
ok(def.id === "grit" && typeof def.setup === "function", "V2 形态：id='grit' + setup")
ok(JSON.stringify(gritPlugin.AGENT_NAMES) === JSON.stringify(["build", "explore", "general", "sage", "browse"]), "AGENT_NAMES 恰为 5 席（plan 归原生，无 factory）")
const tmpHome = mkdtempSync(join(tmpdir(), "grit-home-"))
mkdirSync(join(tmpHome, "agents"), { recursive: true })
writeFileSync(join(tmpHome, "agents", "index.json"), JSON.stringify(index), "utf8")
process.env.GRIT_HOME = tmpHome
const registered: { sessionHooks: string[]; tools: string[] } = { sessionHooks: [], tools: [] }
const fakeCtx = {
  location: { directory: "D:/tmp", project: { id: "p" } },
  session: { hook: async (name: string, _cb: unknown) => { registered.sessionHooks.push(name) } },
  tool: {
    transform: async (cb: (editor: { add: (t: { name: string }) => void }) => void) => {
      cb({ add: (t: { name: string }) => registered.tools.push(t.name) })
    },
  },
  event: { subscribe: (_o: unknown) => ({ [Symbol.asyncIterator]: async function* () {} }) },
}
await (gritPlugin.setup as (c: unknown) => Promise<unknown>)(fakeCtx)
const toolNames = registered.tools.slice().sort()
ok(
  JSON.stringify(toolNames) === JSON.stringify(["clone_repo", "context_usage", "handoff", "profile", "system_time", "ulw_enter", "ulw_exit"]) &&
    registered.sessionHooks.includes("prompt") && registered.sessionHooks.includes("context"),
  `V2 接线在位：prompt/context 钩子 + 7 个工具（含 ulw_enter/ulw_exit）：${toolNames.join(", ")}`,
)
ok(!registered.tools.includes("todowrite"), "不注册 todo 工具（v2 无 todo）")

// ===================== 9. 复审修复回归（F1 契约探测 / F6 插话恢复 / F4 错误分类） =====================
console.log("[review fixes]")
const toolMsgsWithContract = [{
  id: "a1", role: "assistant",
  content: [{
    type: "tool", name: "ulw_enter",
    state: { status: "completed", input: { goal: "g" }, content: [{ type: "text", text: "已进入持续工作模式\n<!-- GRIT:ULW:CONTRACT -->\nbody\n<!-- /GRIT:ULW:CONTRACT -->" }] },
  }],
}]
ok(gritPlugin.contractInHistory(toolMsgsWithContract) === true, "F1 契约探测：看得到工具结果 state.content 里的契约")
ok(gritPlugin.contractInHistory(ctxMsgs) === false, "F1 契约探测：普通对话不误判")
ok(gritPlugin.contractInHistory([{ content: [{ type: "text", text: "<!-- GRIT:ULW:CONTRACT -->" }] }]) === true, "F1 契约探测：顶层 text part 亦算")
ok(gritPlugin.contractInHistory([{ content: [{ type: "tool", state: { output: "<!-- GRIT:ULW:CONTRACT -->" } }] }]) === true, "F1 契约探测：兼容 state.output 形态")
const r16 = gritPlugin.decideContinuation(mkState({ pauseReason: "user-interruption" }), mkCtr({ fingerprint: "old", lastInjectedAt: NOW - 60000 }), CFG, mkIn({ fingerprint: "new" }), NOW)
ok(r16.kind === "countdown" && r16.state.pauseReason === null, "F6 插话后模型有新响应 → 解除暂停并继续")
const r17 = gritPlugin.decideContinuation(mkState({ pauseReason: "user-interruption" }), mkCtr({ fingerprint: "same", lastInjectedAt: NOW - 60000 }), CFG, mkIn({ fingerprint: "same" }), NOW)
ok(r17.kind === "skip" && r17.reason === "paused:user-interruption", "F6 响应未变化 → 保持暂停（不打扰）")
ok(gritPlugin.classifyEvent({ errorText: gritPlugin.errorTextOf({ name: "MessageAbortedError", message: "user aborted" }) }) === "abort", "F4 v2 结构化错误 → abort")
ok(gritPlugin.classifyEvent({ errorText: gritPlugin.errorTextOf({ message: "prompt is too long: token limit exceeded" }) }) === "overflow", "F4 v2 结构化错误 → overflow")

// ===================== 10. 上下文占用率（对齐 OpenCode 官方算法） =====================
console.log("[usage formula]")
const stepSnap = gritPlugin.toSnapshot({ input: 120_000, output: 4_000, reasoning: 0, cache: { read: 380_000, write: 1_000 } })
ok(stepSnap !== null, "toSnapshot 收下单步快照")
ok(gritPlugin.contextOccupancy({ input: 120_000, output: 4_000, reasoning: 0, cache: { read: 380_000, write: 1_000 } }, 1_000_000) === 51, "单步 token 相加（含 cache.write）→ 51%")
ok(gritPlugin.contextOccupancy({ input: 0, output: 0, reasoning: 0, cache: { read: 850_000, write: 0 } }, 1_000_000) === 85, "恰好 85% 的边界")
const pctCumulative = gritPlugin.contextOccupancy({ input: 900_000, output: 0, reasoning: 0, cache: { read: 19_000_000, write: 0 } }, 1_000_000)
ok(pctCumulative !== null && pctCumulative >= 1900, "会话累计值会算出 ≥1900%（当初误拦续跑的原因；已不再采用累计值）")

// ===================== 11. ULW 进入 / 退出 / 压缩恢复（假 ctx + 真文件系统） =====================
console.log("[ulw enter/exit/compaction]")
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const REPO = join(import.meta.dirname ?? ".", "..")

const cn = gritPlugin.contractNotice("<!-- GRIT:ULW:CONTRACT -->\n契约正文\n<!-- /GRIT:ULW:CONTRACT -->", "做 X")
ok(cn.startsWith("<system-reminder>") && cn.endsWith("</system-reminder>"), "契约提醒块用 system-reminder 包裹")
ok(cn.includes("目标：做 X") && cn.includes("<!-- GRIT:ULW:CONTRACT -->"), "契约提醒块含目标与首哨兵")
ok(gritPlugin.isPluginInjectedText(cn) === true, "契约提醒块被识别为插件注入（不当用户插话）")
ok(gritPlugin.isPluginInjectedText(gritPlugin.continuationBlock("x")) === true, "续跑块同样被识别为插件注入")
ok(gritPlugin.isPluginInjectedText("用户普通消息") === false, "普通用户消息不误判")
ok(gritPlugin.isSafeGitUrl("https://github.com/a/b.git") === true && gritPlugin.isSafeGitUrl("-c core.pager=cat") === false && gritPlugin.isSafeGitUrl("a b") === false, "clone_repo：url 防参数注入")
ok(gritPlugin.isSafeGitRef("main") === true && gritPlugin.isSafeGitRef("v1.2.3") === true && gritPlugin.isSafeGitRef("-c core.pager=cat") === false && gritPlugin.isSafeGitRef("a b") === false, "clone_repo：ref 防参数注入")
const en = gritPlugin.exitNoticeBlock()
ok(en.startsWith("<system-reminder>") && en.includes("[GRIT:ULW:EXITED]") && en.includes("不再生效"), "退出提醒块带哨兵与失效声明")

const tmpHome2 = mkdtempSync(join(tmpdir(), "grit-itest-"))
mkdirSync(join(tmpHome2, "contracts"), { recursive: true })
mkdirSync(join(tmpHome2, "agents"), { recursive: true })
writeFileSync(join(tmpHome2, "contracts", "ulw.md"), readFileSync(join(REPO, "contracts", "ulw.md")), "utf8")
writeFileSync(join(tmpHome2, "contracts", "handoff-template.md"), readFileSync(join(REPO, "contracts", "handoff-template.md")), "utf8")
writeFileSync(join(tmpHome2, "agents", "index.json"), JSON.stringify(index), "utf8")
process.env.GRIT_HOME = tmpHome2

const SID = "ses_itest_1"
const prompts: { sessionID: string; text: string }[] = []
const createdInputs: any[] = []
let rejectModel = false
let failNextPrompt = false
const hooks: Record<string, (e: any) => unknown> = {}
const tools2 = new Map<string, any>()
let releaseCompact: () => void = () => {}
const compactGate = new Promise<void>((r) => { releaseCompact = r })
const fakeCtx2 = {
  location: { directory: "D:/tmp/itest", project: { id: "p" } },
  session: {
    hook: async (name: string, cb: any) => { hooks[name] = cb },
    context: async () => [{ id: "u1", role: "user", content: [{ type: "text", text: "[GRIT:ULW:START]\n做点事" }] }],
    prompt: async (arg: { sessionID: string; text: string }) => {
      if (failNextPrompt) { failNextPrompt = false; throw new Error("simulated prompt failure") }
      prompts.push(arg)
      return {}
    },
    create: async (input: any) => {
      if (rejectModel && input?.model) throw new Error('Missing key at ["model"]["id"]')
      createdInputs.push(input)
      return { id: "ses_new" }
    },
  },
  model: { list: async () => [] },
  tool: {
    transform: async (cb: (editor: { add: (t: any) => void }) => void) => {
      cb({ add: (t: any) => tools2.set(t.name, t) })
    },
  },
  event: {
    subscribe: (_o: unknown) => ({
      [Symbol.asyncIterator]: async function* () {
        await compactGate
        yield { type: "session.compaction.started", data: { sessionID: SID, reason: "auto" } }
        yield { type: "session.compaction.ended", data: { sessionID: SID, reason: "auto" } }
        yield { type: "session.compaction.ended", data: { sessionID: SID, reason: "auto" } } // 5 秒去重：不应重复恢复
      },
    }),
  },
}
await (gritPlugin.setup as (c: unknown) => Promise<unknown>)(fakeCtx2)

const enterRes = await tools2.get("ulw_enter").execute({ goal: "把 X 做完" }, { sessionID: SID })
ok(prompts.length === 1 && prompts[0]!.sessionID === SID, "进入：契约用 ctx.session.prompt 发成一条真消息")
ok(prompts[0]!.text.includes("<!-- GRIT:ULW:CONTRACT -->") && prompts[0]!.text.includes("目标：把 X 做完"), "进入：注入内容 = 契约 + 目标")
ok(typeof enterRes.content === "string" && enterRes.content.length < 300 && enterRes.content.includes("ulw_exit"), "进入：工具只回一句短确认（不再塞契约全文）")
ok(!String(enterRes.content).includes("<!-- GRIT:ULW:CONTRACT -->"), "进入：工具结果里没有契约正文")
const stPath = join(tmpHome2, "state", `${SID}.json`)
const stAfterEnter = JSON.parse(readFileSync(stPath, "utf8"))
ok(stAfterEnter.active === true && stAfterEnter.objective === "把 X 做完" && stAfterEnter.contractFingerprint?.startsWith("sha1:"), "进入：账本已写（active/goal/fingerprint）")

// prompt 钩子：插件自己的契约消息不能被当成用户插话
hooks.prompt!({ sessionID: SID, prompt: { text: prompts[0]!.text } })
ok(JSON.parse(readFileSync(stPath, "utf8")).pauseReason === null, "prompt 钩子：契约注入不触发 user-interruption 暂停")
hooks.prompt!({ sessionID: SID, prompt: { text: "这是一条普通用户消息" } })
ok(JSON.parse(readFileSync(stPath, "utf8")).pauseReason === "user-interruption", "prompt 钩子：普通用户消息仍会触发插话暂停（负例）")

// context 钩子（激活中）：只贴每轮标记，不重贴契约（历史里已有契约时不追加契约块）
const msgsActive: any[] = [{ role: "user", content: [{ type: "text", text: "继续" }, { type: "text", text: "<!-- GRIT:ULW:CONTRACT -->\n契约\n<!-- /GRIT:ULW:CONTRACT -->" }] }]
hooks.context!({ agent: "build", sessionID: SID, system: [], messages: msgsActive })
const addedActive = msgsActive[msgsActive.length - 1].content.slice(2)
ok(addedActive.length === 1 && addedActive[0].text.includes("[GRIT:ULW:ACTIVE]") && !addedActive[0].text.includes("<!-- GRIT:ULW:CONTRACT -->"), "每轮：只追加标记、不再重贴契约")

// 兜底：历史里确实没有契约时（压缩事件没赶上 / revert 回退）贴回一次，且 60 秒内不重复贴
const msgsLost: any[] = [{ role: "user", content: [{ type: "text", text: "继续" }] }]
hooks.context!({ agent: "build", sessionID: SID, system: [], messages: msgsLost })
ok(gritPlugin.messageText(msgsLost[msgsLost.length - 1]).includes("<!-- GRIT:ULW:CONTRACT -->"), "兜底：契约不在历史里 → 贴回一次")
const msgsLost2: any[] = [{ role: "user", content: [{ type: "text", text: "继续" }] }]
hooks.context!({ agent: "build", sessionID: SID, system: [], messages: msgsLost2 })
ok(!gritPlugin.messageText(msgsLost2[msgsLost2.length - 1]).includes("<!-- GRIT:ULW:CONTRACT -->"), "兜底：60 秒内不重复贴（防每轮重贴）")

// 旧账本（早期字段集，没有 exitNoticePending）不该误贴退出提醒
const SID_OLD = "ses_itest_old"
const stPathOld = join(tmpHome2, "state", `${SID_OLD}.json`)
writeFileSync(stPathOld, JSON.stringify({ schemaVersion: 2, sessionID: SID_OLD, directory: "D:/tmp/itest", active: false, objective: "旧账本", epoch: 1, activatedAt: 0, contractFingerprint: null, stopReason: "completed", pauseReason: null, totalInjections: 0 }), "utf8")
const msgsOld: any[] = [{ role: "user", content: [{ type: "text", text: "收尾" }] }]
hooks.context!({ agent: "build", sessionID: SID_OLD, system: [], messages: msgsOld })
ok(!gritPlugin.messageText(msgsOld[msgsOld.length - 1]).includes("[GRIT:ULW:EXITED]"), "旧账本缺 exitNoticePending：不误贴退出提醒")

// 模型退出：工具结果短确认 + 账本留下待贴提醒
const exitRes = await tools2.get("ulw_exit").execute({ reason: "done" }, { sessionID: SID })
ok(exitRes.content.includes("不再生效"), "退出：工具返回统一的失效声明")
const stAfterExit = JSON.parse(readFileSync(stPath, "utf8"))
ok(stAfterExit.active === false && stAfterExit.stopReason === "completed" && stAfterExit.exitNoticePending === true, "退出：账本置停并留下待贴提醒")

// context 钩子（退出后第一次组装）：贴一次退出提醒，然后清标记
const msgsExited: any[] = [{ role: "user", content: [{ type: "text", text: "收尾" }] }]
hooks.context!({ agent: "build", sessionID: SID, system: [], messages: msgsExited })
ok(gritPlugin.messageText(msgsExited[msgsExited.length - 1]).includes("[GRIT:ULW:EXITED]"), "退出提醒：由账本驱动贴一次")
ok(JSON.parse(readFileSync(stPath, "utf8")).exitNoticePending === false, "退出提醒：贴完即清标记")
const msgsAgain: any[] = [{ role: "user", content: [{ type: "text", text: "再收尾" }] }]
hooks.context!({ agent: "build", sessionID: SID, system: [], messages: msgsAgain })
ok(!gritPlugin.messageText(msgsAgain[msgsAgain.length - 1]).includes("[GRIT:ULW:EXITED]"), "退出提醒：不会每轮重复贴")

// 再进一次 → 契约再注入一次（每次进入一次）
await tools2.get("ulw_enter").execute({ goal: "第二轮" }, { sessionID: SID })
ok(prompts.length === 2 && prompts[1]!.text.includes("目标：第二轮"), "再进入：契约再注入一次（新目标）")

// 压缩完成事件 → 账本仍激活 → 重注入契约（started 事件不触发；ended 触发且只一次）
releaseCompact()
await sleep(80)
ok(prompts.length === 3, "压缩事件：只有 compaction.ended 触发了一次重注入（started 不触发、5 秒内第二次 ended 去重）")
ok(prompts[2]!.text.includes("<!-- GRIT:ULW:CONTRACT -->") && prompts[2]!.text.includes("目标：第二轮"), "压缩恢复：内容 = 契约 + 当前目标")

// 用户路径退出：prompt 钩子命中暗号 → 同一条 exitUlw（不必等模型配合）
hooks.prompt!({ sessionID: SID, prompt: { text: "[GRIT:ULW:EXIT]\n" } })
const stAfterUserExit = JSON.parse(readFileSync(stPath, "utf8"))
ok(stAfterUserExit.active === false && stAfterUserExit.exitNoticePending === true, "用户 /ulw-exit：prompt 钩子直接置停并留待贴提醒")

// 先消费这条提醒，再验证「提到暗号」不会触发
const msgsUserExit: any[] = [{ role: "user", content: [{ type: "text", text: "收尾" }] }]
hooks.context!({ agent: "build", sessionID: SID, system: [], messages: msgsUserExit })
ok(gritPlugin.messageText(msgsUserExit[msgsUserExit.length - 1]).includes("[GRIT:ULW:EXITED]"), "用户 /ulw-exit：下一次组装也贴同一段提醒")

// 普通消息里只是【提到】这个暗号 → 不再触发退出提醒（旧实现按子串扫，会误判）
const msgsMention: any[] = [{ role: "user", content: [{ type: "text", text: "我之前说过 [GRIT:ULW:EXIT] 这个词" }] }]
hooks.context!({ agent: "build", sessionID: SID, system: [], messages: msgsMention })
ok(!gritPlugin.messageText(msgsMention[msgsMention.length - 1]).includes("[GRIT:ULW:EXITED]"), "提到暗号 ≠ 退出事件：不再按子串扫用户消息")

// prompt 注入失败 → 退回工具结果并如实说明
failNextPrompt = true
const enterFail = await tools2.get("ulw_enter").execute({ goal: "注入失败兜底" }, { sessionID: SID })
ok(String(enterFail.content).includes("注入失败") && String(enterFail.content).includes("<!-- GRIT:ULW:CONTRACT -->"), "进入：prompt 注入失败时退回工具结果兜底")

// ===================== §10 工具通道 & 交接标题 =====================

// 每个 grit 工具都带 codemode+pinned（平台 v2.0.32 无双通道开关，见 grit.ts 的 TOOL_OPTIONS）
for (const name of ["context_usage", "system_time", "clone_repo", "handoff", "profile", "ulw_enter", "ulw_exit"]) {
  const def = tools2.get(name)
  ok(Boolean(def) && def.options?.codemode === true && def.options?.pinned === true, `工具通道：${name} 带 codemode+pinned`)
}

// 摘要只有模板小节名 → 提不出标题（交给系统自动命名，不回落固定名称）
ok(
  gritPlugin.deriveHandoffTitle("## 1. 任务与目标\n## 2. 当前状态\n## 3. 已确认的事实（无需重新探索）\n- 无") === null,
  "标题：只有小节名时不硬造标题",
)

// 跳过小节名 + 剥 markdown 记号 + 按展示宽度收在自然断点（正好落到验收例子的短语上）
ok(
  gritPlugin.deriveHandoffTitle("## 2. 当前状态\n**星网 AI 取数正确性测试与时延分布手册** 已写完，待复核。") ===
    "星网 AI 取数正确性测试与时延分布手册",
  "标题：跳过小节名、剥掉 markdown 记号、超宽时收在自然断点",
)

// 展示宽度受限（40 格，CJK 计 2）
const longSummary = "这是一段非常长的交接摘要内容" + "很长".repeat(40)
const longTitle = gritPlugin.deriveHandoffTitle(longSummary)
ok(
  Boolean(longTitle) && gritPlugin.displayCells(longTitle!) <= gritPlugin.HANDOFF_TITLE_MAX_CELLS,
  "标题：超过展示宽度时按宽度截断",
)

// 空 / 纯符号 → null（交给系统命名）
ok(
  gritPlugin.deriveHandoffTitle("") === null && gritPlugin.deriveHandoffTitle("—— ——") === null,
  "标题：空摘要或纯符号时返回 null",
)

// ---- handoff：标题按摘要内容生成；提取不出就不传 title（交给系统自动命名） ----
const handoffSummary = "## 1. 任务与目标\n## 2. 当前状态\n**星网 AI 取数正确性测试与时延分布手册** 已写完，待复核。"
const handoffRes = await tools2.get("handoff").execute({ summary: handoffSummary }, { sessionID: SID })
const createdWithTitle = createdInputs[createdInputs.length - 1]
ok(createdWithTitle?.title === "星网 AI 取数正确性测试与时延分布手册", "交接：新会话标题取自摘要内容（不是固定名称）")
ok(String(handoffRes.content).includes("ses_new"), "交接：创建新会话 + 注入摘要后返回新会话号")
ok(String(prompts[prompts.length - 1]?.text).includes("[HANDOFF]"), "交接：摘要以 [HANDOFF] 标记注入新会话")

const emptyRes = await tools2.get("handoff").execute({}, { sessionID: SID })
const createdNoTitle = createdInputs[createdInputs.length - 1]
ok(createdNoTitle !== undefined && !("title" in createdNoTitle), "交接：提不出标题时不传 title（交给系统自动命名）")
ok(String(emptyRes.content).includes("ses_new"), "交接：空摘要也能完成交接（标题不影响创建）")

// 继承：新会话带着当前会话的 agent/model 创建（否则会落回平台默认，出现"交接后换了模型"）
hooks.context!({
  agent: "build",
  sessionID: SID,
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "继续" }] }],
  model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
})
await tools2.get("handoff").execute({ summary: "## 1. 任务与目标\n继续做 Y" }, { sessionID: SID, agent: "build" })
const inherited = createdInputs[createdInputs.length - 1]
ok(
  inherited?.agent === "build" &&
    inherited?.model?.providerID === "opencode-go" &&
    inherited?.model?.id === "deepseek-v4.1-flash",
  "交接：新会话继承当前 agent/model（Model.Ref 形状 = { id, providerID }）",
)

// 附加信息不许拖垮交接：平台拒绝继承的 model 时，逐级退回且交接仍成功
rejectModel = true
const fallbackRes = await tools2.get("handoff").execute({ summary: "## 1. 任务与目标\n继续做 Z" }, { sessionID: SID, agent: "build" })
const fallbackInput = createdInputs[createdInputs.length - 1]
rejectModel = false
ok(
  String(fallbackRes.content).includes("ses_new") && fallbackInput !== undefined && !("model" in fallbackInput),
  "交接：平台不接受继承的 model 时逐级退回，交接本身仍成功",
)

// ===================== 结果 =====================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
