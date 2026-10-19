/**
 * grit — 轻量多代理套件插件（OpenCode V2 运行时版，DISIGN-v3 实现）。
 *
 * 【OpenCode V2 插件 API】default 导出 = Plugin.define({ id, setup(ctx) })。接线映射：
 *   setup 内直接执行（启动自检）        → 原 V1 config 钩子
 *   ctx.session.hook("prompt", ...)    → 用户提示（/ulw、/stop 哨兵；真实消息打断判定）
 *   ctx.session.hook("context", ...)   → 请求组装：①角色纪律（→系统提示词）②ULW 动态注入（→消息通道）
 *   ctx.event.subscribe()              → 机制 B/D 数据源（载荷在 ev.data）
 *     - 续跑触发：session.execution.succeeded；interrupted / failed 只作护栏输入（**不再续跑**）
 *     - token 快照：**只取 session.step.ended（单步用量）**，算法照 OpenCode 官方
 *       （input+output+reasoning+cache.read+cache.write ÷ 模型 limit.context）；
 *       session.usage.updated 是会话累计值，**不能**当作"当前上下文大小"
 *     - 事件事实（按安装版 @opencode/schema 2.0.20 的 event-manifest 逐条核对）：有 session.idle、
 *       有 session.execution.*，**没有 session.error**（那是 v1 事件）⇒ abort / 上下文超限护栏
 *       必须走 session.execution.interrupted / .failed，不能走 session.error。
 *   ctx.tool.transform                 → 7 工具（context_usage/system_time/clone_repo/handoff/profile/ulw_enter/ulw_exit）
 *
 * 【v3 关键约束（实验证据，见 docs/DESIGN-v3.md §11）】
 *   - 不设 agent.system：md/配置记录里写 system 会【整段替换】基础提示词并跳过 provider 变体与
 *     工具指导；省略 system 才能保留内置 prompt（如 explore 的 PROMPT_EXPLORE，V-4 实测）。
 *   - 注入分两条通道：**稳定内容**（角色纪律，不随会话变化）→ 系统提示词（同内容同位置 ⇒ 不改前缀缓存）；**会话中触发的动态内容**（激活标记/授权与退出提醒）→ 消息通道的带标签块（只追加尾部）。
 *     - 契约是**一条真消息**：进入 ULW（ulw_enter）与压缩完成（session.compaction.ended）都用 ctx.session.prompt
 *     把「契约 + 目标」落库一次；工具只回一句短确认。退出提醒由账本标记驱动（退出后下一轮组装贴一次）。
 *   - 注入一律走【消息通道】的独立带标签块（或工具返回）；【绝不改写系统提示词】——用户一输入就改系统提示词会让前缀缓存整段失效。
 *   - v2 无 todo 工具（V-6）：机制 B 不扫描清单，完成由模型自判（调用 ulw_exit 退出）。
 *   - ULW 由工具进入/退出：/ulw 命令文本含授权标识 [GRIT:ULW:START]，模型调 ulw_enter(goal) 时校验「上一条用户消息」含该标识才进入；ulw_exit 退出（目标作参数，不做文本嗅探）。
 *
 * 四机制（各自独立可关，profile.features.* 热读 + GRIT_DISABLE 总闸）：
 *   A contract-injector   /ulw 携带授权标识 → 模型调用 ulw_enter（校验标识）进入（契约作为一条真消息注入）；每轮一行标记；压缩后重注入契约
 *   B continuation        执行空闲时，若仍处于 ULW → 独立块续跑；模型调用 ulw_exit 或用户 /ulw-exit 退出
 *   C profile-engine      profile 工具（list/show/switch，改 agents 记录）
 *   D token-snapshot      被动缓存 token 快照（context_usage 与护栏同源）
 * 工具：context_usage / system_time / clone_repo / handoff / profile / ulw_enter / ulw_exit
 *
 *   外置约定（2026-10-18 收窄）：契约与角色纪律外置 contracts/（纯文本、可自由改）；
 *   带变量拼接的便签/回话留在本文件（它们是模板，外置反而更难维护）。文本匹配仅整行哨兵；
 * 一切注入只追加尾部，永不改写历史。
 * 可测试的纯函数全部挂在 default 导出对象上（V2 loader 只读 id/setup）。
 */

import { Plugin } from "@opencode/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  validateProfile,
  buildAgentRecords,
  loadActiveProfile,
  loadProfileByName,
  readAgentsIndex,
} from "../scripts/materialize-core.ts"

// ===================== 常量与哨兵 =====================

/**
 * grit 托管的席位。`plan` 不在此列：它是 OpenCode 原生的只读 plan 模式（`opencode.plan`，
 * 自带 edit:deny 权限与 Plan-mode 提醒），不注入纪律、不物化 agents 记录、不参与动态注入。
 */
const AGENT_NAMES = ["build", "explore", "general", "sage", "browse"]
/** 曾被 grit 托管、现已移除的席位（安装/切换时一并从 opencode.json 清除，避免残留）。
 *  `plan` 交回 OpenCode 原生 plan 模式：不写记录，原生身份/权限/描述才不会被我们覆盖。 */
const REMOVED_AGENT_NAMES = ["factory", "plan", "expert"]
/** /ulw 命令携带的授权标识：ulw_enter 校验「上一条用户消息」是否含它，无则拒绝进入。 */
const ULW_AUTH_TOKEN = "[GRIT:ULW:START]"
const SENTINEL_EXIT = "[GRIT:ULW:EXIT]"
const SENTINEL_CONTINUE = "[GRIT:ULW:CONTINUE]"
const CONTRACT_OPEN = "<!-- GRIT:ULW:CONTRACT -->"
const CONTRACT_CLOSE = "<!-- /GRIT:ULW:CONTRACT -->"
const MARKER_TAG = "[GRIT:ULW:ACTIVE]"
const ARMED_TAG = "[GRIT:ULW:ARMED]"
const EXITED_TAG = "[GRIT:ULW:EXITED]"
/** 插件拦截的整行哨兵（/ulw 命令本身按真实用户消息处理，不做拦截）。 */
const PROMPT_SENTINELS = [SENTINEL_EXIT, SENTINEL_CONTINUE]

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

export interface UlwState {
  schemaVersion: 2
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
  /** 退出后是否还有一条「已退出」提醒待贴（贴一次即清；由账本状态驱动，不靠扫用户消息里的哨兵）。 */
  exitNoticePending: boolean
}

export type StopReason = "manual" | "aborted" | "stagnated" | "completed" | "context-overflow" | "injection-budget" | "tool-loop"
export type PauseReason = "user-interruption" | "max-failures" | "directive-response"

export interface Counters {
  lastInjectedAt: number
  consecutiveFailures: number
  stagnationCount: number
  awaitingProgress: boolean
  fingerprint: string | null
  abortAt: number | null
  /** 上次"兜底重贴契约"的时间（context 钩子里 60 秒节流；正常路径走不到）。 */
  contractRestoreAt?: number
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
  toolLoopStop: number
}

export const DEFAULT_CONTINUATION: ContinuationConfig = {
  countdownSeconds: 2, cooldownBaseMs: 5000, backoffPowCap: 5,
  maxConsecutiveFailures: 5, failureResetWindowMs: 600000, maxStagnation: 2,
  abortWindowMs: 3000, contextSkipPct: 85, maxTotalInjections: 200,
  toolLoopStop: 5,
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
  // 与 OpenCode 官方算法一致：input + output + reasoning + cache.read + cache.write
  // （官方实现见 cli 二进制：session.step.ended → tokens.input+output+reasoning+cache.read+cache.write）
  return s.input + s.output + s.reasoning + (s.cache?.read ?? 0) + (s.cache?.write ?? 0)
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
    "## 1. 任务与目标",
    "-（上一会话未提供摘要）",
    "## 2. 当前状态",
    "-（未知：请先浏览本项目关键文件定位现状）",
    "## 3. 已确认的事实（无需重新探索）",
    "- 无",
    "## 4. 待处理的工作",
    "- 无",
    "## 5. 已知的坑",
    "- 无",
    "## 6. 验证情况",
    "- 无",
    "## 7. 会话级状态",
    "- 无",
  ].join("\n")
}

