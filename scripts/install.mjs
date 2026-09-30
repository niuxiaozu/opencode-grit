#!/usr/bin/env node
/**
 * grit 安装/卸载（DESIGN §13；前身 omo-lite——旧部署自动迁移）。零依赖，node scripts/install.mjs [uninstall]
 *
 * install：
 *   1. 备份 opencode.json → opencode.json.bak-grit（首次）；删除 agent 块（md 唯一来源）
 *   2. 部署：基线 agents → ~/.config/opencode/grit/agents/（物化源）
 *            commands → commands/；plugin → plugins/grit.ts
 *            contracts/profiles/variants/scripts(物化器) → ~/.config/opencode/grit/
 *   3. 写默认 active 指针（已存在则保留）→ 按物化核生成部署版 agents → ~/.config/opencode/agents/
 *   4. 清理旧 omo-lite 部署残留（旧插件/旧 CLI/旧垫片）；提示重启
 *
 * uninstall：还原配置备份；删 commands/plugin/物化 agents；整删 ~/.config/opencode/grit/
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { materializeAll, readActiveName } from "./materialize-core.ts"

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
        if (!body.includes("omo.mjs") && !body.includes("grit.mjs")) continue // 非我们的垫片，不动
      }
      unlinkSync(p)
      console.log(`  - 旧残留 ${p}`)
    } catch (e) {
      console.warn(`  ! 旧残留删除失败：${p}（${e instanceof Error ? e.message : String(e)}）`)
    }
  }
}

const AGENT_NAMES = ["build", "plan", "explore", "general", "expert", "factory"]
const COMMAND_FILES = ["ulw.md", "stop-continuation.md", "handoff.md", "profile.md"]
const DATA_DIRS = [
  ["contracts", join(root, "contracts")],
  ["profiles", join(root, "profiles")],
  ["variants", join(root, "variants")],
]

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
const writeConfig = (cfg) => writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8")
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

/** 定位 npm 全局 bin（nvm4w 下 prefix 可能是 C:\nvm4w\nodejs 而非 APPDATA\npm）。失败返回 null。 */
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

