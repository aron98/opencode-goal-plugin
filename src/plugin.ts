// Goal plugin wiring — assembles the five parts of the Codex-style /goal port:
//   (A) per-session goal store        -> GoalStore
//   (B) /goal command surface         -> command.execute.before
//   (C) per-turn objective+audit inj. -> experimental.chat.system.transform (Task 0 primary)
//   (D) model-only completion tools   -> tool
//   (E) uncapped idle continuation    -> event(session.idle)
//
// UNCAPPED, NO IN-FLIGHT MUTEX (Nadia-1): the only gate on the loop is
// status !== "active". turn N finishes -> session.idle -> continuation N+1, forever,
// until the model calls goal_complete/goal_blocked, the user pauses/clears, or a
// genuine model/turn error trips the brake. The next idle arrives ~1 ms before the
// prior prompt() resolves, so a drop-guard would stall the loop after one step.
//
// Error brake (Sam-1/Nadia-2/Priya-2): client.session.prompt does NOT throw on a
// turn error — it resolves { error }. We read res.error AND handle the async
// session.error event, and block ONLY on a positively-identified model/turn error
// (UnknownError / MessageOutputLengthError). Every other error — transport/disposal,
// ProviderAuthError, APIError/5xx, or any unrecognized shape — leaves the goal active
// (uncapped contract: never auto-block on a non-model error). Matches Task 0 findings.

import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin"
import type { TextPartInput } from "@opencode-ai/sdk"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { GoalStore, type Goal } from "./state"
import { parseGoalArgs } from "./verbs"
import { renderGoalSystem, CONTINUE_NUDGE } from "./prompt"
import { makeGoalTools } from "./tools"

// --- state directory ---------------------------------------------------------

// GOAL_STATE_DIR overrides (used by tests as the deterministic oracle location);
// otherwise goals live under the project's .opencode/goal directory.
function resolveStateDir(input: PluginInput): string {
  const override = process.env.GOAL_STATE_DIR
  if (override) return override
  const base = input.directory || input.worktree || process.cwd()
  return join(base, ".opencode", "goal")
}

// --- debug sink (deterministic oracle for Task 7) ----------------------------

// When GOAL_DEBUG_SINK is set, append one JSON line per inject and per continuation.
function sink(entry: Record<string, unknown>): void {
  const path = process.env.GOAL_DEBUG_SINK
  if (!path) return
  try {
    appendFileSync(path, JSON.stringify(entry) + "\n")
  } catch {
    // Never let observability break the loop.
  }
}

function log(...args: unknown[]): void {
  if (process.env.GOAL_DEBUG) console.error("[goal]", ...args)
}

// --- error classification ----------------------------------------------------

// Uncapped contract: only KNOWN model/turn errors block the goal; unknown/infra
// errors keep the goal active (recoverable via the next continuation or `/goal
// resume`). The default is deliberately inverted so an unrecognized error can never
// auto-block the uncapped loop. From the real EventSessionError.error union
// (ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError
// | ApiError): UnknownError and MessageOutputLengthError are genuine turn failures;
// ProviderAuthError (auth) and ApiError (APIError / 5xx) are infra, and
// MessageAbortedError is a transport/abort — all three stay active.
const MODEL_TURN_ERROR_NAMES = new Set(["UnknownError", "MessageOutputLengthError"])

// Belt-and-suspenders stay-active signals (redundant with the allowlist default, but
// explicit): a known transport/abort name, or a transport/disposal-ish message. These
// must NOT block the goal — the loop can resume under the next persistent host.
const TRANSPORT_ERROR_NAMES = new Set(["MessageAbortedError"])
const TRANSPORT_MSG_RE =
  /econnrefused|econnreset|epipe|fetch failed|socket hang up|network|disposed|dispose|aborted|abort|timed?\s?out|instance.*(gone|dispose)/i

function errName(e: unknown): string | undefined {
  if (e && typeof e === "object" && "name" in e) {
    const n = (e as { name?: unknown }).name
    return typeof n === "string" ? n : undefined
  }
  return undefined
}

function errMessage(e: unknown): string {
  if (!e) return ""
  if (typeof e === "string") return e
  if (typeof e === "object") {
    const o = e as { message?: unknown; data?: { message?: unknown } }
    if (typeof o.message === "string") return o.message
    if (o.data && typeof o.data.message === "string") return o.data.message
    try {
      return JSON.stringify(o)
    } catch {
      return String(e)
    }
  }
  return String(e)
}

// True ONLY for positively-identified model/turn errors (-> blocked). Everything
// else — transport/disposal/abort AND any unrecognized/infra error (ProviderAuthError,
// APIError/5xx, unknown shapes) — returns false (stay active), honoring the uncapped
// contract that a non-model error must never auto-block the loop.
export function isModelTurnError(e: unknown): boolean {
  if (!e) return false
  const name = errName(e)
  // Explicit stay-active signals first (belt and suspenders).
  if (name && TRANSPORT_ERROR_NAMES.has(name)) return false
  if (TRANSPORT_MSG_RE.test(errMessage(e))) return false
  // Default is now stay-active: block only on a known model/turn error name.
  return name !== undefined && MODEL_TURN_ERROR_NAMES.has(name)
}

// --- command output helper ---------------------------------------------------

