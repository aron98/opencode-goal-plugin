import { test, expect, afterEach } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GoalStore } from "../src/state"
import { CONTINUE_NUDGE } from "../src/prompt"
import { GoalPlugin } from "../src/plugin"
import type { PluginInput } from "@opencode-ai/plugin"

// Fake plugin host: a client that records session.prompt calls and returns a
// configurable result, plus a temp GoalStore the plugin shares via GOAL_STATE_DIR.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gp-"))
  process.env.GOAL_STATE_DIR = dir
  const store = new GoalStore(dir)
  const calls: Array<{ path: { id: string }; body: { model?: unknown; parts: Array<{ type: string; text: string }> } }> = []
  let promptResult: unknown = { data: { info: {}, parts: [] }, error: undefined }
  const client = {
    session: {
      prompt: async (o: any) => {
        calls.push(o)
        return promptResult
      },
    },
  }
  const input = { client, directory: dir, worktree: dir } as unknown as PluginInput
  return { dir, store, calls, input, setPromptResult: (r: unknown) => { promptResult = r } }
}

const idle = (sessionID: string) => ({ event: { type: "session.idle", properties: { sessionID } } }) as any
const sysError = (sessionID: string, error: unknown) =>
  ({ event: { type: "session.error", properties: { sessionID, error } } }) as any

afterEach(() => {
  delete process.env.GOAL_DEBUG_SINK
})

test("command.execute.before: set creates an active goal; clear removes it", async () => {
  const { store, input } = setup()
  const hooks = await GoalPlugin(input)
  const out: { parts: unknown[] } = { parts: [] }
  await hooks["command.execute.before"]!({ command: "goal", sessionID: "s1", arguments: "migrate to postgres" }, out as any)
  expect(store.get("s1")!.objective).toBe("migrate to postgres")
  expect(store.get("s1")!.status).toBe("active")

  await hooks["command.execute.before"]!({ command: "goal", sessionID: "s1", arguments: "clear" }, out as any)
  expect(store.get("s1")).toBeUndefined()
})

test("command.execute.before: pause / resume flip status; view surfaces status + turnCount", async () => {
  const { store, input } = setup()
  const hooks = await GoalPlugin(input)
  const out: { parts: Array<{ type: string; text: string }> } = { parts: [] }
  await hooks["command.execute.before"]!({ command: "goal", sessionID: "s1", arguments: "do it" }, out as any)
  store.incrementTurn("s1")

  await hooks["command.execute.before"]!({ command: "goal", sessionID: "s1", arguments: "pause" }, out as any)
  expect(store.get("s1")!.status).toBe("paused")
  await hooks["command.execute.before"]!({ command: "goal", sessionID: "s1", arguments: "resume" }, out as any)
  expect(store.get("s1")!.status).toBe("active")

  await hooks["command.execute.before"]!({ command: "goal", sessionID: "s1", arguments: "" }, out as any)
  const viewText = out.parts.map((p) => p.text).join("\n")
  expect(viewText).toContain("do it")
  expect(viewText).toContain("active")
  expect(viewText).toContain("1") // turnCount surfaced
})

test("command.execute.before: ignores commands other than 'goal'", async () => {
  const { store, input } = setup()
  const hooks = await GoalPlugin(input)
  const out: { parts: unknown[] } = { parts: [{ type: "text", text: "keep me" }] }
  await hooks["command.execute.before"]!({ command: "other", sessionID: "s1", arguments: "whatever" }, out as any)
  expect(store.get("s1")).toBeUndefined()
  expect(out.parts).toEqual([{ type: "text", text: "keep me" }])
})

test("system.transform injects objective + goal_complete for an active goal", async () => {
  const { store, input } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s2", "unify the build")
  const out: { system: string[] } = { system: [] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: "s2", model: {} as any }, out)
  const sys = out.system.join("\n")
  expect(sys).toContain("unify the build")
  expect(sys).toContain("goal_complete")
})

test("system.transform injects nothing without an active goal (missing or paused)", async () => {
  const { store, input } = setup()
  const hooks = await GoalPlugin(input)

  const outMissing: { system: string[] } = { system: [] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: "s3", model: {} as any }, outMissing)
  expect(outMissing.system).toEqual([])

  store.set("s3", "x")
  store.setStatus("s3", "paused")
  const outPaused: { system: string[] } = { system: [] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: "s3", model: {} as any }, outPaused)
  expect(outPaused.system).toEqual([])
})

test("system.transform is a no-op when sessionID is absent", async () => {
  const { input } = setup()
  const hooks = await GoalPlugin(input)
  const out: { system: string[] } = { system: [] }
  await hooks["experimental.chat.system.transform"]!({ model: {} as any }, out)
  expect(out.system).toEqual([])
})

test("session.idle: active goal -> exactly one continuation (model omitted); complete -> zero", async () => {
  const { store, input, calls } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s4", "keep going")

  await hooks.event!(idle("s4"))
  expect(calls.length).toBe(1)
  expect(calls[0]!.path.id).toBe("s4")
  expect(calls[0]!.body.parts[0]!.text).toBe(CONTINUE_NUDGE)
  expect(calls[0]!.body.model).toBeUndefined() // inherit session model
  expect(store.get("s4")!.turnCount).toBe(1)

  store.setStatus("s4", "complete")
  await hooks.event!(idle("s4"))
  expect(calls.length).toBe(1) // no further continuation once not active
})

