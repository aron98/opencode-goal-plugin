import { test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GoalStore } from "../src/state"
import { makeGoalTools } from "../src/tools"
import type { ToolContext } from "@opencode-ai/plugin"

function ctx(sessionID: string): ToolContext {
  return { sessionID } as unknown as ToolContext
}

function freshStore(): GoalStore {
  return new GoalStore(mkdtempSync(join(tmpdir(), "gt-")))
}

test("exposes exactly goal_complete and goal_blocked (no self-pause/resume/status)", () => {
  const tools = makeGoalTools(freshStore())
  expect(Object.keys(tools).sort()).toEqual(["goal_blocked", "goal_complete"])
})

test("goal_complete on an active goal -> status complete, confirmation mentions completion", async () => {
  const store = freshStore()
  store.set("ses_c", "do the thing")
  const tools = makeGoalTools(store)
  const res = await tools.goal_complete!.execute({}, ctx("ses_c"))
  const text = typeof res === "string" ? res : res.output
  expect(text.toLowerCase()).toContain("complete")
  expect(store.get("ses_c")!.status).toBe("complete")
})

test("goal_blocked on an active goal -> status blocked, reason echoed", async () => {
  const store = freshStore()
  store.set("ses_b", "do the thing")
  const tools = makeGoalTools(store)
  const res = await tools.goal_blocked!.execute({ reason: "stuck" }, ctx("ses_b"))
  const text = typeof res === "string" ? res : res.output
  expect(text.toLowerCase()).toContain("block")
  expect(text).toContain("stuck")
  expect(store.get("ses_b")!.status).toBe("blocked")
})

test("no active goal -> clear no-op message, no state created", async () => {
  const store = freshStore()
  const tools = makeGoalTools(store)
  const res = await tools.goal_complete!.execute({}, ctx("ses_none"))
  const text = typeof res === "string" ? res : res.output
  expect(text.toLowerCase()).toContain("no active goal")
  expect(store.get("ses_none")).toBeUndefined()
})

test("completing twice is a safe no-op the second time", async () => {
  const store = freshStore()
  store.set("ses_d", "do the thing")
  const tools = makeGoalTools(store)
  await tools.goal_complete!.execute({}, ctx("ses_d"))
  const res = await tools.goal_complete!.execute({}, ctx("ses_d"))
  const text = typeof res === "string" ? res : res.output
  expect(text.toLowerCase()).toContain("no active goal")
  expect(store.get("ses_d")!.status).toBe("complete")
})
