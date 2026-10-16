import { QUEST_POOL, QUESTS_PER_PERIOD, type QuestDefinition, type QuestType } from '@/lib/quest-definitions'
import { localDateKey, localDayEnd, localDayStart, localWeekEnd, localWeekKey, localWeekStart } from '@/lib/time'

// Which quests a person has, and when they reset. Nothing here is stored: the three daily and three
// weekly quests of a person are a pure function of (user, period), so any server computes the same
// ones, a quest cannot be re-rolled by reloading, and there is no job to run at midnight.

export interface QuestPeriod {
  type: QuestType
  /** The local date ("2026-10-16") or ISO week ("2026-W42") in the user's time zone. */
  key: string
  start: Date
  /** When the period ends and the quests reset: the first instant of the next day or week. */
  end: Date
}

/** The day and the week that `now` falls in, in the user's time zone (UTC when it is missing or invalid). */
export function questPeriods(now: Date, timeZone: string | null | undefined): { daily: QuestPeriod; weekly: QuestPeriod } {
  return {
    daily: { type: 'DAILY', key: localDateKey(now, timeZone), start: localDayStart(now, timeZone), end: localDayEnd(now, timeZone) },
    weekly: { type: 'WEEKLY', key: localWeekKey(now, timeZone), start: localWeekStart(now, timeZone), end: localWeekEnd(now, timeZone) },
  }
}

// --- A small deterministic random source -----------------------------------------------------------
// Plain 32-bit integer arithmetic, so every runtime produces the same numbers from the same seed (unlike
// anything built on Math.random or a platform hash).

/** A 32-bit seed from text (the xmur3 string hash). */
export function seedFrom(text: string): number {
  let h = 1779033703 ^ text.length
  for (let index = 0; index < text.length; index++) {
    h = Math.imul(h ^ text.charCodeAt(index), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

/** Numbers in [0, 1) from a seed (mulberry32). */
export function randomFrom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The quests of one kind that `userId` has in the period `periodKey`: a seeded shuffle of the pool, then the
 * first three that ask for different things (a person is never given three ways of posting an update).
 * The same user and period always give the same quests, in the same order.
 */
export function pickQuests(
  userId: string,
  periodKey: string,
  type: QuestType,
  count: number = QUESTS_PER_PERIOD,
  pool: readonly QuestDefinition[] = QUEST_POOL[type]
): QuestDefinition[] {
  const random = randomFrom(seedFrom(`${type}|${periodKey}|${userId}`))
  // Start from a fixed order so the result depends on the seed alone, not on how the pool is listed.
  const shuffled = [...pool].sort((a, b) => (a.slug < b.slug ? -1 : 1))
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]]
  }

  const chosen: QuestDefinition[] = []
  const metrics = new Set<string>()
  for (const quest of shuffled) {
    if (chosen.length === count) break
    if (metrics.has(quest.metric)) continue
    metrics.add(quest.metric)
    chosen.push(quest)
  }
  // A pool with fewer kinds of action than `count` still fills the slots.
  for (const quest of shuffled) {
    if (chosen.length === count) break
    if (!chosen.includes(quest)) chosen.push(quest)
  }
  return chosen
}

export interface CurrentQuests {
  daily: { period: QuestPeriod; quests: QuestDefinition[] }
  weekly: { period: QuestPeriod; quests: QuestDefinition[] }
}

/** Everything a person has to do right now. */
export function currentQuests(userId: string, now: Date, timeZone: string | null | undefined): CurrentQuests {
  const periods = questPeriods(now, timeZone)
  return {
    daily: { period: periods.daily, quests: pickQuests(userId, periods.daily.key, 'DAILY') },
    weekly: { period: periods.weekly, quests: pickQuests(userId, periods.weekly.key, 'WEEKLY') },
  }
}
