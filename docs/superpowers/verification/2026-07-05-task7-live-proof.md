# Task 7 — Live End-to-End Proof + Install-Layout Discovery

Runtime: opencode `1.17.13`, model `google/gemini-2.5-flash-lite`, `opencode serve` + `opencode run --attach`.

## Install-layout discovery (load-bearing for distribution AND the harness)

**A plugin that `import`s `@opencode-ai/plugin` at runtime (we do — `tool()` in `tools.ts`) only resolves it when the plugin files live UNDER `.opencode/plugin/`.** opencode installs the plugin runtime deps into `<project>/.opencode/node_modules/@opencode-ai/{plugin,sdk}`; files outside that tree cannot resolve them.

- ❌ **Fails silently:** an entry in `.opencode/plugin/` that re-exports from an **absolute path outside** the project (e.g. `/tmp/pkg/plugin.ts`). The import chain throws (unresolved `@opencode-ai/plugin` in the outside `tools.ts`), so opencode never loads the module. No error surfaced; hooks simply never fire (state/sink empty). Diagnosed with a module-load probe: neither `entry-module-loaded` nor `GoalPlugin-factory-called` fired.
- ✅ **Works:** install the package as a **subdirectory** `.opencode/plugin/goalpkg/` (all `src/*.ts` + `continuation.template.md`) plus a single entry `.opencode/plugin/goal.ts`:
  ```ts
  export { GoalPlugin } from "./goalpkg/plugin.ts"
  ```
  goalpkg files resolve `@opencode-ai/plugin` via `.opencode/node_modules`; `import.meta.dir` in `prompt.ts` resolves the co-located template. opencode loads the top-level entry and does **not** double-load the subdir files as separate plugins (confirmed: exactly one `GoalPlugin-factory-called`, no errors).

**Consequences:**
- **Distribution:** ship as a package dir + a one-line entry re-export (or publish to npm and use `opencode.json` `plugin: []`). Not a bare single file, unless bundled with the template inlined.
- **Harness (`test/harness.ts`):** must install the package as `.opencode/plugin/<pkg>/` + entry, NOT a single-file copy. (The Task 0 harness used single-file copy — update it.)

## Live end-to-end proof (natural completion → loop stops)

`opencode run --attach … --command goal "Count from 1 to 3, writing exactly one number per reply, then finish"`, then observed for 10s:

**State file** `<GOAL_STATE_DIR>/<sessionID>.json`:
```json
{ "objective": "\"Count from 1 to 3, …\"", "status": "complete", "turnCount": 3, ... }
```
**Debug sink:** `inject=5`, `continue` lines `turnCount 1 → 2 → 3`.

Interpretation — every mechanism working together, uncapped:
1. `/goal` command set the goal (state file, `active`).
2. Objective + evidence-audit injected every turn (`inject`).
3. **Uncapped idle loop** ran 3 continuations with no cap and no mutex (`continue` 1→2→3).
4. The model, following the evidence-audit, called **`goal_complete`** once done → `status: complete`.
5. The loop **stopped on its own** (turnCount stable at 3, no runaway) — exactly Codex `/goal`: keeps working until the model proves completion, then halts.

## Harness recipe (proven)

- Boot: `opencode serve --port P --hostname 127.0.0.1`, cwd = temp project (with the pkg-dir install), `XDG_CONFIG_HOME` = temp cfg, env `GOAL_STATE_DIR` + `GOAL_DEBUG_SINK` = temp files. Wait for `server listening`.
- Dispatch `/goal`: `opencode run --attach <url> -m <model> --command goal "<args>"` (a plain `"/goal …"` message does NOT dispatch the command). Note: `--command` wraps args in quotes → objective may contain literal quotes; the parser treats the whole string as the objective (fine).
- Oracle: state-file `turnCount`/`status` + sink `kind:inject|continue`. "continues" = turnCount increments; "stopped" = turnCount stable across a quiet window; "injected" = a sink `inject` line carrying the objective.