/** 哨兵匹配：首行或第二行整行精确相等。 */
function matchSentinel(text: string): string | null {
  const lines = text.split(/\r?\n/)
  for (const line of [lines[0], lines[1]]) {
    if (line === undefined) continue
    for (const s of PROMPT_SENTINELS) if (line === s) return s
  }
  return null
}

/** 契约拼装：ulw.md（含交接模板槽位）包 us 首尾哨兵。纯字符串。校准段改为运行时按模型追加，不入契约。 */
function assembleContract(ulwText: string, handoffText: string): string {
  const body = ulwText.replace("{{handoff_template}}", handoffText)
  return `${CONTRACT_OPEN}\n${body.trim()}\n${CONTRACT_CLOSE}`
}

/** 纪律段块（独立带标签，防重复）：席位专属（+ 档里指定的变体）。 */
function disciplineBlock(name: string, content: string): string {
  return `<GRIT-DISCIPLINE agent="${name}">\n[GRIT:DISCIPLINE:${name}]\n${content.trim()}\n</GRIT-DISCIPLINE>`
}

function markerLine(objective: string): string {
  const obj = objective.trim()
  return `<system-reminder>${MARKER_TAG} 持续工作模式进行中（目标：${obj || "（未设定）"}）。纪律契约持续有效；完成后调用 ulw_exit 工具退出。</system-reminder>`
}

function continuationBlock(objective: string): string {
  const obj = objective.trim()
  return [
    "<system-reminder>",
    SENTINEL_CONTINUE,
    "持续工作模式仍在进行：继续推进既定目标，不要停下来等待确认。",
    "- 按已注入的纪律契约执行：真实证据、自己验证、别削弱判据。",
    "- 只有当目标真正完成（每条判据都有真实执行痕迹）时，才调用 ulw_exit 工具退出。",
    obj ? `（目标：${obj}）` : "",
    "</system-reminder>",
  ].filter(Boolean).join("\n")
}

/**
 * 插件自己以「真消息」形式注入的文本（契约同步 / 续跑提示）。prompt 钩子必须把它们当成插件消息：
 * 契约块一旦被当成用户插话，会把账本打成 user-interruption 暂停，刚进入就被按住。
 */
function isPluginInjectedText(text: string): boolean {
  return text.includes(CONTRACT_OPEN) || text.includes(SENTINEL_CONTINUE)
}

/**
 * 进入 ULW（以及压缩后恢复）时注入的「契约 + 目标」块：用原生 system-reminder 包裹，
 * 作为一条真实用户消息落库 —— 后续每一轮请求都看得到，不会随当轮工具结果一起被丢。
 */
function contractNotice(contract: string, objective: string): string {
  const obj = objective.trim()
  const head = [
    "<system-reminder>",
    "以下是持续工作模式（ULW）的纪律契约，自本条消息起生效，直到你调用 ulw_exit 退出。",
    obj ? `目标：${obj}` : "",
  ].filter(Boolean).join("\n")
  return `${head}\n\n${contract}\n</system-reminder>`
}

/** 「已退出」提醒：两条退出路径共用同一段文本，由账本标记驱动、贴一次即清。 */
function exitNoticeBlock(): string {
  return `<system-reminder>${EXITED_TAG} ULW 已退出：纪律契约（场景契约/验收证据/审查门/QA 矩阵/零容忍/完成判定）自此不再生效。请用一两句话总结当前进度与剩余工作后结束回合，不要继续推进。</system-reminder>`
}

/** 取一条消息的纯文本（内容兼容 v2 扁平 {role,content:[{type,text}]} 与 session.context 的形态）。 */
function messageText(m: unknown): string {
  if (!m || typeof m !== "object") return ""
  const mm = m as { text?: unknown; content?: unknown }
  if (typeof mm.text === "string") return mm.text
  if (Array.isArray(mm.content)) {
    return mm.content
      .filter((p): p is { type?: unknown; text?: unknown } => !!p && typeof p === "object")
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => String(p.text))
      .join("\n")
  }
  return ""
}

/** 最后一条 assistant 消息的纯文本。 */
function lastAssistantText(msgs: unknown[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { type?: unknown; role?: unknown } | null
    if (!m) continue
    if (m.type === "assistant" || m.role === "assistant") {
      const t = messageText(m)
      if (t.trim() !== "") return t
    }
  }
  return ""
}

/** 最后一条 user 消息的纯文本。 */
function lastUserTextOf(msgs: unknown[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { type?: unknown; role?: unknown } | null
    if (!m) continue
    if (m.type === "user" || m.role === "user") {
      const t = messageText(m)
      if (t.trim() !== "") return t
    }
  }
  return ""
}

/** 消息里是否已含某标签（注入幂等判据）。 */
function messagesContain(msgs: unknown[], needle: string): boolean {
  return Array.isArray(msgs) && msgs.some((m) => messageText(m).includes(needle))
}

/**
 * 深度取一条消息的文本：顶层 text part **加上** tool part 内嵌的 state.content / state.output。
 * v2 里工具结果是 `{type:"tool", state:{content:[{type:"text",text}]}}`——契约正是这样被 ulw_enter 携带的，
 * 只用顶层 text part 会看不见它（导致"契约已注入"判据恒为假、每轮重注入）。
 */
function deepMessageText(m: unknown): string {
  if (!m || typeof m !== "object") return ""
  const mm = m as { text?: unknown; content?: unknown }
  const parts: string[] = []
  const take = (p: unknown): void => {
    if (!p || typeof p !== "object") return
    const pp = p as { text?: unknown; state?: unknown }
    if (typeof pp.text === "string") parts.push(pp.text)
    const st = pp.state
    if (!st || typeof st !== "object") return
    const s = st as { content?: unknown; output?: unknown }
    if (Array.isArray(s.content)) {
      for (const c of s.content) {
        if (!c || typeof c !== "object") continue
        const cc = c as { type?: unknown; text?: unknown }
        if (typeof cc.text === "string" && (cc.type === undefined || cc.type === "text")) parts.push(cc.text)
      }
    }
    if (typeof s.output === "string") parts.push(s.output)
  }
  if (typeof mm.text === "string") parts.push(mm.text)
  if (Array.isArray(mm.content)) for (const p of mm.content) take(p)
  return parts.join("\n")
}

/** 契约是否已在会话历史里（含 ulw_enter 的工具结果）。压缩后工具结果被丢弃 ⇒ 判假 ⇒ 触发恢复注入。 */
function contractInHistory(msgs: unknown[]): boolean {
  return Array.isArray(msgs) && msgs.some((m) => deepMessageText(m).includes(CONTRACT_OPEN))
}

/** 从 v2 结构化错误（SessionStructuredError）里取可用于分类的文本；形状未知 ⇒ 宽容抽取。 */
function errorTextOf(err: unknown): string {
  if (typeof err === "string") return err
  if (!err || typeof err !== "object") return ""
  const e = err as Record<string, unknown>
  return [e.name, e.message, e.code, e.type, e._tag].filter((v): v is string => typeof v === "string").join(" ")
}

/**
 * 把带标签的注入块追加到「最后一条 user 消息」尾部（只动最新一条、不改写历史前缀、不碰系统提示词）；
 * 没有 user 消息时追加一条独立 user 消息。
 */
function appendInject(msgs: any[], block: string): void {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as any
    if (!m || (m.role !== "user" && m.type !== "user")) continue
    if (Array.isArray(m.content)) {
      m.content.push({ type: "text", text: block })
      return
    }
    if (typeof m.text === "string") {
      m.text = `${m.text}\n\n${block}`
      return
    }
    return
  }
  msgs.push({ id: `msg_grit_${Date.now()}`, role: "user", content: [{ type: "text", text: block }] })
}

/** 响应指纹（最后一条 assistant 文本的短哈希）——用于"指纹未变即停"。 */
function responseFingerprint(msgs: unknown[]): string {
  const t = lastAssistantText(msgs)
  return createHash("sha1").update(t).digest("hex").slice(0, 12)
}

