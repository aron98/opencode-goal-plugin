// Model-only completion tools. Mirrors Codex's asymmetry: the model can declare a
// goal complete or blocked, but cannot pause/resume itself (those are user verbs).
// goal_status was intentionally dropped (YAGNI) — status is injected every turn and
// the `/goal` view covers the user side.

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { GoalStore } from "./state"

export function makeGoalTools(store: GoalStore): Record<string, ToolDefinition> {
  return {
    goal_complete: tool({
      description:
        "Declare the active goal complete. Only call this after the completion audit " +
        "proves every requirement is satisfied against current state. See the injected " +
        "goal system block for the audit you must pass first.",
      args: {
        summary: tool.schema
          .string()
          .optional()
          .describe("Optional short summary of what was accomplished."),
      },
      async execute(args, ctx) {
        const id = ctx.sessionID
        const goal = store.get(id)
        if (!goal || goal.status !== "active") {
          return "No active goal to complete."
        }
        store.setStatus(id, "complete")
        return args.summary
          ? `Goal marked complete: ${args.summary}`
          : "Goal marked complete."
      },
    }),
    goal_blocked: tool({
      description:
        "Declare the active goal blocked. Only call this when the strict blocked audit " +
        "in the injected goal system block is satisfied (the same blocker has recurred " +
        "across turns and you cannot make meaningful progress without user input).",
      args: {
        reason: tool.schema
          .string()
          .describe("Why the goal is blocked and what is needed to unblock it."),
      },
      async execute(args, ctx) {
        const id = ctx.sessionID
        const goal = store.get(id)
        if (!goal || goal.status !== "active") {
          return "No active goal to block."
        }
        store.setStatus(id, "blocked")
        return `Goal marked blocked: ${args.reason}`
      },
    }),
  }
}
