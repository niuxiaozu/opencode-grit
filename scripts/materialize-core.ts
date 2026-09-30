/**
 * materialize-core — profile → 部署版 agent md 的物化纯函数核（唯一定义点）。
 * 被 plugins/grit.ts（bun）、scripts/materialize.mjs 与 scripts/install.mjs（node）、
 * harness（node）三方共用。同步 IO、确定性输出：同输入 ⇒ 同字节。
 *
 * 设计规格：docs/DESIGN.md §8.4。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, renameSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const MODEL_RE = /^[^\s/]+\/[^\s/]+$/

/** profile JSON 校验（DESIGN §8.1）。未知字段 → warning 不拒收。 */
export function validateProfile(
  obj: unknown,
  opts: { expectedName?: string; validCalibrations: string[] },
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
  if (typeof p.calibration !== "string" || !opts.validCalibrations.includes(p.calibration)) {
    errors.push(`calibration(${String(p.calibration)}) 必须是以下之一：${opts.validCalibrations.join(", ")}`)
  }
  if (p.model !== undefined && p.model !== null) {
    if (typeof p.model !== "object") errors.push("model 必须是对象")
    else {
      for (const [k, v] of Object.entries(p.model as Record<string, unknown>)) {
        if (typeof v !== "string" || !MODEL_RE.test(v)) errors.push(`model.${k}(${String(v)}) 必须是 provider/model 格式`)
      }
    }
  }
  if (p.params !== undefined && p.params !== null && typeof p.params !== "object") errors.push("params 必须是对象")
  if (p.promptVariants !== undefined && p.promptVariants !== null && typeof p.promptVariants !== "object") {
    errors.push("promptVariants 必须是对象")
  }
  if (p.permissions !== undefined && p.permissions !== null && typeof p.permissions !== "object") {
    errors.push("permissions 必须是对象")
  }
  const tc = p.features as Record<string, unknown> | undefined
  if (tc !== undefined && tc !== null && typeof tc !== "object") errors.push("features 必须是对象")
  const KNOWN = ["name", "description", "model", "calibration", "promptVariants", "params", "permissions", "features"]
  for (const k of Object.keys(p)) if (!KNOWN.includes(k)) warnings.push(`未知字段 ${k}（忽略）`)
  return { ok: errors.length === 0, errors, warnings }
}

/** 极简 YAML 序列化：对象/字符串/数组（标量）。字符串一律 JSON 引用，合法 YAML 且无歧义。 */
function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent)
  if (Array.isArray(value)) {
    return value.map((v) => `${pad}- ${JSON.stringify(v)}`).join("\n")
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        const key = /^[\w.-]+$/.test(k) ? k : JSON.stringify(k)
        if (v !== null && typeof v === "object") return `${pad}${key}:\n${toYaml(v, indent + 1)}`
        return `${pad}${key}: ${JSON.stringify(v)}`
      })
      .join("\n")
  }
  return `${pad}${JSON.stringify(value)}`
}

export interface BaselineDoc {
  frontLines: string[] // frontmatter 内的原始行（不含 --- 围栏）
  body: string
}

/** 解析基线 md：--- 围栏 frontmatter + 正文。 */
export function parseBaseline(text: string): BaselineDoc {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { frontLines: [], body: text }
  return { frontLines: (m[1] ?? "").split(/\r?\n/), body: m[2] ?? "" }
}

export interface MaterializeOptions {
  baselineText: string
  agentName: string
  profile: Record<string, unknown>
  defaultProfile: Record<string, unknown>
  variantText: string | null
}

/** 单个代理物化：基线 + profile 的 model/permission 注入 + 变体追加 + 尾部物化标记。 */
export function materializeAgent(opts: MaterializeOptions): { content: string; warnings: string[] } {
  const warnings: string[] = []
  const { frontLines, body } = parseBaseline(opts.baselineText)
  const profile = opts.profile
  const defaults = opts.defaultProfile
  const modelMap = (profile.model ?? {}) as Record<string, string>
  const defaultModelMap = (defaults.model ?? {}) as Record<string, string>
  const model = modelMap[opts.agentName] ?? defaultModelMap[opts.agentName]
  if (!model) warnings.push(`${opts.agentName}: profile 与 default 均无 model，物化产物将不含 model 行（回退 opencode 全局默认）`)
  const permMap = (profile.permissions ?? {}) as Record<string, unknown>
  const perm = permMap[opts.agentName]
  const lines = ["---", ...frontLines]
  if (model) lines.push(`model: ${model}`)
  if (perm !== undefined) lines.push(`permission:\n${toYaml(perm, 1)}`)
  lines.push("---")
  let content = `${lines.join("\n")}\n\n${body.replace(/\s+$/, "")}\n`
  if (opts.variantText !== null) content += `\n${opts.variantText.replace(/\s+$/, "")}\n`
  const sha1 = createHash("sha1").update(content).digest("hex")
  content += `\n<!-- grit:materialized profile=${profile.name as string} sha1=${sha1} -->\n`
  return { content, warnings }
}

