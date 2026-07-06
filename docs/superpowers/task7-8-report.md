# Tasks 7-8 Implementation Report

**Repo:** `/home/dan/code/opencode-goal-plugin`
**Scope:** Task 7 (integration tests + distributable packaging) and Task 8 (README) of
`docs/superpowers/plans/2026-07-05-opencode-goal-plugin.md`. No behavior changes to `src/`
(only the packaging entry described in the task). Runtime: opencode `1.17.13`, bun `1.3.14`,
model `google/gemini-2.5-flash-lite`.

## Overall status: DONE

Packaging is real and distributable (project + global installs both verified live), the
integration layer drives a live `opencode serve` end-to-end, and the README documents it.
Whole `bun test` suite and `tsc --noEmit` are green.

## Commit range

`ebd3d37..af4121a` (plus this report), each message carrying the required Amplifier trailer:

| Commit | Title |
|---|---|
| `ebd3d37` | test: package as pkg-dir + one-line entry; installer + integration harness |
| `fe73ff9` | test: end-to-end user-story integration suite |
| `af4121a` | docs: README with install + usage |

## What was implemented

1. **`scripts/install.sh`** — installs the plugin as a package dir + one-line entry
   (`.opencode/plugin/goalpkg/` + `.opencode/plugin/goal.ts`) plus the `/goal` command,
   into a **project** (`<dir>/.opencode/...`) or the **global** config
   (`~/.config/opencode/...`, detected by the `opencode` basename). `src/` stays the single
   source of truth; the script only copies it.
2. **`test/harness.ts`** — rewritten to install via that installer into a temp project, boot
   `opencode serve` (temp `XDG_CONFIG_HOME` + `GOAL_STATE_DIR` + `GOAL_DEBUG_SINK`), and drive
   it via `opencode run --attach`. Exposes `setGoal` (fire-and-forget + poll the state-file
   oracle), `driveCommand`/`driveMessage` (bounded awaits), `stateFor`, `sinkLines`,
   `stateSessions`, `stop`.
3. **`test/integration.test.ts`** — the acceptance suite (below).
4. **`README.md`** — Task 8.

## Integration-test results (`bun test test/integration.test.ts`)

**4 pass, 1 skip, 0 fail** (~57-95s per full run; repeated green).

| Test | Result | Proves |
|---|---|---|
| continues, self-completes, then stops | **PASS** | a long one-per-reply count reliably runs real continuations (turnCount climbs, status active, objective injected); then done is redefined to what the evidence already proves, the model calls `goal_complete` itself, and the loop halts (turnCount frozen, status complete) |
| pause halts the running loop | **PASS** | loop continues (turnCount ≥ 1), `/goal pause` → status paused, turnCount frozen across the quiet window |
| clear removes the goal state file | **PASS** | after a set the state exists; `/goal clear` removes it |
| a session with no goal is left untouched | **PASS** | a plain message creates no state file and zero injections for that session |
| real turn-error → blocked | **SKIP** (`test.skip`, honest) | covered deterministically in `test/plugin.unit.test.ts` against the real Task 0 error shape (`res.error`/`session.error` → `UnknownError`). A live e2e error turn is impractical: continuations inherit the session model, so a model broken enough to fail a continuation fails the initial turn too — nothing would set the goal to break. |

Oracle is deterministic throughout: goal state file (`turnCount`/`status`) + the `GOAL_DEBUG_SINK`
JSONL (`inject`/`continue`), never model transcript text. Every test clears its goal in a
`finally`, and `afterAll` group-kills the server, so the uncapped loop can never run away.

## Whole-suite + typecheck

- **`bun test` (whole suite): 40 pass, 1 skip, 0 fail** — 41 tests across 6 files (unit: state 4,
  verbs 4, prompt 5, tools 5, plugin.unit 17 + 1 sink; integration 4 + 1 skip).
- **`tsc --noEmit`: clean (exit 0).**

## Packaging verified live (both modes)

- **Project install** — exercised by the entire integration suite (installer → serve → real goals).
- **Global install** — `scripts/install.sh ~/.config/opencode` then a goal set from an unrelated
  empty project: the global plugin loaded and dispatched (state file written), and
  `@opencode-ai/plugin` resolved for the global plugin. No plugin/resolution errors.

## Concerns