/** npm 全局 bin 写 grit.cmd 垫片 → 任意终端可用 `grit profile <name>`（零 API）。 */
function writeShim(scriptsOut) {
  const target = join(scriptsOut, "grit.mjs")
  const cmdBody = `@echo off\nnode "${target}" %*\n`
  const shimDir = resolveNpmBin()
  if (!shimDir) {
    console.warn("  ! 未定位到 npm 全局 bin——跳过 grit 垫片（可在任意终端手动执行：node " + target + "）")
    return
  }
  const shim = join(shimDir, "grit.cmd")
  try {
    writeFileSync(shim, cmdBody, "utf8")
    console.log(`  + ${shim}（grit 命令垫片）`)
  } catch (e) {
    console.warn(`  ! 垫片写入失败：${e instanceof Error ? e.message : String(e)}`)
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

  // 数据根：基线 agents（物化源）+ contracts/profiles/variants + 物化脚本
  copyDir(join(root, "agents"), join(dataRoot, "agents"))
  for (const [sub, src] of DATA_DIRS) copyDir(src, join(dataRoot, sub))
  const scriptsOut = join(cfgDir, "scripts")
  mkdirSync(scriptsOut, { recursive: true })
  copyFileSync(join(root, "scripts", "materialize-core.ts"), join(scriptsOut, "materialize-core.ts"))
  for (const f of COMMAND_FILES) {
    mkdirSync(join(cfgDir, "commands"), { recursive: true })
    copyFileSync(join(root, "commands", f), join(cfgDir, "commands", f))
    console.log(`  + commands/${f}`)
  }
  copyFileSync(join(root, "plugin", "grit.ts"), join(cfgDir, "plugins", "grit.ts"))
  console.log("  + plugins/grit.ts")
  copyFileSync(join(root, "scripts", "grit.mjs"), join(scriptsOut, "grit.mjs"))
  console.log("  + scripts/grit.mjs（grit CLI）")
  writeShim(scriptsOut)
  cleanupLegacyArtifacts(resolveNpmBin())
  mkdirSync(join(dataRoot, "state"), { recursive: true })
  mkdirSync(join(dataRoot, "log"), { recursive: true })
  console.log(`  + ${join(dataRoot, "{agents,contracts,profiles,variants,scripts,state,log}")}`)

  // 激活指针（保留已有）
  const activePath = join(dataRoot, "profiles", "active")
  if (!existsSync(activePath)) {
    writeFileSync(activePath, "default\n", "utf8")
    console.log("  + profiles/active = default")
  }

  // 物化部署版 agents
  const active = readActiveName(join(dataRoot, "profiles")) ?? "default"
  const res = materializeAll({
    agentsSrcDir: join(dataRoot, "agents"),
    outDir: join(cfgDir, "agents"),
    profilesDir: join(dataRoot, "profiles"),
    activeName: active,
    variantsDir: join(dataRoot, "variants"),
  })
  for (const w of res.warnings) console.warn(`  ! ${w}`)
  for (const f of res.written) console.log(`  + agents/${f.name}.md（profile=${active}${f.hasVariant ? "，含变体段" : ""}）`)

  const cfg = readConfig()
  if ("agent" in cfg) {
    delete cfg.agent
    writeConfig(cfg)
    console.log("opencode.json：已移除 `agent` 块（代理定义由物化产物提供）")
  } else {
    console.log("opencode.json：无 `agent` 块，无需修改")
  }
  console.log("✓ grit 安装完成。重启 OpenCode 生效。")
}

function uninstall() {
  if (existsSync(bakPath)) {
    writeFileSync(cfgPath, readFileSync(bakPath, "utf8"), "utf8")
    unlinkSync(bakPath)
    console.log("  opencode.json 已从 bak-grit 还原")
  } else {
    console.log("  无备份可还原（可能从未安装或已还原）")
  }
  for (const f of COMMAND_FILES) {
    const p = join(cfgDir, "commands", f)
    if (existsSync(p)) {
      try {
        unlinkSync(p)
        console.log(`  - commands/${f}`)
      } catch (e) {
        console.warn(`  ! 无法删除 ${p}：${e.message}（可能被占用，重启后手动删）`)
      }
    }
  }
  for (const name of ["grit.ts", "omo-lite.ts"]) {
    const plugin = join(cfgDir, "plugins", name)
    if (!existsSync(plugin)) continue
    try {
      unlinkSync(plugin)
      console.log(`  - plugins/${name}`)
    } catch (e) {
      console.warn(`  ! 无法删除 ${plugin}：${e.message}（重启后手动删）`)
    }
  }
  for (const n of AGENT_NAMES) {
    const p = join(cfgDir, "agents", `${n}.md`)
    if (existsSync(p)) {
      try {
        unlinkSync(p)
      } catch {
        console.warn(`  ! 无法删除 agents/${n}.md（重启后手动删）`)
      }
    }
  }
  const deployedCore = join(cfgDir, "scripts", "materialize-core.ts")
  if (existsSync(deployedCore)) {
    try {
      unlinkSync(deployedCore)
      console.log("  - scripts/materialize-core.ts")
    } catch {
      console.warn("  ! 无法删除 scripts/materialize-core.ts（重启后手动删）")
    }
  }
  for (const name of ["grit.mjs", "omo.mjs"]) {
    const deployedCli = join(cfgDir, "scripts", name)
    if (!existsSync(deployedCli)) continue
    try {
      unlinkSync(deployedCli)
      console.log(`  - scripts/${name}`)
    } catch {
      console.warn(`  ! 无法删除 scripts/${name}（重启后手动删）`)
    }
  }
  const shimDir = resolveNpmBin()
  const shim = shimDir ? join(shimDir, "grit.cmd") : null
  if (shim && existsSync(shim)) {
    try {
      const body = readFileSync(shim, "utf8")
      if (body.includes("grit.mjs") || body.includes("omo.mjs")) {
        unlinkSync(shim)
        console.log(`  - ${shim}`)
      }
    } catch {
      console.warn("  ! 无法删除 grit.cmd 垫片（手动删）")
    }
  }
  if (existsSync(dataRoot)) {
    try {
      rmSync(dataRoot, { recursive: true, force: true })
      console.log("  - omo-lite/（数据根整目录）")
    } catch (e) {
      console.warn(`  ! 数据根删除失败：${e.message}（重启后手动删 ${dataRoot}）`)
    }
  }
  console.log("✓ omo-lite 已卸载。重启 OpenCode 生效。")
}

const cmd = process.argv[2] ?? "install"
if (cmd === "uninstall") uninstall()
else if (cmd === "install") install()
else die(`未知命令：${cmd}（用法：node scripts/install.mjs [install|uninstall]）`)