export interface MaterializeAllDeps {
  agentsSrcDir: string
  outDir: string
  profilesDir: string
  activeName: string
  variantsDir: string | null
  /** 测试注入：覆写文件读取（不传则读真实文件系统） */
  readFile?: (path: string) => string
  /** 测试注入：不传则真实写出 outDir */
  writeFile?: (path: string, content: string) => void
}

export interface MaterializeAllResult {
  written: { name: string; path: string; content: string; hasVariant: boolean }[]
  warnings: string[]
}

/** 全量物化：读 agents/*.md 基线 + active profile（缺键回退 default.json）+ variants，写 outDir。 */
export function materializeAll(deps: MaterializeAllDeps): MaterializeAllResult {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"))
  const warnings: string[] = []
  const defaultPath = join(deps.profilesDir, "default.json")
  const defaultProfile = existsSync(defaultPath)
    ? (JSON.parse(readFile(defaultPath)) as Record<string, unknown>)
    : ({} as Record<string, unknown>)
  const profilePath = join(deps.profilesDir, `${deps.activeName}.json`)
  if (!existsSync(profilePath)) throw new Error(`profile 不存在：${deps.activeName}（${profilePath}）`)
  const profile = JSON.parse(readFile(profilePath)) as Record<string, unknown>
  const vr = validateProfile(profile, { expectedName: deps.activeName, validCalibrations: ["default", "glm", "deepseek"] })
  warnings.push(...vr.warnings)
  if (!vr.ok) throw new Error(`profile 校验失败：${vr.errors.join("；")}`)
  const variantsMap = (profile.promptVariants ?? {}) as Record<string, string>
  const names = readdirSync(deps.agentsSrcDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
  mkdirSync(deps.outDir, { recursive: true })
  const written: MaterializeAllResult["written"] = []
  for (const name of names) {
    const baselineText = readFile(join(deps.agentsSrcDir, `${name}.md`))
    let variantText: string | null = null
    const variantName = variantsMap[name]
    if (variantName && deps.variantsDir) {
      const vp = join(deps.variantsDir, variantName, "agents", `${name}.md`)
      if (existsSync(vp)) variantText = readFile(vp)
      else warnings.push(`${name}: 变体文件缺失 ${vp}（跳过变体追加）`)
    }
    const { content, warnings: w } = materializeAgent({
      baselineText, agentName: name, profile, defaultProfile, variantText,
    })
    warnings.push(...w.map((x) => `${name}: ${x}`))
    const path = join(deps.outDir, `${name}.md`)
    if (deps.writeFile) deps.writeFile(path, content)
    else {
      const tmp = `${path}.tmp`
      writeFileSync(tmp, content, "utf8")
      try { unlinkSync(path) } catch { /* 首次不存在 */ }
      renameSync(tmp, path)
    }
    written.push({ name, path, content, hasVariant: variantText !== null })
  }
  return { written, warnings }
}

/** 读激活指针（纯文本一行）。指针不存在返回 null。 */
export function readActiveName(profilesDir: string): string | null {
  const p = join(profilesDir, "active")
  if (!existsSync(p)) return null
  const raw = readFileSync(p, "utf8").trim()
  return raw === "" ? null : raw
}

/** 加载激活 profile（缺 model 键回退 default.json）。返回 null = 无指针/文件缺失。 */
export function loadActiveProfile(profilesDir: string): { name: string; profile: Record<string, unknown>; warnings: string[] } | null {
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
    const merged: Record<string, string> = { ...dm, ...pm }
    profile.model = merged
  }
  return { name, profile, warnings }
}
