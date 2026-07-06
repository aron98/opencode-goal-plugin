# Opencode `/goal` Plugin — Implementation Plan (v2, panel-hardened)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an Opencode plugin that reproduces Codex CLI's `/goal` — a persistent, self-verifying objective that keeps a session working across turns until the model proves completion or the user stops it — **uncapped**, no source changes to Opencode.

**Architecture:** A TypeScript/Bun plugin with five parts: (A) a per-session JSON goal store, (B) a `/goal` command surface intercepted via `command.execute.before`, (C) per-turn objective+evidence-audit injection, (D) model-only completion tools (`goal_complete`/`goal_blocked`), (E) an idle-driven auto-continuation loop via the `event` hook that re-prompts through the version-matched plugin `client`. The brake is the injected (verbatim-ported) evidence-audit prompt plus the model's completion tool — never a numeric cap.

**Tech Stack:** TypeScript, `@opencode-ai/plugin` (pinned 1.15.6), Bun test, `opencode serve` integration harness.

---

## Panel Review Summary (v1 → v2 changelog)

Three reviewers (Cranky Old Sam — fidelity/soundness; Nadia — API correctness; Priya — test rigor) hardened v1. Resolved criticals:

- **[Nadia-1 / cap-of-1 bug] Removed the in-flight "single-flight" drop-guard.** The spike proves idle(N+1) arrives ~1 ms *before* prompt(N) resolves (`spike.log`); a set-before-await/clear-in-finally guard would suppress the continuation and **stall the loop after one step** — an accidental cap of 1. The only gate is now `status !== "active"`. (Global Constraints; Task 6.)
- **[Sam-1 / Nadia-2 / Priya-2 — triple consensus] Fixed the error brake.** `client.session.prompt` defaults to `throwOnError:false` → it **returns `{data,error}`, does not throw**; and real turn errors likely surface via the async **`EventSessionError`** event, not a rejection. v1's `try/catch → blocked` never fires and also conflated transport/disposal with model errors. v2 detects errors via `res.error` + `EventSessionError`, and **distinguishes genuine model/turn errors (→ blocked) from transport/disposal (→ leave active)**. Task 0 now probes the real error shape first. (Global Constraints; Task 0.4; Task 6; Task 7.4.)
- **[Sam-2 / Nadia-3] Task 0 now verifies injection on the idle *continuation* turn, and probes both injection hooks.** `experimental.chat.system.transform` has an **optional** `sessionID`; if 1.17.13 omits it, injection silently no-ops. Task 0 exercises both it and the `chat.message` fallback (non-optional `sessionID`) in one pass and picks the primary on evidence — and asserts the marker appears on a programmatic continuation, not just a user turn. (Task 0.)
- **[Sam-3] Brake prompt is now ported verbatim,** not paraphrased: Task 4 pulls the real `continuation.md` from `openai/codex` and adapts only tool names. `CONTINUE_NUDGE` is specified. (Task 4.)
- **[Sam-4 / Priya-1 / Priya-3] Deterministic acceptance tests.** Split the flaky "continues → completes → stops" into: (7.1) *continues* proved deterministically via the **`turnCount` state oracle** + a verbatim **injection sink log**, halted with `/goal pause`; (7.2) *complete stops* via a **steered** `goal_complete`. Natural model self-completion is a separate, capable-model, non-gating check. Standard oracle everywhere: state-file `turnCount` + sink log, never model transcript text. (Task 7.)
- **[Sam-5] YAGNI:** dropped `goal_status` (status is injected every turn; `/goal` view covers the user side). Kept `turnCount` — now justified: it powers the `/goal` view verb **and** is the test oracle.

## Global Constraints