/** 同一工具调用（name+input）的最大重复次数——工具死循环护栏的判据。 */
function maxToolRepeat(msgs: unknown[], window = 60): number {
  const counts = new Map<string, number>()
  let max = 0
  const start = Math.max(0, msgs.length - window)
  for (let i = start; i < msgs.length; i++) {
    const m = msgs[i] as { content?: unknown } | null
    const c = m?.content
    if (!Array.isArray(c)) continue
    for (const p of c) {
      if (!p || typeof p !== "object") continue
      const pp = p as { type?: unknown; name?: unknown; state?: unknown; input?: unknown }
      if (pp.type !== "tool" || typeof pp.name !== "string") continue
      const st = pp.state as { input?: unknown } | undefined
      const input = st?.input ?? pp.input ?? {}
      let sig: string
      try {
        sig = `${pp.name}:${JSON.stringify(input)}`
      } catch {
        sig = `${pp.name}:?`
      }
      const n = (counts.get(sig) ?? 0) + 1
      counts.set(sig, n)
      if (n > max) max = n
    }
  }
  return max
}

export type ContinueActionKind = "countdown" | "skip" | "pause" | "stop"
export interface ContinueInput {
  occupancy: number | null
  fingerprint: string
  maxToolRepeat: number
}
export interface ContinueAction {
  kind: ContinueActionKind
  reason?: string
  counters: Counters
  state: UlwState
}

/**
 * 续跑门（简化为"激活 + 未声明完成 + 护栏"）。纯函数：返回动作 + 新计数器/状态（不落盘）。
 * 门序：非激活→abort 窗口→已声明完成→暂停→停滞→失败上限→冷却→上下文过高→工具死循环→预算→countdown。
 */
function decideContinuation(
  stateIn: UlwState,
  countersIn: Counters,
  cfg: ContinuationConfig,
  input: ContinueInput,
  now: number,
): ContinueAction {
  const counters: Counters = { ...countersIn }
  const state: UlwState = { ...stateIn }
  if (!state.active || state.stopReason !== null) {
    return { kind: "skip", reason: state.stopReason ? "stopped" : "not-active", counters, state }
  }
  if (counters.abortAt !== null && now - counters.abortAt < cfg.abortWindowMs) {
    return { kind: "skip", reason: "abort-window", counters, state }
  }
  if (state.pauseReason !== null) {
    if (state.pauseReason === "max-failures" && counters.lastInjectedAt > 0 && now - counters.lastInjectedAt >= cfg.failureResetWindowMs) {
      state.pauseReason = null
      counters.consecutiveFailures = 0
    } else if ((state.pauseReason === "directive-response" || state.pauseReason === "user-interruption") && input.fingerprint !== counters.fingerprint) {
      // 用户插话/中止后模型已产出新响应 ⇒ 解除暂停回到常规门（仍受冷却/停滞/预算约束）。
      // 没有这条，用户插一次话 ULW 就永久停摆（"暂停"退化成"报废"）。
      state.pauseReason = null
      counters.stagnationCount = 0
    } else {
      return { kind: "skip", reason: `paused:${state.pauseReason}`, counters, state }
    }
  }
  // 停滞：注入后本轮响应指纹未变化 → 无进展
  if (counters.awaitingProgress) {
    if (counters.fingerprint !== null && counters.fingerprint === input.fingerprint) {
      counters.stagnationCount += 1
      if (counters.stagnationCount >= cfg.maxStagnation) {
        state.stopReason = "stagnated"
        state.active = false
        return { kind: "stop", reason: "stagnated", counters, state }
      }
    } else {
      counters.stagnationCount = 0
    }
    counters.awaitingProgress = false
  }
  counters.fingerprint = input.fingerprint
  if (counters.consecutiveFailures >= cfg.maxConsecutiveFailures) {
    state.pauseReason = "max-failures"
    return { kind: "pause", reason: "max-failures", counters, state }
  }
  if (now - counters.lastInjectedAt < cfg.cooldownBaseMs * Math.pow(2, Math.min(counters.consecutiveFailures, cfg.backoffPowCap))) {
    return { kind: "skip", reason: "cooldown", counters, state }
  }
  if (input.occupancy !== null && input.occupancy >= cfg.contextSkipPct) {
    return { kind: "skip", reason: "context-high", counters, state }
  }
  if (input.maxToolRepeat >= cfg.toolLoopStop) {
    state.stopReason = "tool-loop"
    state.active = false
    return { kind: "stop", reason: "tool-loop", counters, state }
  }
  if (state.totalInjections >= cfg.maxTotalInjections) {
    state.stopReason = "injection-budget"
    state.active = false
    return { kind: "stop", reason: "injection-budget", counters, state }
  }
  return { kind: "countdown", counters, state }
}

export type EventClass = "abort" | "overflow" | "other"
/** 仅用于错误事件分类（abort / 上下文超限）。纯函数。 */
function classifyEvent(input: { errorText?: string }): EventClass {
  const t = (input.errorText ?? "").toLowerCase()
  if (t.includes("abort")) return "abort"
  if (t.includes("token limit") || t.includes("context") || t.includes("overflow") || t.includes("too large")) return "overflow"
  return "other"
}

/**
 * clone_repo 入参防护（纯函数，便于测试）：git 会把以 `-` 开头的参数当选项，未校验时
 * 模型可以传 `ref="-c core.pager=cat"` 这种"正当输入"去改写 git 行为。
 */
export function isSafeGitUrl(url: string): boolean {
  return url.length > 0 && !url.startsWith("-") && !/\s/.test(url)
}
export function isSafeGitRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
}

// ===================== 工具定义 =====================

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
      "Hand off the current session to a fresh top-level session: creates a new session (same directory, NOT a child session) and injects the handoff summary. Pass `summary` with the full summary you authored per the 交接摘要模板 (from the /handoff or /ulw contract) — state INFORMATION only (what/where/results/gaps), never instructions, and make it complete enough that the next session never re-investigates what you already know; without it a lean placeholder summary is used.",
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
      "Manage grit profiles. list = enumerate profiles; show = active profile details with effect boundaries; switch = atomically activate a profile (writes the active pointer and updates the OpenCode `agents` records in opencode.json). Under OpenCode V2 the config dir is watched (~3s), so model/permission changes take effect automatically (no restart). Behavior/mechanism toggles take effect immediately. The current session keeps its already-selected model.",
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
  {
    name: "ulw_enter",
    description:
      "Enter Continuous-Work (ULW) mode. Call this ONLY when the user asked for continuous work (they ran /ulw) — otherwise it is rejected. Pass `goal`: one line stating the task the user MOST RECENTLY asked for — locate it within the last few turns (it need NOT be the final message; chatter or follow-ups may come after it); NOT an older, broader goal. The discipline contract is injected into the session as a separate reminder message; this tool returns only a short confirmation. The mode lasts until you call ulw_exit.",
    input: {
      type: "object",
      properties: { goal: { type: "string", description: "一句话目标（从会话上下文提炼）" } },
      required: ["goal"],
      additionalProperties: false,
    },
  },
  {
    name: "ulw_exit",
    description:
      "Exit Continuous-Work (ULW) mode. Call this when the goal is genuinely complete (every acceptance criterion has real evidence) or when the user asks to stop. After exit the ULW discipline contract no longer applies.",
    input: {
      type: "object",
      properties: { reason: { type: "string", description: "可选：退出原因（一句话）" } },
      additionalProperties: false,
    },
  },
]

// ===================== 插件（V2） =====================

/* eslint-disable @typescript-eslint/no-explicit-any */

