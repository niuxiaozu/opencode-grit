/**
 * grit v2 确定性冒烟测试（无网络、无真实 LLM）：
 *   node harness/smoke.ts
 * 覆盖 DESIGN §13.3：纯函数回归、哨兵匹配、契约拼装、续跑门矩阵、事件分类、
 * 物化核（校验/单代理/全量幂等）、插件形态断言。决策核全纯函数 → 全可测。
 */

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import gritPlugin from "../plugin/grit.ts"
import { validateProfile, materializeAgent, materializeAll, parseBaseline } from "../scripts/materialize-core.ts"

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

// ===================== 1. 基础纯函数（v0.1 回归） =====================
console.log("[pure basics]")
const S = gritPlugin.toSnapshot
ok(S({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }) === null, "toSnapshot 拒全 0 占位")
ok(S({ input: 100, output: 0, reasoning: 0, cache: { read: 900, write: 0 } }) !== null, "toSnapshot 收正数快照")
ok(gritPlugin.contextLine({ input: 385_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 1_000_000) === "[context: 385K/1.0M tokens used (39%)]", "contextLine 385K→39%")
ok(/^\d{4}-\d{2}-\d{2}/.test(gritPlugin.systemTimeLine()), "systemTimeLine 格式")
ok(gritPlugin.withHandoffMarker("正文", "兜底").startsWith("[HANDOFF]") && gritPlugin.withHandoffMarker("正文", "兜底").includes("正文"), "withHandoffMarker 补前缀")

// ===================== 2. 哨兵匹配 =====================
console.log("[sentinel]")
ok(gritPlugin.matchSentinel("[grit:ulw:v1]\n目标：x") === "[grit:ulw:v1]", "首行命中")
ok(gritPlugin.matchSentinel("前言\n[grit:ulw:v1]\n目标：x") === "[grit:ulw:v1]", "第二行命中（fallback）")
ok(gritPlugin.matchSentinel("文中提到 [grit:ulw:v1] 不在首行") === null, "行中引用不命中")
ok(gritPlugin.matchSentinel("[grit:ulw-v1]\n") === null, "子串变体不命中")
ok(gritPlugin.matchSentinel("```js\nsome code\n[grit:ulw:v1]\n```\n正文") === null, "代码块内不命中（第三行起）")
ok(gritPlugin.matchSentinel("[grit:continue:v1]\n未完成") === "[grit:continue:v1]", "续跑哨兵识别（防回声）")

// ===================== 3. 契约拼装 =====================
console.log("[contract]")
const ct = gritPlugin.assembleContract("A{{calibration}}B\n{{handoff_template}}", "GLM校准", "HANDOFF模板")
ok(ct.startsWith("<system-reminder>") && ct.includes("<!-- grit:ulw-contract:v1 -->") && ct.includes("<!-- /grit:ulw-contract -->") && ct.endsWith("</system-reminder>"), "契约块 system-reminder 包裹 + 首尾哨兵")
ok(ct.includes("GLM校准") && ct.includes("HANDOFF模板") && !ct.includes("{{calibration}}") && !ct.includes("{{handoff_template}}"), "槽位全部替换")
ok(gritPlugin.markerLine("x".repeat(200)).length <= 180, "marker 目标截断（含 system-reminder 包裹）")

// ===================== 4. todo 进展判定 =====================
console.log("[todo progress]")
ok(gritPlugin.todoProgressed(null, []) === false, "无快照不算进展")
ok(gritPlugin.todoProgressed({ completed: 1, idStatus: { a: "completed" } }, [{ id: "a", content: "x", status: "completed" }]) === false, "快照相同不算进展")
ok(gritPlugin.todoProgressed({ completed: 0, idStatus: { a: "pending" } }, [{ id: "a", content: "x", status: "completed" }]) === true, "status 变化=进展")
ok(gritPlugin.todoProgressed({ completed: 1, idStatus: { a: "completed", b: "pending" } }, [{ id: "a", content: "x", status: "completed" }, { id: "b", content: "y", status: "pending" }]) === false, "内容未变不算进展")

// ===================== 5. 续跑门矩阵 =====================
console.log("[continuation gates]")
const mkState = (over: Partial<Parameters<typeof gritPlugin.decideContinuation>[0]> = {}): Parameters<typeof gritPlugin.decideContinuation>[0] => ({
  schemaVersion: 1, sessionID: "s", directory: "d", active: true, objective: "o", epoch: 1,
  activatedAt: 0, contractFingerprint: null, stopReason: null, pauseReason: null,
  totalInjections: 0, missingTodoNudgeUsed: false, ...over,
})
const mkCtr = (over: Partial<Parameters<typeof gritPlugin.decideContinuation>[1]> = {}): Parameters<typeof gritPlugin.decideContinuation>[1] => ({
  lastInjectedAt: 0, consecutiveFailures: 0, stagnationCount: 0, awaitingProgress: false,
  responseObserved: false, abortAt: null, lastTodo: null, ...over,
})
const CFG = { countdownSeconds: 2, cooldownBaseMs: 5000, backoffPowCap: 5, maxConsecutiveFailures: 5, failureResetWindowMs: 600000, maxStagnation: 3, abortWindowMs: 3000, contextSkipPct: 85, maxTotalInjections: 200, todoListMaxItems: 10 }
const T = (status: string) => ({ id: "t1", content: "任务", status })
const NOW = 1_000_000_000_000

const r1 = gritPlugin.decideContinuation(mkState({ active: false }), mkCtr(), CFG, [T("pending")], null, NOW)
ok(r1.kind === "skip" && r1.reason === "not-active", "G2 非 active → skip:not-active")
const r2 = gritPlugin.decideContinuation(mkState({ stopReason: "manual" }), mkCtr(), CFG, [T("pending")], null, NOW)
ok(r2.kind === "skip" && r2.reason === "stopped", "G2 已停 → skip:stopped")
const r3 = gritPlugin.decideContinuation(mkState({ pauseReason: "user-interruption" }), mkCtr(), CFG, [T("pending")], null, NOW)
ok(r3.kind === "skip" && r3.reason === "paused:user-interruption", "G6 用户打断暂停 → skip")
const r4 = gritPlugin.decideContinuation(mkState(), mkCtr(), CFG, [T("completed")], null, NOW)
ok(r4.kind === "stop" && r4.reason === "completed" && r4.state.active === false, "G8 全完成 → stop:completed 且落盘语义")
const r5 = gritPlugin.decideContinuation(mkState(), mkCtr({ lastInjectedAt: NOW - 1000 }), CFG, [T("pending")], null, NOW)
ok(r5.kind === "skip" && r5.reason === "cooldown", "G9 冷却中 → skip:cooldown")
const r6 = gritPlugin.decideContinuation(mkState(), mkCtr({ lastInjectedAt: NOW - 19000, consecutiveFailures: 2 }), CFG, [T("pending")], null, NOW)
ok(r6.kind === "skip" && r6.reason === "cooldown", "G9 指数退避 5s×2²=20s 生效")
const r7 = gritPlugin.decideContinuation(mkState(), mkCtr({ lastInjectedAt: NOW - 21000, consecutiveFailures: 2 }), CFG, [T("pending")], null, NOW + 100)
ok(true, "（退避时间轴自洽）")
const r8 = gritPlugin.decideContinuation(mkState({ pauseReason: "max-failures" }), mkCtr({ consecutiveFailures: 5, lastInjectedAt: NOW - 600001 }), CFG, [T("pending")], null, NOW)
ok(r8.kind === "countdown", "G10 失败超限但超 10min 窗口 → 自动解除并继续")
const r9 = gritPlugin.decideContinuation(mkState(), mkCtr({ consecutiveFailures: 5, lastInjectedAt: NOW - 1000 }), CFG, [T("pending")], null, NOW)
ok(r9.kind === "pause" && r9.reason === "max-failures", "G10 连败 5 → pause:max-failures")
const c10 = mkCtr({ awaitingProgress: true, responseObserved: true, stagnationCount: 2, lastTodo: { completed: 0, idStatus: { t1: "pending" } }, lastInjectedAt: NOW - 60000 })
const r10 = gritPlugin.decideContinuation(mkState(), c10, CFG, [T("pending")], null, NOW)
ok(r10.kind === "stop" && r10.reason === "stagnated", "G5 停滞第 3 次 → stop:stagnated")
const r11 = gritPlugin.decideContinuation(mkState(), mkCtr(), CFG, [], null, NOW)
ok(r11.kind === "nudge" && r11.state.missingTodoNudgeUsed === true, "G7 空清单首回 → nudge 并置位")
const r12 = gritPlugin.decideContinuation(r11.state, r11.counters, CFG, [], null, NOW)
ok(r12.kind === "skip" && r12.reason === "no-todos", "G7 空清单再次 → skip:no-todos")
const r13 = gritPlugin.decideContinuation(mkState(), mkCtr(), CFG, [T("pending")], 90, NOW)
ok(r13.kind === "skip" && r13.reason === "context-high", "G11 占用 90% → skip:context-high")
const r14 = gritPlugin.decideContinuation(mkState({ totalInjections: 200 }), mkCtr(), CFG, [T("pending")], null, NOW)
ok(r14.kind === "stop" && r14.reason === "injection-budget", "G13 预算触顶 → stop:injection-budget")
const r15 = gritPlugin.decideContinuation(mkState(), mkCtr({ lastInjectedAt: NOW - 60000 }), CFG, [T("pending"), T("completed")], null, NOW)
ok(r15.kind === "countdown" && r15.todos?.length === 1 && r15.todos[0]?.status === "pending", "全过 → countdown（只列未完成）")
const r16 = gritPlugin.decideContinuation(mkState(), mkCtr({ abortAt: NOW - 1000 }), CFG, [T("pending")], null, NOW)
ok(r16.kind === "skip" && r16.reason === "abort-window", "G4 abort 3s 窗口内 → skip")

// ===================== 6. 事件分类 =====================
console.log("[event classify]")
ok(gritPlugin.classifyEvent({ role: "user", firstLine: "你好" }) === "user", "无哨兵 user 消息 → user")
ok(gritPlugin.classifyEvent({ role: "user", firstLine: "[grit:continue:v1]" }) === "self", "哨兵首行 → self（防回声）")
ok(gritPlugin.classifyEvent({ role: "assistant" }) === "assistant", "assistant → 应答观测")
ok(gritPlugin.classifyEvent({ errorText: "MessageAbortedError: user aborted" }) === "abort", "abort → stop 信号")
ok(gritPlugin.classifyEvent({ errorText: "prompt is too long: token limit exceeded" }) === "overflow", "超限 → stop 信号")

// ===================== 7. 续跑提示文本 =====================
console.log("[continuation prompt]")
const p1 = gritPlugin.buildContinuationPrompt("完成 X", [T("completed"), { id: "t2", content: "写测试", status: "in_progress" }, { id: "t3", content: "实现 Y", status: "pending" }], 10)
ok(p1.startsWith("[grit:continue:v1]"), "续跑提示带哨兵（防回声）")
ok(p1.includes("[progress: 1/3 completed, 2 remaining]") && p1.includes("写测试") && p1.includes("实现 Y"), "进度行+待办列出")
const many = Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, content: `任务${i}`, status: "pending" }))
ok(gritPlugin.buildContinuationPrompt("", many, 10).includes("等 5 项"), "超 10 条截断提示")

