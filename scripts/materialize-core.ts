/**
 * materialize-core — profile → OpenCode v2 `agents` 配置记录 的物化纯函数核（唯一定义点）。
 * 被 plugins/grit.ts（bun 运行的插件）、scripts/{materialize.mjs,grit.mjs,install.mjs}（node）、
 * harness（node）四方共用。同步 IO、确定性输出：同输入 ⇒ 同记录。
 *
 * 设计依据：docs/DESIGN-v3.md §5/§8/§10。要点：载体是 opencode.json 的 `agents` 记录，
 * 只写 mode/description/model/permissions —— **绝不写 system**（写 system 会整段替换基础
 * 提示词并跳过工具指导；省略 system 才能保留内置 prompt，如 explore 的 PROMPT_EXPLORE）。
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const MODEL_RE = /^[^\s/]+\/[^\s/]+$/

/** profile JSON 校验。未知字段 → warning 不拒收。 */
export function validateProfile(
  obj: unknown,
  opts: { expectedName?: string },
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  if (!obj || typeof obj !== "object") {
    return { ok: false, errors: ["profile 不是对象"], warnings }
  }
  const p = obj as Record<string, unknown>
  if (typeof p.name !== "string" || p.name.trim() === "") errors.push("name 缺失或为空")
  if (opts.expectedName && p.name !== opts.expectedName) errors.push(`name(${p.name}) 与文件名(${opts.expectedName}) 不一致`)
  if (opts.expectedName && p.name === "active") errors.push("profile 名不能为 active（保留给指针文件）")
  if (p.model !== undefined && p.model !== null) {
    if (typeof p.model !== "object") errors.push("model 必须是对象")
    else {
      for (const [k, v] of Object.entries(p.model as Record<string, unknown>)) {
        if (typeof v !== "string" || !MODEL_RE.test(v)) errors.push(`model.${k}(${String(v)}) 必须是 provider/model 格式`)
      }
    }
  }
  if (p.promptVariants !== undefined && p.promptVariants !== null && typeof p.promptVariants !== "object") {
    errors.push("promptVariants 必须是对象")
  }
  if (p.permissions !== undefined && p.permissions !== null && typeof p.permissions !== "object") {
    errors.push("permissions 必须是对象")
  }
  const tc = p.features as Record<string, unknown> | undefined
  if (tc !== undefined && tc !== null && typeof tc !== "object") errors.push("features 必须是对象")
  const KNOWN = ["name", "description", "model", "promptVariants", "permissions", "features"]
  for (const k of Object.keys(p)) if (!KNOWN.includes(k)) warnings.push(`未知字段 ${k}（忽略）`)
  return { ok: errors.length === 0, errors, warnings }
}

// ===================== agent 记录物化（DESIGN §5/§8） =====================

