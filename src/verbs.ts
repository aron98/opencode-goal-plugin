// Parser for the `/goal` argument string (the text after "/goal").
//
// Grammar (matches Codex's UX, adapted):
//   ""            -> view    (show the current goal)
//   "pause"       -> pause   (single bare control word, case-insensitive)
//   "resume"      -> resume
//   "clear"       -> clear
//   <anything else> -> set   (the full trimmed text becomes the objective)
//
// A control word only counts as a verb when it is the ENTIRE argument. Multi-word
// input like "pause the pipeline" is an objective, not the pause verb.

export type GoalAction =
  | { kind: "view" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "set"; objective: string }

const CONTROL_VERBS = new Set<"pause" | "resume" | "clear">(["pause", "resume", "clear"])

export function parseGoalArgs(args: string): GoalAction {
  const trimmed = args.trim()
  if (trimmed === "") return { kind: "view" }

  const lowered = trimmed.toLowerCase()
  // Single bare control word only (no embedded whitespace).
  if (!/\s/.test(trimmed) && CONTROL_VERBS.has(lowered as "pause" | "resume" | "clear")) {
    return { kind: lowered as "pause" | "resume" | "clear" }
  }

  return { kind: "set", objective: trimmed }
}
