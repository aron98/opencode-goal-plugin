// Integration harness: boots `opencode serve` with a plugin, drives it via
// `opencode run --attach` (the version-matched path proven in Task 0), and
// exposes command + message drivers plus a probe-log reader. Task 7 builds on this.
//
// Proven Task 0 facts baked in:
//  - `/goal` verbs dispatch ONLY as commands: use driveCommand() (`--command`), not driveMessage().
//  - continuations inherit the session model (omit body.model in the plugin).
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type Harness = {
  baseUrl: string
  projDir: string
  driveMessage: (text: string, model?: string) => Promise<void>
  driveCommand: (name: string, args: string, model?: string) => Promise<void>
  readLog: (path: string) => string
  stop: () => void
}

export type StartOpts = {
  pluginFile: string // absolute path to a plugin .ts to install into the project
  commands?: Record<string, string> // name -> markdown body, written to .opencode/command/<name>.md
  env?: Record<string, string> // extra env for the server process
  port?: number
  model?: string
}

const DEFAULT_MODEL = "google/gemini-2.5-flash-lite"

export async function startServer(opts: StartOpts): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "goal-harness-"))
  const projDir = join(root, "proj")
  const cfgDir = join(root, "cfg")
  mkdirSync(join(projDir, ".opencode", "plugin"), { recursive: true })
  mkdirSync(join(projDir, ".opencode", "command"), { recursive: true })
  mkdirSync(join(cfgDir, "opencode"), { recursive: true })
  cpSync(opts.pluginFile, join(projDir, ".opencode", "plugin", "plugin.ts"))
  for (const [name, body] of Object.entries(opts.commands ?? {})) {
    writeFileSync(join(projDir, ".opencode", "command", `${name}.md`), body)
  }
  writeFileSync(join(cfgDir, "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2))

  const port = opts.port ?? 39900 + Math.floor(Math.random() * 90)
  const baseUrl = `http://127.0.0.1:${port}`
  const serverLog = join(root, "server.log")
  const env = { ...process.env, XDG_CONFIG_HOME: cfgDir, ...(opts.env ?? {}) }

  const server = Bun.spawn(["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: projDir, env, stdout: Bun.file(serverLog), stderr: Bun.file(serverLog),
  })

  // Wait for "server listening"
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await Bun.sleep(300)
    if (existsSync(serverLog) && readFileSync(serverLog, "utf8").includes("server listening")) break
  }

  const model = opts.model ?? DEFAULT_MODEL
  const run = async (extra: string[]) => {
    const p = Bun.spawn(["opencode", "run", "--attach", baseUrl, "-m", model, ...extra], {
      cwd: projDir, env, stdout: "pipe", stderr: "pipe",
    })
    await p.exited
  }

  return {
    baseUrl,
    projDir,
    driveMessage: (text, m) => run(m ? ["-m", m, text] : [text]),
    driveCommand: (name, args, m) => run([...(m ? ["-m", m] : []), "--command", name, args]),
    readLog: (path) => (existsSync(path) ? readFileSync(path, "utf8") : ""),
    stop: () => { try { server.kill() } catch {} },
  }
}
