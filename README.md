# opencode-goal-plugin

An [Opencode](https://opencode.ai) plugin that reproduces Codex CLI's `/goal`: a
persistent, self-verifying objective that keeps a session working across turns
until the model **proves** completion or the user stops it — **uncapped** (no
max-iterations, no wall-clock, no token budget), with no source changes to Opencode.

Set a goal once; the plugin re-engages the model every time the session goes idle,
injecting the objective plus a verbatim-ported evidence-audit prompt, and drives the
loop forward until the model calls `goal_complete`/`goal_blocked`, you pause or clear
it, or a real turn error trips the brake.

## How it works

1. **`/goal <objective>`** stores a per-session goal (`active`) and seeds the first turn.
2. **Every turn**, the objective and a verbatim port of Codex's evidence-audit prompt
   are injected into the system prompt (via `experimental.chat.system.transform`).
3. **When the session goes idle** with an `active` goal, the plugin re-prompts it (a
   "continuation") through the in-process, version-matched client — **indefinitely**.
   The only gate is `status === "active"`; there is no counter, timer, or budget, and
   no in-flight mutex.
4. **The model ends the loop** by calling `goal_complete` (or `goal_blocked`) once the
   injected audit is satisfied. That is the brake — the audit, not a number.

The audit (`src/continuation.template.md`) is ported near-verbatim from
`openai/codex` — "treat completion as unproven; verify every requirement against real
current state before completing" — which is exactly what makes "run until actually
done" safe without a ceiling.

## Stop model (uncapped)

The loop runs forever until one of these terminal conditions:

| Condition | Trigger | Result |
|---|---|---|
| **Complete** | model calls `goal_complete` | `status: complete`, loop stops |
| **Blocked** | model calls `goal_blocked` | `status: blocked`, loop stops |
| **Paused** | user runs `/goal pause` | `status: paused`, objective preserved; `/goal resume` continues |
| **Cleared** | user runs `/goal clear` | goal removed |
| **Turn error** | a genuine model/turn error (`res.error` or a `session.error` event) | `status: blocked` |

Transport/disposal blips (aborts, disconnects, a one-shot instance being disposed) are
**not** treated as failures — the goal stays `active` and resumes under the next
persistent host. There is **no** automatic iteration, time, or token limit.

## `/goal` verbs

| Command | Action |
|---|---|
| `/goal <objective>` | Set (or replace) the goal and start working toward it |
| `/goal` | View the current goal — status and turn count |
| `/goal pause` | Stop automatic continuations; keep the objective |
| `/goal resume` | Resume automatic continuations |
| `/goal clear` | Remove the goal for this session |

`pause` / `resume` / `clear` are recognized only as the entire argument; anything else
(e.g. `pause the pipeline`) is treated as a new objective.

## Model tools

The model — and only the model — can declare a terminal outcome (mirroring Codex's
asymmetry: no self-pause/resume):

- **`goal_complete({ summary?: string })`** — declare the goal complete. Only after the
  injected completion audit proves every requirement against current state.
- **`goal_blocked({ reason: string })`** — declare the goal blocked. Only after the
  strict blocked audit (same blocker recurring across turns; a true impasse needing
  user input).

## Install

The plugin ships as a **package directory + a one-line entry**, installed by
`scripts/install.sh`. (It must live under the opencode plugin directory: the plugin
imports `@opencode-ai/plugin` at runtime, and opencode only resolves that dependency
for files under `plugin/`. A single file that references sources outside that tree is
silently skipped.)

```sh
# Global — available in every session:
scripts/install.sh ~/.config/opencode

# ...or per-project:
scripts/install.sh /path/to/your/project
```

This copies `src/*` into `.../plugin/goalpkg/`, writes the entry
`.../plugin/goal.ts` (`export { GoalPlugin } from "./goalpkg/plugin.ts"`), and installs
the `/goal` command (`.../command/goal.md`). `src/` remains the single source of truth;
re-run the script to update. Then restart the TUI / server.

### Persistent-host caveat

The continuation loop is driven by `session.idle` in a **persistent host** — the TUI
(`opencode`) or a server (`opencode serve`). Under one-shot `opencode run`, the
instance disposes right after the first turn, so the goal is set but the auto-
continuations do not run to completion (the loop no-ops rather than hanging). Use the
TUI or `opencode serve` to actually run a goal to completion.

## Configuration

Environment variables (all optional):

- `GOAL_STATE_DIR` — where per-session goals persist (default: `<project>/.opencode/goal`).
- `GOAL_DEBUG_SINK` — path to a JSONL file; one line is written per injection and per
  continuation (`{kind:"inject"|"continue", sessionID, ...}`). Used as the deterministic
  test oracle; handy for debugging.
- `GOAL_DEBUG` — set to log plugin decisions to stderr.

## Development

```sh
bun install
bun test            # unit tests + live integration tests (real inference; needs a model)
bun test test/state.test.ts test/verbs.test.ts test/prompt.test.ts \
         test/tools.test.ts test/plugin.unit.test.ts   # unit tests only (no network)
tsc --noEmit        # typecheck
```

Unit tests cover the store, verb parser, verbatim prompt renderer, tools, and the full
plugin wiring (including the error brake against the real observed error shape and the
"no cap-of-1 mutex" regression). `test/integration.test.ts` drives a live `opencode
serve` with a real model and asserts against the state-file/sink oracle — it continues,
self-completes and stops; pauses; clears; and leaves no-goal sessions untouched.

The design rationale and the empirical facts this port is built on (injection hook
choice, error shape, model inheritance, and the pkg-dir install-layout discovery) are
recorded under [`docs/superpowers/verification/`](docs/superpowers/verification/).
