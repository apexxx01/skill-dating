// The level curve and the tiers. Pure: no I/O, so the same function backs the
// rewards engine, the API and any client that wants to draw a progress bar.
//
// A level's size is the XP needed to move from that level to the next one:
//
//   levels 1 to 55:    xpForLevel(n) = round(5 * n^1.85)      (5 for level 1, 18 for level 2, ...)
//   levels 56 to 99:   xpForLevel(n) = 4100 + 50 * (n - 56)   (4100 for level 56, 6200 for level 98)
//
// The power law keeps climbing, and left alone it would make level 80 (Mythic) a
// ten year goal even for someone who plays like a full-time builder. From level 56 the
// size grows in a straight line instead, which is what puts Mythic at about five years
// for a power user (see the simulation in docs/GAMIFICATION.md). The sizes up to level 55
// are untouched, so every threshold up to the start of level 56 is the same as before.
//
// Level 1 starts at 0 XP, so the XP at which a level begins is the sum of the
// sizes of all the levels before it. The top level (MAX_LEVEL) has no next level.

export const MAX_LEVEL = 100

export const TIERS = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MYTHIC'] as const
export type Tier = (typeof TIERS)[number]

/** First level of each tier. A tier lasts until the next tier's first level. */
export const TIER_START_LEVEL: Record<Tier, number> = {
  BRONZE: 1,
  SILVER: 10,
  GOLD: 20,
  PLATINUM: 35,
  DIAMOND: 55,
  MYTHIC: 80,
}

export interface LevelInfo {
  level: number
  tier: Tier
  /** XP earned since this level began. 0 at the start of a level. */
  xpIntoLevel: number
  /** The size of this level: XP needed to reach the next one. 0 at MAX_LEVEL. */
  xpForNextLevel: number
  /** 0 to 1: how far through this level. Always 1 at MAX_LEVEL. */
  progress: number
}

/** The last level whose size follows the power law. Larger levels follow the straight line. */
export const POWER_LAW_LAST_LEVEL = 55
const LINEAR_FIRST_SIZE = 4100
const LINEAR_STEP = 50

/** XP needed to get from `level` to `level + 1`. */
export function xpForLevel(level: number): number {
  if (level <= POWER_LAW_LAST_LEVEL) return Math.round(5 * Math.pow(level, 1.85))
  return LINEAR_FIRST_SIZE + LINEAR_STEP * (level - POWER_LAW_LAST_LEVEL - 1)
}

// cumulative[n - 1] = XP at which level n begins (cumulative[0] = 0).
const CUMULATIVE: number[] = (() => {
  const starts = [0]
  for (let level = 1; level < MAX_LEVEL; level++) starts.push(starts[level - 1] + xpForLevel(level))
  return starts
})()

/** Total XP at which `level` begins. */
export function xpAtLevelStart(level: number): number {
  const clamped = Math.min(Math.max(Math.trunc(level), 1), MAX_LEVEL)
  return CUMULATIVE[clamped - 1]
}

export function tierForLevel(level: number): Tier {
  let tier: Tier = 'BRONZE'
  for (const candidate of TIERS) {
    if (level >= TIER_START_LEVEL[candidate]) tier = candidate
  }
  return tier
}

/** Negative, fractional or non-finite XP is treated as the nearest valid amount (0 for the first two). */
export function levelFor(xp: number): LevelInfo {
  const total = Number.isFinite(xp) ? Math.max(0, Math.floor(xp)) : 0

  // Binary search for the highest level whose start is <= total.
  let low = 1
  let high = MAX_LEVEL
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (CUMULATIVE[mid - 1] <= total) low = mid
    else high = mid - 1
  }
  const level = low

  if (level === MAX_LEVEL) {
    return { level, tier: tierForLevel(level), xpIntoLevel: total - CUMULATIVE[level - 1], xpForNextLevel: 0, progress: 1 }
  }

  const xpIntoLevel = total - CUMULATIVE[level - 1]
  const xpForNextLevel = xpForLevel(level)
  return { level, tier: tierForLevel(level), xpIntoLevel, xpForNextLevel, progress: xpIntoLevel / xpForNextLevel }
}
