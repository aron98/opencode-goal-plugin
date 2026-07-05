# Tasks 1–6 Implementation Report

**Repo:** `/home/dan/code/opencode-goal-plugin`
**Scope:** Tasks 1–6 of `docs/superpowers/plans/2026-07-05-opencode-goal-plugin.md` (Task 0 pre-done; Tasks 7–8 out of scope).
**Method:** strict TDD per task (failing test → run → minimal impl → run → whole-suite + `tsc` → commit).
**Runtime:** bun 1.3.14, TypeScript 5.9.3, `@opencode-ai/plugin`/`@opencode-ai/sdk` 1.15.6 (pinned).

## Overall status: DONE_WITH_CONCERNS

Concerns are all forward-looking wiring notes for Task 7 (integration), not defects in Tasks 1–6. Full unit suite green, `tsc --noEmit` clean.

## Commit range

`fccd369..3cb9f37` (6 commits, one per task).

| Task | Commit | Title |
|---|---|---|
| 1 | `fccd369` | chore: project setup |
| 2 | `8dc7f97` | feat: per-session goal state store |
| 3 | `52dec45` | feat: /goal sub-verb parser |
| 4 | `924bacb` | feat: verbatim-ported goal evidence-audit prompt renderer |
| 5 | `24673a9` | feat: goal_complete/goal_blocked tools |
| 6 | `3cb9f37` | feat: goal plugin wiring (command, injection, tools, uncapped idle loop) |

Each commit message ends with the required `Generated with Amplifier` / `Co-Authored-By` trailer.

## Per-task status

- **Task 1 — Project setup — DONE.** `package.json` (pins `@opencode-ai/plugin@1.15.6`, `@opencode-ai/sdk@1.15.6`, `typescript`, `@types/bun`; `test`/`typecheck` scripts), `tsconfig.json` (strict, `moduleResolution: bundler`, ES2022, `types:["bun"]`, `skipLibCheck`), `bun install` resolved the toolkit, baseline `tsc` clean. Minimal `README.md` skeleton per plan Task 1 (full docs are Task 8).
- **Task 2 — Goal state store (`src/state.ts`) — DONE.** `GoalStore` (fs-backed, one goal/session, atomic write-temp-then-rename, ENOENT→undefined, missing-goal mutations are no-ops). `test/state.test.ts`: **4 pass**.
- **Task 3 — `/goal` verb parser (`src/verbs.ts`) — DONE.** `parseGoalArgs` → view/pause/resume/clear/set; bare single control word (case-insensitive) only; `"pause the pipeline"`→set. `test/verbs.test.ts`: **4 pass**.
- **Task 4 — Prompt renderer (`src/prompt.ts`) — DONE.** `renderGoalSystem` reads the provided verbatim `src/continuation.template.md`, fills `{{objective}}` XML-escaped in an `<objective>` block; `CONTINUE_NUDGE` exported. Tests assert objective, verbatim `goal_complete`/`goal_blocked`, untrusted-data sentence, `unproven`, a load-bearing sentence, and `&`/`<`/`>` escaping. `test/prompt.test.ts`: **5 pass**.
- **Task 5 — Completion tools (`src/tools.ts`) — DONE.** `makeGoalTools` → exactly `goal_complete`({summary?}) / `goal_blocked`({reason}) via `tool()`+`tool.schema`; read `ctx.sessionID`, transition active→complete/blocked, no-op message otherwise. `test/tools.test.ts`: **5 pass**.
- **Task 6 — Plugin wiring (`src/plugin.ts`, `index.ts`, `.opencode/command/goal.md`) — DONE.** Assembles A–E: `command.execute.before` (`goal` verbs), `experimental.chat.system.transform` (inject on active goal), `tool` (completion tools), `event` (uncapped `session.idle` loop + `res.error`/`session.error` brake). **No in-flight mutex** — sole gate is `status!=="active"`; `incrementTurn` before await; continuation omits `body.model`; blocks only on genuine model/turn errors, stays active on transport/disposal/throw. `GOAL_DEBUG_SINK` writes one JSONL line per inject and per continuation (Task 7 oracle). `test/plugin.unit.test.ts`: **17 pass** — incl. the no-mutex regression (two sequential idles → two continuations), model-error→blocked, transport-error→active, prompt-throw→active, session.error(model)→blocked.

## Test results

`bun test` (whole suite, final): **35 pass / 0 fail**, 94 expect() calls, 5 files.
Breakdown: state 4, verbs 4, prompt 5, tools 5, plugin.unit 17.
`tsc --noEmit`: **clean (exit 0)** across `src`, `test` (incl. the pre-existing `harness.ts`/`probe.plugin.ts`), and `index.ts`. Existing Task 0 harness/probe untouched and still typecheck.

## Global-constraint conformance

