/**
 * grit TUI 插件 — profile 切换的显著提示（OpenCode V2 CLI/TUI 插件）。
 *
 * 职责单一：只"提示"，不参与生效。OpenCode V2 会监视配置目录，profile 切换
 * 物化的 agents/*.md 会被自动热重载（~3s，无需重启）；本插件轮询 profiles/active，
 * 变化即弹模态 dialog.alert（必须点掉，比 toast 更显著）。
 *
 * 部署：~/.config/opencode/plugins/grit-tui/tui.ts（仅 TUI 入口，无 index.ts）。
 * 触发源：终端 `grit profile <name>` 与 会话内 `/profile` 工具都写同一个 active 指针。
 */
import { Plugin } from "@opencode/plugin/tui"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const pluginDir = dirname(fileURLToPath(import.meta.url))
// 部署于 <config>/plugins/grit-tui/ → 数据根 = <config>/grit
const dataRoot = process.env.GRIT_HOME ?? process.env.OMO_LITE_HOME ?? join(pluginDir, "..", "..", "grit")
const profilesDir = join(dataRoot, "profiles")
const activePath = join(profilesDir, "active")
const POLL_MS = 2000

function readActive(): string | null {
  try {
    if (!existsSync(activePath)) return null
    const raw = readFileSync(activePath, "utf8").trim()
    return raw === "" ? null : raw
  } catch {
    return null
  }
}

function describe(name: string): string {
  try {
    const p = JSON.parse(readFileSync(join(profilesDir, `${name}.json`), "utf8")) as { description?: unknown }
    return typeof p.description === "string" ? p.description : ""
  } catch {
    return ""
  }
}

export default Plugin.define({
  id: "grit.tui",
  // 只用到 ui.dialog.alert；TUI Context 类型引用 OpenTUI 前端类型，故此处用 any
  // （与 plugin/grit.ts 的 ctx:any 同款，避免把无关前端类型拖进本插件）。
  setup(context: any) {
    let lastSeen = readActive() // 记初值：启动不弹，仅"变化"时提示
    const timer = setInterval(() => {
      const name = readActive()
      if (!name || name === lastSeen) return
      const from = lastSeen
      lastSeen = name
      const desc = describe(name)
      void context.ui.dialog
        .alert({
          title: `grit · profile 已切换 → ${name}`,
          message:
            (from ? `原 profile：${from}\n` : "") +
            (desc ? `说明：${desc}\n\n` : "\n") +
            `模型映射 / permissions / 提示词变体已自动热生效（约 3s，无需重启）。\n` +
            `注意：当前会话已选模型不变，下一次子代理或新会话起用新模型。`,
        })
        .catch(() => { /* 提示失败不影响主流程 */ })
    }, POLL_MS)
    return () => clearInterval(timer)
  },
})
