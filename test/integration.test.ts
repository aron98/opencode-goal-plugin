// Task 7 acceptance layer: the /goal plugin driven against a live `opencode serve`
// with REAL inference. Deterministic oracle everywhere — the goal state file
// (turnCount/status) and the JSONL debug sink (inject/continue) — never model
// transcript text. Definitions:
//   continues  = turnCount increments (>= 1 continuation ran)
//   stopped    = turnCount stable across a quiet window (>= 1 idle cycle)
//   injected   = a sink `inject` line carrying the objective
//
// One shared server for the file (booting `opencode serve` is the slow part, and a
// SIGKILLed-per-test server leaks worker processes). Tests are isolated by session id
// (distinct per driveCommand/setGoal call) and each clears its goal in a `finally` —
// so the uncapped loop is always stopped before the next test and can never keep
// burning tokens. afterAll group-kills the server and every client.
import { test, expect, beforeAll, afterAll } from "bun:test"
import { startServer, type Harness } from "./harness"

const MODEL = "google/gemini-2.5-flash-lite"

// Quiet window must exceed one idle cycle (observed ~1-3s per continuation).
const QUIET_MS = 9_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function poll(pred: () => boolean, timeoutMs: number, intervalMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(intervalMs)
  }
  return pred()
}

// Robustly prove the loop stopped: return true once turnCount has not changed for
// `quietMs`. Resets on any change, so a late in-flight continuation that settles a
// few seconds after a terminal status (slower under load) doesn't cause a false
// failure — we simply wait for it to settle, then confirm the quiet window.
async function loopStopped(sid: string, quietMs: number, maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs
  let last = h.stateFor(sid)?.turnCount ?? -1
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await sleep(1_000)
    const now = h.stateFor(sid)?.turnCount ?? -1
    if (now !== last) {
      last = now
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= quietMs) {
      return true
    }
  }
  return false
}

let h: Harness

beforeAll(async () => {
  h = await startServer({ model: MODEL })
}, 90_000)

afterAll(() => {
  h?.stop()
})

async function safeClear(sessionID: string): Promise<void> {
  if (!sessionID) return
  try {
    await h.driveCommand("goal", "clear", { session: sessionID, timeoutMs: 20_000 })
  } catch {
    /* best-effort teardown; afterAll also group-kills the server */
  }
}

test(
  "continues, self-completes, then stops (uncapped loop halts on goal_complete)",
  async () => {
    let sid = ""
    try {
      // A long one-number-per-reply count RELIABLY forces genuine turn-by-turn
      // continuations (too many to cram into the seed turn, and there is no early
      // completion path to short-circuit) — so "continues" is deterministic.
      sid = await h.setGoal(
        "Count from 1 to 50, writing exactly one number per reply. Never write more than one number in a single reply.",
      )
      expect(sid).toMatch(/^ses_/)

      // The uncapped loop runs several continuations on its own.
      const continued = await poll(() => (h.stateFor(sid)?.turnCount ?? 0) >= 3, 60_000, 1_000)
      expect(continued).toBe(true)
      expect(h.stateFor(sid)?.status).toBe("active")

      // The objective was injected verbatim on the continuation turns.
      const injects = h.sinkLines(sid).filter((l) => l.kind === "inject")
      expect(injects.length).toBeGreaterThanOrEqual(1)
      expect(injects.some((l) => (l.block ?? "").includes("Count from 1 to 50"))).toBe(true)

      // Now that the loop has demonstrably continued, redefine "done" to something the
      // evidence already proves (it has counted past 3). The model — its own tool,
      // its own audit satisfied — calls goal_complete and the loop halts.
      await h.driveMessage(
        "Update to the goal: you only need to count to 3, and the numbers written so far already " +
          "pass 3, so the objective is fully satisfied. Call the goal_complete tool now.",
        { session: sid, timeoutMs: 30_000 },
      )
      const completed = await poll(() => h.stateFor(sid)?.status === "complete", 60_000, 1_500)
      expect(completed).toBe(true)
      expect(h.stateFor(sid)?.status).toBe("complete")

      // The loop stopped: turnCount frozen across a quiet window.
      expect(await loopStopped(sid, QUIET_MS, 40_000)).toBe(true)
      expect(h.stateFor(sid)?.status).toBe("complete")
    } finally {
      await safeClear(sid)
    }
  },
  180_000,
)

test(
  "pause halts the running loop",
  async () => {
    let sid = ""
    try {
      // A long count forces many one-per-reply turns, so the loop is genuinely
      // running (not self-completed) when we pause it.
      sid = await h.setGoal(
        "Count from 1 to 40, writing exactly one number per reply. Never write more than one number in a reply.",
      )
      expect(sid).toMatch(/^ses_/)

      // Let the uncapped loop run at least one continuation.
      const ran = await poll(() => (h.stateFor(sid)?.turnCount ?? 0) >= 1, 60_000, 1_000)
      expect(ran).toBe(true)

      // Pause on the SAME session (short-lived: pausing stops the loop, client exits).
      await h.driveCommand("goal", "pause", { session: sid, timeoutMs: 25_000 })
      const paused = await poll(() => h.stateFor(sid)?.status === "paused", 25_000, 500)
      expect(paused).toBe(true)

      // The loop is frozen: turnCount stops changing once paused (tolerating a late
      // in-flight continuation settling under load).
      expect(await loopStopped(sid, QUIET_MS, 40_000)).toBe(true)
      expect(h.stateFor(sid)?.status).toBe("paused")
    } finally {
      await safeClear(sid)
    }
  },
  170_000,
)

test(
  "clear removes the goal state file",
  async () => {
    let sid = ""
    try {
      sid = await h.setGoal("Count from 1 to 40, writing exactly one number per reply.")
      expect(sid).toMatch(/^ses_/)
      // The goal exists after a set.
      expect(h.stateFor(sid)).toBeDefined()

      await h.driveCommand("goal", "clear", { session: sid, timeoutMs: 25_000 })
      const gone = await poll(() => h.stateFor(sid) === undefined, 20_000, 500)
      expect(gone).toBe(true)
    } finally {
      // Idempotent: if clear already removed it, this is a no-op.
      await safeClear(sid)
    }
  },
  120_000,
)

test(
  "a session with no goal is left untouched (no state file, no injections)",
  async () => {
    const sid = await h.driveMessage("say hi", { timeoutMs: 30_000 })
    expect(sid).toMatch(/^ses_/)
    // No goal was ever set for THIS session, so it has no state file...
    expect(h.stateFor(sid)).toBeUndefined()
    // ...and the plugin injected nothing for it (session-scoped: the shared sink
    // holds other tests' injections, so we filter to this session).
    expect(h.sinkLines(sid).filter((l) => l.kind === "inject").length).toBe(0)
  },
  90_000,
)

// The turn-error -> blocked brake is covered deterministically in
// test/plugin.unit.test.ts against the REAL error shape observed in Task 0
// (res.error / session.error carrying UnknownError; see
// docs/superpowers/verification/2026-07-05-hook-behavior.md). A live end-to-end
// error turn is impractical here: continuations inherit the session model, so a
// model broken enough to fail a continuation also fails the initial turn — nothing
// would set the goal to break in the first place. Skipped honestly, not hidden.
test.skip("real turn-error -> blocked (see plugin.unit + Task 0 error-shape proof)", () => {})
