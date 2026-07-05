import { test, expect } from "bun:test"
import { parseGoalArgs } from "../src/verbs"

test("empty / whitespace-only args -> view", () => {
  expect(parseGoalArgs("")).toEqual({ kind: "view" })
  expect(parseGoalArgs("  ")).toEqual({ kind: "view" })
  expect(parseGoalArgs("\t\n")).toEqual({ kind: "view" })
})

test("bare single-word control verbs (case-insensitive) -> verb", () => {
  expect(parseGoalArgs("pause")).toEqual({ kind: "pause" })
  expect(parseGoalArgs("PAUSE")).toEqual({ kind: "pause" })
  expect(parseGoalArgs("  Resume  ")).toEqual({ kind: "resume" })
  expect(parseGoalArgs("resume")).toEqual({ kind: "resume" })
  expect(parseGoalArgs("clear")).toEqual({ kind: "clear" })
  expect(parseGoalArgs("CLEAR")).toEqual({ kind: "clear" })
})

test("free-form text -> set with full trimmed objective", () => {
  expect(parseGoalArgs("migrate to postgres")).toEqual({ kind: "set", objective: "migrate to postgres" })
  expect(parseGoalArgs("  migrate to postgres  ")).toEqual({ kind: "set", objective: "migrate to postgres" })
})

test("a control word embedded in a longer objective is NOT a verb", () => {
  expect(parseGoalArgs("pause the pipeline")).toEqual({ kind: "set", objective: "pause the pipeline" })
  expect(parseGoalArgs("clear the build cache")).toEqual({ kind: "set", objective: "clear the build cache" })
  expect(parseGoalArgs("resume onboarding flow")).toEqual({ kind: "set", objective: "resume onboarding flow" })
})
