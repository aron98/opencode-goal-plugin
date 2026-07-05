# Task 0 — Hook-Behavior Verification Findings

**Runtime:** opencode `1.17.13`, `@opencode-ai/plugin`/`sdk` `1.15.6`. Method: `opencode serve` + `opencode run --attach` driving a probe plugin (`test/probe.plugin.ts`) that logs every hook to a JSONL sink. Two server boots (A: `MAX_CONT=2`; B: `BREAK_MODEL=1`). Raw evidence quoted below.

## Decisions (contract for Tasks 4–7)

| Unknown | Finding | Decision |
|---|---|---|
| **Injection fires on the idle *continuation* turn?** (Sam-2) | **YES.** `experimental.chat.system.transform` fired before the initial turn **and before each programmatic continuation**, every call with `hasSessionID:true`. | **Primary injection hook = `experimental.chat.system.transform`.** Push the goal block onto `output.system`. |
| **Is `system.transform` `sessionID` populated on 1.17.13?** (Nadia-3) | **YES**, always `hasSessionID:true`. No silent-no-op risk. `chat.message` also fires on continuations (viable fallback, `sessionID` always present). | Use `system.transform` primary; `chat.message` fallback only if needed. Renderer stays hook-agnostic (returns a string). |
| **Error-propagation shape** (Sam-1 / Nadia-2 / Priya-2) | `client.session.prompt` **does NOT throw** on a bad-model turn: `threw:false`, resolves `{ error: { name:"UnknownError", data:{ message, ref } } }`. **AND** an async **`session.error`** event fires with the richer message. | Brake reads **`res.error`** after the continuation **and** handles the **`session.error`** event. Both channels carry it. |
| **Model inheritance** | Omitting `body.model` works: continuations ran (`modelOmitted:true, threw:false, error:null`, tokens climbed 12510→13118→13752). | **Omit `body.model`** in continuations — inherit the session model. Do not hard-pin. |
| **Command dispatch** | `command.execute.before` **does NOT fire** for a plain `"/goal ..."` message via `run` (treated as a user message). It **DOES fire** via `opencode run --command goal "<args>"` (command="goal", arguments carry the text, sessionID + `output.parts` present). | Real users invoke `/goal` in the TUI (fires the hook). **Integration tests (Task 7) MUST dispatch `/goal` via `--command goal` or the command API — not a plain message.** |
| **Loop self-sequences w/o mutex** (Nadia-1) | Re-confirmed: idle→cont#1→idle→cont#2→idle(stop). Counter set-before-await, **no mutex**, no stall. | Task 6: gate on `status!=="active"` only. No in-flight mutex. |

## Evidence (quoted from the probe sink)

**Continuation injection + model inheritance (server A):**
```
{"hook":"system.transform","sessionID":"ses_..1U","hasSessionID":true,"systemLen":1}   ← initial turn
{"hook":"event","type":"session.idle","sid":"ses_..1U","priorConts":0}
{"hook":"system.transform","sessionID":"ses_..1U","hasSessionID":true,"systemLen":1}   ← CONTINUATION turn 1
{"hook":"continuation.result","cont":1,"modelOmitted":true,"threw":false,"error":null}
{"hook":"system.transform","sessionID":"ses_..1U","hasSessionID":true,"systemLen":1}   ← CONTINUATION turn 2
{"hook":"continuation.result","cont":2,"modelOmitted":true,"threw":false,"error":null}
```

**Error shape (server B, broken model id):**
```
{"hook":"continuation.result","cont":1,"modelOmitted":false,"threw":false,
 "error":{"name":"UnknownError","data":{"message":"Unexpected server error...","ref":"err_121404c9"}}}
{"hook":"event","type":"session.error","props":{"sessionID":"ses_..yc",
 "error":{"name":"UnknownError","data":{"message":"Model not found: google/gemini-DOES-NOT-EXIST-9x..."}}}}
```

**Command dispatch (via `--command goal "buy milk"`):**
```
{"hook":"command.before","command":"goal","arguments":"\"buy milk\"","sessionID":"ses_..hA","outParts":1}
```
(Plain `"/goal buy milk"` message → **zero** `command.before` entries.)

## Plan impact

- **Confirms** v2 architecture: `system.transform` injection, `res.error`+`session.error` brake, model-omit, no mutex. No task rewrites needed.
- **New constraint for Task 7:** dispatch `/goal` verbs via `--command goal`/command API. Add a `driveCommand()` to the harness alongside `driveMessage()`.
- **Note:** `system.transform` also fires for auxiliary model calls (e.g. title generation) — injecting the goal there is harmless; no action.
