#!/usr/bin/env node
/**
 * grit CLI — grit 套件终端命令行（零模型 API 消耗）。
 *
 * 用法：
 *   grit profile            列出全部 profile（* = 当前激活）
 *   grit profile <name>     切换激活 profile（写指针 + 更新 opencode.json 的 agents 记录）
 *
 * 任意终端可用（PATH 垫片 grit.cmd 由 install.mjs 写入 npm 全局 bin）。
 * 生效边界（OpenCode V2）：features 开关/阈值 ≤3s 热生效；模型映射/permissions
 * 也自动热生效（~3s，V2 监视配置目录自动重载，无需重启）；仅"当前会话已选模型"不追溯。
 * 开发仓库内调试用 --profiles/--index/--config 覆盖。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"
import { validateProfile, buildAgentRecords, readAgentsIndex, readActiveName } from "./materialize-core.ts"

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const arg = (f) => {
  const i = process.argv.indexOf(f)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const home = process.env.USERPROFILE ?? process.env.HOME
const cfgDir = join(home ?? "", ".config", "opencode")
const dataRoot = join(cfgDir, "grit")
const profilesDir = arg("--profiles") ?? join(dataRoot, "profiles")
const indexPath = arg("--index") ?? join(dataRoot, "agents", "index.json")
const cfgPath = arg("--config") ?? join(cfgDir, "opencode.json")
/** 曾被 grit 托管、现已移除的席位（切换时一并清除，避免残留）。 */
const REMOVED_AGENT_NAMES = ["factory"]

const die = (m) => {
  console.error(`✗ ${m}`)
  process.exit(1)
}
const listNames = () => readdirSync(profilesDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))

function listProfiles() {
  if (!existsSync(profilesDir)) die(`未找到 profile 目录：${profilesDir}（先跑 install）`)
  const active = readActiveName(profilesDir)
  const rows = listNames().map((n) => {
    let desc = "（解析失败）"
    try {
      desc = String(JSON.parse(readFileSync(join(profilesDir, `${n}.json`), "utf8")).description ?? "")
    } catch { /* 占位 */ }
    return `${n === active ? "*" : " "} ${n.padEnd(10)} ${desc}`
  })
  console.log(`可用 profile（* = 当前激活）：\n${rows.join("\n")}`)
  console.log(`\n切换：grit profile <名字>`)
  console.log(`立即生效：features 开关与阈值；自动热生效（~3s，无需重启）：模型映射、permissions`)
}

function switchProfile(name) {
  if (!existsSync(profilesDir)) die(`未找到 profile 目录：${profilesDir}（先跑 install）`)
  const names = listNames()
  if (!names.includes(name)) die(`profile 不存在：${name}（可用：${names.join(", ")}）`)
  let obj
  try {
    obj = JSON.parse(readFileSync(join(profilesDir, `${name}.json`), "utf8"))
  } catch (e) {
    die(`profile JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const vr = validateProfile(obj, { expectedName: name })
  if (!vr.ok) die(`profile 校验失败：${vr.errors.join("；")}`)
  // 原子写指针
  const tmp = join(profilesDir, "active.tmp")
  writeFileSync(tmp, `${name}\n`, "utf8")
  try { unlinkSync(join(profilesDir, "active")) } catch { /* 首次 */ }
  renameSync(tmp, join(profilesDir, "active"))
  // 更新 opencode.json 的 agents 记录
  const index = readAgentsIndex(indexPath)
  if (Object.keys(index).length === 0) die(`agents/index.json 缺失：${indexPath}`)
  const defaultPath = join(profilesDir, "default.json")
  const defaultProfile = existsSync(defaultPath) ? JSON.parse(readFileSync(defaultPath, "utf8")) : {}
  const { records, warnings } = buildAgentRecords({ index, profile: obj, defaultProfile })
  for (const w of warnings) console.warn(`! ${w}`)
  // 严格读：带注释/坏 JSON 一律中止（防把用户配置覆盖成"只剩 agents"）
  let rawCfg = null
  let cfg = {}
  if (existsSync(cfgPath)) {
    rawCfg = readFileSync(cfgPath, "utf8")
    try {
      cfg = JSON.parse(rawCfg)
    } catch (e) {
      die(`opencode.json 解析失败（可能有注释/JSONC）：${e.message}——已中止，未改动文件`)
    }
  }
  for (const n of [...Object.keys(records), ...REMOVED_AGENT_NAMES]) {
    if (cfg.agents && typeof cfg.agents === "object") delete cfg.agents[n]
  }
  cfg.agents = { ...(cfg.agents ?? {}), ...records }
  // 改前备份（单槽）
  const bakPath = `${cfgPath}.bak-switch`
  if (rawCfg !== null) {
    try { writeFileSync(bakPath, rawCfg, "utf8") } catch (e) { console.warn(`  ! 备份失败：${e.message}`) }
  }
  const tmpCfg = `${cfgPath}.tmp`
  writeFileSync(tmpCfg, `${JSON.stringify(cfg, null, 2)}\n`, "utf8")
  try { unlinkSync(cfgPath) } catch { /* 首次 */ }
  renameSync(tmpCfg, cfgPath)
  // 写后校验：能解析 且 每条记录 model 与档一致；不通过 → 还原 + 报错
  try {
    const after = JSON.parse(readFileSync(cfgPath, "utf8"))
    const bad = Object.keys(records).filter((n) => !after?.agents?.[n] || after.agents[n].model !== records[n]?.model)
    if (bad.length > 0) throw new Error(`缺记录或 model 不符：${bad.join(", ")}`)
  } catch (e) {
    if (rawCfg !== null) {
      try { writeFileSync(cfgPath, rawCfg, "utf8"); die(`写后校验失败：${e.message}——已从备份还原 ${bakPath}`) } catch { /* 还原也失败 */ }
    }
    die(`写后校验失败：${e.message}（无备份可还原）`)
  }
  console.log(`✓ 已切换到 profile：${name}（更新 ${Object.keys(records).length} 条 agents 记录 → ${cfgPath}，改前备份 ${bakPath}）`)
  console.log(`立即生效：features 开关与阈值。`)
  console.log(`自动热生效（~3s，无需重启）：模型映射、permissions。`)
}

const sub = process.argv[2]
const name = process.argv[3]
if (sub === undefined || (sub === "profile" && !name)) listProfiles()
else if (sub === "profile" && name) switchProfile(name)
else if (sub === "--profiles" || sub === "--index" || sub === "--config") listProfiles()
else {
  console.log(`用法：\n  grit profile            列出全部 profile\n  grit profile <name>     切换激活 profile\n调试旗标：--profiles <dir> --index <path> --config <path>`)
  process.exit(sub === undefined ? 0 : 1)
}