export interface Perm {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/** agents/index.json 的一条席位定义（不含 model —— model 由 profile 提供）。 */
export interface AgentDef {
  mode: "subagent" | "primary" | "all"
  description: string
  /** 隐藏：不出现在任何用户可见清单，也不进"模型可见的子代理目录"（按名字仍可调用）。 */
  hidden?: boolean
  /** 结构性命名的权限（如 explore 放行 clone_repo）；最终追加在内置权限之后（后者覆盖前者）。 */
  permissions?: Perm[]
}

/** 物化产物：opencode.json `agents.<name>` 的单条记录。**不含 system**。 */
export interface AgentRecord {
  mode: string
  description: string
  hidden?: boolean
  model?: string
  permissions?: Perm[]
}

function isPerm(x: unknown): x is Perm {
  if (!x || typeof x !== "object") return false
  const p = x as Record<string, unknown>
  return (
    typeof p.action === "string" &&
    typeof p.resource === "string" &&
    (p.effect === "allow" || p.effect === "deny" || p.effect === "ask")
  )
}

/** 单席位物化：def（mode/description/基础 permissions）+ profile.model[name] + profile.permissions[name] 覆盖。 */
export function buildAgentRecord(
  name: string,
  def: AgentDef,
  profile: Record<string, unknown>,
  defaultProfile: Record<string, unknown>,
): { record: AgentRecord; warnings: string[] } {
  const warnings: string[] = []
  const modelMap = (profile.model ?? {}) as Record<string, string>
  const defaultModelMap = (defaultProfile.model ?? {}) as Record<string, string>
  const model = modelMap[name] ?? defaultModelMap[name]
  if (!model) warnings.push(`${name}: profile 与 default 均无 model（回退 opencode 全局默认）`)
  const perms: Perm[] = Array.isArray(def.permissions) ? [...def.permissions] : []
  const overrides = (profile.permissions ?? {}) as Record<string, unknown>
  const extra = overrides[name]
  if (Array.isArray(extra)) {
    for (const p of extra) if (isPerm(p)) perms.push(p)
  }
  const record: AgentRecord = { mode: def.mode, description: def.description }
  if (def.hidden) record.hidden = true
  if (model) record.model = model
  if (perms.length > 0) record.permissions = perms
  return { record, warnings }
}

/** 全量物化：index（席位定义）→ 记录表。缺 model 回退 defaultProfile。 */
export function buildAgentRecords(opts: {
  index: Record<string, AgentDef>
  profile: Record<string, unknown>
  defaultProfile: Record<string, unknown>
}): { records: Record<string, AgentRecord>; warnings: string[] } {
  const records: Record<string, AgentRecord> = {}
  const warnings: string[] = []
  for (const [name, def] of Object.entries(opts.index)) {
    const { record, warnings: w } = buildAgentRecord(name, def, opts.profile, opts.defaultProfile)
    records[name] = record
    warnings.push(...w)
  }
  return { records, warnings }
}

/** 读 agents/index.json（席位定义）。缺文件返回 {}。 */
export function readAgentsIndex(path: string): Record<string, AgentDef> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, AgentDef>
  } catch {
    return {}
  }
}

// ===================== profile 指针 =====================

/** 读激活指针（纯文本一行）。指针不存在返回 null。 */
export function readActiveName(profilesDir: string): string | null {
  const p = join(profilesDir, "active")
  if (!existsSync(p)) return null
  const raw = readFileSync(p, "utf8").trim()
  return raw === "" ? null : raw
}

/** 加载激活 profile（缺 model 键回退 default.json）。返回 null = 无指针/文件缺失。 */
export function loadActiveProfile(
  profilesDir: string,
): { name: string; profile: Record<string, unknown>; warnings: string[] } | null {
  const name = readActiveName(profilesDir)
  if (!name) return null
  const p = join(profilesDir, `${name}.json`)
  if (!existsSync(p)) return null
  const profile = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>
  const warnings: string[] = []
  const defaultPath = join(profilesDir, "default.json")
  if (existsSync(defaultPath)) {
    const dflt = JSON.parse(readFileSync(defaultPath, "utf8")) as Record<string, unknown>
    const pm = (profile.model ?? {}) as Record<string, string>
    const dm = (dflt.model ?? {}) as Record<string, string>
    profile.model = { ...dm, ...pm }
  }
  return { name, profile, warnings }
}

/** 读 profile 文件（含 default 合并），用于 profile 工具与脚本。返回 null = 文件缺失。 */
export function loadProfileByName(
  profilesDir: string,
  name: string,
): { name: string; profile: Record<string, unknown> } | null {
  const p = join(profilesDir, `${name}.json`)
  if (!existsSync(p)) return null
  const profile = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>
  const defaultPath = join(profilesDir, "default.json")
  if (existsSync(defaultPath)) {
    const dflt = JSON.parse(readFileSync(defaultPath, "utf8")) as Record<string, unknown>
    const pm = (profile.model ?? {}) as Record<string, string>
    const dm = (dflt.model ?? {}) as Record<string, string>
    profile.model = { ...dm, ...pm }
  }
  return { name, profile }
}
