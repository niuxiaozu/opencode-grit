#!/usr/bin/env node
/**
 * materialize CLI：按 profile 物化部署版 agents/*.md。
 * 用法：node scripts/materialize.mjs [--profile <name>] [--src <dir>] [--out <dir>] [--profiles <dir>] [--variants <dir>]
 * 默认按仓库布局解析（src=../agents, profiles=../profiles, variants=../variants, out=$GRIT_AGENTS_DIR 或 ~/.config/opencode/agents）。
 */
import { readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { materializeAll } from "./materialize-core.ts"

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const home = process.env.USERPROFILE ?? process.env.HOME
const arg = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const src = arg("--src") ?? join(root, "agents")
const profilesDir = arg("--profiles") ?? join(root, "profiles")
const variantsDir = arg("--variants") ?? join(root, "variants")
const out = arg("--out") ?? process.env.GRIT_AGENTS_DIR ?? process.env.OMO_LITE_AGENTS_DIR ?? join(home ?? "", ".config", "opencode", "agents")
let profileName = arg("--profile")
if (!profileName) {
  const fsmod = await import("node:fs")
  const ap = join(profilesDir, "active")
  profileName = fsmod.existsSync(ap) ? fsmod.readFileSync(ap, "utf8").trim() : "default"
}

const names = readdirSync(src).filter((f) => f.endsWith(".md"))
if (names.length === 0) {
  console.error(`✗ 源目录无基线代理：${src}`)
  process.exit(1)
}
const res = materializeAll({ agentsSrcDir: src, outDir: out, profilesDir, activeName: profileName, variantsDir })
for (const w of res.warnings) console.warn(`! ${w}`)
for (const f of res.written) console.log(`  + ${f.path}${f.hasVariant ? " (含变体段)" : ""}`)
console.log(`✓ 已按 profile "${profileName}" 物化 ${res.written.length} 个代理 → ${out}`)