// ===================== 跨实例共享状态（挂在 globalThis 上） =====================
// OpenCode 会多次加载同一插件文件（每 agent / 每次 reload 各跑一次 setup）。实测：**模块级变量
// 在同一文件被重复 import 时仍是每个模块实例一份**，去重因此失效（同毫秒 8 份 COUNTDOWN）。
// 所以把共享状态挂到 globalThis（进程级，跨模块实例唯一）。
interface GritShared {
  stateCache: Map<string, { mtimeMs: number; s: UlwState }>
  counters: Map<string, Counters>
  countdownTimers: Map<string, ReturnType<typeof setTimeout>>
  lastTokens: Map<string, TokenSnapshot>
  /** 每会话最近一次请求的模型引用（用于查真实上下文窗口，见 limitFor）。 */
  lastModels: Map<string, { providerID: string; modelID: string }>
  /** 每会话最近一次「压缩后恢复」的时间戳（事件分发给每个插件实例，用它去重）。 */
  lastCompacted: Map<string, number>
  /** 正在处理 idle 的会话（防并发重入导致重复注入）。 */
  inflight: Set<string>
  /** 同进程插件 setup 次数（诊断用）。 */
  setups: number
  startedLogged: boolean
}
const GRIT_SHARED_KEY = "__grit_v3_shared__"
const globalBag = globalThis as unknown as Record<string, GritShared | undefined>
/**
 * 取/建跨实例共享袋。**必须逐字段补默认值**：热重载时旧实例可能已经建好一个"缺新字段"的旧形状对象
 * （模块级变量在重复 import 时各一份，见 DESIGN-v3 §0.2-6，所以只能挂 globalThis）；
 * 若直接沿用旧对象，新代码写新字段就会抛（真实踩过：lastModels ⇒ 动态注入整段被 catch 吞掉）。
 */
const SHARED: GritShared = (() => {
  const existing = globalBag[GRIT_SHARED_KEY]
  if (existing) {
    const b = existing as Partial<GritShared>
    b.stateCache ??= new Map()
    b.counters ??= new Map()
    b.countdownTimers ??= new Map()
    b.lastTokens ??= new Map()
    b.lastModels ??= new Map()
    b.lastCompacted ??= new Map()
    b.inflight ??= new Set()
    b.setups ??= 0
    b.startedLogged ??= false
    return existing
  }
  const fresh: GritShared = {
    stateCache: new Map(),
    counters: new Map(),
    countdownTimers: new Map(),
    lastTokens: new Map(),
    lastModels: new Map(),
    lastCompacted: new Map(),
    inflight: new Set(),
    setups: 0,
    startedLogged: false,
  }
  globalBag[GRIT_SHARED_KEY] = fresh
  return fresh
})()