- **No cap of any kind.** No max-iterations, no wall-clock, no token budget. Prohibited. Terminators only: model calls `goal_complete`/`goal_blocked`; user `/goal pause|clear`; a genuine model/turn error → `blocked`.
- **Loop self-sequences; do NOT add an in-flight mutex.** turn N completes → emits `session.idle` → fires continuation N+1. The next idle arrives ~1 ms before the prior `prompt()` resolves (proven, `spike.log`), so any "one prompt in flight" drop-guard stalls the loop after one step. Gate solely on `status !== "active"`. Any optional de-dup must be **identity-based** (per turn/message id), never suppress a *new* turn's idle.
- **`client.session.prompt` does not throw on turn/HTTP errors** (`throwOnError` defaults `false`, `sdk.gen.d.ts:174`): it resolves `{data, error}`. Detect failures via `res.error` **and** the async `EventSessionError` event. **Distinguish** genuine model/turn errors (→ `blocked`) from transport/disposal rejections (→ leave `active`, resume under next persistent host).
- **Never hand-roll HTTP.** Use the in-process plugin `client` (version-matched). `@opencode-ai/sdk` 1.15.6 vs server 1.17.13 drift.
- **Graceful in one-shot:** under `opencode run` the instance disposes after the first turn; the plugin must not hang or spuriously `block`.
- **Continuation call:** `client.session.prompt({ path:{ id }, body:{ parts:[…] } })`. `body.model` is **optional** (`types.gen.d.ts:2247`) — omit to inherit the session model (verified in Task 0.4); do not hard-pin.
- **Event shape (verified):** `session.idle` = `{ type:"session.idle", properties:{ sessionID:string } }`.

---

### Task 0: Hook-behavior verification harness (nails every load-bearing unknown)

Extends the proven session.idle/prompt spike into the reusable harness and empirically resolves **all** behaviors later tasks depend on — including the three the panel flagged (continuation-turn injection, error-propagation shape, injection-hook choice). No goal logic yet.

**Files:**
- Create: `test/harness.ts`
- Create: `test/probe.plugin.ts` (logs every hook invocation + shape to `$PROBE_LOG`)
- Create: `docs/superpowers/verification/2026-07-05-hook-behavior.md` (findings, with evidence)

**Interfaces:**
- Produces: `startServer(opts): Promise<{ baseUrl, createSession(), prompt(id,text,model?), messages(id), sessionModel(id), stop() }>` — boots `opencode serve` with a temp `XDG_CONFIG_HOME` + temp project holding `.opencode/plugin/probe.plugin.ts`; drives via the SDK `client` (run from `~/.config/opencode` so `@opencode-ai/sdk` resolves). Used by all later integration tests.

- [ ] **Step 1: Write the probe plugin** implementing `event` (log every `session.*` type + properties, incl. `session.error`), **both** `experimental.chat.system.transform` (push `PROBE_SYS_MARKER`) **and** `chat.message` (push a `PROBE_MSG_MARKER` text part), `command.execute.before` (log `input` + whether it can suppress a turn), and one `tool` (log `ctx`). Every hook appends a JSON line to `$PROBE_LOG`.
- [ ] **Step 2: Write `startServer` harness** (boot, wait for `server listening`, SDK-client helpers, `stop()` kills pid). Model the boot/drive on a proven serve+attach harness.
- [ ] **Step 3: Run probes for command/injection/tool/idle** and record findings:
  1. `command.execute.before` fires for `.opencode/command/goal.md`? Is `input.arguments` the text after `/goal`? Does empty `output.parts` suppress the model turn (needed for pause/clear/view short-circuit) or does a turn still run?
  2. Which injection hook fires on a **user** turn with a usable session id — `experimental.chat.system.transform` (note: `input.sessionID` optional, `index.d.ts:265`) and/or `chat.message` (`sessionID` required, `index.d.ts:187`)? Record both.
  3. `tool` execute `ctx` — confirm `ctx.sessionID` (`tool.d.ts:2`).
- [ ] **Step 4: Run the panel-flagged probes** (these gate Tasks 4/6/7):
  1. **Continuation-turn injection:** set a fake "active" marker, let the probe fire a `client.session.prompt` continuation from `event(session.idle)`, then assert the chosen injection marker appears in **that continuation turn's** request — not only user turns. If system.transform doesn't fire for programmatic turns, the primary injection hook must be the one that does.
  2. **Error-propagation shape:** issue a real continuation with a **broken model id** through the real `client.session.prompt`; record whether it (a) rejects, (b) resolves `{error}`, or (c) emits `EventSessionError`. This is the single fact the only automatic brake depends on.
  3. **Model inheritance:** issue a continuation with `body.model` **omitted**; confirm it runs on the session's model (`sessionModel(id)`), else continuations must pass the model explicitly.
- [ ] **Step 5: Decide & document** in the verification doc, with evidence: primary injection hook + renderer shape (system string vs message part); command short-circuit strategy; error-detection wiring (`res.error` vs `EventSessionError`); model-explicit-or-omit. These become the interface contract for Tasks 4–7.
- [ ] **Step 6: Commit** `test: hook-behavior verification harness + findings`.

---

### Task 1: Project setup

