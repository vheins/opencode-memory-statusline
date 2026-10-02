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
 *   GET /api/health  -> daemon version
 *   GET /api/repos   -> per-repo aggregates (summed across every owner)
 *
 * `/api/stats` is deliberately NOT used: it filters `owner` strictly, and the
 * daemon's `/api/repos` records carry no owner, so an owner-scoped query for
 * a bare repo name returns zeros. `/api/repos` already aggregates every owner
 * into one row per repo, which is what "this repository" means to the user.
 *
 * Env overrides:
 *   LOCAL_MEMORY_API    base URL of the daemon (default http://127.0.0.1:3456)
 *   LOCAL_MEMORY_REPO   force repo scope
 */
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { execFile } from "node:child_process"
import { basename } from "node:path"

const PLUGIN_ID = "memory-statusline"
const PLUGIN_VERSION = "0.5.1"
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

/**
 * Candidate repo names for the current workspace, most specific first.
 *
 * The **directory name comes first**: it is what the user opened and what the
 * agent normally registers work under. The git remote is only a fallback — a
 * folder can carry a stale or reused remote (e.g. `odoo-stp/` still points at
 * `vheins/odoo-fleet.git`, whose row in the memory DB is a different, older
 * project). The caller then picks whichever candidate actually has a row.
 */
const repoCandidatesCache = new Map()
const repoCandidatesInFlight = new Map()

function directoryCandidate(directory) {
  if (!directory) return []
  const base = basename(directory)
  return base ? [base] : []
}

/**
 * Resolve candidates off the render path.
 *
 * The directory name is available synchronously; the git remote is only a
 * fallback, so it is fetched with async `execFile` (never `execFileSync`) and
 * memoized per directory. The synchronous return value is always the
 * directory-name candidate, so rendering never blocks on a git spawn; callers
 * that want the remote candidate `await` the promise, which resolves to the
 * full list and warms the cache for later sync reads.
 */
function resolveRepoCandidates(directory) {
  const forced = process.env.LOCAL_MEMORY_REPO
  if (forced) return { immediate: [forced], pending: Promise.resolve([forced]) }

  const immediate = directoryCandidate(directory)
  const cached = repoCandidatesCache.get(directory)
  if (cached) return { immediate: cached, pending: Promise.resolve(cached) }

  const pending =
    repoCandidatesInFlight.get(directory) ??
    new Promise((resolve) => {
      if (!directory) {
        resolve(immediate)
        return
      }
      execFile(
        "git",
        ["-C", directory, "remote", "get-url", "origin"],
        { encoding: "utf8", timeout: 2000, windowsHide: true },
        (err, stdout) => {
          const candidates = immediate.slice()
          if (!err && typeof stdout === "string") {
            const match = stdout.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
            if (match && !candidates.includes(match[2])) candidates.push(match[2])
          }
          repoCandidatesCache.set(directory, candidates)
          repoCandidatesInFlight.delete(directory)
          resolve(candidates)
        },
      )
    })

  repoCandidatesInFlight.set(directory, pending)
  return { immediate, pending }
}

async function request(path, signal) {
  const res = await fetch(API_BASE + path, { signal, headers: { accept: "application/json" } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return body?.data?.attributes ?? body?.data ?? body
}

const SHARED_REFRESH_MS = REFRESH_MS
let sharedStore = null

/**
 * A single module-level store shared by both slots.
 *
 * Previously each slot mounted its own `createMemory`: two independent
 * `setInterval` loops, two initial `fetch` bursts, and a sync git spawn in each
 * render body. One store means one timer, one fetch cycle, and one candidate
 * resolution for the whole app. Ref-counted so the timer stops when the last
 * consumer unmounts.
 */
function acquireMemory(directory) {
  if (!sharedStore || sharedStore.directory !== directory) {
    if (sharedStore) sharedStore.dispose()
    sharedStore = createSharedStore(directory)
  }
  const store = sharedStore
  store.refs += 1
  let released = false
  return {
    data: store.data,
    error: store.error,
    dispose() {
      if (released) return
      released = true
      store.refs -= 1
      if (store.refs <= 0) {
        store.dispose()
        if (sharedStore === store) sharedStore = null
      }
    },
  }
}

function createSharedStore(directory) {
  const { immediate, pending } = resolveRepoCandidates(directory)
  const [data, setData] = createSignal()
  const [error, setError] = createSignal()
  const controller = new AbortController()
  let candidates = immediate
  let disposed = false

  void pending.then((list) => {
    if (!disposed) candidates = list
  })

  const load = async () => {
    try {
      const health = await request("/api/health", controller.signal)
      const repos = await request("/api/repos", controller.signal)
      const list = (Array.isArray(repos) ? repos : (repos?.data ?? [])).map((item) => item?.attributes ?? item)

      // Exact match only: a fuzzy match could silently show another project's
      // numbers, which is the very confusion this resolver exists to prevent.
      const repo = candidates.find((name) => list.some((item) => item?.repo === name))
      const entry = repo ? list.find((item) => item?.repo === repo) : undefined

      if (disposed) return
      setData({ health, repo, entry })
      setError()
    } catch (err) {
      if (disposed || controller.signal.aborted) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  void load()
  const timer = setInterval(() => void load(), SHARED_REFRESH_MS)
  return {
    directory,
    refs: 0,
    data,
    error,
    dispose() {
      disposed = true
      clearInterval(timer)
      controller.abort()
    },
  }
}

/* ------------------------------------------------------------------ sidebar */

function SidebarView(props) {
  const theme = () => props.api.theme.current
  const [open, setOpen] = createSignal(true)
  const store = acquireMemory(props.api.state.path.directory)
  onCleanup(() => store.dispose())
  const state = store

  const health = createMemo(() => state.data()?.health)
  const repo = createMemo(() => state.data()?.repo)
  const entry = createMemo(() => state.data()?.entry)

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
        <Show when={repo()}>
          <text fg={theme().text}>{`${RULE} ${repo()}`}</text>
        </Show>
        <Show when={entry()}>
          <text fg={theme().textMuted}>{`${fmt(entry().memoryCount)} mem`}</text>
          {/* Two short rows: never wraps, never clipped at the sidebar bottom. */}
          <box flexDirection="row" gap={1}>
            <text flexShrink={0} fg={theme().warning}>
              {DOT}
            </text>
            <text fg={theme().text} wrapMode="none">
              {`${fmt(entry().backlogCount)} backlog ${BULLET} ${fmt(entry().pendingCount)} pending`}
            </text>
          </box>
          <box flexDirection="row" gap={1}>
            <text flexShrink={0} fg={theme().accent}>
              {DOT}
            </text>
            <text fg={theme().textMuted} wrapMode="none">
              {`${fmt(entry().inProgressCount)} in-progress`}
            </text>
          </box>
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

  const store = acquireMemory(props.api.state.path.directory)
  onCleanup(() => store.dispose())
  const state = store
  const entry = createMemo(() => state.data()?.entry)
  const repo = createMemo(() => state.data()?.repo)

  return (
    <Show when={collapsed()}>
      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2}>
        <Show when={entry()}>
          <box flexDirection="row" gap={1}>
            <text flexShrink={0} fg={theme().warning}>
              {DOT}
            </text>
            <text fg={theme().textMuted} wrapMode="none">
              {`${fmt(entry().backlogCount)} backlog ${BULLET} ${fmt(entry().pendingCount)} pending ${BULLET} ${fmt(
                entry().inProgressCount,
              )} in-progress`}
            </text>
          </box>
        </Show>
        <Show when={repo()}>
          <text fg={theme().textMuted} wrapMode="none">
            {repo()}
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
