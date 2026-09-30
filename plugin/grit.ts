/**
 * grit — 轻量多代理套件插件（v2 运行时版，按 docs/DESIGN.md 终稿实现；前身 omo-lite，已更名）
 *
 * 【OpenCode V2 插件 API】default 导出 = Plugin.define({ id, setup(ctx) })。
 * V1 → V2 接线映射（行为语义与 v1 版保持一致）：
 *   config（启动自检）                    → setup 内直接执行
 *   chat.message（哨兵处理，机制 A）       → ctx.session.hook("prompt", ...)
 *   experimental.chat.messages.transform  → ctx.session.hook("context", ...)（消息形状为扁平 {type,text}）
 *   chat.params（机制 C 热参数）           → 同一 "context" 钩子内写 event.options
 *   event（机制 B/D 数据源）              → ctx.event.subscribe()；V2 载荷在 event.data
 *     - token 快照：session.step.ended / session.usage.updated（字段 input/output/reasoning/cache 与 v1 相同）
 *     - responseObserved：session.tool.called / session.tool.success / message.updated
 *     - 续跑触发：session.idle（todo 无事件，改为 idle 时经 ctx.session.context 扫最新 todowrite 工具调用）
 *   tool map（5 工具）                    → ctx.tool.transform（JSON Schema 入参，返回 {content}）
 *   dispose                               → setup 返回的清理函数
 *
 * 四机制（各自独立可关，profile features.* 热读 + GRIT_DISABLE 总闸）：
 *   A contract-injector   /ulw 哨兵→全量契约注入(持久)；每轮 1 行标记(非持久)；压缩后恢复
 *   B todo-continuation   todo 驱动续跑；13 道门 + 2s 倒计时 + 多重熔断
 *   C profile-engine      热参数（temperature/topP/variant）；profile 工具(list/show/switch)
 *   D token-snapshot      被动缓存 token 快照（A/B/context_usage 的数据源）
 * 工具：context_usage / system_time / clone_repo / handoff / profile
 *
 *   铁律（DESIGN §2）：插件源码零提示词文本（契约全外置 contracts/）；
 * 文本匹配仅两处（/ulw、/stop-continuation 首行/次行整行哨兵），无正则无子串；
 * 一切注入只追加尾部或固定位置，永不改写历史。
 * 可测试的纯函数全部挂在 default 导出对象上（V2 loader 只读 id/setup，附加属性无副作用）。
 */

import { Plugin } from "@opencode/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  validateProfile,
  materializeAll,
  loadActiveProfile,
} from "../scripts/materialize-core.ts"

// ===================== 常量与哨兵（DESIGN §5.2，最终值） =====================

const SENTINEL_ULW = "[grit:ulw:v1]"
const SENTINEL_STOP = "[grit:ulw-stop:v1]"
const SENTINEL_CONTINUE = "[grit:continue:v1]"
const SENTINEL_CONTRACT_OPEN = "<!-- grit:ulw-contract:v1 -->"
const SENTINEL_CONTRACT_CLOSE = "<!-- /grit:ulw-contract -->"
const MARKER_TAG = "[grit:ulw-active]"
const ALL_SENTINELS = [SENTINEL_ULW, SENTINEL_STOP, SENTINEL_CONTINUE, SENTINEL_CONTRACT_OPEN, SENTINEL_CONTRACT_CLOSE, MARKER_TAG]

const DEFAULT_CONTEXT_LIMIT = 1_000_000
const STATE_TTL_MS = 14 * 24 * 3600 * 1000
const LOG_MAX_BYTES = 2_000_000
const PROFILE_TTL_MS = 3000

// ===================== 类型 =====================

export interface TokenSnapshot {
  input: number
  output: number
  reasoning: number
  cache?: { read: number; write: number }
}

export interface TodoItem {
  id?: string
  content: string
  status: string
  priority?: string
}

export interface UlwState {
  schemaVersion: 1
  sessionID: string
  directory: string
  active: boolean
  objective: string
  epoch: number
  activatedAt: number
  contractFingerprint: string | null
  stopReason: StopReason | null
  pauseReason: PauseReason | null
  totalInjections: number
  missingTodoNudgeUsed: boolean
}

export type StopReason = "manual" | "aborted" | "stagnated" | "completed" | "context-overflow" | "injection-budget"
export type PauseReason = "user-interruption" | "max-failures" | "directive-response"

export interface Counters {
  lastInjectedAt: number
  consecutiveFailures: number
  stagnationCount: number
  awaitingProgress: boolean
  responseObserved: boolean
  abortAt: number | null
  lastTodo: { completed: number; idStatus: Record<string, string> } | null
}

export interface ContinuationConfig {
  countdownSeconds: number
  cooldownBaseMs: number
  backoffPowCap: number
  maxConsecutiveFailures: number
  failureResetWindowMs: number
  maxStagnation: number
  abortWindowMs: number
  contextSkipPct: number
  maxTotalInjections: number
  todoListMaxItems: number
}

export const DEFAULT_CONTINUATION: ContinuationConfig = {
  countdownSeconds: 2, cooldownBaseMs: 5000, backoffPowCap: 5,
  maxConsecutiveFailures: 5, failureResetWindowMs: 600000, maxStagnation: 3,
  abortWindowMs: 3000, contextSkipPct: 85, maxTotalInjections: 200, todoListMaxItems: 10,
}

// ===================== 纯函数（挂 default 供测试） =====================

function toSnapshot(tokens: unknown): TokenSnapshot | null {
  if (!tokens || typeof tokens !== "object") return null
  const t = tokens as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const input = num(t.input)
  const output = num(t.output)
  const reasoning = num(t.reasoning)
  const cache = t.cache as { read?: unknown; write?: unknown } | undefined
  const read = num(cache?.read)
  const total = num(t.total)
  if (total <= 0 && input <= 0 && output <= 0 && reasoning <= 0 && read <= 0) return null
  return { input, output, reasoning, cache: { read, write: num(cache?.write) } }
}