- **Uncapped / no mutex:** verified by `no mutex regression` test (2 idles → 2 continuations, still active) and code review — only gate is `status!=="active"`, counter set before await.
- **Error brake:** `res.error` **and** `session.error` both handled; `isModelTurnError` blocks genuine model/turn errors, leaves active on abort/transport; prompt throw caught → active; whole `event` body try/caught → only logs.
- **Model inheritance:** continuation omits `body.model` (asserted `undefined` in the idle test).
- **Injection hook:** `experimental.chat.system.transform` pushes `renderGoalSystem(goal)` onto `output.system` for active goals only (Task 0 primary).
- **Event/tool shapes:** `session.idle.properties.sessionID`, `ctx.sessionID` — matched to installed 1.15.6 types.

## Plan vs Task 0 conflicts

None encountered. All Task 0 findings were applied directly as the contract (system.transform primary, model-omit, res.error+session.error brake, no mutex). No case required overriding the plan with runtime findings.

## Deviations / concerns (forward-looking, for Task 7)

1. **State-dir resolution is env-driven.** The plugin builds its `GoalStore` from `GOAL_STATE_DIR` if set, else `<project>/.opencode/goal`. The plan specified `GoalStore(dir)` but not where the plugin sources `dir`. **Task 7 must set `GOAL_STATE_DIR` to a temp dir** to use the state-file `turnCount` as its oracle.
2. **Template loading via `import.meta.dir`.** `renderGoalSystem` reads the sibling `src/continuation.template.md`. This works in unit tests and when the package ships intact, but the current `test/harness.ts` copies a **single** plugin file into `.opencode/plugin/plugin.ts` (Task 0 shape) — that would not carry the sibling modules/template. **Task 7 must install/point at the full package or bundle it (e.g. `bun build`)**, per its Step 3 ("wire harness to install the built plugin"). No change made to the harness (out of scope / it's the Task 0 artifact).
3. **Non-`set` verb turn-suppression is not relied upon.** Task 0 did not confirm that emptying `output.parts` suppresses a model turn, so pause/resume/clear/view replace `output.parts` with a single confirmation/status text part instead of trying to cancel the turn. A trivial acknowledgment turn may run for those verbs; it triggers no continuation (the idle gate returns because the goal is paused/cleared/unchanged). If Task 7 finds suppression is preferable/possible, it's a localized change in `command.execute.before`.
4. **`isModelTurnError` is a heuristic boundary.** model/turn → blocked; transport/disposal (`MessageAbortedError`, or messages matching a connection/disposal/abort regex) → active. It matches Task 0's observed real failure (`UnknownError` w/ a model message → blocked). Exported for Task 7 reuse; Task 7.4 (real broken-model turn) exercises the blocked path end-to-end and can tighten the boundary if a real transport error surfaces under a non-abort name.
5. **Task 5 test shape** differs from the plan's literal sketch (which called complete then blocked on the *same* session — the second would no-op since the goal is no longer active). Tests use separate sessions per transition plus explicit no-op coverage; the plan's intent (both transitions verified) is fully met.

## Review fixes (post Tasks 1-6 code review)

Two Important findings from the task review were fixed in a single follow-up commit:

- **I1 - restored dropped verbatim bullets.** The Blocked-audit list in `src/continuation.template.md` had shrunk to 4 of upstream's 6 bullets. Restored (verbatim, with the `update_goal status "blocked"` -> `goal_blocked` swap, in upstream order): the *resume -> fresh blocked audit* rule and the *don't idle while claiming blocked; call `goal_blocked`* rule. Added `test/prompt.test.ts` guard `keeps all six blocked-audit bullets from the verbatim port` - asserts distinctive phrases ("fresh blocked audit", "three consecutive resumed goal turns", "do not keep reporting") and that the Blocked-audit section carries exactly six `- ` bullets, so the template can't silently shrink again.
- **I2 - strongly-typed the command-output parts.** `setParts` previously typed its param `{ parts: unknown[] }` and pushed `{ type:"text", text }`, masking the shape from tsc. Retyped the param to the real hook contract, derived so it can't drift: `type CommandBeforeOutput = Parameters<NonNullable<Hooks["command.execute.before"]>>[1]`. The hook declares `output.parts: Part[]` (server-side `TextPart` requires `id`/`sessionID`/`messageID`), but `command.execute.before`'s input is only `{ command, sessionID, arguments }` - no `messageID`, no part `id` - so a full `Part` cannot be built without inventing fields. Per the review's guidance, the constructed value is typed as the SDK's real minimal `TextPartInput` (tsc now verifies the `"text"` discriminant + `text:string`, no `unknown[]` widening) and bridged into the `Part` slot with a **single** narrowly-scoped `as` assertion plus a `// TODO(Task 7): verify replaced part renders as the user message` comment. A double-cast was **not** needed - `tsc --noEmit` is clean with the single assertion. Runtime confirmation that the replaced part renders is Task 7's job (unchanged).

**Post-fix verification:** `bun test` -> **36 pass / 0 fail** (was 35; +1 for the new blocked-audit guard), 98 expect() calls, 5 files. `tsc --noEmit` -> clean (exit 0).
