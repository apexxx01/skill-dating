import { daysBetweenDateKeys, localDateKey } from '@/lib/time'

// Streak rules. Pure: the same functions back grant() (which stores the result), the
// envelope and the player card, so there is one definition of "still alive".
//
//  - A day counts when the user earned XP from an action of their own that LOCAL day
//    (their time zone; see time.ts). Which awards are "an action of their own" is decided
//    in rewards-config.ts. One counting day extends the streak by one, however many actions
//    there were.
//  - Missing exactly one day does not end the streak if a freeze is banked: the freeze is
//    spent automatically and the streak carries on. Missing two or more days ends it.
//  - One freeze is earned for every completed run of 7 days (day 7, 14, 21, ...), up to 2 banked.

export const MAX_STREAK_FREEZES = 2
/** A freeze is earned every time the streak reaches a multiple of this many days. */
export const DAYS_PER_FREEZE = 7
/** Idle days after which earning XP again counts as a comeback. */
export const COMEBACK_IDLE_DAYS = 30

export interface StreakState {
  current: number
  longest: number
  /** The last local day that counted, "YYYY-MM-DD", or null for a user who never had one. */
  lastDay: string | null
  freezes: number
  /** A freeze was spent during the current run. */
  freezeUsedInRun: boolean
}

export const NEW_STREAK: StreakState = { current: 0, longest: 0, lastDay: null, freezes: 0, freezeUsedInRun: false }

export interface StreakAdvance {
  state: StreakState
  /** Today is a new counting day and the streak grew (or started) because of it. */
  extended: boolean
  /** A banked freeze covered a missed day. */
  freezeUsed: boolean
  /** The streak had ended and this day started a new one (including the very first). */
  restarted: boolean
  /** A freeze was earned today. */
  freezeEarned: boolean
  /** Whole days between the previous counting day and today, 0 for the first ever. */
  idleDays: number
  /** Today had already counted: nothing changed. */
  alreadyCounted: boolean
}

/** Registers that the user did something of their own on local day `today`. */
export function advanceStreak(state: StreakState, today: string): StreakAdvance {
  const gap = state.lastDay === null ? null : daysBetweenDateKeys(state.lastDay, today)

  // The same day, or a clock that moved backwards (a time zone change): nothing to add.
  if (gap !== null && gap <= 0) {
    return { state, extended: false, freezeUsed: false, restarted: false, freezeEarned: false, idleDays: 0, alreadyCounted: true }
  }

  const idleDays = gap ?? 0
  const canFreeze = gap === 2 && state.freezes > 0
  const continues = gap === 1 || canFreeze

  let current: number
  let freezes = state.freezes
  let freezeUsedInRun = state.freezeUsedInRun
  if (continues) {
    current = state.current + 1
    if (canFreeze) {
      freezes -= 1
      freezeUsedInRun = true
    }
  } else {
    current = 1
    freezeUsedInRun = false
  }

  const freezeEarned = continues && current % DAYS_PER_FREEZE === 0 && freezes < MAX_STREAK_FREEZES
  if (freezeEarned) freezes += 1

  return {
    state: { current, longest: Math.max(state.longest, current), lastDay: today, freezes, freezeUsedInRun },
    extended: true,
    freezeUsed: canFreeze,
    restarted: !continues,
    freezeEarned,
    idleDays,
    alreadyCounted: false,
  }
}

/**
 * The streak to show right now. The stored `current` is only updated when the user earns
 * something, so it can be stale: a streak last extended three days ago is over, however
 * big the number in the row. Yesterday (or the day before, with a freeze to cover it) still
 * counts, because the user can keep it alive today.
 */
export function effectiveStreak(state: StreakState, today: string): number {
  if (state.lastDay === null || state.current === 0) return 0
  const gap = daysBetweenDateKeys(state.lastDay, today)
  if (gap <= 1) return state.current
  if (gap === 2 && state.freezes > 0) return state.current
  return 0
}

/** The local date at `now` for a user, in the form streaks store. */
export function streakDay(now: Date, timeZone: string | null | undefined): string {
  return localDateKey(now, timeZone)
}

/** The state of a `User` row's streak columns. */
export interface StreakColumns {
  currentStreak: number
  longestStreak: number
  lastStreakDay: string | null
  streakFreezes: number
  streakFreezeUsed: boolean
}

export function streakFromColumns(row: StreakColumns): StreakState {
  return {
    current: row.currentStreak,
    longest: row.longestStreak,
    lastDay: row.lastStreakDay,
    freezes: row.streakFreezes,
    freezeUsedInRun: row.streakFreezeUsed,
  }
}

export function columnsFromStreak(state: StreakState): StreakColumns {
  return {
    currentStreak: state.current,
    longestStreak: state.longest,
    lastStreakDay: state.lastDay,
    streakFreezes: state.freezes,
    streakFreezeUsed: state.freezeUsedInRun,
  }
}
