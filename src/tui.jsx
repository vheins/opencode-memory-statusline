/**
 * opencode-memory-statusline — TUI sidebar + status-bar summary for
 * local-memory-mcp. Independent plugin; the subagent monitor lives in
 * opencode-asynchronous-agent.
 *
 * Two surfaces:
 *
 *   1. sidebar_content  → collapsible "Memory" section next to Context / MCP,
 *      showing the CURRENT repository only (memories + task pipeline).
 *      Task counts are split across short rows so they never wrap or clip.
 *   2. app_bottom       → compact one-line summary in the bottom status bar,
 *      shown ONLY when the sidebar is collapsed because the terminal is too
 *      narrow (OpenCode hides the sidebar at width <= 120).
 *
 * Data source — local-memory-mcp HTTP API (default http://127.0.0.1:3456):
 *   GET /api/health              -> daemon version
 *   GET /api/stats?owner=&repo=  -> repo-scoped memories + tasks
 *
 * Env overrides:
 *   LOCAL_MEMORY_API    base URL of the daemon (default http://127.0.0.1:3456)
 *   LOCAL_MEMORY_OWNER  force owner scope
 *   LOCAL_MEMORY_REPO   force repo scope
 */
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { execFileSync } from "node:child_process"
import { basename } from "node:path"

const PLUGIN_ID = "memory-statusline"
const PLUGIN_VERSION = "0.4.0"
const API_BASE = (process.env.LOCAL_MEMORY_API || "http://127.0.0.1:3456").replace(/\/+$/, "")
const REFRESH_MS = 15000
const SIDEBAR_MIN_WIDTH = 120

const nf = new Intl.NumberFormat("en-US")
const fmt = (value) => (typeof value === "number" && Number.isFinite(value) ? nf.format(value) : "0")

const BULLET = "\u00b7" // ·
const ARROW_DOWN = "\u25BC" // ▼
const ARROW_RIGHT = "\u25B6" // ▶
const DOT = "\u25CF" // ●
const RULE = "\u2500" // ─

function resolveScope(directory) {
  let owner
  let repo
  if (directory) {
    try {
      const url = execFileSync("git", ["-C", directory, "remote", "get-url", "origin"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
      if (match) {
        owner = match[1]
        repo = match[2]
      }
    } catch {
      // not a git repo / no remote — fall back to the directory name
    }
    if (!repo) repo = basename(directory)
  }
  return {
    owner: process.env.LOCAL_MEMORY_OWNER || owner,
    repo: process.env.LOCAL_MEMORY_REPO || repo,
  }
}

async function request(path, signal) {
  const res = await fetch(API_BASE + path, { signal, headers: { accept: "application/json" } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return body?.data?.attributes ?? body?.data ?? body
}

function createMemory(scope) {
  const [data, setData] = createSignal()
  const [error, setError] = createSignal()
  const controller = new AbortController()
  let disposed = false

  const load = async () => {
    try {
      const health = await request("/api/health", controller.signal)
      let scoped
      if (scope.repo) {
        const query = `owner=${encodeURIComponent(scope.owner ?? "")}&repo=${encodeURIComponent(scope.repo)}`
        scoped = await request(`/api/stats?${query}`, controller.signal)
      }
      if (disposed) return
      setData({ health, scoped })
      setError()
    } catch (err) {
      if (disposed || controller.signal.aborted) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  void load()
  const timer = setInterval(() => void load(), REFRESH_MS)
  onCleanup(() => {
    disposed = true
    clearInterval(timer)
    controller.abort()
  })

  return { data, error }
}

/* ------------------------------------------------------------------ sidebar */

function SidebarView(props) {
  const theme = () => props.api.theme.current
  const [open, setOpen] = createSignal(true)
  const scope = resolveScope(props.api.state.path.directory)
  const state = createMemory(scope)

  const health = createMemo(() => state.data()?.health)
  const scoped = createMemo(() => state.data()?.scoped)
  const tasks = createMemo(() => scoped()?.taskStats)

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
        <text fg={theme().text}>{open() ? ARROW_DOWN : ARROW_RIGHT}</text>
        <text fg={theme().text}>
          <b>Memory</b>
        </text>
        <Show when={health()}>
          <text fg={theme().textMuted}>{health().version ?? PLUGIN_VERSION}</text>
        </Show>
      </box>
      <Show when={open()}>
        <Show when={state.error()}>
          <text fg={theme().error} wrapMode="word">
            {`offline ${BULLET} ${state.error()}`}
          </text>
        </Show>
        <Show when={scope.repo}>
          <text fg={theme().text}>{`${RULE} ${scope.repo}`}</text>
        </Show>
        <Show when={scoped()}>
          <text fg={theme().textMuted}>{`${fmt(scoped().total)} mem`}</text>
        </Show>
        <Show when={tasks()}>
          {(t) => (
            <>
              {/* Two short rows: never wraps, never clipped at the sidebar bottom. */}
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={theme().warning}>
                  {DOT}
                </text>
                <text fg={theme().text} wrapMode="none">
                  {`${fmt(t().backlog)} backlog ${BULLET} ${fmt(t().pending)} pending`}
                </text>
              </box>
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={theme().accent}>
                  {DOT}
                </text>
                <text fg={theme().textMuted} wrapMode="none">
                  {`${fmt(t().in_progress)} in-progress`}
                </text>
              </box>
            </>
          )}
        </Show>
      </Show>
    </box>
  )
}

/* --------------------------------------------------------------- status bar */

function StatusBarView(props) {
  const theme = () => props.api.theme.current
  const dims = useTerminalDimensions()
  const collapsed = createMemo(() => dims().width <= SIDEBAR_MIN_WIDTH)

  const scope = resolveScope(props.api.state.path.directory)
  const state = createMemory(scope)
  const tasks = createMemo(() => state.data()?.scoped?.taskStats)

  return (
    <Show when={collapsed()}>
      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2}>
        <Show when={tasks()}>
          {(t) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme().warning}>
                {DOT}
              </text>
              <text fg={theme().textMuted} wrapMode="none">
                {`${fmt(t().backlog)} backlog ${BULLET} ${fmt(t().pending)} pending ${BULLET} ${fmt(
                  t().in_progress,
                )} in-progress`}
              </text>
            </box>
          )}
        </Show>
        <Show when={scope.repo}>
          <text fg={theme().textMuted} wrapMode="none">
            {scope.repo}
          </text>
        </Show>
      </box>
    </Show>
  )
}

/* --------------------------------------------------------------- register */

const tui = async (api) => {
  api.slots.register({
    order: 250,
    slots: {
      sidebar_content() {
        return <SidebarView api={api} />
      },
      app_bottom() {
        return <StatusBarView api={api} />
      },
    },
  })
}

const plugin = { id: PLUGIN_ID, tui }

export default plugin
