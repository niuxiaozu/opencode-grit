#!/usr/bin/env node
/**
 * grit 安装/卸载（DESIGN-v3；前身 omo-lite——旧部署自动迁移）。零依赖，node scripts/install.mjs [uninstall]
 *
 * install：
 *   1. 备份 opencode.json → opencode.json.bak-grit（首次）
 *   2. 部署：contracts/profiles/variants/agents(index.json)/scripts → ~/.config/opencode/grit/
 *            commands → commands/；plugin → plugins/grit.ts + plugins/grit-tui/tui.ts
 *   3. 按 active profile 物化 **agents 配置记录** 写入 opencode.json（只写 mode/description/model/permissions，不写 system）
 *   4. 清理：删除旧 md 版 agents、旧 `agent` 块、旧 omo-lite 残留；提示重启
 *
 * uninstall：还原配置备份；删 commands/plugin/agents 记录；整删 ~/.config/opencode/grit/
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { buildAgentRecords, readAgentsIndex, loadProfileByName, readActiveName } from "./materialize-core.ts"

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const home = process.env.USERPROFILE ?? process.env.HOME
if (!home) {
  console.error("✗ 无法定位用户目录（USERPROFILE/HOME 均为空）")
  process.exit(1)
}
const cfgDir = join(home, ".config", "opencode")
const cfgPath = join(cfgDir, "opencode.json")
const bakPath = join(cfgDir, "opencode.json.bak-grit")
const dataRoot = join(cfgDir, "grit")
const legacyDataRoot = join(cfgDir, "omo-lite")

const AGENT_NAMES = ["build", "plan", "explore", "general", "sage", "browse"]
/** 曾被 grit 托管、现已移除的席位（安装时一并清除，避免残留）。 */
const REMOVED_AGENT_NAMES = ["factory", "plan", "expert"]
const COMMAND_FILES = ["ulw.md", "ulw-exit.md", "handoff.md", "profile.md"]
/** 旧命令名（改名后清理部署残留）。 */
const LEGACY_COMMAND_FILES = ["stop-continuation.md"]