const gritDefinition = Plugin.define({
  id: "grit",
  async setup(ctx: any) {
    const pluginDir = dirname(fileURLToPath(import.meta.url))
    // 部署布局：~/.config/opencode/plugins/grit.ts → 数据根 ../grit
    const home = process.env.GRIT_HOME ?? join(pluginDir, "..", "grit")
    const directory = ctx?.location?.directory ?? process.cwd()
    const cfgDir = process.env.GRIT_CONFIG_DIR ?? join(home, "..")
    const cfgPath = join(cfgDir, "opencode.json")
    const contractsDir = join(home, "contracts")
    const disciplineDir = join(contractsDir, "discipline")
    const profilesDir = join(home, "profiles")
    const agentsDir = join(home, "agents")
    const stateDir = join(home, "state")
    const logDir = join(home, "log")
    const disabled = process.env.GRIT_DISABLE === "1"

    const log = (mech: string, msg: string): void => {
      try {
        mkdirSync(logDir, { recursive: true })
        const lp = join(logDir, "grit.log")
        try {
          if (statSync(lp).size > LOG_MAX_BYTES) writeFileSync(lp, "", "utf8")
        } catch { /* 不存在 */ }
        writeFileSync(lp, `${new Date().toISOString()} [${mech}] ${msg}\n`, { flag: "a", encoding: "utf8" })
      } catch { /* 日志失败不影响主流程 */ }
    }
    mkdirSync(stateDir, { recursive: true })

    // ---- 文本读取（现读现拼：改 contracts 文件即改纪律/契约，进程无需重启） ----
    const readText = (p: string): string | null => {
      try {
        return existsSync(p) ? readFileSync(p, "utf8") : null
      } catch {
        return null
      }
    }
    const variantsDir = join(home, "variants")
    const readDiscipline = (name: string): string | null => {
      const variantsMap = (getActiveProfile()?.profile.promptVariants ?? {}) as Record<string, string>
      const vn = typeof variantsMap[name] === "string" ? (variantsMap[name] as string) : ""
      const shared = readText(join(disciplineDir, "_shared.md")) ?? ""
      const own = readText(join(disciplineDir, `${name}.md`))
      if (own === null) return null
      const variant = vn ? readText(join(variantsDir, vn, "discipline", `${name}.md`)) ?? "" : ""
      return [shared.trim(), own.trim(), variant.trim()].filter(Boolean).join("\n\n")
    }

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
      const tc = ((ap?.profile.features ?? {}) as Record<string, Record<string, unknown>>).continuation ?? {}
      const num = (k: keyof ContinuationConfig): number => {
        const v = tc[k]
        return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_CONTINUATION[k]
      }
      return {
        countdownSeconds: num("countdownSeconds"), cooldownBaseMs: num("cooldownBaseMs"),
        backoffPowCap: num("backoffPowCap"), maxConsecutiveFailures: num("maxConsecutiveFailures"),
        failureResetWindowMs: num("failureResetWindowMs"), maxStagnation: num("maxStagnation"),
        abortWindowMs: num("abortWindowMs"), contextSkipPct: num("contextSkipPct"),
        maxTotalInjections: num("maxTotalInjections"), toolLoopStop: num("toolLoopStop"),
      }
    }
    const contEnabled = (): boolean => {
      if (disabled) return false
      const tc = ((getActiveProfile()?.profile.features ?? {}) as Record<string, Record<string, unknown>>).continuation ?? {}
      return tc.enabled !== false
    }

    // ---- state IO（缓存跨实例共享 + 按 mtime 感知磁盘变化，见 SHARED） ----
    const stateCache = SHARED.stateCache
    const statePath = (sid: string): string => join(stateDir, `${sid}.json`)
    const loadState = (sid: string): UlwState | null => {
      const p = statePath(sid)
      let mtimeMs: number
      try {
        mtimeMs = statSync(p).mtimeMs
      } catch {
        return null
      }
      const cached = stateCache.get(sid)
      if (cached && cached.mtimeMs === mtimeMs) return cached.s
      try {
        const s = JSON.parse(readFileSync(p, "utf8")) as UlwState
        if (s.schemaVersion !== 2) return null
        stateCache.set(sid, { mtimeMs, s })
        return s
      } catch {
        return null
      }
    }
    const saveState = (s: UlwState): void => {
      try {
        const p = statePath(s.sessionID)
        const tmp = `${p}.tmp`
        writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8")
        try { unlinkSync(p) } catch { /* 首次 */ }
        renameSync(tmp, p)
        try {
          stateCache.set(s.sessionID, { mtimeMs: statSync(p).mtimeMs, s })
        } catch {
          stateCache.delete(s.sessionID)
        }
      } catch (e) {
        log("a", `state 写盘失败 s=${s.sessionID.slice(0, 8)} err=${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const newState = (sid: string, dir: string): UlwState => ({
      schemaVersion: 2, sessionID: sid, directory: dir, active: true, objective: "",
      epoch: 1, activatedAt: Date.now(), contractFingerprint: null,
      stopReason: null, pauseReason: null, totalInjections: 0, exitNoticePending: false,
    })
    try {
      const now = Date.now()
      for (const f of readdirSync(stateDir)) {
        if (!f.endsWith(".json")) continue
        const p = join(stateDir, f)
        if (now - statSync(p).mtimeMs > STATE_TTL_MS) unlinkSync(p)
      }
    } catch { /* 目录不存在等 */ }

    // ---- 续跑计数器（内存，重载归零=安全侧；跨实例共享） ----
    const counters = SHARED.counters
    const getCtr = (sid: string): Counters => {
      let c = counters.get(sid)
      if (!c) {
        c = { lastInjectedAt: 0, consecutiveFailures: 0, stagnationCount: 0, awaitingProgress: false, fingerprint: null, abortAt: null }
        counters.set(sid, c)
      }
      return c
    }
    const countdownTimers = SHARED.countdownTimers

    // ---- token 快照（机制 D；跨实例共享） ----
    const lastTokens = SHARED.lastTokens
    let currentSession: string | null = null

    // ---- 模型真实上下文窗口（懒查一次并缓存 5min；查不到回退 DEFAULT_CONTEXT_LIMIT） ----
    // 原先写死 1M：对 128K/256K 窗口的模型会把占用率算低几倍，85% 上限门几乎永不触发。
    let limitCache: { at: number; byKey: Map<string, number> } | null = null
    const limitFor = async (sid: string): Promise<number> => {
      const ref = SHARED.lastModels.get(sid)
      if (!ref || !ref.providerID || !ref.modelID) return DEFAULT_CONTEXT_LIMIT
      try {
        if (!limitCache || Date.now() - limitCache.at > 300_000) {
          const raw = (await ctx.model?.list?.()) as unknown
          const list = Array.isArray(raw) ? raw : ((raw as { data?: unknown } | null)?.data ?? [])
          const byKey = new Map<string, number>()
          for (const info of Array.isArray(list) ? list : []) {
            const i = info as { providerID?: unknown; modelID?: unknown; limit?: { context?: unknown } }
            const c = i?.limit?.context
            if (typeof i?.providerID === "string" && typeof i?.modelID === "string" && typeof c === "number" && c > 0) {
              byKey.set(`${i.providerID}/${i.modelID}`, c)
            }
          }
          limitCache = { at: Date.now(), byKey }
        }
        const v = limitCache.byKey.get(`${ref.providerID}/${ref.modelID}`)
        if (v !== undefined && v > 0) return v
      } catch (e) {
        log("b", `model limit 查询失败：${e instanceof Error ? e.message : String(e)}`)
      }
      return DEFAULT_CONTEXT_LIMIT
    }

    // ---- 契约 ----
    const buildContract = (): { text: string; fingerprint: string } | { error: string } => {
      const ulw = readText(join(contractsDir, "ulw.md"))
      if (ulw === null) return { error: "contracts/ulw.md 缺失" }
      const ht = readText(join(contractsDir, "handoff-template.md")) ?? ""
      const text = assembleContract(ulw, ht)
      return { text, fingerprint: `sha1:${createHash("sha1").update(text).digest("hex").slice(0, 12)}` }
    }

    // ---- 续跑注入 ----
    const cancelCountdown = (sid: string): void => {
      const t = countdownTimers.get(sid)
      if (t !== undefined) {
        clearTimeout(t)
        countdownTimers.delete(sid)
      }
    }
    const doInject = async (sid: string): Promise<void> => {
      // 注入前复核新鲜状态：已退出/已停则不发、不写（防陈旧快照把 active:true 复活）
      const st = loadState(sid)
      if (!st || !st.active || st.stopReason !== null) {
        log("b", `INJECT-SKIP s=${sid.slice(0, 8)} reason=not-active`)
        return
      }
      try {
        // 独立带标签块（不拼进用户原文）：作为一条独立 prompt 注入并唤醒会话。
        await ctx.session.prompt({ sessionID: sid, text: continuationBlock(st.objective) })
        const ctr = getCtr(sid)
        ctr.lastInjectedAt = Date.now()
        ctr.awaitingProgress = true
        ctr.consecutiveFailures = 0
        // 写回用新鲜状态，且仅在仍激活时计数
        const after = loadState(sid)
        if (after && after.active && after.stopReason === null) {
          after.totalInjections += 1
          saveState(after)
          log("b", `INJECT s=${sid.slice(0, 8)} epoch=${after.epoch} total=${after.totalInjections}`)
        } else {
          log("b", `INJECT-EXITED s=${sid.slice(0, 8)}（注入后已退出，不回写 active）`)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const ctr = getCtr(sid)
        ctr.consecutiveFailures += 1
        ctr.lastInjectedAt = Date.now()
        log("b", `INJECT-FAIL s=${sid.slice(0, 8)} err=${msg}`)
        if (/token|context|overflow|too large/i.test(msg)) {
          const fresh = loadState(sid)
          if (fresh && fresh.active) saveState({ ...fresh, stopReason: "context-overflow", active: false })
        }
      }
    }
    const handleIdle = async (sid: string): Promise<void> => {
      if (!contEnabled()) return
      // 去重：并发重入 或 已有倒计时在等 → 跳过（防重复注入）
      if (SHARED.inflight.has(sid)) { log("b", `SKIP s=${sid.slice(0, 8)} reason=inflight`); return }
      if (countdownTimers.has(sid)) { log("b", `SKIP s=${sid.slice(0, 8)} reason=countdown-pending`); return }
      SHARED.inflight.add(sid)
      try {
        const state = loadState(sid)
        if (!state) return
        const ctr = getCtr(sid)
        const cfg = getContConfig()
        let msgs: unknown[] = []
        try {
          const res = await ctx.session.context({ sessionID: sid })
          msgs = Array.isArray(res) ? res : ((res as any)?.data ?? [])
        } catch (e) {
          log("b", `context 读取失败 s=${sid.slice(0, 8)} err=${e instanceof Error ? e.message : String(e)}`)
        }
        const toks = lastTokens.get(sid)
        const occupancy = toks ? contextOccupancy(toks, await limitFor(sid)) : null
        const input: ContinueInput = {
          occupancy,
          fingerprint: responseFingerprint(msgs),
          maxToolRepeat: maxToolRepeat(msgs),
        }
        const r = decideContinuation(state, ctr, cfg, input, Date.now())
        counters.set(sid, r.counters)
        const stateChanged = JSON.stringify(r.state) !== JSON.stringify(state)
        if (stateChanged) saveState(r.state)
        if (r.kind === "skip") { log("b", `SKIP s=${sid.slice(0, 8)} reason=${r.reason ?? ""}`); return }
        if (r.kind === "stop") { log("b", `STOP s=${sid.slice(0, 8)} reason=${r.reason ?? ""}`); return }
        if (r.kind === "pause") { log("b", `PAUSE s=${sid.slice(0, 8)} reason=${r.reason ?? ""}`); return }
        cancelCountdown(sid)
        const ms = Math.max(0, cfg.countdownSeconds) * 1000
        const timer = setTimeout(() => {
          countdownTimers.delete(sid)
          void doInject(sid)
        }, ms)
        countdownTimers.set(sid, timer)
        log("b", `COUNTDOWN s=${sid.slice(0, 8)} ms=${ms} toolRepeat=${input.maxToolRepeat}`)
      } finally {
        SHARED.inflight.delete(sid)
      }
    }

    // ---- 取"上一条用户消息"文本（ulw_enter 的授权校验依据） ----
    const lastUserText = async (sid: string): Promise<string> => {
      try {
        const res = await ctx.session.context({ sessionID: sid })
        const msgs: unknown[] = Array.isArray(res) ? res : ((res as any)?.data ?? [])
        return lastUserTextOf(msgs)
      } catch (e) {
        log("b", `lastUserText 读取失败 s=${sid.slice(0, 8)} err=${e instanceof Error ? e.message : String(e)}`)
        return ""
      }
    }

    /** 模型调用 ulw_enter：仅当「上一条用户消息」含授权标识 ULW_AUTH_TOKEN（即用户执行过 /ulw），
     *  或本会话已在 ULW 中（允许更新目标）时生效；无授权标识则拒绝并告知模型。 */
    const enterUlw = async (sid: string, dir: string, goal: string): Promise<string> => {
      if (!featEnabled("contractInjector")) return "ULW 机制已关闭（profile.features.contractInjector=false 或 GRIT_DISABLE=1）。"
      const existing = loadState(sid)
      if (!existing?.active) {
        const lu = await lastUserText(sid)
        if (!lu.includes(ULW_AUTH_TOKEN)) {
          log("a", `ENTER-REJECT s=${sid.slice(0, 8)}（上一条用户消息无授权标识）`)
          return `未进入 ULW：上一条用户消息不含授权标识。仅当用户执行过 /ulw（其命令文本含 ${ULW_AUTH_TOKEN}）时才应调用本工具；否则不要进入持续工作模式。`
        }
      }
      const state: UlwState = {
        ...(existing ?? newState(sid, dir)),
        active: true, objective: goal.trim().slice(0, 200),
        epoch: (existing?.epoch ?? 0) + 1, activatedAt: Date.now(),
        stopReason: null, pauseReason: null, totalInjections: 0,
      }
      const bc = buildContract()
      if ("error" in bc) {
        saveState(state)
        log("a", `CONTRACT-MISSING s=${sid.slice(0, 8)} err=${bc.error}`)
        return `已进入 ULW，但契约文件缺失：${bc.error}（无契约注入）。`
      }
      state.contractFingerprint = bc.fingerprint
      saveState(state)
      counters.set(sid, {
        ...getCtr(sid),
        consecutiveFailures: 0, stagnationCount: 0, awaitingProgress: false,
        // 契约注入本身就是一次"启动"：记下时间，避免紧接着又被续跑门推一把（冷却 5s）
        lastInjectedAt: Date.now(),
      })
      log("a", `ENTER s=${sid.slice(0, 8)} epoch=${state.epoch} fp=${bc.fingerprint} goal=${state.objective.slice(0, 30)}`)
      // 契约走「真消息」：ctx.session.prompt 会把这条文本落库（UI 上就是一条用户消息），
      // 下一轮及以后的请求一定能看到；工具结果只在当轮可见，压缩后就会丢。
      try {
        await ctx.session.prompt({ sessionID: sid, text: contractNotice(bc.text, state.objective) })
        log("a", `ENTER-INJECT s=${sid.slice(0, 8)} chars=${bc.text.length}`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log("a", `ENTER-INJECT-FAIL s=${sid.slice(0, 8)} err=${msg}`)
        // 注入失败是异常路径：把契约退回工具结果，至少本模式仍能生效（并如实说明）
        return [
          `已进入 ULW（目标：${state.objective || "（未指定）"}），但契约作为消息注入失败：${msg}`,
          "以下契约全文改由本条工具结果提供：",
          "",
          bc.text,
        ].join("\n")
      }
      return `已进入持续工作模式（ULW）。目标：${state.objective || "（未指定）"}。契约已作为一条提醒消息注入本会话，按它执行；完成时调用 ulw_exit 退出。`
    }

    /** 退出 ULW（模型调用 ulw_exit 或用户 /ulw-exit）。两条路径共用这一个函数：
     *  账本置停 + 留一个「待贴退出提醒」标记；具体提醒由下一次请求组装统一贴一次（见 context 钩子）。 */
    const exitUlw = (sid: string, reason: string): string => {
      const st = loadState(sid)
      cancelCountdown(sid)
      if (!st || !st.active) {
        log("a", `EXIT-NOOP s=${sid.slice(0, 8)} reason=${reason || "model"}`)
        return "当前不在 ULW 模式。"
      }
      saveState({ ...st, active: false, stopReason: "completed", pauseReason: null, exitNoticePending: true })
      log("a", `EXIT s=${sid.slice(0, 8)} reason=${reason || "model"}`)
      return "ULW 已退出：纪律契约自此不再生效。"
    }

    // ---- 启动自检 ----
    if (disabled) {
      log("c", "GRIT_DISABLE=1：机制全关，仅工具可用")
    } else {
      const ap = getActiveProfile()
      if (!ap) log("c", "WARN 无激活 profile（profiles/active 缺失）——机制按默认开")
      if (readText(join(contractsDir, "ulw.md")) === null) log("c", "WARN contracts/ulw.md 缺失——/ulw 将降级")
      const idx = readAgentsIndex(join(agentsDir, "index.json"))
      if (Object.keys(idx).length === 0) log("c", "WARN agents/index.json 缺失——profile 切换将不物化 agents 记录")
    }

    // ---- 配置读写（profile switch 写 agents 记录） ----
    /** 严格读 opencode.json：文件不存在 → 空对象（首次安装）；存在但解析失败（例如带注释/JSONC）
     *  → 返回错误，调用方必须中止，绝不把用户配置覆盖成"只剩 agents"的样子。 */
    const readConfigStrict = (): { ok: true; cfg: Record<string, any> } | { ok: false; error: string } => {
      let raw: string
      try {
        raw = readFileSync(cfgPath, "utf8")
      } catch {
        return { ok: true, cfg: {} }
      }
      try {
        return { ok: true, cfg: JSON.parse(raw) as Record<string, any> }
      } catch (e) {
        return { ok: false, error: `opencode.json 解析失败（可能有注释/JSONC）：${e instanceof Error ? e.message : String(e)}` }
      }
    }
    const writeAgentsRecords = (name: string): { ok: boolean; message: string } => {
      const index = readAgentsIndex(join(agentsDir, "index.json"))
      if (Object.keys(index).length === 0) return { ok: false, message: "agents/index.json 缺失" }
      const loaded = loadProfileByName(profilesDir, name)
      if (!loaded) return { ok: false, message: `profile 不存在：${name}` }
      const defaultPath = join(profilesDir, "default.json")
      const defaultProfile = existsSync(defaultPath) ? (JSON.parse(readFileSync(defaultPath, "utf8")) as Record<string, unknown>) : {}
      const { records, warnings } = buildAgentRecords({ index, profile: loaded.profile, defaultProfile })
      // 1) 严格读原文件：带注释/坏 JSON 一律中止（这一条是防数据损失的关键）
      const rc = readConfigStrict()
      if (!rc.ok) return { ok: false, message: `${rc.error}——已中止，未改动文件` }
      const cfg = rc.cfg
      const owned = [...Object.keys(records), ...REMOVED_AGENT_NAMES]
      for (const n of owned) if (cfg.agents && typeof cfg.agents === "object") delete cfg.agents[n]
      cfg.agents = { ...(cfg.agents ?? {}), ...records }
      // 2) 改前备份（单槽覆盖，留最近一次切换前的样子）
      const bakPath = `${cfgPath}.bak-switch`
      let backup: string | null = null
      try {
        backup = readFileSync(cfgPath, "utf8")
        writeFileSync(bakPath, backup, "utf8")
      } catch { backup = null }
      // 3) 原子写
      try {
        const tmp = `${cfgPath}.tmp`
        writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8")
        try { unlinkSync(cfgPath) } catch { /* 首次 */ }
        renameSync(tmp, cfgPath)
      } catch (e) {
        return { ok: false, message: `写 opencode.json 失败：${e instanceof Error ? e.message : String(e)}` }
      }
      // 4) 写后校验：能解析 且 每条记录的 model 与档一致；不通过就还原 + 报错
      try {
        const after = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, any>
        const bad = Object.keys(records).filter((n) => {
          const got = after?.agents?.[n]
          return !got || got.model !== records[n]?.model
        })
        if (bad.length > 0) throw new Error(`缺记录或 model 不符：${bad.join(", ")}`)
      } catch (e) {
        let restored = false
        if (backup !== null) {
          try {
            writeFileSync(cfgPath, backup, "utf8")
            restored = true
            log("c", `SWITCH-VERIFY-FAIL 已从备份还原 ${bakPath}`)
          } catch { /* 还原也失败 */ }
        }
        return { ok: false, message: `写后校验失败：${e instanceof Error ? e.message : String(e)}（${restored ? "已从备份还原" : "无备份可还原"}）` }
      }
      return { ok: true, message: `${Object.keys(records).length} 条 agents 记录${warnings.length ? `（告警 ${warnings.length}）` : ""}` }
    }

    // ---- prompt 钩子（哨兵 A + 打断判定） ----
    await ctx.session.hook("prompt", (event: any) => {
      try {
        const sid = event.sessionID as string
        currentSession = sid
        const text = typeof event.prompt?.text === "string" ? (event.prompt.text as string) : ""
        if (text === "") return
        const sentinel = matchSentinel(text)
        if (sentinel === SENTINEL_EXIT) {
          exitUlw(sid, "user")
          return
        }
        if (sentinel === SENTINEL_CONTINUE) return // 自己的续跑提示（防回声）
        // 插件自己注入的契约（进入 / 压缩后恢复）也是一条真消息：既不是用户插话、也不是退出暗号。
        if (isPluginInjectedText(text)) return
        const st = loadState(sid)
        if (!st) return
        if (st.active && st.stopReason === null) {
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

    // ---- context 钩子 ----
    // 注入分两条通道：
    //   · 稳定内容（角色纪律，不随会话变化）→ 系统提示词（同内容同位置 ⇒ 不影响前缀缓存）
    //   · 会话中触发的动态内容（激活标记 / 授权与退出提醒 / 压缩后契约恢复）→ 消息通道的带标签块（只追加尾部）
    const sysHas = (sys: any[], needle: string): boolean =>
      Array.isArray(sys) && sys.some((p) => typeof p?.text === "string" && p.text.includes(needle))

    await ctx.session.hook("context", (event: any) => {
      const agent = String(event.agent ?? "")
      // 角色纪律（稳定）→ 系统提示词
      try {
        const sys = event.system
        if (Array.isArray(sys) && AGENT_NAMES.includes(agent)) {
          const tag = `[GRIT:DISCIPLINE:${agent}]`
          if (!sysHas(sys, tag)) {
            const content = readDiscipline(agent)
            if (content) sys.push({ type: "text", text: disciplineBlock(agent, content) })
          }
        }
      } catch (e) {
        log("a", `纪律段注入失败开放：${e instanceof Error ? e.message : String(e)}`)
      }
      // 动态注入（会话中触发）→ 消息通道
      try {
        const msgs = event.messages as any[] | undefined
        if (!Array.isArray(msgs)) return
        // 只认真实 agent 回合：标题/压缩/generate 这类辅助请求不带 agent（见 v2 SessionTitle/SessionCompaction），
        // 给它们塞注入只会污染压缩输入与标题提示词。
        if (!AGENT_NAMES.includes(agent)) return
        const sid = String(event.sessionID ?? "")
        const mref = event.model as { providerID?: unknown; id?: unknown } | undefined
        if (mref && typeof mref.providerID === "string" && typeof mref.id === "string") {
          SHARED.lastModels.set(sid, { providerID: mref.providerID, modelID: mref.id })
        }
        const st = loadState(sid)
        const lu = lastUserTextOf(msgs)
        if (st && st.active && st.stopReason === null) {
          // 契约已在进入 / 压缩恢复时作为一条真消息注入（落库、历史里查得到），这里只贴每轮一行标记。
          if (!messagesContain(msgs, MARKER_TAG)) appendInject(msgs, markerLine(st.objective))
          // 兜底（正常路径走不到）：压缩事件没赶上、session.revert 回退、收件箱取消 → 历史里契约没了。
          // 只追加到本轮请求（不落库），所以加 60 秒节流，避免判据看不见契约时每轮重贴。
          if (!contractInHistory(msgs)) {
            const ctr = getCtr(sid)
            const now = Date.now()
            if (now - (ctr.contractRestoreAt ?? 0) > 60_000) {
              const bc = buildContract()
              if ("text" in bc) {
                appendInject(msgs, `<system-reminder>\n${bc.text}\n</system-reminder>`)
                ctr.contractRestoreAt = now
                log("a", `RESTORE-FALLBACK s=${sid.slice(0, 8)}`)
              }
            }
          }
        } else {
          // 「已退出」提醒由账本状态驱动：退出后第一次组装贴一次，随后清标记。
          // 不再依赖用户消息里是否还有 [GRIT:ULW:EXIT]（命令正文可能被折叠/改写，暗号不可靠）。
          if (st && st.stopReason !== null && st.exitNoticePending) {
            if (!messagesContain(msgs, EXITED_TAG)) appendInject(msgs, exitNoticeBlock())
            saveState({ ...st, exitNoticePending: false })
            log("a", `EXITED-NOTICE s=${sid.slice(0, 8)}`)
          }
          if (lu.includes(ULW_AUTH_TOKEN) && !messagesContain(msgs, ARMED_TAG)) {
            appendInject(msgs, `<system-reminder>${ARMED_TAG} 用户已请求持续工作模式：请立即调用 ulw_enter 工具进入，传入「用户最近一次提出的任务」作为目标（在最近几轮里定位，未必是最后一条消息；不要取更早的、更大范围的全局目标）。工具会把纪律契约作为一条提醒消息注入本会话，按其执行；完成时调用 ulw_exit 退出。</system-reminder>`)
          }
        }
      } catch (e) {
        log("a", `动态注入失败开放：${e instanceof Error ? e.message : String(e)}`)
      }
    })

    // ---- 5 工具注册 ----
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
                return { content: contextLine(tokens, await limitFor(sid)) ?? "（占用率计算不可用）" }
              }
              case "system_time":
                return { content: systemTimeLine() }
              case "clone_repo": {
                const url = String(input?.url ?? "").trim()
                if (!url) return { content: "clone_repo 需要 url 参数（Git 仓库地址）。" }
                const full = /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}.git` : url
                const ref = typeof input?.ref === "string" ? input.ref.trim() : undefined
                // 参数注入防护：git 会把以 - 开头的参数当选项（例如 ref="-c core.pager=cat"）
                if (!isSafeGitUrl(full)) return { content: "clone_repo：url 不合法（不能以 - 开头、不能含空白）。" }
                if (ref !== undefined && !isSafeGitRef(ref)) return { content: "clone_repo：ref 只允许字母/数字/._/-，且不能以 - 开头。" }
                const safe = full.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
                const cacheRoot = process.env.CLONE_CACHE ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "C:/Users/Administrator", ".cache", "opencode", "clone")
                const dest = join(cacheRoot, safe)
                if (existsSync(dest)) {
                  if (ref) {
                    const r = spawnSync("git", ["-C", dest, "checkout", "--detach", ref], { encoding: "utf8", timeout: 120_000 })
                    if (r.status !== 0) return { content: `已存在缓存但 checkout ${ref} 失败：${r.stderr.slice(0, 300)}` }
                  }
                  return { content: `已克隆缓存：${dest}\n（重新 checkout ${ref ?? "默认"} 完成）` }
                }
                mkdirSync(cacheRoot, { recursive: true })
                const gitArgs = ["clone", "--depth", "1"]
                if (ref) gitArgs.push("--branch", ref)
                gitArgs.push("--", full, dest)
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
                  const active = getActiveProfile()?.name
                  const rows = names.map((n) => {
                    try {
                      const p = JSON.parse(readFileSync(join(profilesDir, `${n}.json`), "utf8")) as Record<string, unknown>
                      return `${n === active ? "*" : " "} ${n} — ${String(p.description ?? "")}`
                    } catch {
                      return `  ${n} —（解析失败）`
                    }
                  })
                  return { content: `可用 profile（* = 当前激活）：\n${rows.join("\n")}` }
                }
                if (action === "show") {
                  const ap = getActiveProfile()
                  if (!ap) return { content: "当前无激活 profile（profiles/active 缺失）。" }
                  return { content: `当前 profile：${ap.name}\n热生效：features 开关与阈值\n自动热生效（~3s）：model、permissions（agents 记录被自动重载，无需重启）\n注意：当前会话已选模型不变；下一次子代理或新会话起用新模型` }
                }
                const name = String(input?.name ?? "").trim()
                if (!name) return { content: "switch 需要 name 参数。" }
                const loaded = loadProfileByName(profilesDir, name)
                if (!loaded) return { content: `profile 不存在：${name}（用 action=list 查看可用项）` }
                const vr = validateProfile(loaded.profile, { expectedName: name })
                if (!vr.ok) return { content: `profile 校验失败：${vr.errors.join("；")}` }
                // 先写 agents 记录（带备份与写后校验）；只有成功才动 active 指针，避免"指针换了、配置没写成"
                const wr = writeAgentsRecords(name)
                if (!wr.ok) {
                  log("c", `SWITCH profile=${name} fail ${wr.message}`)
                  return { content: `切换失败：${wr.message}\n未改动 profiles/active（仍是原档），当前会话不受影响。` }
                }
                const tmp = join(profilesDir, "active.tmp")
                writeFileSync(tmp, `${name}\n`, "utf8")
                try { unlinkSync(join(profilesDir, "active")) } catch { /* 首次 */ }
                renameSync(tmp, join(profilesDir, "active"))
                profileCache = null
                log("c", `SWITCH profile=${name} ok ${wr.message}`)
                return { content: `已切换到 profile：${name}。已更新 ${wr.message}。\n立即生效：机制开关与阈值。\n自动热生效（~3s，无需重启）：模型映射、permissions。\n注意：当前会话已选模型不变；下一次子代理或新会话起用新模型。` }
              }
              case "ulw_enter":
                return { content: await enterUlw(sid, directory, String(input?.goal ?? "")) }
              case "ulw_exit":
                return { content: exitUlw(sid, String(input?.reason ?? "model")) }
              default:
                return { content: `未知工具：${def.name}` }
            }
          },
        })
      }
    })

    // ---- 压缩恢复：压缩完成事件里把契约重新作为一条真消息注入 ----
    // 恢复只在这里做：context 钩子只允许改消息数组，不能发消息；而且压缩后"历史里找不到契约"这个判据
    // 已经不再需要（契约本身是一条落库的 user 消息）。事件会分发给每个插件实例 → 用 SHARED 时间戳去重。
    const restoreAfterCompact = async (sid: string): Promise<void> => {
      const now = Date.now()
      const st = loadState(sid)
      if (!st || !st.active || st.stopReason !== null) {
        log("a", `COMPACTED s=${sid.slice(0, 8)} 账本未激活，不恢复契约`)
        return
      }
      const last = SHARED.lastCompacted.get(sid) ?? 0
      if (now - last < 5000) {
        log("a", `COMPACTED-SKIP s=${sid.slice(0, 8)} reason=dedupe`)
        return
      }
      SHARED.lastCompacted.set(sid, now)
      const bc = buildContract()
      if ("error" in bc) {
        log("a", `COMPACTED s=${sid.slice(0, 8)} 契约缺失：${bc.error}`)
        return
      }
      try {
        await ctx.session.prompt({ sessionID: sid, text: contractNotice(bc.text, st.objective) })
        // 刚发过一条真消息，别让续跑门紧接着再推一把
        getCtr(sid).lastInjectedAt = Date.now()
        log("a", `COMPACT-RESTORE s=${sid.slice(0, 8)} epoch=${st.epoch}`)
      } catch (e) {
        log("a", `COMPACT-RESTORE-FAIL s=${sid.slice(0, 8)} err=${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // ---- 事件订阅（机制 B/D 数据源） ----
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const type = String((ev as any)?.type ?? "")
            const data = ((ev as any)?.data ?? (ev as any)?.properties ?? {}) as Record<string, unknown>
            const sid = typeof data.sessionID === "string" ? data.sessionID : undefined
            if (sid) currentSession = sid
            // 上下文占用率的**分子只取「单步」用量**——这是照 OpenCode 官方实现来的：
            // 官方（cli 内 JS）在 session.step.ended 时用 tokens.input+output+reasoning+cache.read+cache.write
            // 除以 provider.models[modelID].limit.context 得到百分比（TUI 里那个数）。
            // 必须注意：session.usage.updated 给的是**会话累计**值，拿它当"当前上下文"会算出上千个百分点
            // （实测 19.1M/1.0M = 1905%），会把续跑门第 7 条（≥85% 跳过）永久触发、自动续跑彻底失效。
            if (type === "session.step.ended") {
              if (sid && data.tokens) {
                const snap = toSnapshot(data.tokens)
                if (snap) lastTokens.set(sid, snap)
              }
            }
            // v1 遗留事件：v2 的 event-manifest 里没有 session.error，这段在 v2 下不会触发，保留兼容
            if (type === "session.error") {
              if (!sid) continue
              const st = loadState(sid)
              if (!st || !st.active || st.stopReason !== null) continue
              const cls = classifyEvent({ errorText: String(data.error ?? data.message ?? "") })
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
            // 压缩完成：契约可能被压掉，账本仍激活就重注入（fire-and-forget，别阻塞事件循环）。
            // 事件名必须是 session.compaction.ended：插件事件流走 @opencode/schema 的 ServerDefinitions，
            // 里面只有 compaction.started/delta/ended/failed；另一个 session.compacted（内部 Definitions 才有）
            // 到不了插件，用它等于死代码（且真被灌进来会让 OpenCodeEvent 解码失败、整条事件流中断）。
            if (type === "session.compaction.ended") {
              if (sid) void restoreAfterCompact(sid)
              continue
            }
            if (type === "session.execution.started") {
              if (sid) cancelCountdown(sid)
              continue
            }
            // 用户中止 / 关闭：**不进续跑**，进 abort 窗口并暂停
            if (type === "session.execution.interrupted") {
              if (!sid) continue
              const st = loadState(sid)
              if (!st || !st.active || st.stopReason !== null) continue
              cancelCountdown(sid)
              getCtr(sid).abortAt = Date.now()
              const reason = String(data.reason ?? "")
              if (reason === "shutdown") {
                saveState({ ...st, stopReason: "aborted", active: false, pauseReason: null })
                log("b", `STOP s=${sid.slice(0, 8)} reason=aborted(shutdown)`)
              } else {
                saveState({ ...st, pauseReason: "user-interruption" })
                log("b", `PAUSE s=${sid.slice(0, 8)} reason=interrupted:${reason || "?"}`)
              }
              continue
            }
            // 执行失败：abort / 上下文超限 → 停；其余计一次失败并交给续跑门（冷却 + 失败上限兜底）
            if (type === "session.execution.failed") {
              if (!sid) continue
              const st = loadState(sid)
              if (!st || !st.active || st.stopReason !== null) continue
              const cls = classifyEvent({ errorText: errorTextOf(data.error) })
              if (cls === "abort") {
                cancelCountdown(sid)
                getCtr(sid).abortAt = Date.now()
                saveState({ ...st, stopReason: "aborted", active: false, pauseReason: null })
                log("b", `STOP s=${sid.slice(0, 8)} reason=aborted`)
                continue
              }
              if (cls === "overflow") {
                cancelCountdown(sid)
                saveState({ ...st, stopReason: "context-overflow", active: false })
                log("b", `STOP s=${sid.slice(0, 8)} reason=context-overflow`)
                continue
              }
              getCtr(sid).consecutiveFailures += 1
              void handleIdle(sid)
              continue
            }
            // 续跑触发：执行边沿（session.idle 在 2.0.20 manifest 中存在，但本实现只认 succeeded，语义更明确）
            if (type === "session.execution.succeeded") {
              if (!sid) continue
              const st = loadState(sid)
              if (!st || !st.active || st.stopReason !== null) continue
              void handleIdle(sid)
              continue
            }
          } catch (e) {
            log("a", `event 处理失败开放：${e instanceof Error ? e.message : String(e)}`)
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) log("c", `event 流中断：${e instanceof Error ? e.message : String(e)}`)
      }
    })()

    SHARED.setups += 1
    log("c", `SETUP #${SHARED.setups}（同进程插件实例序号）`)
    if (!SHARED.startedLogged) {
      SHARED.startedLogged = true
      log("info", "grit 已启动（V2 插件运行时，DESIGN-v3）")
    }

    return () => {
      controller.abort()
      for (const t of countdownTimers.values()) clearTimeout(t)
      countdownTimers.clear()
    }
  },
})

const gritPlugin = Object.assign(gritDefinition, {
  AGENT_NAMES,
  DEFAULT_CONTINUATION,
  toSnapshot,
  contextOccupancy,
  contextLine,
  systemTimeLine,
  withHandoffMarker,
  leanHandoffSummary,
  matchSentinel,
  assembleContract,
  disciplineBlock,
  markerLine,
  continuationBlock,
  isPluginInjectedText,
  contractNotice,
  exitNoticeBlock,
  messageText,
  lastAssistantText,
  lastUserTextOf,
  messagesContain,
  deepMessageText,
  contractInHistory,
  errorTextOf,
  appendInject,
  responseFingerprint,
  maxToolRepeat,
  decideContinuation,
  classifyEvent,
  isSafeGitUrl,
  isSafeGitRef,
  TOOL_DEFS,
})

export default gritPlugin
