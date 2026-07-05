# Opencode `/goal` Plugin — Design Spec

**Date:** 2026-07-05
**Status:** Approved in principle (uncapped model); open decisions flagged for panel review

## 1. Goal

Reproduce OpenAI Codex CLI's `/goal` feature inside Opencode **as a plugin, without modifying Opencode source**: a persistent, self-verifying objective that keeps a session working across turns until the model *proves* completion (or the user stops it). It must be **uncapped** — no iteration, wall-clock, or token limit — matching Codex's behavior when run with unlimited tokens and no `token_budget`.

## 2. Motivation & fidelity target

Codex `/goal` (crate `codex-rs/ext/goal/`) = four mechanisms:

1. **Persistent per-thread state** (objective + status), *not* project instructions/memory.
2. **A continuation prompt re-injected every turn** carrying an "evidence audit": treat completion as unproven; verify every requirement against real current state before stopping.
3. **A completion tool** the model calls to stop (`update_goal(status: complete|blocked)`), plus `create_goal`/`get_goal`. The model can *complete/block* but **cannot** pause/resume itself.
4. **An idle-driven auto-continuation loop** that starts the next turn while the goal is active.

Confirmed in research: with unlimited tokens / no `token_budget`, **nothing mechanical stops the loop** — no max-iterations, no wall-clock, no "no-tool suppression." The only terminators are: model calls `update_goal(complete|blocked)`; a turn error auto-blocks; or the user pauses/clears. **We replicate this exactly. A cap is explicitly prohibited by the user.**

## 3. Proven environment facts (from the spike, opencode 1.17.13)

These are load-bearing and already verified end-to-end — the plan must not re-litigate them, but the build must not contradict them:

- **Plugins load** from `.opencode/plugin/` (and `.opencode/plugins/`), project and global (`~/.config/opencode/plugin/`). Confirmed: plugin loaded in both `run` and `serve`.
- **`event` hook receives `session.idle`** as `{ type: "session.idle", properties: { sessionID: string } }`. Confirmed delivered.
- **`client.session.prompt({ path:{id}, body:{ model, parts } })` starts a real new turn that runs the model to completion.** Proven by transcript: injected turns produced real assistant replies (`READY` → `CONTINUED` → `CONTINUED`), and each completion emitted the next `session.idle`, so the loop self-sequences through idle events.
- **Reentrancy:** event handlers fire concurrently — the next `session.idle` can arrive before the previous `prompt()` await returns. **State guards must be set *before* the await.**
- **`opencode run` (one-shot) disposes the instance right after the first turn** (`"exiting loop"` → `"disposing instance"`), cutting continuations off. The loop only runs under a **persistent host** (interactive TUI, `opencode serve`, or `run --attach`). The plugin must **no-op gracefully** in one-shot mode rather than fight it.
- **SDK/server version drift is real:** installed `@opencode-ai/sdk` is `1.15.6`, server is `1.17.13`; hand-rolled HTTP schemas had drifted. The **in-process plugin `client` is version-matched and works** — build on the plugin `client`, never hand-rolled HTTP. Pin `@opencode-ai/plugin`.

## 4. Architecture

TypeScript plugin (Bun runtime), distributed as a repo that installs into `~/.config/opencode/plugin/` (global `/goal` everywhere) or a project `.opencode/plugin/`.

### Components

| # | Component | Mechanism | Responsibility |
|---|-----------|-----------|----------------|
| A | **Goal state store** | JSON file keyed by `sessionID` | One goal per session: `{ objective, status, createdAt, updatedAt, turnCount }`. Durable across restarts. |
| B | **`/goal` command surface** | command markdown + plugin `command.execute.before` | `/goal <objective>` set; `/goal` view; `/goal pause`; `/goal resume`; `/goal clear`. Parses sub-verbs, mutates state, seeds the first turn. |
| C | **Per-turn re-injection** | `experimental.chat.system.transform` | Append the active objective + continuation/evidence-audit prompt to `output.system` every request. |
| D | **Completion tools** | plugin `tool` hook | `goal_complete`, `goal_blocked` (the brake); `goal_status` (read). Model-only; mirror Codex asymmetry (no self-pause/resume). |
| E | **Auto-continuation loop** | `event` on `session.idle` | If session has an `active` goal → `client.session.prompt(continuation)`. Idle-only single-flight guard (concurrency, **not** a cap). Uncapped. |
| F | **Compaction survival** (nice-to-have) | `experimental.session.compacting` | Push the goal into `output.context` so long runs keep it. |

### Stop conditions (complete list — nothing else)

1. Model calls `goal_complete` or `goal_blocked` → status leaves `active` → loop stops.
2. User `/goal pause` or `/goal clear`.
3. Turn error → status `blocked` (prevents error-loop; Codex does this too).

No max-iterations. No wall-clock. No token budget.

### The brake is the prompt, not a number

Component C's continuation prompt is ported near-verbatim from Codex `continuation.md`: objective wrapped as untrusted data; "treat completion as unproven, derive concrete requirements, find authoritative evidence for each against real current state, only then call `goal_complete`"; blocked only after a genuine repeated impasse. This evidence-audit is what makes an uncapped loop terminate correctly instead of stopping early or never.

## 5. Non-goals

- Token budgets / any cap (prohibited).
- Multiple goals per session.
- Persisting goal *history*/analytics.
- Reproducing Codex's TUI status bar (a `toast`/status line is a stretch nice-to-have, not required).

## 6. Open decisions (for the panel)

1. **Command mechanics.** Does `/goal <text>` need a command markdown file to exist for the slash command to register, with the plugin's `command.execute.before` adding statefulness — or can the plugin surface `/goal` alone? Needs verification against 1.17.13 (`command.execute.before` input shape `{ command, sessionID, arguments }` seen in installed types).
2. **Initial-turn kick.** On `/goal <text>`, does setting `output.parts` in `command.execute.before` both record state *and* run the first goal turn, or do we set state and let the normal turn proceed with C injecting the objective?
3. **State location.** `~/.local/share/opencode-goal/<sessionID>.json` vs. a single JSON map vs. project-local. Concurrency: multiple sessions write concurrently.
4. **Single-flight guard.** Keep the idle-only "one continuation per idle" guard (Codex-style, concurrency only) or drop it? (User is cap-averse; confirm it is not a limiter.)
5. **`experimental.*` risk.** `chat.system.transform` is unstable across versions. Fallback: inject via `chat.message` parts. Which is primary?

## 7. Test strategy

Highest-abstraction tests that prove the **user stories**, via an **integration harness** (the spike, productized): boot `opencode serve` with the plugin + a temp config, drive sessions via the version-matched SDK/`client`, assert on **session transcripts and the state file**. Unit tests only for pure logic (state store, sub-verb parsing, prompt rendering). Real model turns use a cheap model (`google/gemini-2.5-flash-lite`) — the same one the spike proved works.

**Key user-story tests:**
- Setting a goal makes the session continue past the first turn (≥2 auto-continuations observed) with the objective present in system context.
- `goal_complete` stops the loop; the transcript shows no further continuations.
- `/goal pause` / `/goal clear` stop the loop.
- A turn error blocks the goal (no infinite error loop).
- No-goal sessions are untouched (no continuations injected).
- One-shot `opencode run` does not hang or loop (graceful no-op).

## 8. Tech stack

TypeScript, `@opencode-ai/plugin` (pinned), Bun. No hand-rolled HTTP. Integration harness in Bun/TS driving `opencode serve`.