/** 旧 omo-lite 部署 → grit 迁移（保留 active 指针/state/log；幂等）。 */
function migrateLegacy() {
  try {
    if (existsSync(join(cfgDir, "opencode.json.bak-omo-lite")) && !existsSync(bakPath)) {
      renameSync(join(cfgDir, "opencode.json.bak-omo-lite"), bakPath)
      console.log("  ~ 迁移备份：opencode.json.bak-omo-lite → bak-grit")
    }
    if (existsSync(legacyDataRoot) && !existsSync(dataRoot)) {
      renameSync(legacyDataRoot, dataRoot)
      console.log("  ~ 迁移数据根：omo-lite/ → grit/（active 指针与状态已保留）")
    }
  } catch (e) {
    console.warn(`  ! 迁移失败（可手动改名 ${legacyDataRoot} → ${dataRoot}）：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 清理旧 omo-lite 部署残留文件（旧插件/旧 CLI/旧垫片；存在才删）。 */
function cleanupLegacyArtifacts(shimDir) {
  const olds = [
    join(cfgDir, "plugins", "omo-lite.ts"),
    join(cfgDir, "scripts", "omo.mjs"),
  ]
  if (shimDir) olds.push(join(shimDir, "omo.cmd"))
  for (const p of olds) {
    if (!existsSync(p)) continue
    try {
      if (p.endsWith(".cmd")) {
        const body = readFileSync(p, "utf8")
        if (!body.includes("omo.mjs") && !body.includes("grit.mjs")) continue
      }
      unlinkSync(p)
      console.log(`  - 旧残留 ${p}`)
    } catch (e) {
      console.warn(`  ! 旧残留删除失败：${p}（${e instanceof Error ? e.message : String(e)}）`)
    }
  }
}

const die = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
const readConfig = () => {
  if (!existsSync(cfgPath)) die(`未找到 ${cfgPath}`)
  try {
    return JSON.parse(readFileSync(cfgPath, "utf8"))
  } catch (e) {
    die(`opencode.json 解析失败：${e.message}`)
  }
}
const writeConfig = (cfg) => writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8")
const copyDir = (srcDir, dstDir) => {
  mkdirSync(dstDir, { recursive: true })
  for (const f of readdirSync(srcDir, { withFileTypes: true })) {
    if (f.name === "active") continue // 不覆盖激活指针
    const s = join(srcDir, f.name)
    const d = join(dstDir, f.name)
    if (f.isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

/** 删除目标树里「源树已没有」的文件/目录（部署根陈旧残留，如移除的 factory 席、旧变体 agents/）。
 *  只对镜像式目录用；含运行时文件的目录（profiles 的 active、state、log）不要用。 */
function pruneMissing(srcDir, dstDir) {
  if (!existsSync(dstDir)) return
  const srcNames = new Set(existsSync(srcDir) ? readdirSync(srcDir) : [])
  for (const name of readdirSync(dstDir)) {
    const s = join(srcDir, name)
    const d = join(dstDir, name)
    if (!srcNames.has(name)) {
      try {
        rmSync(d, { recursive: true, force: true })
        console.log(`  - 陈旧残留 ${d}`)
      } catch (e) {
        console.warn(`  ! 陈旧残留删除失败：${d}（${e instanceof Error ? e.message : String(e)}）`)
      }
      continue
    }
    let isDir = false
    try { isDir = statSync(d).isDirectory() } catch { /* ignore */ }
    if (isDir) pruneMissing(s, d)
  }
}

/** 定位 npm 全局 bin。失败返回 null。 */
function resolveNpmBin() {
  try {
    const r = spawnSync("npm prefix -g", { encoding: "utf8", timeout: 30_000, shell: true })
    const out = r.status === 0 ? (r.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop() : ""
    if (out && existsSync(out)) return out
  } catch { /* npm 不可用 */ }
  const appData = process.env.APPDATA
  const fallback = appData ? join(appData, "npm") : ""
  return fallback && existsSync(fallback) ? fallback : null
}

function writeShim(scriptsOut) {
  const target = join(scriptsOut, "grit.mjs")
  const cmdBody = `@echo off\nnode "${target}" %*\n`
  const shimDir = resolveNpmBin()
  if (!shimDir) {
    console.warn(`  ! 未定位到 npm 全局 bin——跳过 grit 垫片（可手动执行：node ${target}）`)
    return
  }
  try {
    writeFileSync(join(shimDir, "grit.cmd"), cmdBody, "utf8")
    console.log(`  + ${join(shimDir, "grit.cmd")}（grit 命令垫片）`)
  } catch (e) {
    console.warn(`  ! 垫片写入失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function ensureHostDeps() {
  const hostPkg = join(cfgDir, "package.json")
  try {
    let pkg = {}
    if (existsSync(hostPkg)) {
      try { pkg = JSON.parse(readFileSync(hostPkg, "utf8")) } catch { pkg = {} }
    }
    pkg.dependencies = pkg.dependencies ?? {}
    if (!pkg.dependencies["@opencode/plugin"]) {
      pkg.name = pkg.name ?? "opencode-config-host"
      pkg.private = pkg.private ?? true
      pkg.dependencies["@opencode/plugin"] = "^2.0.20"
      writeFileSync(hostPkg, `${JSON.stringify(pkg, null, 2)}\n`, "utf8")
      console.log(`  + ${hostPkg} (declares @opencode/plugin)`)
    }
    if (existsSync(join(cfgDir, "node_modules", "@opencode", "plugin"))) {
      console.log("  = host dep @opencode/plugin ready")
      return
    }
    const hasBun = spawnSync("bun --version", { encoding: "utf8", timeout: 15_000, shell: true }).status === 0
    const cmd = hasBun ? "bun install" : "npm install --no-audit --no-fund"
    console.log(`  ... installing host deps in ${cfgDir} (${cmd})`)
    const r = spawnSync(cmd, { cwd: cfgDir, encoding: "utf8", timeout: 300_000, shell: true })
    if (r.status === 0 && existsSync(join(cfgDir, "node_modules", "@opencode", "plugin"))) {
      console.log("  + node_modules/@opencode/plugin installed")
    } else {
      console.warn(`  ! host dep install failed. Run manually: cd ${cfgDir} && ${cmd}`)
    }
  } catch (e) {
    console.warn(`  ! host dep setup error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 删除旧 md 版代理（迁移到 agents 记录）。 */
function removeLegacyAgentsMd() {
  for (const dir of [join(cfgDir, "agents"), join(dataRoot, "agents")]) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue
      try {
        unlinkSync(join(dir, f))
        console.log(`  - 旧 md 代理 ${join(dir, f).replace(cfgDir + "\\", "")}`)
      } catch { /* 占用等，忽略 */ }
    }
  }
}

function install() {
  migrateLegacy()
  if (!existsSync(bakPath)) {
    writeFileSync(bakPath, readFileSync(cfgPath, "utf8"), "utf8")
    console.log("  备份 opencode.json → opencode.json.bak-grit")
  } else {
    console.log("  备份已存在，保留：opencode.json.bak-grit")
  }

  // 数据根
  copyDir(join(root, "contracts"), join(dataRoot, "contracts"))
  copyDir(join(root, "profiles"), join(dataRoot, "profiles"))
  copyDir(join(root, "variants"), join(dataRoot, "variants"))
  mkdirSync(join(dataRoot, "agents"), { recursive: true })
  copyFileSync(join(root, "agents", "index.json"), join(dataRoot, "agents", "index.json"))
  // 清陈旧残留（源树已删而部署根还在的文件，如 factory.md / variants/strict/agents/）。
  // profiles 不做 prune：它的 active 指针不在源树里。
  pruneMissing(join(root, "contracts"), join(dataRoot, "contracts"))
  pruneMissing(join(root, "variants"), join(dataRoot, "variants"))
  pruneMissing(join(root, "agents"), join(dataRoot, "agents"))
  const scriptsOut = join(cfgDir, "scripts")
  mkdirSync(scriptsOut, { recursive: true })
  copyFileSync(join(root, "scripts", "materialize-core.ts"), join(scriptsOut, "materialize-core.ts"))
  copyFileSync(join(root, "scripts", "grit.mjs"), join(scriptsOut, "grit.mjs"))
  console.log("  + scripts/{materialize-core.ts,grit.mjs}")

  for (const f of COMMAND_FILES) {
    mkdirSync(join(cfgDir, "commands"), { recursive: true })
    copyFileSync(join(root, "commands", f), join(cfgDir, "commands", f))
    console.log(`  + commands/${f}`)
  }
  for (const f of LEGACY_COMMAND_FILES) {
    const p = join(cfgDir, "commands", f)
    if (!existsSync(p)) continue
    try { unlinkSync(p); console.log(`  - 旧命令 commands/${f}`) } catch { /* 占用等，忽略 */ }
  }
  mkdirSync(join(cfgDir, "plugins"), { recursive: true })
  copyFileSync(join(root, "plugin", "grit.ts"), join(cfgDir, "plugins", "grit.ts"))
  console.log("  + plugins/grit.ts")
  const tuiDir = join(cfgDir, "plugins", "grit-tui")
  mkdirSync(tuiDir, { recursive: true })
  copyFileSync(join(root, "plugin", "tui.ts"), join(tuiDir, "tui.ts"))
  console.log("  + plugins/grit-tui/tui.ts（TUI 提示插件）")
  ensureHostDeps()
  writeShim(scriptsOut)
  cleanupLegacyArtifacts(resolveNpmBin())
  removeLegacyAgentsMd()
  mkdirSync(join(dataRoot, "state"), { recursive: true })
  mkdirSync(join(dataRoot, "log"), { recursive: true })
  console.log(`  + ${join(dataRoot, "{agents,contracts,profiles,variants,scripts,state,log}")}`)

  // 激活指针（保留已有）
  const activePath = join(dataRoot, "profiles", "active")
  if (!existsSync(activePath)) {
    writeFileSync(activePath, "default\n", "utf8")
    console.log("  + profiles/active = default")
  }

  // 物化 agents 配置记录 → opencode.json
  const active = readActiveName(join(dataRoot, "profiles")) ?? "default"
  const index = readAgentsIndex(join(dataRoot, "agents", "index.json"))
  const loaded = loadProfileByName(join(dataRoot, "profiles"), active)
  if (!loaded) die(`profile 不存在：${active}`)
  const defaultPath = join(dataRoot, "profiles", "default.json")
  const defaultProfile = existsSync(defaultPath) ? JSON.parse(readFileSync(defaultPath, "utf8")) : {}
  const { records, warnings } = buildAgentRecords({ index, profile: loaded.profile, defaultProfile })
  for (const w of warnings) console.warn(`  ! ${w}`)
  const cfg = readConfig()
  if ("agent" in cfg) {
    delete cfg.agent
    console.log("opencode.json：已移除旧 `agent` 块")
  }
  for (const n of [...Object.keys(records), ...REMOVED_AGENT_NAMES]) {
    if (cfg.agents && typeof cfg.agents === "object") delete cfg.agents[n]
  }
  cfg.agents = { ...(cfg.agents ?? {}), ...records }
  writeConfig(cfg)
  console.log(`  + opencode.json：写入 ${Object.keys(records).length} 条 agents 记录（profile=${active}，不含 system）`)

  console.log("✓ grit 安装完成。agents 记录与插件由 OpenCode V2 自动热加载（~3s）；个别未生效项再重启。")
}

function uninstall() {
  if (existsSync(bakPath)) {
    writeFileSync(cfgPath, readFileSync(bakPath, "utf8"), "utf8")
    unlinkSync(bakPath)
    console.log("  opencode.json 已从 bak-grit 还原")
  } else if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"))
      if (cfg.agents && typeof cfg.agents === "object") {
        for (const n of AGENT_NAMES) delete cfg.agents[n]
        if (Object.keys(cfg.agents).length === 0) delete cfg.agents
        writeConfig(cfg)
        console.log("  opencode.json：已移除 grit agents 记录")
      }
    } catch { /* 忽略 */ }
  }
  for (const f of COMMAND_FILES) {
    const p = join(cfgDir, "commands", f)
    if (existsSync(p)) {
      try { unlinkSync(p); console.log(`  - commands/${f}`) } catch (e) { console.warn(`  ! 无法删除 ${p}：${e.message}`) }
    }
  }
  for (const name of ["grit.ts", "omo-lite.ts"]) {
    const plugin = join(cfgDir, "plugins", name)
    if (!existsSync(plugin)) continue
    try { unlinkSync(plugin); console.log(`  - plugins/${name}`) } catch (e) { console.warn(`  ! 无法删除 ${plugin}：${e.message}`) }
  }
  const tuiDir = join(cfgDir, "plugins", "grit-tui")
  if (existsSync(tuiDir)) {
    try { rmSync(tuiDir, { recursive: true, force: true }); console.log("  - plugins/grit-tui/") } catch (e) { console.warn(`  ! 无法删除 ${tuiDir}：${e.message}`) }
  }
  for (const n of AGENT_NAMES) {
    const p = join(cfgDir, "agents", `${n}.md`)
    if (existsSync(p)) { try { unlinkSync(p) } catch { /* ignore */ } }
  }
  for (const name of ["materialize-core.ts", "grit.mjs", "omo.mjs"]) {
    const p = join(cfgDir, "scripts", name)
    if (!existsSync(p)) continue
    try { unlinkSync(p); console.log(`  - scripts/${name}`) } catch { /* ignore */ }
  }
  const shimDir = resolveNpmBin()
  const shim = shimDir ? join(shimDir, "grit.cmd") : null
  if (shim && existsSync(shim)) {
    try {
      const body = readFileSync(shim, "utf8")
      if (body.includes("grit.mjs") || body.includes("omo.mjs")) { unlinkSync(shim); console.log(`  - ${shim}`) }
    } catch { console.warn("  ! 无法删除 grit.cmd 垫片（手动删）") }
  }
  if (existsSync(dataRoot)) {
    try { rmSync(dataRoot, { recursive: true, force: true }); console.log("  - grit/（数据根整目录）") } catch (e) { console.warn(`  ! 数据根删除失败：${e.message}`) }
  }
  console.log("✓ grit 已卸载。V2 自动热卸载；个别残留未清再重启。")
}

const cmd = process.argv[2] ?? "install"
if (cmd === "uninstall") uninstall()
else if (cmd === "install") install()
else die(`未知命令：${cmd}（用法：node scripts/install.mjs [install|uninstall]）`)
