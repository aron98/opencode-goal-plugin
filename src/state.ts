// Per-session goal state store. One goal per session, fs-backed, atomic writes.
//
// Storage layout: <dir>/<sessionID>.json, written via write-temp-then-rename so a
// reader never observes a half-written file. `turnCount` is load-bearing: it powers
// the `/goal` view verb (Task 6) and is the deterministic acceptance-test oracle (Task 7).

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"

export type GoalStatus = "active" | "paused" | "complete" | "blocked"

export type Goal = {
  sessionID: string
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  turnCount: number
}

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT"
}

export class GoalStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  get(id: string): Goal | undefined {
    try {
      const raw = readFileSync(this.path(id), "utf8")
      return JSON.parse(raw) as Goal
    } catch (err) {
      if (isENOENT(err)) return undefined
      throw err
    }
  }

  private write(goal: Goal): void {
    const target = this.path(goal.sessionID)
    // Unique temp name avoids collisions between concurrent writers, then atomic rename.
    const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(tmp, JSON.stringify(goal, null, 2))
    renameSync(tmp, target)
  }

  set(id: string, objective: string): Goal {
    const now = Date.now()
    const goal: Goal = {
      sessionID: id,
      objective,
      status: "active",
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
    }
    this.write(goal)
    return goal
  }

  setStatus(id: string, status: GoalStatus): Goal | undefined {
    const goal = this.get(id)
    if (!goal) return undefined
    goal.status = status
    goal.updatedAt = Date.now()
    this.write(goal)
    return goal
  }

  incrementTurn(id: string): void {
    const goal = this.get(id)
    if (!goal) return
    goal.turnCount += 1
    goal.updatedAt = Date.now()
    this.write(goal)
  }

  clear(id: string): void {
    try {
      unlinkSync(this.path(id))
    } catch (err) {
      if (isENOENT(err)) return
      throw err
    }
  }
}