function usedTokens(s: TokenSnapshot): number {
  return s.input + s.output + s.reasoning + (s.cache?.read ?? 0)
}

function contextOccupancy(tokens: TokenSnapshot, limit: number): number | null {
  if (!limit || limit <= 0) return null
  const used = usedTokens(tokens)
  if (used <= 0) return null
  return Math.round((used / limit) * 100)
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function contextLine(tokens: TokenSnapshot, limit: number): string | null {
  const pct = contextOccupancy(tokens, limit)
  if (pct === null) return null
  return `[context: ${fmtCount(usedTokens(tokens))}/${fmtCount(limit)} tokens used (${pct}%)]`
}

function systemTimeLine(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, "0")
  const week = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()] ?? ""
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? "+" : "-"
  const oh = Math.floor(Math.abs(off) / 60)
  const om = Math.abs(off) % 60
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${week} (UTC${sign}${pad(oh)}:${pad(om)}) | epoch ${d.getTime()}ms`
}

function withHandoffMarker(authored: string, fallback: string): string {
  const a = authored.trim()
  if (a) return a.startsWith("[HANDOFF]") ? a : `[HANDOFF] 【会话交接摘要】\n\n${a}`
  return fallback.startsWith("[HANDOFF]") ? fallback : `[HANDOFF] ${fallback}`
}

function leanHandoffSummary(): string {
  return [
    "[HANDOFF] 【会话交接摘要】",
    "",
    "## 当前状态",
    "-（上一会话未提供富摘要：请先浏览本项目关键文件快速定位现状）",
    "## 已确认的事实（无需重新探索）",
    "- 无",
    "## 待处理的工作",
    "- 沿用上一会话的任务方向；先用 todowrite 重建任务清单再推进",
    "## 已知的坑",
    "- 无",
  ].join("\n")
}

/** 哨兵匹配：首行或第二行整行精确相等（容错 opencode 对命令模板的轻微改写；DESIGN §13.4-① fallback）。 */
function matchSentinel(text: string): string | null {
  const lines = text.split(/\r?\n/)
  for (const line of [lines[0], lines[1]]) {
    if (line === undefined) continue
    for (const s of ALL_SENTINELS) if (line === s) return s
  }
  return null
}

/** 契约拼装：ulw.md + 校准段 + handoff 模板，包 system-reminder（opencode 原生动态内容惯例）+ 契约哨兵。纯字符串。 */
function assembleContract(ulwText: string, calibrationText: string, handoffText: string): string {
  const body = ulwText
    .replace("{{calibration}}", calibrationText)
    .replace("{{handoff_template}}", handoffText)
  return `<system-reminder>\n${SENTINEL_CONTRACT_OPEN}\n${body.trim()}\n${SENTINEL_CONTRACT_CLOSE}\n</system-reminder>`
}

function markerLine(objective: string): string {
  const obj = objective.trim().slice(0, 60)
  return `<system-reminder>${MARKER_TAG} 持续工作模式进行中（目标：${obj || "（待提炼）"}）。已注入的纪律契约持续有效，按 todo 清单继续推进。</system-reminder>`
}

function todoProgressed(last: Counters["lastTodo"], todos: TodoItem[]): boolean {
  const completed = todos.filter((t) => t.status === "completed").length
  if (last === null) return false
  if (completed !== last.completed) return true
  const idStatus: Record<string, string> = {}
  for (const [i, t] of todos.entries()) idStatus[t.id ?? `#${i}`] = t.status
  for (const [k, v] of Object.entries(last.idStatus)) {
    if (idStatus[k] !== v) return true
  }
  for (const k of Object.keys(idStatus)) {
    if (last.idStatus[k] === undefined) return true
  }
  return false
}

function todoIdStatus(todos: TodoItem[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [i, t] of todos.entries()) out[t.id ?? `#${i}`] = t.status
  return out
}

export type ContinueActionKind = "countdown" | "nudge" | "skip" | "pause" | "stop"
export interface ContinueAction {
  kind: ContinueActionKind
  reason?: string
  todos?: TodoItem[]
  counters: Counters
  state: UlwState
}