**Files:** Create `package.json`, `tsconfig.json`, `.gitignore`, `README.md` (skeleton)

- [ ] **Step 1: `package.json`** — pin `@opencode-ai/plugin@1.15.6`, `@opencode-ai/sdk@1.15.6`, `typescript`; scripts `test: bun test`, `typecheck: tsc --noEmit`.
- [ ] **Step 2: `tsconfig.json`** — strict, `moduleResolution: bundler`, target ES2022.
- [ ] **Step 3:** `bun install` — Expected: `@opencode-ai/plugin` present.
- [ ] **Step 4: Commit** `chore: project setup`.

---

### Task 2: Goal state store (`src/state.ts`)

Pure fs-backed store. One goal per session. Atomic writes. Statuses: `active | paused | complete | blocked`.

**Files:** Create `src/state.ts`; Test `test/state.test.ts`

**Interfaces (Produces):**
- `type GoalStatus = "active" | "paused" | "complete" | "blocked"`
- `type Goal = { sessionID: string; objective: string; status: GoalStatus; createdAt: number; updatedAt: number; turnCount: number }`
- `class GoalStore { constructor(dir: string); get(id): Goal|undefined; set(id, objective): Goal; setStatus(id, s): Goal|undefined; incrementTurn(id): void; clear(id): void }`
- Storage: `<dir>/<sessionID>.json`, atomic write-temp-then-rename. `turnCount` justified: surfaced by `/goal` view (Task 6) and the acceptance-test oracle (Task 7).

- [ ] **Step 1: Failing test** (as v1): set→active(turnCount 0); incrementTurn→1; setStatus→complete; clear→undefined; persists across instances.

```ts
import { test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"
import { GoalStore } from "../src/state"
test("lifecycle + persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-"))
  const s = new GoalStore(dir)
  expect(s.get("ses_1")).toBeUndefined()
  const g = s.set("ses_1", "migrate to X")
  expect(g.status).toBe("active"); expect(g.turnCount).toBe(0)
  s.incrementTurn("ses_1"); expect(s.get("ses_1")!.turnCount).toBe(1)
  s.setStatus("ses_1", "complete"); expect(s.get("ses_1")!.status).toBe("complete")
  s.clear("ses_1"); expect(s.get("ses_1")).toBeUndefined()
  new GoalStore(dir).set("ses_2", "obj"); expect(new GoalStore(dir).get("ses_2")!.objective).toBe("obj")
})
```

- [ ] **Step 2: Run — FAIL.** `bun test test/state.test.ts`
- [ ] **Step 3: Implement** (`mkdirSync recursive`; ENOENT→undefined; atomic write; bump `updatedAt`).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat: per-session goal state store`.

---

### Task 3: `/goal` sub-verb parser (`src/verbs.ts`)

**Files:** Create `src/verbs.ts`; Test `test/verbs.test.ts`

**Interfaces (Produces):** `type GoalAction = {kind:"view"}|{kind:"pause"}|{kind:"resume"}|{kind:"clear"}|{kind:"set";objective:string}`; `parseGoalArgs(args:string):GoalAction`. Rules: trimmed empty→view; bare `pause`/`resume`/`clear` (case-insensitive, single word only)→verb; else→set(full trimmed text). `pause the pipeline`→set.

- [ ] **Step 1: Failing test** (`""`,`"  "`→view; `"pause"`,`"PAUSE"`→pause; `"resume"`,`"clear"`; `"migrate to postgres"`→set; `"pause the pipeline"`→set).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat: /goal sub-verb parser`.

---

### Task 4: Continuation/system prompt renderer (`src/prompt.ts`) — VERBATIM PORT

Port the real Codex evidence-audit, do not paraphrase (Sam-3).

**Files:** Create `src/prompt.ts`; Create `src/continuation.template.md` (verbatim); Test `test/prompt.test.ts`

**Interfaces (Produces):**
- `const CONTINUE_NUDGE: string` — the minimal user-part text for a continuation turn: `"Continue working toward the active goal."` (objective + audit ride in on the injected system block, so the nudge stays minimal and content-free).
- `function renderGoalSystem(goal: Goal): string` — returns the injection block: the **verbatim** ported `continuation.md` body with `{{objective}}` filled (XML-escaped, wrapped `<objective>…</objective>`, labeled untrusted), the "keep working / don't shrink success" clause, the **completion audit** ("treat completion as unproven … evidence for every requirement against current state … then call `goal_complete`"), and the **blocked** clause ("only after the same blocker recurs across turns … call `goal_blocked`"). Only Codex tool names are swapped for `goal_complete`/`goal_blocked`.

