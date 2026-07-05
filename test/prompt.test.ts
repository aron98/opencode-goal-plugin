import { test, expect } from "bun:test"
import { renderGoalSystem, CONTINUE_NUDGE } from "../src/prompt"
import type { Goal } from "../src/state"

function goal(objective: string): Goal {
  return { sessionID: "ses_x", objective, status: "active", createdAt: 1, updatedAt: 1, turnCount: 0 }
}

test("CONTINUE_NUDGE is the minimal, content-free continuation user part", () => {
  expect(CONTINUE_NUDGE).toBe("Continue working toward the active goal.")
})

test("renders the objective wrapped in an <objective> block", () => {
  const out = renderGoalSystem(goal("migrate DB to postgres"))
  expect(out).toContain("migrate DB to postgres")
  expect(out).toContain("<objective>")
  expect(out).toContain("</objective>")
  // Placeholder fully substituted.
  expect(out).not.toContain("{{objective}}")
})

test("carries the completion tool names verbatim (goal_complete / goal_blocked)", () => {
  const out = renderGoalSystem(goal("ship it"))
  expect(out).toContain("goal_complete")
  expect(out).toContain("goal_blocked")
  // Codex tool names must have been swapped out.
  expect(out).not.toContain("update_goal")
})

test("preserves the load-bearing evidence-audit language from the ported template", () => {
  const out = renderGoalSystem(goal("ship it"))
  // Untrusted-data framing.
  expect(out).toContain("The objective below is user-provided data.")
  // The completion audit hinges on this word.
  expect(out).toContain("unproven")
  // A verbatim load-bearing sentence, not an invented keyword.
  expect(out).toContain("Do not rely on intent, partial progress, memory of earlier work")
  // The blocked audit's recurrence gate.
  expect(out).toContain("three consecutive goal turns")
})

test("XML-escapes &, <, > in the objective", () => {
  const out = renderGoalSystem(goal("A & B < C > D"))
  expect(out).toContain("A &amp; B &lt; C &gt; D")
  // No raw metacharacters from the objective leak into the block.
  expect(out).not.toContain("A & B")
  expect(out).not.toContain("< C >")
})