/** 续跑门序列（DESIGN §7.7.2，G1–G13）。纯函数：返回动作 + 新计数器/状态（不落盘）。 */
function decideContinuation(
  stateIn: UlwState,
  countersIn: Counters,
  cfg: ContinuationConfig,
  todos: TodoItem[],
  occupancy: number | null,
  now: number,
): ContinueAction {
  const counters: Counters = { ...countersIn }
  const state: UlwState = { ...stateIn }
  // G1 由调用方（enabled 检查）承担——此处假设已启用。
  if (!state.active || state.stopReason !== null) return { kind: "skip", reason: state.stopReason ? "stopped" : "not-active", counters, state } // G2
  if (counters.awaitingProgress && counters.lastInjectedAt === -1) return { kind: "skip", reason: "in-flight", counters, state } // G3（防御位）
  if (counters.abortAt !== null && now - counters.abortAt < cfg.abortWindowMs) return { kind: "skip", reason: "abort-window", counters, state } // G4
  // todo 进展判定（解除 pause / 清 stagnation / 清 awaitingProgress）
  const progressed = todoProgressed(counters.lastTodo, todos)
  counters.lastTodo = { completed: todos.filter((t) => t.status === "completed").length, idStatus: todoIdStatus(todos) }
  if (progressed) {
    counters.stagnationCount = 0
    if (state.pauseReason === "user-interruption" || state.pauseReason === "directive-response" || state.pauseReason === "max-failures") {
      state.pauseReason = null
    }
    counters.awaitingProgress = false
    counters.consecutiveFailures = 0
  }
  // G10 自动解除：max-failures 暂停超过 failureResetWindowMs
  if (state.pauseReason === "max-failures" && counters.lastInjectedAt > 0 && now - counters.lastInjectedAt >= cfg.failureResetWindowMs) {
    state.pauseReason = null
    counters.consecutiveFailures = 0
  }
  if (counters.awaitingProgress && counters.responseObserved && !progressed && state.pauseReason === null) {
    counters.stagnationCount += 1
    if (counters.stagnationCount >= cfg.maxStagnation) {
      state.stopReason = "stagnated"
      state.active = false
      return { kind: "stop", reason: "stagnated", counters, state } // G5 终态
    }
    state.pauseReason = "directive-response"
    counters.awaitingProgress = false
  }
  if (state.pauseReason !== null) return { kind: "skip", reason: `paused:${state.pauseReason}`, counters, state } // G5/G6 停留
  const incomplete = todos.filter((t) => t.status === "pending" || t.status === "in_progress")
  const allCompleted = todos.length > 0 && incomplete.length === 0
  if (allCompleted) {
    state.stopReason = "completed"
    state.active = false
    return { kind: "stop", reason: "completed", counters, state } // G8
  }
  if (counters.consecutiveFailures >= cfg.maxConsecutiveFailures) {
    state.pauseReason = "max-failures"
    return { kind: "pause", reason: "max-failures", counters, state } // G10（先于冷却：否则退避封顶期 pause 不可达）
  }
  if (now - counters.lastInjectedAt < cfg.cooldownBaseMs * Math.pow(2, Math.min(counters.consecutiveFailures, cfg.backoffPowCap))) {
    return { kind: "skip", reason: "cooldown", counters, state } // G9
  }
  if (occupancy !== null && occupancy >= cfg.contextSkipPct) {
    return { kind: "skip", reason: "context-high", counters, state } // G11
  }
  if (state.totalInjections >= cfg.maxTotalInjections) {
    state.stopReason = "injection-budget"
    state.active = false
    return { kind: "stop", reason: "injection-budget", counters, state } // G13
  }
  if (todos.length === 0) {
    if (!state.missingTodoNudgeUsed) {
      state.missingTodoNudgeUsed = true
      return { kind: "nudge", counters, state } // G7 建清单提醒
    }
    return { kind: "skip", reason: "no-todos", counters, state }
  }
  return { kind: "countdown", todos: incomplete, counters, state }
}

export type EventClass = "user" | "self" | "assistant" | "activity" | "abort" | "overflow" | "other"

/** 非 idle 事件分类（DESIGN §7.7.5）。纯函数。 */
function classifyEvent(input: { role?: string; firstLine?: string; errorText?: string }): EventClass {
  if (input.errorText !== undefined) {
    const t = input.errorText.toLowerCase()
    if (t.includes("abort")) return "abort"
    if (t.includes("token limit") || t.includes("context") || t.includes("overflow") || t.includes("too large")) return "overflow"
    return "other"
  }
  if (input.role === "user") {
    const fl = input.firstLine ?? ""
    for (const s of ALL_SENTINELS) if (fl === s) return "self"
    return "user"
  }
  if (input.role === "assistant") return "assistant"
  return "activity"
}

function buildContinuationPrompt(objective: string, todos: TodoItem[], maxItems: number): string {
  const done = todos.filter((t) => t.status === "completed").length
  const pending = todos.filter((t) => t.status === "pending" || t.status === "in_progress")
  const lines = [
    SENTINEL_CONTINUE,
    "未完成任务仍在清单中，继续推进下一个待办项。",
    "- 无需请示；完成并验证一项后立即标记 completed",
    "- 清单全部完成才收尾；若认为已全部完成，先从怀疑角度逐项复核再更新清单",
    `[progress: ${done}/${todos.length} completed, ${pending.length} remaining]`,
  ]
  for (const t of pending.slice(0, maxItems)) lines.push(`- [${t.status}] ${t.content}`)
  if (pending.length > maxItems) lines.push(`…等 ${pending.length - maxItems} 项`)
  if (objective.trim()) lines.push(`（目标：${objective.trim().slice(0, 60)}）`)
  return lines.join("\n")
}

function buildNudgePrompt(): string {
  return `${SENTINEL_CONTINUE}\n持续工作模式已激活但尚无任务清单——立即用 todowrite 创建清单并开始第一项。`
}

// ===================== 工具定义（名称与 JSON Schema，纯数据，setup 时注册；测试断言用） =====================

export interface ToolDefLite {
  name: string
  description: string
  input: Record<string, unknown>
}

