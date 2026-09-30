#!/usr/bin/env node
/**
 * grit CLI — grit 套件终端命令行（零模型 API 消耗）。
 *
 * 用法：
 *   grit profile            列出全部 profile（* = 当前激活）
 *   grit profile <name>     切换激活 profile（写指针 + 重物化 agents/*.md）
 *
 * 任意终端可用（PATH 垫片 grit.cmd 由 install.mjs 写入 npm 全局 bin）。
 * 生效边界：params、features 开关/阈值、calibration ≤3s 热生效（运行中的
 * OpenCode 会话经插件 TTL 自动感知）；模型映射/permissions/变体需重启。
 *
 * 默认操作【部署版】数据根（~/.config/opencode）；开发仓库内调试用
 * --profiles/--src/--out 覆盖。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { validateProfile, materializeAll, readActiveName } from "./materialize-core.ts"

const arg = (f) => {
  const i = process.argv.indexOf(f)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const home = process.env.USERPROFILE ?? process.env.HOME
const cfgDir = join(home ?? "", ".config", "opencode")
const dataRoot = join(cfgDir, "grit")
const profilesDir = arg("--profiles") ?? join(dataRoot, "profiles")
const srcDir = arg("--src") ?? join(dataRoot, "agents")
const outDir = arg("--out") ?? join(cfgDir, "agents")
const variantsDir = join(dataRoot, "variants")

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
    } catch { /* 保持占位 */ }
    return `${n === active ? "*" : " "} ${n.padEnd(10)} ${desc}`
  })
  console.log(`可用 profile（* = 当前激活）：\n${rows.join("\n")}`)
  console.log(`\n切换：grit profile <名字>`)
  console.log(`立即生效：params、features 开关与阈值、calibration（运行中会话 ≤3s 自动感知）；需重启 OpenCode：模型映射、permissions、变体`)
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
  const vr = validateProfile(obj, { expectedName: name, validCalibrations: ["default", "glm", "deepseek"] })
  if (!vr.ok) die(`profile 校验失败：${vr.errors.join("；")}`)
  // 原子写指针（与插件 profile 工具同款）
  const tmp = join(profilesDir, "active.tmp")
  writeFileSync(tmp, `${name}\n`, "utf8")
  try { unlinkSync(join(profilesDir, "active")) } catch { /* 首次不存在 */ }
  renameSync(tmp, join(profilesDir, "active"))
  try {
    const res = materializeAll({ agentsSrcDir: srcDir, outDir, profilesDir, activeName: name, variantsDir })
    for (const w of res.warnings) console.warn(`! ${w}`)
    console.log(`✓ 已切换到 profile：${name}（重物化 ${res.written.length} 个代理 → ${outDir}）`)
  } catch (e) {
    die(`指针已切换但物化失败：${e instanceof Error ? e.message : String(e)}\n  稍后手跑：node "${join(cfgDir, "scripts", "materialize.mjs")}" --profile ${name}`)
  }
  console.log(`立即生效：params、features 开关与阈值、calibration（运行中会话 ≤3s 自动感知）。`)
  console.log(`需重启 OpenCode 生效：模型映射、permissions、提示词变体。`)
}

const sub = process.argv[2]
const name = process.argv[3]
if (sub === undefined || (sub === "profile" && !name)) listProfiles()
else if (sub === "profile" && name) switchProfile(name)
else if (sub === "--profiles" || sub === "--src" || sub === "--out") listProfiles() // 仅有调试旗标也走列表
else {
  console.log(`用法：\n  grit profile            列出全部 profile\n  grit profile <name>     切换激活 profile\n调试旗标：--profiles <dir> --src <dir> --out <dir>`)
  process.exit(sub === undefined ? 0 : 1)
}
