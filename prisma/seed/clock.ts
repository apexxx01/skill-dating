// A clock that can be set to a moment in the past, so the world's history is made by the same code that runs live: a streak, a daily cap, a quest period, a Ship Day and a season stamp
// all read "now", and here "now" is the simulated day. Date.now() and new Date() answer `real now - offset`; a Date with arguments is untouched.
//
// Columns that the DATABASE stamps with its own clock (`DEFAULT now()`) cannot follow; retime() moves the rows a step wrote back to the simulated moment afterwards.

import type { PrismaClient } from '@prisma/client'

const RealDate = Date
let offsetMs = 0

class SimulatedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() - offsetMs)
    else super(...(args as [number]))
  }
  static now(): number {
    return RealDate.now() - offsetMs
  }
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof RealDate
  }
}

let installed = false
export function installClock(): void {
  if (installed) return
  installed = true
  globalThis.Date = SimulatedDate as unknown as DateConstructor
}

/** The real moment, whatever the simulated clock says. */
export const realNow = (): number => RealDate.now()

export function setSimulatedNow(at: Date | null): void {
  offsetMs = at ? RealDate.now() - at.getTime() : 0
}

/** A column the database stamps with its own clock (`DEFAULT now()`). */
export interface StampedColumn {
  table: string
  column: string
}

/**
 * Columns stamped by the database's clock that the steps of the history write; each is moved back to the simulated moment by atMoment(). (Posts, comments, sparks and the like
 * are written with the moment the domain function was given, and `@updatedAt` columns come from the simulated Date.)
 */
export const STAMPED: readonly StampedColumn[] = [
  { table: 'XPEvent', column: 'createdAt' },
  { table: 'Notification', column: 'createdAt' },
  { table: 'ProductEvent', column: 'createdAt' },
  { table: 'ProjectUpdate', column: 'createdAt' },
  { table: 'Activity', column: 'createdAt' },
  { table: 'ProgressTick', column: 'createdAt' },
  { table: 'UserAchievement', column: 'earnedAt' },
  { table: 'UserQuest', column: 'createdAt' },
  { table: 'UserCosmetic', column: 'unlockedAt' },
  { table: 'Prop', column: 'createdAt' },
]

/** Runs `fn` with the clock set to `at`, then moves what it wrote with the database's clock back to `at`. */
export async function atMoment<T>(db: PrismaClient, at: Date, fn: () => Promise<T>, columns: readonly StampedColumn[] = STAMPED): Promise<T> {
  const started = RealDate.now() - 20
  setSimulatedNow(at)
  const shiftSeconds = (RealDate.now() - at.getTime()) / 1000
  try {
    return await fn()
  } finally {
    setSimulatedNow(null)
    if (shiftSeconds > 1) {
      for (const { table, column } of columns) {
        await db.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = "${column}" - make_interval(secs => $1) WHERE "${column}" >= $2`, shiftSeconds, new RealDate(started))
      }
    }
  }
}