// The command.execute.before hook declares its output as { parts: Part[] } — the
// server-side Part union whose text member (TextPart) requires id/sessionID/messageID.
// The hook input, however, is only { command, sessionID, arguments }: it carries no
// part id and no messageID, so a full Part cannot be honestly constructed here without
// inventing those fields. We build the SDK's real minimal text-part *input* shape
// (TextPartInput — tsc verifies the "text" discriminant and text:string field, with no
// unknown[] widening) and make a single narrowly-scoped assertion into the hook's Part
// slot, so tsc guards the part shape instead of masking it behind unknown[].
// Verified in Task 7's live run: the replaced text part renders as the user message
// (see docs/superpowers/verification/2026-07-05-task7-live-proof.md).
type CommandBeforeOutput = Parameters<NonNullable<Hooks["command.execute.before"]>>[1]

// Replace the command's expanded parts in place with a single text part. Mutating
// in place (not reassigning) keeps the host's array reference valid.
function setParts(output: CommandBeforeOutput, text: string): void {
  const part: TextPartInput = { type: "text", text }
  output.parts.length = 0
  output.parts.push(part as CommandBeforeOutput["parts"][number])
}

function viewText(goal: Goal | undefined): string {
  if (!goal) return "No goal set for this session. Use `/goal <objective>` to start one."
  return `Goal [${goal.status}] (turn ${goal.turnCount}): ${goal.objective}`
}

// --- plugin ------------------------------------------------------------------

export const GoalPlugin: Plugin = async (input): Promise<Hooks> => {
  const store = new GoalStore(resolveStateDir(input))
  const client = input.client
  const tools = makeGoalTools(store)

  return {
    tool: tools,

    // (B) /goal command surface.
    "command.execute.before": async (cin, cout) => {
      if (cin.command !== "goal") return
      const id = cin.sessionID
      const action = parseGoalArgs(cin.arguments ?? "")
      switch (action.kind) {
        case "set": {
          store.set(id, action.objective)
          // Seed the first turn: the objective + audit ride in via system injection
          // (the goal is now active), so the user part stays minimal.
          setParts(cout, CONTINUE_NUDGE)
          return
        }
        case "pause": {
          // Honest confirmation: don't claim to have paused a goal that isn't there.
          if (!store.get(id)) {
            setParts(cout, "No goal set for this session.")
            return
          }
          store.setStatus(id, "paused")
          setParts(cout, "[goal] paused — automatic continuations stopped; the objective is preserved. `/goal resume` to continue.")
          return
        }
        case "resume": {
          const existing = store.get(id)
          if (!existing) {
            setParts(cout, "No goal set for this session.")
            return
          }
          const wasComplete = existing.status === "complete"
          store.setStatus(id, "active")
          setParts(
            cout,
            wasComplete
              ? "[goal] resumed — re-opening a completed goal; the continuation loop restarts."
              : "[goal] resumed.",
          )
          return
        }
        case "clear": {
          if (!store.get(id)) {
            setParts(cout, "No goal set for this session.")
            return
          }
          store.clear(id)
          setParts(cout, "[goal] cleared.")
          return
        }
        case "view": {
          setParts(cout, viewText(store.get(id)))
          return
        }
      }
    },

    // (C) per-turn injection — fires on user AND programmatic continuation turns
    // (Task 0: experimental.chat.system.transform, sessionID always populated).
    "experimental.chat.system.transform": async (sin, sout) => {
      const id = sin.sessionID
      if (!id) return
      const goal = store.get(id)
      if (!goal || goal.status !== "active") return
      const block = renderGoalSystem(goal)
      sout.system.push(block)
      sink({ kind: "inject", sessionID: id, block })
    },

    // (E) uncapped idle continuation + (error brake).
    event: async ({ event }) => {
      try {
        if (event.type === "session.idle") {
          // Deliberate assumption: one session.idle per completed turn (Task 0-observed),
          // so each idle drives exactly one continuation. Identity-based de-dup of
          // overlapping idles is intentionally de-scoped (uncapped contract).
          const id = event.properties.sessionID
          const goal = store.get(id)
          // The ONLY gate. No in-flight mutex (a drop-guard would cap the loop at 1).
          if (!goal || goal.status !== "active") return
          // Set the counter BEFORE awaiting (reentrancy-safe); no mutex.
          store.incrementTurn(id)
          sink({ kind: "continue", sessionID: id, turnCount: store.get(id)?.turnCount })

          let res: unknown
          try {
            res = await client.session.prompt({
              path: { id },
              // Omit body.model -> inherit the session model (Task 0.4).
              body: { parts: [{ type: "text", text: CONTINUE_NUDGE }] },
            })
          } catch (err) {
            // Transport/disposal throw (e.g. one-shot instance disposed): leave active.
            log("continuation prompt threw (transport/disposal) — leaving goal active", id, err)
            return
          }

          const error = (res as { error?: unknown } | null | undefined)?.error
          if (error) {
            if (isModelTurnError(error)) {
              store.setStatus(id, "blocked")
              log("continuation returned a model/turn error — goal blocked", id, error)
            } else {
              log("continuation returned a non-model error (transport/infra/unknown) — leaving goal active", id, error)
            }
          }
          return
        }

        if (event.type === "session.error") {
          const id = event.properties.sessionID
          if (!id) return
          const goal = store.get(id)
          if (!goal || goal.status !== "active") return
          const error = event.properties.error
          if (isModelTurnError(error)) {
            store.setStatus(id, "blocked")
            log("session.error names an active goal (model/turn error) — goal blocked", id, error)
          } else {
            log("session.error is a non-model error (transport/infra/unknown) — leaving goal active", id, error)
          }
          return
        }
      } catch (err) {
        // Never block on an unexpected transport throw — matches graceful one-shot.
        log("event handler error (ignored)", err)
      }
    },
  }
}