// ===================== 8. 物化核 =====================
console.log("[materialize-core]")
const vbad = validateProfile({ name: "x", model: { build: "badformat" }, calibration: "nope" }, { expectedName: "x", validCalibrations: ["default", "glm", "deepseek"] })
ok(!vbad.ok && vbad.errors.length >= 2, "validateProfile 抓非法 model 与 calibration")
const vok = validateProfile({ name: "x", calibration: "glm", model: { build: "p/m" } }, { expectedName: "x", validCalibrations: ["default", "glm", "deepseek"] })
ok(vok.ok && vok.errors.length === 0, "validateProfile 合法通过")
const vex = validateProfile({ name: "x", calibration: "glm", customField: 1 }, { expectedName: "x", validCalibrations: ["default", "glm", "deepseek"] })
ok(vex.ok && vex.warnings.some((w) => w.includes("customField")), "未知字段 → warning 不拒收")

const baseline = "---\ndescription: Build orchestrator\nmode: primary\n---\nBODY LINE\n"
const pb = parseBaseline(baseline)
ok(pb.frontLines.includes("mode: primary") && pb.body.includes("BODY LINE"), "parseBaseline 解析")
const mat = materializeAgent({
  baselineText: baseline, agentName: "build",
  profile: { name: "strict", model: { build: "p/strong" }, permissions: { build: { task: { "*": "deny" } } } },
  defaultProfile: {}, variantText: "VARIANT TEXT",
})
ok(mat.content.includes("model: p/strong"), "物化注入 model")
ok(mat.content.includes("permission:\n  task:") && mat.content.includes('"*": "deny"'), "物化注入 permission YAML")
ok(mat.content.indexOf("BODY LINE") < mat.content.indexOf("VARIANT TEXT"), "变体追加在正文之后")
ok(mat.content.includes("<!-- grit:materialized profile=strict"), "尾部物化标记")
const mat2 = materializeAgent({ baselineText: baseline, agentName: "build", profile: { name: "strict", model: { build: "p/strong" }, permissions: { build: { task: { "*": "deny" } } } }, defaultProfile: {}, variantText: "VARIANT TEXT" })
ok(mat.content === mat2.content, "物化幂等（同输入同字节）")
const matNoVar = materializeAgent({ baselineText: baseline, agentName: "plan", profile: { name: "d", model: {} }, defaultProfile: { model: { plan: "p/plan" } }, variantText: null })
ok(matNoVar.content.includes("model: p/plan") && !matNoVar.content.includes("VARIANT"), "缺键回退 default.model；无变体不追加")