- [ ] **Step 1: Fetch the real template.** Pull `codex-rs/ext/goal/templates/goals/continuation.md` from `openai/codex` (web/researcher). Save adapted copy to `src/continuation.template.md`. Record source URL + commit in a header comment.
- [ ] **Step 2: Failing test** — assert the rendered string contains the objective, literal `goal_complete` and `goal_blocked`, the untrusted-data sentence, the word `unproven`, and that `&`/`<`/`>` in an objective are escaped. Assert it matches the ported template (key load-bearing sentences present), not invented keywords.
- [ ] **Step 3: Run — FAIL.**
- [ ] **Step 4: Implement** `renderGoalSystem` (template read + `{{objective}}` escape/fill) and export `CONTINUE_NUDGE`.
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6: Commit** `feat: verbatim-ported goal evidence-audit prompt renderer`.

---

### Task 5: Completion tools (`src/tools.ts`)

Model-only. `goal_complete` + `goal_blocked` only (dropped `goal_status`, Sam-5). Mirror Codex asymmetry (no self-pause/resume).

**Files:** Create `src/tools.ts`; Test `test/tools.test.ts`

**Interfaces:**
- Consumes: `GoalStore`.
- Produces: `makeGoalTools(store): Record<string, ToolDefinition>` with `goal_complete` (args `{ summary?: string }` → setStatus `complete`) and `goal_blocked` (args `{ reason: string }` → setStatus `blocked`). Each reads `ctx.sessionID` (confirmed `tool.d.ts:2`), transitions state, returns a short confirmation string. No-op with a clear message if no active goal.

- [ ] **Step 1: Failing test** — temp store with active goal for `ses_x`; `goal_complete.execute({}, {sessionID:"ses_x"})` → status `complete`, string mentions completion; `goal_blocked.execute({reason:"stuck"}, {sessionID:"ses_x"})` → status `blocked`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** via `tool()` + `tool.schema` (zod).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat: goal_complete/goal_blocked tools`.

---

### Task 6: Plugin wiring (`src/plugin.ts`) + command file

Assemble A–E. Reentrancy-safe, **uncapped, no in-flight mutex** (Nadia-1). Error handling via `res.error` + `EventSessionError`, transport-vs-model distinction (Sam-1/Nadia-2/Priya-2).

**Files:** Create `src/plugin.ts`; Create `.opencode/command/goal.md`; Create `index.ts`; Test `test/plugin.unit.test.ts`

**Interfaces:**
- Consumes: `GoalStore`, `parseGoalArgs`, `renderGoalSystem`, `CONTINUE_NUDGE`, `makeGoalTools`, Task 0 findings (injection hook, command short-circuit, error shape, model omit/keep).
- Produces: `const GoalPlugin: Plugin` implementing:
  - `command.execute.before`: `input.command === "goal"` → `parseGoalArgs`; `set`→`store.set` + seed first turn (Task 0 strategy); `pause/resume`→`setStatus`; `clear`→`store.clear`; `view`→status+turnCount text; short-circuit non-`set` verbs per Task 0.
  - **[chosen injection hook from Task 0]** (`experimental.chat.system.transform` or `chat.message`): active goal for the session → inject `renderGoalSystem(goal)` (as system string or message part per hook).
  - `tool`: `makeGoalTools(store)`.
  - `event`:
    - `session.idle`: read `properties.sessionID`; **if `store.get(id)?.status !== "active"` → return** (the only gate — no mutex); `store.incrementTurn(id)`; `const res = await client.session.prompt({ path:{id}, body:{ parts:[{type:"text",text:CONTINUE_NUDGE}] }})`; **if `res?.error`** → classify: model/turn error → `store.setStatus(id,"blocked")`; transport/disposal → leave `active` (log).
    - `session.error` (`EventSessionError`): if it names a session with an `active` goal and is a model/turn error → `store.setStatus(id,"blocked")`; transport/disposal → leave `active`.
  - Wrap the whole `event` body in try/catch that **only logs** (never blocks) on unexpected transport throws — matches "graceful in one-shot".

- [ ] **Step 1: Failing unit test** (fake `client` records `session.prompt`; fake `EventSessionError`; temp store):
  - `command.execute.before` set/clear mutate state as expected.
  - injection handler with active goal → output contains objective + `goal_complete`.
  - `event(session.idle)` with `active` goal → exactly one `session.prompt`; with `complete` goal → zero.
  - **No mutex regression:** two *sequential* idles for `"s"` (simulating turn N then N+1, active throughout) → **two** `session.prompt` calls (loop keeps going). (Do NOT assert "overlapping → one dropped" — that was the v1 bug.)
  - `res.error` = model error → status `blocked`; `res.error` = transport error → status still `active`.
  - `session.error` event (model) for active goal → `blocked`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `src/plugin.ts`, `.opencode/command/goal.md` (minimal; plugin owns behavior), `index.ts`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat: goal plugin wiring (command, injection, tools, uncapped idle loop)`.

