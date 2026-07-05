import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { appendFileSync } from "node:fs"

// Task 0 probe: logs every load-bearing hook invocation to $PROBE_LOG and,
// on session.idle, fires a continuation to characterize (a) whether injection
// hooks run on programmatic continuation turns, (b) the error-propagation shape,
// (c) model inheritance. Driven by env:
//   PROBE_LOG        - required, path to JSONL log
//   PROBE_MAX_CONT   - max auto-continuations per session (default 0)
//   PROBE_BREAK_MODEL- if set, continuation uses a nonexistent model id (force error)
const LOG = process.env.PROBE_LOG || "/tmp/probe.log"
const MAX = Number(process.env.PROBE_MAX_CONT || "0")
const BREAK = !!process.env.PROBE_BREAK_MODEL
const rec = (o: unknown) => { try { appendFileSync(LOG, JSON.stringify(o) + "\n") } catch {} }

export const Probe: Plugin = async ({ client }) => {
  rec({ hook: "loaded", MAX, BREAK })
  const conts = new Map<string, number>()
  return {
    event: async ({ event }) => {
      const t = event.type
      if (!t.startsWith("session.")) return
      const props = (event as any).properties
      if (t !== "session.idle") { rec({ hook: "event", type: t, props }); return }
      const sid = props?.sessionID as string
      const n = conts.get(sid) ?? 0
      rec({ hook: "event", type: t, sid, priorConts: n })
      if (n >= MAX) return
      conts.set(sid, n + 1) // set BEFORE await (reentrancy-safe; no mutex)
      const body: any = { parts: [{ type: "text", text: `PROBE_CONTINUATION_${n + 1}: reply with only the word CONTINUED` }] }
      if (BREAK) body.model = { providerID: "google", modelID: "gemini-DOES-NOT-EXIST-9x" }
      // else: omit model entirely -> tests session-model inheritance
      let threw = false, errPayload: unknown = undefined
      try {
        const res: any = await client.session.prompt({ path: { id: sid }, body })
        errPayload = res?.error ?? null
      } catch (e) {
        threw = true
        errPayload = e instanceof Error ? e.message : String(e)
      }
      rec({ hook: "continuation.result", sid, cont: n + 1, modelOmitted: !BREAK, threw, error: errPayload })
    },
    "experimental.chat.system.transform": async (i: any, o: any) => {
      rec({ hook: "system.transform", sessionID: i?.sessionID ?? null, hasSessionID: i?.sessionID != null, systemLen: o.system.length })
      o.system.push("PROBE_SYS_MARKER")
    },
    "chat.message": async (i: any, o: any) => {
      rec({ hook: "chat.message", sessionID: i?.sessionID ?? null, hasSessionID: i?.sessionID != null, parts: o.parts?.length })
    },
    "command.execute.before": async (i: any, o: any) => {
      rec({ hook: "command.before", command: i?.command, arguments: i?.arguments, sessionID: i?.sessionID, outParts: o?.parts?.length })
    },
    tool: {
      probe_tool: tool({ description: "probe", args: {}, async execute(_a: any, ctx: any) { rec({ hook: "tool", ctxKeys: Object.keys(ctx || {}), sessionID: ctx?.sessionID }); return "ok" } }),
    },
  }
}
