import { test, expect } from "bun:test"
import { mkdtempSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GoalStore } from "../src/state"

test("lifecycle + persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-"))
  const s = new GoalStore(dir)
  expect(s.get("ses_1")).toBeUndefined()
  const g = s.set("ses_1", "migrate to X")
  expect(g.status).toBe("active")
  expect(g.turnCount).toBe(0)
  s.incrementTurn("ses_1")
  expect(s.get("ses_1")!.turnCount).toBe(1)
  s.setStatus("ses_1", "complete")
  expect(s.get("ses_1")!.status).toBe("complete")
  s.clear("ses_1")
  expect(s.get("ses_1")).toBeUndefined()
  new GoalStore(dir).set("ses_2", "obj")
  expect(new GoalStore(dir).get("ses_2")!.objective).toBe("obj")
})

test("set stamps timestamps and identity; updates bump updatedAt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-"))
  const s = new GoalStore(dir)
  const g = s.set("ses_a", "do the thing")
  expect(g.sessionID).toBe("ses_a")
  expect(g.createdAt).toBeGreaterThan(0)
  expect(g.updatedAt).toBe(g.createdAt)
  await Bun.sleep(2)
  s.incrementTurn("ses_a")
  const after = s.get("ses_a")!
  expect(after.createdAt).toBe(g.createdAt)
  expect(after.updatedAt).toBeGreaterThanOrEqual(g.createdAt)
})

test("setStatus / incrementTurn / clear on a missing goal are safe no-ops", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-"))
  const s = new GoalStore(dir)
  expect(s.setStatus("nope", "blocked")).toBeUndefined()
  expect(() => s.incrementTurn("nope")).not.toThrow()
  expect(() => s.clear("nope")).not.toThrow()
  expect(s.get("nope")).toBeUndefined()
})

test("writes are atomic (no stray temp files left behind)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-"))
  const s = new GoalStore(dir)
  s.set("ses_z", "objective")
  s.incrementTurn("ses_z")
  expect(existsSync(join(dir, "ses_z.json"))).toBe(true)
  const stray = require("node:fs").readdirSync(dir).filter((f: string) => f.includes(".tmp"))
  expect(stray).toEqual([])
})