---

### Task 7: Integration tests — user stories (`test/integration.test.ts`)

Acceptance layer against live `opencode serve`. **Deterministic oracle everywhere:** the state-file `turnCount` + a verbatim injection **sink log** the plugin writes when it injects (add a tiny debug sink gated by an env var, so "objective injected" is observed directly, never inferred from model text). "continued" = `turnCount` increments; "stopped" = `turnCount` stable across ≥1 idle cycle quiet window.

**Files:** Create `test/integration.test.ts`

- [ ] **Step 1: Failing tests** (boot server w/ goal plugin):
  1. **Continues (deterministic):** `/goal <2-step objective>` → assert `turnCount` goes 0→1→2 within a bounded window via the state file, AND the injection sink shows the objective verbatim on a *continuation* turn; then `/goal pause` → assert `turnCount` stable across the quiet window. No dependence on the model ever completing. (Cheap model OK.)
  2. **Complete stops (steered):** seed an active goal; inject a user prompt explicitly instructing an immediate `goal_complete` call; assert status→`complete` and `turnCount` stable across the quiet window (loop stopped). (Cheap model.)
  3. **Pause / clear stop:** active goal mid-loop → `/goal pause` halts (turnCount stable); `/goal clear` removes state file.
  4. **Real turn error → blocked:** drive a continuation whose turn genuinely fails (broken model id via the **real** `client.session.prompt`, per Task 0.4 finding — no plugin-internal monkeypatching) → assert state flips to `blocked`, loop stops, no infinite retry.
  5. **No-goal untouched:** normal session, no goal → zero continuations (turnCount file absent), no injection sink entries.
  6. **One-shot no-hang:** `opencode run "<x>"` with a goal set mid-turn → process exits before timeout AND final `status ∈ {active, blocked}` (assert the exact allowed set; not "sane").
  7. **Natural completion (non-gating, capable model):** a deterministically-reachable objective with a capable model → eventually `goal_complete`; marked slow/allowed-flaky, excluded from the required gate.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Wire** harness to install the built plugin; add the injection sink; fix real bugs surfaced.
- [ ] **Step 4: Run — PASS** (gate = tests 1–6; generous timeouts on real inference).
- [ ] **Step 5: Commit** `test: end-to-end user-story integration suite`.

---

### Task 8: README + install

- [ ] **Step 1:** Document what it is, the uncapped stop model, `/goal` verbs, the `goal_complete`/`goal_blocked` tools, install (`~/.config/opencode/plugin/` global or project `.opencode/plugin/`, or npm via `opencode.json` `plugin:[]`), and the persistent-host caveat (loop needs TUI/serve; one-shot `run` no-ops).
- [ ] **Step 2: Commit** `docs: README with install + usage`.

## Self-Review

- **Spec coverage:** A→T2; B→T6+command; C→T4+T6 (hook per T0); D→T5; E→T6; stop-conditions→T6 (model err→blocked, transport→stays active) + T5 + proof T7.2/7.4; uncapped→Global Constraints + T6 (no mutex) + T7.1; compaction (F) deferred (unnecessary with per-turn injection).
- **No silent deferrals:** every user story has a Task 7 test on **real** server + real model, with a deterministic state/log oracle; the error brake (7.4) uses a real failing turn, no stub; Task 0 replaces all four load-bearing assumptions (injection-on-continuation, error shape, hook choice, model inheritance) with verified findings before dependents build on them.
- **Type consistency:** `Goal`/`GoalStatus`/`GoalStore` (T2/5/6); `parseGoalArgs`/`GoalAction` (T3/6); `renderGoalSystem`/`CONTINUE_NUDGE` (T4/6); `makeGoalTools` (T5/6).
- **Panel criticals:** all six resolved and cross-referenced in the changelog above.
