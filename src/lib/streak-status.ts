import type { Db } from '@/lib/events'
import type { StreakStatus } from '@/types/api'
import { effectiveStreak, streakDay, streakFromColumns, type StreakState } from '@/lib/streaks'

// Reading a user's streak for display. The stored numbers only change when the user
// earns something, so "what is the streak right now" needs today's date in their time zone.

const streakSelect = {
  xp: true,
  timezone: true,
  currentStreak: true,
  longestStreak: true,
  lastStreakDay: true,
  streakFreezes: true,
  streakFreezeUsed: true,
} as const

export interface UserStreakRead {
  xp: number
  timezone: string | null
  state: StreakState
  /** The streak to show now: 0 when it has lapsed. */
  current: number
}

export async function readUserStreak(db: Db, userId: string, now: Date = new Date()): Promise<UserStreakRead | null> {
  const row = await db.user.findUnique({ where: { id: userId }, select: streakSelect })
  if (!row) return null
  const state = streakFromColumns(row)
  return { xp: row.xp, timezone: row.timezone, state, current: effectiveStreak(state, streakDay(now, row.timezone)) }
}

/** The streak as a request that did not touch it reports it. */
export function steadyStatus(read: Pick<UserStreakRead, 'state' | 'current'>): StreakStatus {
  return { current: read.current, longest: read.state.longest, extended: false, freezeUsed: false }
}