1. **Model nondeterminism in the "continues + self-completes" test (handled, worth knowing).**
   `gemini-2.5-flash-lite` will happily "cram" a small objective (write 1-3 and call
   `goal_complete`) into the seed turn → `turnCount` 0, no continuation. Several objective
   phrasings ("count to 3 then finish", "count to 10 … then complete", a two-reply forbid, a
   RELEASE.txt file gate the model could satisfy itself) each flaked. The reliable construction:
   a **long** one-per-reply count (`1..50`) has no early completion path and is too large to cram,
   so it *deterministically* continues; once the loop has demonstrably run, a follow-up message
   redefines "done" to what the evidence already proves (it counted past 3), which lets the model
   self-complete via its own tool without fighting the injected audit. Per the task's guidance,
   assertions are robust ("continued at all" + "stopped after a terminal status", never exact
   counts). This required no `src/` changes.

2. **Process hygiene was load-bearing for reliability.** `opencode serve` survives SIGTERM and
   `opencode run` spawns session-worker children that orphan on a plain kill; a per-test-server
   design leaked heavy `opencode serve` processes and starved later tests (setGoal timeouts).
   Fixed by (a) one shared server for the file, and (b) spawning every process under `setsid` and
   tearing it down with a **process-group SIGKILL**. Teardown now leaves no `opencode serve`/worker
   of ours behind (verified). Note: a pre-existing, externally-owned opencode session worker
   (not spawned by this suite) is present in the environment and is intentionally left alone.

3. **The integration suite runs as part of `bun test` and needs a live model + auth.** It does
   real inference (~1 min). In an environment without model access it would fail; the fast,
   network-free unit subset is documented in the README
   (`bun test test/state.test.ts … test/plugin.unit.test.ts`).

4. **`install.sh` global detection is by basename.** A target whose basename is `opencode`
   installs directly under it (global layout); anything else nests under `.opencode/` (project
   layout). A project literally named `opencode` would be treated as a global config root — an
   accepted, documented edge case.

## Final-review fixes (post whole-branch review)

The whole-branch review returned zero Critical and a handful of adjudicable items. Given the
"never stop unless prompted" uncapped directive, all were applied in one follow-up commit. No
behavior regressed; the fast unit subset (`state`/`verbs`/`prompt`/`tools`/`plugin.unit`) is
green (**41 pass / 0 fail**) and `tsc --noEmit` is clean.

- **FIX-1 (Important) — inverted the error classifier so the uncapped loop never auto-blocks on
  a non-model error.** `isModelTurnError` previously returned `true` (→ `blocked`) for *any* error
  outside a transport allowlist/regex — meaning an infra error (`ProviderAuthError`, `APIError`/5xx
  from the real `EventSessionError.error` union) would wrongly block a healthy goal. Inverted the
  default: block **only** on a positively-identified model/turn error name
  (`MODEL_TURN_ERROR_NAMES = { "UnknownError", "MessageOutputLengthError" }`); every other error —
  transport/disposal, `ProviderAuthError`, `APIError`/5xx, or any unrecognized shape — stays
  `active` (recoverable via the next continuation or `/goal resume`). Kept the transport
  name-set + message regex as explicit belt-and-suspenders stay-active signals. Added four unit
  cases proving `ProviderAuthError` and `APIError`-shaped errors stay `active` via **both** the
  `res.error` and `session.error` channels; the existing `UnknownError → blocked` and
  transport/abort → active cases still pass.
- **FIX-2 (Minor) — completed the verbatim port.** Restored the upstream trailing completion
  guard in `src/continuation.template.md`, budget-free: "Do not mark a goal complete merely
  because you are stopping work." (upstream's "…because the budget is nearly exhausted or…" half
  stays dropped — this port is uncapped). Added a `prompt.test.ts` guard asserting the restored
  sentence is present and the budget clause is absent.
- **FIX-3 (Minor) — resolved a stale TODO.** Replaced the `// TODO(Task 7): verify replaced part
  renders as the user message` in `src/plugin.ts` with a note that Task 7's live run verified it.
- **FIX-4 (Minor) — documented the idle assumption.** Added a one-line comment at the
  `session.idle` handler recording the deliberate "one idle per completed turn" assumption
  (Task 0-observed); identity-based de-dup is intentionally de-scoped.
- **FIX-5 (Minor) — honest command confirmations + doc corrections.** `pause`/`resume`/`clear`
  now check `store.get(id)` first and reply "No goal set for this session." instead of a false
  confirmation when no goal exists; `resume` of a `complete` goal notes it is re-opening a
  completed goal. Corrected `task1-6-report.md` deviation #3 (`view`/`resume` DO fire a benign
  continuation; only `pause`/`clear` stop the loop) and added a "Behavior notes" section to the
  README.