const TOOL_DEFS: ToolDefLite[] = [
  {
    name: "context_usage",
    description:
      'Query the current context-window occupancy for this session, e.g. "[context: 385K/1.0M tokens used (39%)]". Use it to decide whether to hand off the session (see the handoff tool) before the context fills up. No network dependency.',
    input: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "system_time",
    description:
      "Query the current LOCAL system time: date, time, weekday, UTC offset, epoch ms. Useful for timestamping progress notes, logs, decisions, and handoff summaries. No network dependency.",
    input: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "clone_repo",
    description:
      "Clone an external repository into the managed cache and return its local path, so you can read/grep its source. Use this for dependency / upstream research: e.g. clone a GitHub repo to inspect library internals or cross-reference an upstream implementation. Clones are shallow (--depth 1) and cached per URL — calling twice returns the same path. Works read-only; it never modifies your project.",
    input: {
      type: "object",
      properties: {
        url: { type: "string", description: "Git clone URL (https://..., git@..., or owner/repo shorthand)." },
        ref: { type: "string", description: "Optional branch/tag/commit to check out (default: default branch)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "handoff",
    description:
      "Hand off the current session to a fresh top-level session: creates a new session (same directory, NOT a child session) and injects the handoff summary. Pass `summary` with the full summary you authored per the 交接摘要模板 (from the /handoff or /ulw contract); without it a lean placeholder summary is used.",
    input: {
      type: "object",
      properties: {
        summary: { type: "string", description: "你按模板撰写的完整交接摘要（Markdown：当前状态/已确认的事实/待处理的工作/已知的坑/会话级状态）。省略时用内置瘦摘要。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "profile",
    description:
      "Manage grit profiles. list = enumerate profiles; show = active profile details with hot/restart effect boundaries; switch = atomically activate a profile (writes the active pointer, re-materializes agents/*.md). Model/permission/prompt-variant changes require an OpenCode restart; behavior params/calibration/mechanism toggles take effect immediately.",
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "show", "switch"], description: "list=枚举；show=当前激活详情；switch=切换" },
        name: { type: "string", description: "switch 的目标 profile 名（文件名去 .json）" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
]

// ===================== 插件（V2） =====================

/* eslint-disable @typescript-eslint/no-explicit-any */

const gritDefinition = Plugin.define({
  id: "grit",
  async setup(ctx: any) {
    // ---- 数据根与日志（部署布局：~/.config/opencode/plugins/grit.ts，数据根 ../grit） ----
    const pluginDir = dirname(fileURLToPath(import.meta.url))
    const home = process.env.GRIT_HOME ?? process.env.OMO_LITE_HOME ?? join(pluginDir, "..", "grit")
    const agentsOutDir = process.env.GRIT_AGENTS_DIR ?? process.env.OMO_LITE_AGENTS_DIR ?? join(pluginDir, "..", "agents")
    const directory = ctx?.location?.directory ?? process.cwd()
    const contractsDir = join(home, "contracts")
    const calibrationDir = join(contractsDir, "calibration")
    const profilesDir = join(home, "profiles")
    const stateDir = join(home, "state")
    const logDir = join(home, "log")
    const disabled = process.env.GRIT_DISABLE === "1" || process.env.OMO_LITE_DISABLE === "1"

    const log = (mech: string, msg: string): void => {
      try {
        mkdirSync(logDir, { recursive: true })
        const lp = join(logDir, "grit.log")
        try {
          if (statSync(lp).size > LOG_MAX_BYTES) writeFileSync(lp, "", "utf8")
        } catch { /* 不存在 */ }
        const line = `${new Date().toISOString()} [${mech}] ${msg}\n`
        writeFileSync(lp, line, { flag: "a", encoding: "utf8" })
      } catch { /* 日志失败不影响主流程 */ }
    }
    mkdirSync(stateDir, { recursive: true })

    // ---- profile 3s TTL 热读 ----
    let profileCache: { at: number; data: ReturnType<typeof loadActiveProfile> } | null = null
    const getActiveProfile = () => {
      const now = Date.now()
      if (profileCache && now - profileCache.at < PROFILE_TTL_MS) return profileCache.data
      try {
        profileCache = { at: now, data: loadActiveProfile(profilesDir) }
      } catch (e) {
        log("c", `profile 读取失败：${e instanceof Error ? e.message : String(e)}`)
        profileCache = { at: now, data: null }
      }
      return profileCache.data
    }
    const featEnabled = (mech: "contractInjector" | "profileEngine"): boolean => {
      if (disabled) return false
      const ap = getActiveProfile()
      const f = (ap?.profile.features ?? {}) as Record<string, { enabled?: boolean } | undefined>
      return f[mech]?.enabled !== false
    }
    const getContConfig = (): ContinuationConfig => {
      const ap = getActiveProfile()
      const tc = ((ap?.profile.features ?? {}) as Record<string, Record<string, unknown>>).todoContinuation ?? {}
      const num = (k: keyof ContinuationConfig): number => {
        const v = tc[k]
        return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_CONTINUATION[k]
      }
      return {
        countdownSeconds: num("countdownSeconds"), cooldownBaseMs: num("cooldownBaseMs"),
        backoffPowCap: num("backoffPowCap"), maxConsecutiveFailures: num("maxConsecutiveFailures"),
        failureResetWindowMs: num("failureResetWindowMs"), maxStagnation: num("maxStagnation"),
        abortWindowMs: num("abortWindowMs"), contextSkipPct: num("contextSkipPct"),
        maxTotalInjections: num("maxTotalInjections"), todoListMaxItems: num("todoListMaxItems"),
      }
    }
    const contEnabled = (): boolean => {
      if (disabled) return false
      const tc = ((getActiveProfile()?.profile.features ?? {}) as Record<string, Record<string, unknown>>).todoContinuation ?? {}
      return tc.enabled !== false
    }

    // ---- state IO ----
    const stateCache = new Map<string, UlwState>()
    const statePath = (sid: string): string => join(stateDir, `${sid}.json`)
    const loadState = (sid: string): UlwState | null => {
      const cached = stateCache.get(sid)
      if (cached) return cached
      const p = statePath(sid)
      if (!existsSync(p)) return null
      try {
        const s = JSON.parse(readFileSync(p, "utf8")) as UlwState
        if (s.schemaVersion !== 1) return null
        stateCache.set(sid, s)
        return s
      } catch {
        return null
      }
    }
    const saveState = (s: UlwState): void => {
      stateCache.set(s.sessionID, s)
      try {
        const p = statePath(s.sessionID)
        const tmp = `${p}.tmp`
        writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8")
        try { unlinkSync(p) } catch { /* 首次不存在 */ }
        renameSync(tmp, p)
      } catch (e) {
        log("a", `state 写盘失败 s=${s.sessionID.slice(0, 8)} err=${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const newState = (sid: string, dir: string): UlwState => ({
      schemaVersion: 1, sessionID: sid, directory: dir, active: true, objective: "",
      epoch: 1, activatedAt: Date.now(), contractFingerprint: null,
      stopReason: null, pauseReason: null, totalInjections: 0, missingTodoNudgeUsed: false,
    })
    // state TTL 清扫（启动一次）
    try {
      const now = Date.now()
      for (const f of readdirSync(stateDir)) {
        if (!f.endsWith(".json")) continue
        const p = join(stateDir, f)
        if (now - statSync(p).mtimeMs > STATE_TTL_MS) unlinkSync(p)
      }
    } catch { /* 目录不存在等 */ }

    // ---- 续跑计数器（内存，重载归零=安全侧） ----
    const counters = new Map<string, Counters>()
    const getCtr = (sid: string): Counters => {
      let c = counters.get(sid)
      if (!c) {
        c = { lastInjectedAt: 0, consecutiveFailures: 0, stagnationCount: 0, awaitingProgress: false, responseObserved: false, abortAt: null, lastTodo: null }
        counters.set(sid, c)
      }
      return c
    }
    const countdownTimers = new Map<string, ReturnType<typeof setTimeout>>()

    // ---- token 快照（机制 D） + 当前会话追踪 ----
    const lastTokens = new Map<string, TokenSnapshot>()
    let currentSession: string | null = null

    // ---- 契约读取与拼装 ----
    const readText = (p: string): string | null => {
      try {
        return existsSync(p) ? readFileSync(p, "utf8") : null
      } catch {
        return null
      }
    }
    const buildContract = (): { text: string; fingerprint: string } | { error: string } => {
      const ulw = readText(join(contractsDir, "ulw.md"))
      if (ulw === null) return { error: "contracts/ulw.md 缺失" }
      const calName = getActiveProfile()?.profile.calibration
      const cal = (typeof calName === "string" ? readText(join(calibrationDir, `${calName}.md`)) : null)
        ?? readText(join(calibrationDir, "default.md"))
      if (cal === null) return { error: `contracts/calibration/${String(calName ?? "default")}.md 缺失` }
      const ht = readText(join(contractsDir, "handoff-template.md")) ?? ""
      const text = assembleContract(ulw, cal, ht)
      return { text, fingerprint: `sha1:${createHash("sha1").update(text).digest("hex").slice(0, 12)}` }
    }

    // ---- todo 读取（V2 无 todo 事件：idle 时从会话上下文扫最新 todowrite 工具调用） ----
    const fetchTodos = async (sid: string): Promise<TodoItem[]> => {
      try {
        const res = await ctx.session.context({ sessionID: sid })
        const arr: any[] = Array.isArray(res) ? (res as any[]) : (((res as any)?.data as any[]) ?? [])
        for (let i = arr.length - 1; i >= 0; i--) {
          const m = arr[i] as any
          if (m?.type !== "tool" || m?.name !== "todowrite") continue
          const input = m?.state?.input ?? m?.input
          const todos = Array.isArray(input) ? input : (input?.todos ?? [])
          if (Array.isArray(todos)) return todos as TodoItem[]
        }
      } catch (e) {
        log("b", `todos 读取失败 s=${sid.slice(0, 8)} err=${e instanceof Error ? e.message : String(e)}`)
      }
      return []
    }

    // ---- 续跑注入执行 ----
    const cancelCountdown = (sid: string): void => {
      const t = countdownTimers.get(sid)
      if (t !== undefined) {
        clearTimeout(t)
        countdownTimers.delete(sid)
      }
    }
    const doInject = async (sid: string, text: string, state: UlwState, ctr: Counters): Promise<void> => {
      try {
        await ctx.session.prompt({ sessionID: sid, text })
        ctr.lastInjectedAt = Date.now()
        ctr.awaitingProgress = true
        ctr.responseObserved = false
        ctr.consecutiveFailures = 0
        if (state.pauseReason === "directive-response") state.pauseReason = null
        state.totalInjections += 1
        saveState(state)
        log("b", `INJECT s=${sid.slice(0, 8)} epoch=${state.epoch} total=${state.totalInjections}`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        ctr.consecutiveFailures += 1
        ctr.lastInjectedAt = Date.now()
        log("b", `INJECT-FAIL s=${sid.slice(0, 8)} err=${msg}`)
        if (/token|context|overflow|too large/i.test(msg)) {
          state.stopReason = "context-overflow"
          state.active = false
          saveState(state)
        }
      }
    }
    const handleIdle = async (sid: string): Promise<void> => {
      if (!contEnabled()) return
      const state = loadState(sid)
      if (!state) return
      const ctr = getCtr(sid)
      const cfg = getContConfig()
      const todos = await fetchTodos(sid)
      const toks = lastTokens.get(sid)
      const occupancy = toks ? contextOccupancy(toks, DEFAULT_CONTEXT_LIMIT) : null
      const r = decideContinuation(state, ctr, cfg, todos, occupancy, Date.now())
      counters.set(sid, r.counters)
      const stateChanged = JSON.stringify(r.state) !== JSON.stringify(state)
      if (stateChanged) saveState(r.state)
      if (r.kind === "skip") {
        log("b", `SKIP s=${sid.slice(0, 8)} reason=${r.reason ?? ""}`)
        return
      }
      if (r.kind === "stop") {
        log("b", `STOP s=${sid.slice(0, 8)} reason=${r.reason ?? ""}`)
        return
      }
      if (r.kind === "pause") {
        log("b", `PAUSE s=${sid.slice(0, 8)} reason=${r.reason ?? ""}`)
        return
      }
      cancelCountdown(sid)
      const ms = Math.max(0, cfg.countdownSeconds) * 1000
      const timer = setTimeout(() => {
        countdownTimers.delete(sid)
        if (r.kind === "nudge") void doInject(sid, buildNudgePrompt(), r.state, r.counters)
        else if (r.kind === "countdown" && r.todos) void doInject(sid, buildContinuationPrompt(r.state.objective, todos, cfg.todoListMaxItems), r.state, r.counters)
      }, ms)
      countdownTimers.set(sid, timer)
      log("b", `COUNTDOWN s=${sid.slice(0, 8)} ms=${ms} kind=${r.kind}`)
    }

    // ---- 哨兵处理（机制 A，V1 chat.message → V2 prompt 钩子） ----
    const handleUlwActivate = (sid: string, dir: string, text: string): string | null => {
      if (!featEnabled("contractInjector")) return null
      const m = text.match(/^目标：(.*)$/m)
      const objective = (m?.[1] ?? "").trim()
      const existing = loadState(sid)
      const state = existing && existing.active
        ? { ...existing, epoch: existing.epoch + 1, activatedAt: Date.now(), stopReason: null, pauseReason: null, totalInjections: 0, missingTodoNudgeUsed: false, objective }
        : existing
          ? { ...existing, active: true, epoch: existing.epoch + 1, activatedAt: Date.now(), stopReason: null, pauseReason: null, totalInjections: 0, missingTodoNudgeUsed: false, objective }
          : newState(sid, dir)
      state.objective = objective
      const bc = buildContract()
      if ("error" in bc) {
        log("a", `CONTRACT-MISSING s=${sid.slice(0, 8)} err=${bc.error}`)
        saveState(state)
        return `[grit] 契约文件缺失：${bc.error}。已记录 ULW 激活但无契约注入。`
      }
      state.contractFingerprint = bc.fingerprint
      saveState(state)
      const ctr = getCtr(sid)
      counters.set(sid, { ...ctr, consecutiveFailures: 0, stagnationCount: 0, awaitingProgress: false, responseObserved: false })
      log("a", `ACTIVATE s=${sid.slice(0, 8)} epoch=${state.epoch} fp=${bc.fingerprint}`)
      return bc.text
    }

    // ---- 启动自检（V1 config 钩子 → setup 内直接执行，仅记日志不改配置） ----
    if (disabled) {
      log("c", "GRIT_DISABLE=1：机制全关，仅工具可用")
    } else {
      const ap = getActiveProfile()
      if (!ap) log("c", "WARN 无激活 profile（profiles/active 缺失）——机制按默认开")
      const ulw = readText(join(contractsDir, "ulw.md"))
      if (ulw === null) log("c", "WARN contracts/ulw.md 缺失——/ulw 将降级")
      const cal = ap?.profile.calibration
      if (typeof cal === "string" && readText(join(calibrationDir, `${cal}.md`)) === null) {
        log("c", `WARN 校准段缺失 calibration=${cal}`)
      }
      const markerFile = join(agentsOutDir, "build.md")
      const mt = readText(markerFile)
      if (mt !== null && !mt.includes("grit:materialized")) log("c", "WARN agents/build.md 无物化标记——跑 node scripts/materialize.mjs 并重启")
    }

    // ---- V1 chat.message → V2 prompt 钩子（哨兵 A + 用户打断判定） ----
    await ctx.session.hook("prompt", (event: any) => {
      try {
        const sid = event.sessionID as string
        currentSession = sid
        const text = typeof event.prompt?.text === "string" ? (event.prompt.text as string) : ""
        if (text === "") return
        const sentinel = matchSentinel(text)
        if (sentinel === SENTINEL_ULW) {
          const appended = handleUlwActivate(sid, directory, text)
          if (appended !== null) event.prompt.text = `${text}\n\n${appended}`
          return
        }
        if (sentinel === SENTINEL_STOP) {
          const st = loadState(sid)
          if (st) {
            saveState({ ...st, active: false, stopReason: "manual", pauseReason: null })
            log("a", `STOP-CMD s=${sid.slice(0, 8)}`)
          }
          cancelCountdown(sid)
          return
        }
        if (sentinel !== null) return // 自己的注入物（续跑提示回环）——防回声
        // 真实用户消息：打断判定（仅 ULW 活跃会话）
        const st = loadState(sid)
        if (st && st.active && st.stopReason === null) {
          cancelCountdown(sid)
          if (st.pauseReason !== "user-interruption") {
            saveState({ ...st, pauseReason: "user-interruption" })
            log("b", `USER-INTERRUPT s=${sid.slice(0, 8)}`)
          }
        }
      } catch (e) {
        log("a", `prompt 钩子失败开放：${e instanceof Error ? e.message : String(e)}`)
      }
    })

    // ---- V1 experimental.chat.messages.transform + chat.params → V2 context 钩子 ----
    await ctx.session.hook("context", (event: any) => {
      // 机制 C：profile 热参数（V1 chat.params 语义）
      try {
        if (!disabled && featEnabled("profileEngine")) {
          const params = (getActiveProfile()?.profile.params ?? {}) as Record<string, unknown>
          if (params.apply === true) {
            if (typeof params.temperature === "number") event.options.temperature = params.temperature
            if (typeof params.topP === "number") event.options.topP = params.topP
            if (typeof params.variant === "string" && params.variant !== "") event.options.variant = params.variant
          }
        }
      } catch (e) {
        log("c", `params 失败开放：${e instanceof Error ? e.message : String(e)}`)
      }
      // 机制 A：契约恢复 + 每轮标记（V1 messages.transform 语义；V2 消息为扁平 {type,text}）
      try {
        if (!featEnabled("contractInjector")) return
        const msgs = event.messages as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(msgs) || msgs.length === 0) return
        const sid = event.sessionID as string
        const st = loadState(sid)
        if (!st || !st.active || st.stopReason !== null || st.pauseReason !== null) return
        const textOf = (m: unknown): string | null => {
          const t = (m as { text?: unknown } | null)?.text
          return typeof t === "string" ? t : null
        }
        // 压缩恢复探测：持久消息中既无契约首哨兵也无尾哨兵
        let contractPresent = false
        for (const m of msgs) {
          const t = textOf(m)
          if (t !== null && (t.includes(SENTINEL_CONTRACT_OPEN) || t.includes(SENTINEL_CONTRACT_CLOSE))) {
            contractPresent = true
            break
          }
        }
        if (!contractPresent) {
          const bc = buildContract()
          if ("text" in bc) {
            const at = Math.min(1, msgs.length)
            msgs.splice(at, 0, {
              type: "user",
              id: `msg_grit_contract_${Date.now()}`,
              text: bc.text,
              time: { created: Date.now() },
            })
            log("a", `RESTORE s=${sid.slice(0, 8)} at=${at}`)
          }
          return
        }
        // 每轮一行标记：追加到最后一条 user 消息
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i] as { type?: unknown; text?: unknown }
          if (m?.type !== "user") continue
          const t = textOf(m)
          const line = markerLine(st.objective)
          if (t === null) msgs[i] = { ...m, text: line }
          else if (!t.includes(MARKER_TAG)) msgs[i] = { ...m, text: `${t}\n${line}` }
          return
        }
      } catch (e) {
        log("a", `transform 失败开放：${e instanceof Error ? e.message : String(e)}`)
      }
    })

    // ---- 5 工具注册（V1 tool map → V2 tool transform；JSON Schema；返回 {content}） ----
    await ctx.tool.transform((editor: any) => {
      for (const def of TOOL_DEFS) {
        editor.add({
          name: def.name,
          description: def.description,
          input: def.input,
          execute: async (input: Record<string, unknown>, toolCtx: any): Promise<{ content: string }> => {
            const sid: string = (toolCtx?.sessionID as string) ?? currentSession ?? ""
            switch (def.name) {
              case "context_usage": {
                const tokens = lastTokens.get(sid)
                if (!tokens) return { content: "（暂无 token 快照——本会话尚未产生可计量的上下文数据）" }
                return { content: contextLine(tokens, DEFAULT_CONTEXT_LIMIT) ?? "（占用率计算不可用）" }
              }
              case "system_time":
                return { content: systemTimeLine() }
              case "clone_repo": {
                const url = String(input?.url ?? "").trim()
                if (!url) return { content: "clone_repo 需要 url 参数（Git 仓库地址）。" }
                const full = /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}.git` : url
                const safe = full.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
                const ref = typeof input?.ref === "string" ? input.ref : undefined
                const cacheRoot = process.env.CLONE_CACHE ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "C:/Users/Administrator", ".cache", "opencode", "clone")
                const dest = join(cacheRoot, safe)
                if (existsSync(dest)) {
                  if (ref) {
                    const r = spawnSync("git", ["-C", dest, "checkout", ref], { encoding: "utf8", timeout: 120_000 })
                    if (r.status !== 0) return { content: `已存在缓存但 checkout ${ref} 失败：${r.stderr.slice(0, 300)}` }
                  }
                  return { content: `已克隆缓存：${dest}\n（重新 checkout ${ref ?? "默认"} 完成）` }
                }
                mkdirSync(cacheRoot, { recursive: true })
                const gitArgs = ["clone", "--depth", "1"]
                if (ref) gitArgs.push("--branch", ref)
                gitArgs.push(full, dest)
                const r = spawnSync("git", gitArgs, { encoding: "utf8", timeout: 300_000 })
                if (r.status !== 0) return { content: `clone 失败：${r.stderr.slice(0, 400) || r.stdout.slice(0, 400)}` }
                return { content: `克隆完成：${dest}\n可用 read/grep/glob 检查该目录下的源码。` }
              }
              case "handoff": {
                const summary = withHandoffMarker(typeof input?.summary === "string" ? input.summary : "", leanHandoffSummary())
                try {
                  const created = await ctx.session.create({ title: "会话交接", location: { directory } })
                  const newID = (created as any)?.id
                  if (!newID) return { content: `交接失败：创建新会话返回异常 (${JSON.stringify(created).slice(0, 200)})` }
                  await ctx.session.prompt({ sessionID: newID, text: summary })
                  const st = loadState(sid)
                  if (st && st.active) saveState({ ...st, active: false, stopReason: "manual" })
                  return { content: `已交接：新会话 ${newID} 已创建并注入交接摘要。本会话不再执行任何任务。` }
                } catch (e) {
                  return { content: `交接失败：${e instanceof Error ? e.message : String(e)}` }
                }
              }
              case "profile": {
                if (disabled) return { content: "GRIT_DISABLE=1：profile 机制已关闭。" }
                const action = String(input?.action ?? "")
                if (action === "list") {
                  const names = readdirSync(profilesDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
                  const rows = names.map((n) => {
                    try {
                      const p = JSON.parse(readFileSync(join(profilesDir, `${n}.json`), "utf8")) as Record<string, unknown>
                      const active = loadActiveProfile(profilesDir)?.name === n
                      return `${active ? "*" : " "} ${n} — ${String(p.description ?? "")}`
                    } catch {
                      return `  ${n} —（解析失败）`
                    }
                  })
                  return { content: `可用 profile（* = 当前激活）：\n${rows.join("\n")}` }
                }
                if (action === "show") {
                  const ap = getActiveProfile()
                  if (!ap) return { content: "当前无激活 profile（profiles/active 缺失）。" }
                  return { content: `当前 profile：${ap.name}\n校准段：${String(ap.profile.calibration)}\n热生效：features 开关与阈值、params（temperature/topP/variant）、calibration\n重启生效：model、permissions、promptVariants` }
                }
                // switch
                const name = String(input?.name ?? "").trim()
                if (!name) return { content: "switch 需要 name 参数。" }
                const pf = join(profilesDir, `${name}.json`)
                if (!existsSync(pf)) return { content: `profile 不存在：${name}（用 action=list 查看可用项）` }
                let obj: unknown
                try {
                  obj = JSON.parse(readFileSync(pf, "utf8"))
                } catch (e) {
                  return { content: `profile JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }
                }
                const vr = validateProfile(obj, { expectedName: name, validCalibrations: ["default", "glm", "deepseek"] })
                if (!vr.ok) return { content: `profile 校验失败：${vr.errors.join("；")}` }
                const tmp = join(profilesDir, "active.tmp")
                writeFileSync(tmp, `${name}\n`, "utf8")
                try { unlinkSync(join(profilesDir, "active")) } catch { /* 首次 */ }
                renameSync(tmp, join(profilesDir, "active"))
                profileCache = null
                let mat = ""
                try {
                  const res = materializeAll({
                    agentsSrcDir: join(home, "agents"),
                    outDir: agentsOutDir,
                    profilesDir,
                    activeName: name,
                    variantsDir: join(home, "variants"),
                  })
                  mat = `已重物化 ${res.written.length} 个代理。`
                } catch (e) {
                  mat = `物化失败（可稍后手跑终端命令：grit profile ${name}，或 node ~/.config/opencode/scripts/grit.mjs profile ${name}）：${e instanceof Error ? e.message : String(e)}`
                }
                log("c", `SWITCH profile=${name}`)
                return { content: `已切换到 profile：${name}。${mat}\n立即生效：机制开关与阈值、params、calibration。\n需重启 OpenCode 生效：模型映射、permissions、提示词变体。` }
              }
              default:
                return { content: `未知工具：${def.name}` }
            }
          },
        })
      }
    })

    // ---- 事件订阅（机制 B/D 数据源；V1 event 钩子 → V2 event.subscribe；载荷在 ev.data） ----
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const type = String((ev as any)?.type ?? "")
            const data = ((ev as any)?.data ?? (ev as any)?.properties ?? {}) as Record<string, unknown>
            const sid = typeof data.sessionID === "string" ? data.sessionID : undefined
            if (sid) currentSession = sid
            // 机制 D：token 快照（V2：step.ended=步级，usage.updated=会话累计）
            if (type === "session.step.ended" || type === "session.usage.updated") {
              if (sid && data.tokens) {
                const snap = toSnapshot(data.tokens)
                if (snap) lastTokens.set(sid, snap)
              }
            }
            // responseObserved（V1 tool.execute.after / message.updated 语义）
            if (type === "session.tool.called" || type === "session.tool.success" || type === "message.updated") {
              if (sid) {
                const st = loadState(sid)
                if (st && st.active) getCtr(sid).responseObserved = true
              }
            }
            if (type === "session.error") {
              if (!sid) continue
              const errText = String(data.error ?? data.message ?? "")
              const st = loadState(sid)
              if (!st || !st.active || st.stopReason !== null) continue
              const cls = classifyEvent({ errorText: errText })
              if (cls === "abort") {
                cancelCountdown(sid)
                getCtr(sid).abortAt = Date.now()
                saveState({ ...st, stopReason: "aborted", active: false, pauseReason: null })
                log("b", `STOP s=${sid.slice(0, 8)} reason=aborted`)
              } else if (cls === "overflow") {
                cancelCountdown(sid)
                saveState({ ...st, stopReason: "context-overflow", active: false })
                log("b", `STOP s=${sid.slice(0, 8)} reason=context-overflow`)
              }
              continue
            }
            if (type === "session.compacted") {
              if (sid) log("a", `COMPACTED s=${sid.slice(0, 8)}（恢复由 context 钩子探测执行）`)
              continue
            }
            if (type === "session.idle" || type === "session.status") {
              const status = data.status as { type?: string } | undefined
              const isIdle = type === "session.idle" || status?.type === "idle"
              if (!sid) continue
              if (!isIdle) {
                cancelCountdown(sid) // 会话恢复活动 → 取消倒计时
                continue
              }
              const st = loadState(sid)
              if (!st) continue
              void handleIdle(sid)
            }
          } catch (e) {
            log("a", `event 处理失败开放：${e instanceof Error ? e.message : String(e)}`)
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) log("c", `event 流中断：${e instanceof Error ? e.message : String(e)}`)
      }
    })()

    log("info", "grit 已启动（V2 插件运行时）")

    // ---- 清理（V1 dispose → setup 返回的清理函数） ----
    return () => {
      controller.abort()
      for (const t of countdownTimers.values()) clearTimeout(t)
      countdownTimers.clear()
    }
  },
})

// 可测试内部实现挂 default（非模块导出；V2 loader 只读 id/setup，附加属性无副作用）
const gritPlugin = Object.assign(gritDefinition, {
  toSnapshot,
  contextOccupancy,
  contextLine,
  systemTimeLine,
  withHandoffMarker,
  leanHandoffSummary,
  matchSentinel,
  assembleContract,
  markerLine,
  todoProgressed,
  decideContinuation,
  classifyEvent,
  buildContinuationPrompt,
  buildNudgePrompt,
  TOOL_DEFS,
})

export default gritPlugin
