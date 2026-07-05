// Continuation / system-prompt renderer.
//
// The brake on the uncapped loop is NOT a numeric cap; it is this injected
// evidence-audit prompt plus the model's completion tool. The audit is a VERBATIM
// port of Codex CLI's continuation.md (see src/continuation.template.md for the
// source URL + adaptation notes) — do not paraphrase it here. Only {{objective}}
// is substituted, XML-escaped and wrapped in an <objective> block.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Goal } from "./state"

// The minimal, content-free user part for a continuation turn. The objective and
// audit ride in on the injected system block, so the nudge stays deliberately empty.
export const CONTINUE_NUDGE = "Continue working toward the active goal."

const TEMPLATE_PATH = join(import.meta.dir, "continuation.template.md")

let templateCache: string | null = null
function template(): string {
  if (templateCache === null) {
    const raw = readFileSync(TEMPLATE_PATH, "utf8")
    // Drop the leading HTML provenance comment so only the prompt body is injected.
    templateCache = raw.replace(/^\s*<!--[\s\S]*?-->\s*/, "")
  }
  return templateCache
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Returns the goal injection block: the verbatim ported continuation audit with the
// (untrusted, XML-escaped) objective filled into its <objective> placeholder.
export function renderGoalSystem(goal: Goal): string {
  return template().replace(/\{\{objective\}\}/g, xmlEscape(goal.objective))
}
