// Integration harness for Task 7.
//
// Installs the goal plugin the SAME way it ships (proven in
// docs/superpowers/verification/2026-07-05-task7-live-proof.md): as a package dir
// `.opencode/plugin/goalpkg/` + a one-line entry `.opencode/plugin/goal.ts`, via
// scripts/install.sh — NOT a single-file copy. A file outside `.opencode/plugin/`
// cannot resolve `@opencode-ai/plugin` and is silently skipped; the pkg-dir layout
// resolves it via `.opencode/node_modules`.
//
// Then boots `opencode serve` against a temp project with a temp XDG_CONFIG_HOME,
// a temp GOAL_STATE_DIR (the deterministic turnCount/status oracle) and a temp
// GOAL_DEBUG_SINK (the inject/continue JSONL oracle), and drives it via the
// version-matched `opencode run --attach` path.
//
// Process hygiene: `opencode serve` survives SIGTERM and `opencode run` spawns
// session-worker children that orphan on a plain kill. So every process is spawned
// under `setsid` (its own process group) and torn down with a process-group SIGKILL,
// which reliably reaps the server and its workers. (Verified empirically.)
//
// Proven Task 0/7 facts baked in:
//  - `/goal` verbs dispatch ONLY as commands: use setGoal()/driveCommand()
//    (`--command goal`), a plain message does NOT dispatch the command.
//  - Once a goal is set, the loop is driven ENTIRELY server-side (the plugin's
//    in-process client). The external `opencode run --attach` client just injects
//    the command; a SET that starts a long loop is fire-and-forget (setGoal) + poll
//    the state file; quick verbs that stop/inspect (pause/clear) are awaited.
//  - `opencode run --attach` creates one session per call; reuse it on later calls
//    with `-s <id>` (needed for pause/clear). Session id is captured from the state
//    file the SET writes, or from the `--format json` event stream.
//  - continuations inherit the session model (the plugin omits body.model).
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import type { Goal } from "../src/state"

const REPO_ROOT = join(import.meta.dir, "..")
const INSTALL_SH = join(REPO_ROOT, "scripts", "install.sh")
const DEFAULT_MODEL = "google/gemini-2.5-flash-lite"

export type SinkLine = {
  kind: "inject" | "continue" | string
  sessionID: string
  turnCount?: number
  block?: string
  [k: string]: unknown
}

export type DriveOpts = {
  /** Reuse an existing session id instead of creating a new one (`-s <id>`). */
  session?: string
  /** Override the model for this call. */
  model?: string
  /** Hard cap before the client subprocess is killed (ms). */
  timeoutMs?: number
}

export type Harness = {
  baseUrl: string
  projDir: string
  stateDir: string
  sinkPath: string
  /**
   * Fire-and-forget `/goal <objective>` (starts the uncapped loop) and poll the
   * state file until the goal is written. Returns the session id. The streaming
   * client is tracked and killed on stop(); the server keeps looping autonomously.
   */
  setGoal: (objective: string, opts?: DriveOpts) => Promise<string>
  /** Dispatch `/goal <args>` and await the (short-lived) client. Returns the session id. */
  driveCommand: (name: string, args: string, opts?: DriveOpts) => Promise<string>
  /** Send a plain user message (does NOT dispatch commands). Returns the session id. */
  driveMessage: (text: string, opts?: DriveOpts) => Promise<string>
  /** Read the goal state file for a session (the turnCount/status oracle). */
  stateFor: (sessionID: string) => Goal | undefined
  /** Parsed JSONL sink lines, optionally filtered to one session. */
  sinkLines: (sessionID?: string) => SinkLine[]
  /** Session ids of every state file currently present (newest first). */
  stateSessions: () => string[]
  stop: () => void
}

export type StartOpts = {
  port?: number
  model?: string
  env?: Record<string, string>
  /** Max ms to wait for "server listening" (first boot installs plugin deps). */
  bootTimeoutMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Reap a setsid-spawned process and its whole group (server + session workers).
function groupKill(p: Subprocess): void {
  const pid = p.pid
  if (typeof pid === "number") {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      /* group already gone */
    }
  }
  try {
    p.kill(9)
  } catch {
    /* ignore */
  }
}