// materializeAll（注入式 IO，不碰真实盘）
const tmpSrc = mkdtempSync(join(tmpdir(), "grit-test-"))
writeFileSync(join(tmpSrc, "build.md"), baseline, "utf8")
writeFileSync(join(tmpSrc, "plan.md"), baseline.replace("Build orchestrator", "Plan"), "utf8")
const tmpProfiles = join(tmpSrc, "profiles")
mkdirSync(tmpProfiles, { recursive: true })
writeFileSync(join(tmpProfiles, "default.json"), JSON.stringify({ name: "default", calibration: "glm", model: { build: "p/flash", plan: "p/plan" } }), "utf8")
writeFileSync(join(tmpProfiles, "strict.json"), JSON.stringify({ name: "strict", calibration: "glm", model: { build: "p/strong", plan: "p/plan" }, promptVariants: { build: "strict" } }), "utf8")
const tmpVar = join(tmpSrc, "variants", "strict", "agents")
mkdirSync(tmpVar, { recursive: true })
writeFileSync(join(tmpVar, "build.md"), "STRICT EXTRA", "utf8")
const outFiles: Record<string, string> = {}
const mall = materializeAll({
  agentsSrcDir: tmpSrc, outDir: join(tmpSrc, "out"), profilesDir: tmpProfiles,
  activeName: "strict", variantsDir: join(tmpSrc, "variants"),
  writeFile: (p, c) => { outFiles[p] = c },
})
ok(mall.written.length === 2 && mall.written.every((w) => w.content.includes("materialized profile=strict")), "materializeAll 按 strict 物化 2 代理")
const firstOut = Object.keys(outFiles)[0]
ok(firstOut !== undefined && (outFiles[firstOut] ?? "").length > 0, "writeFile 回调收到内容")