test("no mutex regression: two sequential idles (active throughout) -> two continuations", async () => {
  const { store, input, calls } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s5", "loop indefinitely")

  await hooks.event!(idle("s5"))
  await hooks.event!(idle("s5"))

  expect(calls.length).toBe(2) // the loop is NOT capped at 1
  expect(store.get("s5")!.turnCount).toBe(2)
  expect(store.get("s5")!.status).toBe("active")
})

test("session.idle: paused goal -> zero continuations", async () => {
  const { store, input, calls } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s5b", "x")
  store.setStatus("s5b", "paused")
  await hooks.event!(idle("s5b"))
  expect(calls.length).toBe(0)
})

test("continuation res.error: model error -> blocked", async () => {
  const { store, input, setPromptResult } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s6", "x")
  setPromptResult({ data: undefined, error: { name: "UnknownError", data: { message: "the model exploded" } } })
  await hooks.event!(idle("s6"))
  expect(store.get("s6")!.status).toBe("blocked")
})

test("continuation res.error: transport/abort error -> stays active", async () => {
  const { store, input, setPromptResult } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s7", "x")
  setPromptResult({ data: undefined, error: { name: "MessageAbortedError", data: { message: "request aborted (instance disposed)" } } })
  await hooks.event!(idle("s7"))
  expect(store.get("s7")!.status).toBe("active")
})

test("continuation res.error: ProviderAuthError (infra) -> stays active (never auto-block)", async () => {
  const { store, input, setPromptResult } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s7c", "x")
  setPromptResult({ data: undefined, error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "invalid api key" } } })
  await hooks.event!(idle("s7c"))
  expect(store.get("s7c")!.status).toBe("active")
})

test("continuation res.error: ApiError/5xx (infra) -> stays active (never auto-block)", async () => {
  const { store, input, setPromptResult } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s7d", "x")
  // Real union member name is "APIError"; not a model/turn error -> must not block.
  setPromptResult({ data: undefined, error: { name: "APIError", data: { message: "upstream 503", statusCode: 503, isRetryable: true } } })
  await hooks.event!(idle("s7d"))
  expect(store.get("s7d")!.status).toBe("active")
})

test("continuation throw (transport/disposal) -> stays active, no throw out of hook", async () => {
  const { store, input } = setup()
  // A client whose prompt rejects (network/disposal).
  const throwingClient = { session: { prompt: async () => { throw new Error("ECONNREFUSED") } } }
  const throwingInput = { client: throwingClient, directory: (input as any).directory } as unknown as PluginInput
  const hooks = await GoalPlugin(throwingInput)
  store.set("s7b", "x")
  await hooks.event!(idle("s7b"))
  expect(store.get("s7b")!.status).toBe("active")
})

test("session.error event (model error) for an active goal -> blocked", async () => {
  const { store, input } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s8", "x")
  await hooks.event!(sysError("s8", { name: "UnknownError", data: { message: "provider 500" } }))
  expect(store.get("s8")!.status).toBe("blocked")
})

test("session.error event (abort/transport) for an active goal -> stays active", async () => {
  const { store, input } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s9", "x")
  await hooks.event!(sysError("s9", { name: "MessageAbortedError" }))
  expect(store.get("s9")!.status).toBe("active")
})

test("session.error event (ProviderAuthError, infra) for an active goal -> stays active", async () => {
  const { store, input } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s9b", "x")
  await hooks.event!(sysError("s9b", { name: "ProviderAuthError", data: { providerID: "openai", message: "401 unauthorized" } }))
  expect(store.get("s9b")!.status).toBe("active")
})

test("session.error event (ApiError/5xx, infra) for an active goal -> stays active", async () => {
  const { store, input } = setup()
  const hooks = await GoalPlugin(input)
  store.set("s9c", "x")
  await hooks.event!(sysError("s9c", { name: "APIError", data: { message: "upstream 500", statusCode: 500, isRetryable: true } }))
  expect(store.get("s9c")!.status).toBe("active")
})

test("session.error for a session with no active goal is ignored", async () => {
  const { store, input } = setup()
  const hooks = await GoalPlugin(input)
  // no goal for s10
  await hooks.event!(sysError("s10", { name: "UnknownError" }))
  expect(store.get("s10")).toBeUndefined()
})

test("tool hook exposes goal_complete and goal_blocked", async () => {
  const { input } = setup()
  const hooks = await GoalPlugin(input)
  expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(["goal_blocked", "goal_complete"])
})

test("GOAL_DEBUG_SINK records an inject line and a continuation line", async () => {
  const { store, input, dir } = setup()
  const sinkPath = join(dir, "sink.log")
  process.env.GOAL_DEBUG_SINK = sinkPath
  const hooks = await GoalPlugin(input)
  store.set("s11", "sink me verbatim")

  const out: { system: string[] } = { system: [] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: "s11", model: {} as any }, out)
  await hooks.event!(idle("s11"))

  const lines = readFileSync(sinkPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const inject = lines.find((l) => l.kind === "inject")
  const cont = lines.find((l) => l.kind === "continue")
  expect(inject).toBeTruthy()
  expect(inject.sessionID).toBe("s11")
  expect(inject.block).toContain("sink me verbatim")
  expect(cont).toBeTruthy()
  expect(cont.sessionID).toBe("s11")
})