export async function startServer(opts: StartOpts = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "goal-int-"))
  const projDir = join(root, "proj")
  const cfgDir = join(root, "cfg")
  const stateDir = join(root, "state")
  const sinkPath = join(root, "sink.jsonl")
  const serverLog = join(root, "server.log")

  mkdirSync(projDir, { recursive: true })
  mkdirSync(join(cfgDir, "opencode"), { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(sinkPath, "")
  writeFileSync(
    join(cfgDir, "opencode", "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
  )

  // Install the plugin exactly as it ships (pkg-dir + entry), via the real installer.
  const install = spawnSync("bash", [INSTALL_SH, projDir], { encoding: "utf8" })
  if (install.status !== 0) {
    throw new Error(`install.sh failed (${install.status}):\n${install.stdout}\n${install.stderr}`)
  }

  const port = opts.port ?? 39900 + Math.floor(Math.random() * 90)
  const baseUrl = `http://127.0.0.1:${port}`
  const model = opts.model ?? DEFAULT_MODEL
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: cfgDir,
    GOAL_STATE_DIR: stateDir,
    GOAL_DEBUG_SINK: sinkPath,
    ...(opts.env ?? {}),
  }

  // setsid => the server leads its own process group, so groupKill reaps its workers.
  const server = Bun.spawn(["setsid", "opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: projDir,
    env,
    stdout: Bun.file(serverLog),
    stderr: Bun.file(serverLog),
  })

  const clients: Subprocess[] = []

  const deadline = Date.now() + (opts.bootTimeoutMs ?? 45_000)
  let listening = false
  while (Date.now() < deadline) {
    await sleep(300)
    if (existsSync(serverLog) && readFileSync(serverLog, "utf8").includes("server listening")) {
      listening = true
      break
    }
  }
  if (!listening) {
    groupKill(server)
    const log = existsSync(serverLog) ? readFileSync(serverLog, "utf8") : "(no log)"
    throw new Error(`opencode serve never listened within timeout.\n${log}`)
  }

  const sessionFlag = (o?: DriveOpts): string[] => (o?.session ? ["-s", o.session] : [])

  const stateSessions = (): string[] =>
    existsSync(stateDir)
      ? readdirSync(stateDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => ({ id: f.replace(/\.json$/, ""), m: statSync(join(stateDir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)
          .map((e) => e.id)
      : []

  // Await a short-lived client (pause/clear/message), capturing its session id.
  const runAwaited = async (extra: string[], o?: DriveOpts): Promise<string> => {
    const model_ = o?.model ?? model
    const argv = ["run", "--attach", baseUrl, "-m", model_, "--format", "json", ...sessionFlag(o), ...extra]
    const p = Bun.spawn(["setsid", "opencode", ...argv], { cwd: projDir, env, stdout: "pipe", stderr: "pipe" })
    clients.push(p)
    let timedOut = false
    const killer = setTimeout(() => {
      timedOut = true
      groupKill(p)
    }, o?.timeoutMs ?? 35_000)
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    await p.exited
    clearTimeout(killer)
    if (!timedOut) groupKill(p) // reap the session-worker child even on clean exit
    const match = (out + "\n" + err).match(/ses_[A-Za-z0-9]+/)
    return match ? match[0] : (stateSessions()[0] ?? "")
  }

  return {
    baseUrl,
    projDir,
    stateDir,
    sinkPath,

    setGoal: async (objective, o) => {
      const before = new Set(stateSessions())
      const model_ = o?.model ?? model
      const argv = ["run", "--attach", baseUrl, "-m", model_, "--format", "json", ...sessionFlag(o), "--command", "goal", objective]
      // Fire-and-forget: the client only injects the command; the SERVER drives the
      // loop. stdout/stderr ignored so an unread pipe never backpressures the turn.
      const p = Bun.spawn(["setsid", "opencode", ...argv], { cwd: projDir, env, stdout: "ignore", stderr: "ignore" })
      clients.push(p)
      // Poll the state file the SET writes synchronously in command.execute.before.
      const deadline_ = Date.now() + (o?.timeoutMs ?? 45_000)
      while (Date.now() < deadline_) {
        const fresh = stateSessions().filter((s) => !before.has(s))
        if (fresh.length > 0) return fresh[0]!
        if (o?.session && stateSessions().includes(o.session)) return o.session
        await sleep(500)
      }
      throw new Error("setGoal: goal state file never appeared within timeout")
    },

    driveCommand: (name, args, o) => runAwaited(["--command", name, args], o),
    driveMessage: (text, o) => runAwaited([text], o),

    stateFor: (sessionID) => {
      const path = join(stateDir, `${sessionID}.json`)
      if (!existsSync(path)) return undefined
      try {
        return JSON.parse(readFileSync(path, "utf8")) as Goal
      } catch {
        return undefined
      }
    },

    sinkLines: (sessionID) => {
      if (!existsSync(sinkPath)) return []
      const lines = readFileSync(sinkPath, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
      const parsed: SinkLine[] = []
      for (const l of lines) {
        try {
          parsed.push(JSON.parse(l) as SinkLine)
        } catch {
          /* skip partial last line */
        }
      }
      return sessionID ? parsed.filter((p) => p.sessionID === sessionID) : parsed
    },

    stateSessions,

    stop: () => {
      for (const c of clients) groupKill(c)
      groupKill(server)
    },
  }
}
