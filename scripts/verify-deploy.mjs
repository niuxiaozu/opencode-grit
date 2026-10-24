/**
 * 部署一致性校验：仓库 → 本机部署副本，逐字节比对 + 配置体检。
 *
 * 为什么需要它：install.mjs 是「复制」语义，改完仓库忘了装、或装了旧副本，
 * 都是"源码看着对、实际跑的却是旧代码"。这条把「仓库 vs 正在跑的」拉平成一道检查。
 *
 * 约定：
 *   · profiles/active 是运行时指针（当前 profile），install 刻意不覆盖 → 只报告不比对。
 *   · 镜像目录里多出来的文件（旧版本残留）也算问题。
 *
 * 用法：node scripts/verify-deploy.mjs   （或 npm run verify，含 tsc + smoke）
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { homedir } from "node:os"

const root = resolve(import.meta.dirname, "..")
const cfgDir = join(homedir(), ".config", "opencode")
const dataRoot = join(cfgDir, "grit")
const AGENT_NAMES = ["build", "explore", "general", "sage", "browse"]
const STALE_SEATS = ["plan", "factory", "expert"]
/** 运行时文件：install 有意不覆盖，故只报告、不比对。 */
const RUNTIME_SKIP = new Set(["profiles/active"])

const problems = []
const notes = []
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex")

function cmp(src, dst, label) {
  if (!existsSync(dst)) return problems.push(`缺失 ${label}`)
  if (sha(src) !== sha(dst)) problems.push(`不一致 ${label}`)
}

function mirror(dirName) {
  const src = join(root, dirName)
  if (!existsSync(src)) return
  const seen = new Set()
  const walk = (rel) => {
    const abs = join(src, rel)
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      const label = `${dirName}/${childRel}`
      if (RUNTIME_SKIP.has(label)) continue
      if (ent.isDirectory()) walk(childRel)
      else {
        seen.add(childRel)
        cmp(join(src, childRel), join(dataRoot, dirName, childRel), label)
      }
    }
  }
  walk("")
  // 反向：部署里多出来的（旧版本残留）
  const walkDeployed = (rel) => {
    const abs = join(dataRoot, dirName, rel)
    if (!existsSync(abs)) return
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      if (RUNTIME_SKIP.has(`${dirName}/${childRel}`)) continue
      if (ent.isDirectory()) walkDeployed(childRel)
      else if (!seen.has(childRel)) problems.push(`多余 ${dirName}/${childRel}`)
    }
  }
  walkDeployed("")
}

for (const d of ["contracts", "profiles", "variants"]) mirror(d)

cmp(join(root, "agents", "index.json"), join(dataRoot, "agents", "index.json"), "agents/index.json")
for (const f of readdirSync(join(root, "commands")).filter((n) => n.endsWith(".md"))) {
  cmp(join(root, "commands", f), join(cfgDir, "commands", f), `commands/${f}`)
}
cmp(join(root, "plugin", "grit.ts"), join(cfgDir, "plugins", "grit.ts"), "plugins/grit.ts")
cmp(join(root, "plugin", "tui.ts"), join(cfgDir, "plugins", "grit-tui", "tui.ts"), "plugins/grit-tui/tui.ts")
cmp(join(root, "scripts", "materialize-core.ts"), join(cfgDir, "scripts", "materialize-core.ts"), "scripts/materialize-core.ts")
cmp(join(root, "scripts", "grit.mjs"), join(cfgDir, "scripts", "grit.mjs"), "scripts/grit.mjs")

// ---- 配置体检：opencode.json 的 agents 记录 ----
const cfgPath = join(cfgDir, "opencode.json")
if (!existsSync(cfgPath)) problems.push("缺失 opencode.json")
else {
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"))
  } catch (e) {
    problems.push(`opencode.json 解析失败：${e.message}`)
  }
  if (cfg) {
    const names = Object.keys(cfg.agents ?? {})
    const missing = AGENT_NAMES.filter((n) => !names.includes(n))
    const extra = names.filter((n) => !AGENT_NAMES.includes(n))
    if (missing.length) problems.push(`agents 记录缺席位：${missing.join(", ")}`)
    if (extra.length) problems.push(`agents 记录多出身份：${extra.join(", ")}（不归 grit 管，不该有）`)
    const stale = STALE_SEATS.filter((n) => names.includes(n))
    if (stale.length) problems.push(`agents 记录残留已移除席位：${stale.join(", ")}`)
    const withSystem = names.filter((n) => cfg.agents?.[n]?.system)
    if (withSystem.length) problems.push(`agents 记录写了 system（会整段替换内置提示词）：${withSystem.join(", ")}`)
    if (cfg.agent) problems.push("opencode.json 仍有旧 `agent` 块")
    notes.push(`agents=${names.length}（${names.join(", ")}）`)
  }
}

// ---- 运行时指针（只报告）----
const activePath = join(dataRoot, "profiles", "active")
const activeProfile = existsSync(activePath) ? readFileSync(activePath, "utf8").trim() : "(缺失)"
if (activeProfile === "(缺失)") problems.push("缺失 profiles/active")
else notes.push(`active profile=${activeProfile}（运行时指针，不比对）`)

// ---- 结果 ----
for (const n of notes) console.log(`  · ${n}`)
if (problems.length === 0) {
  console.log(`✓ 部署一致：仓库与 ${cfgDir} 的副本逐字节相同，agents 记录干净`)
  process.exit(0)
}
for (const p of problems) console.log(`  ✗ ${p}`)
console.log(`✗ 部署校验失败：${problems.length} 处（改完仓库请跑 node scripts/install.mjs）`)
process.exit(1)