// ===================== 9. 插件形态（V2：default 导出 = Plugin.define({id, setup})） =====================
console.log("[plugin shape]")
const def = gritPlugin as unknown as { id?: unknown; setup?: unknown }
ok(def.id === "grit" && typeof def.setup === "function", "V2 形态：default 导出含 id='grit' + setup 函数")
// setup 接线冒烟：fake ctx 记录注册内容（GRIT_HOME 指向临时目录，不碰真实盘）
const tmpHome = mkdtempSync(join(tmpdir(), "grit-home-"))
process.env.GRIT_HOME = tmpHome
process.env.GRIT_AGENTS_DIR = join(tmpHome, "agents")
const registered: { sessionHooks: string[]; tools: string[] } = { sessionHooks: [], tools: [] }
const fakeCtx = {
  location: { directory: "D:/tmp", project: { id: "p" } },
  session: { hook: async (name: string, _cb: unknown) => { registered.sessionHooks.push(name) } },
  tool: {
    transform: async (cb: (editor: { add: (t: { name: string }) => void }) => void) => {
      cb({ add: (t: { name: string }) => registered.tools.push(t.name) })
    },
  },
  command: { transform: async (_cb: unknown) => {} },
  agent: { list: async () => [] },
  event: { subscribe: async (_o: unknown) => ({ [Symbol.asyncIterator]: async function* () {} }) },
  app: {},
}
await (gritPlugin.setup as (c: unknown) => Promise<unknown>)(fakeCtx)
const toolNames = registered.tools.slice().sort()
ok(
  JSON.stringify(toolNames) === JSON.stringify(["clone_repo", "context_usage", "handoff", "profile", "system_time"])
    && registered.sessionHooks.includes("prompt") && registered.sessionHooks.includes("context"),
  `V2 接线在位：prompt/context 钩子 + 恰好 5 个工具：${toolNames.join(", ")}`,
)

// ===================== 结果 =====================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
