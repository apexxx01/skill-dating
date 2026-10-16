import type { RewardsEnvelope, StreakStatus } from '@/types/api'
import { levelFor } from './levels'

// The RewardsEnvelope is built from two XP totals, so it is pure and cannot
// disagree with the level curve: levels, tiers and the "changed" flags are all
// derived from the before and after totals, never tracked separately.
//
// While a request is still collecting what it earned, the streak may not be known
// yet (an achievement unlocking does not touch it). That is a draft; the request's
// final envelope fills it in from the user's stored streak (see EventScope.rewardsFor).

/** An envelope whose streak is not known yet. */
export type EnvelopeDraft = Omit<RewardsEnvelope, 'streak'> & { streak: StreakStatus | null }

function describe(oldXp: number, newXp: number, parts: Pick<RewardsEnvelope, 'achievements' | 'questsCompleted'> & { streak: StreakStatus | null }): EnvelopeDraft {
  const before = levelFor(oldXp)
  const after = levelFor(newXp)
  return {
    xpGained: newXp - oldXp,
    totalXp: newXp,
    oldLevel: before.level,
    newLevel: after.level,
    leveledUp: after.level > before.level,
    oldTier: before.tier,
    newTier: after.tier,
    tierChanged: after.tier !== before.tier,
    achievements: parts.achievements,
    questsCompleted: parts.questsCompleted,
    streak: parts.streak,
  }
}

/** Nothing was earned: the user stays where they are. */
export function emptyEnvelope(totalXp: number, streak: StreakStatus | null = null): EnvelopeDraft {
  return describe(totalXp, totalXp, { achievements: [], questsCompleted: [], streak })
}

/** `gained` XP was added on top of `oldXp`. */
export function envelopeForGain(
  oldXp: number,
  gained: number,
  achievements: RewardsEnvelope['achievements'] = [],
  streak: StreakStatus | null = null
): EnvelopeDraft {
  return describe(oldXp, oldXp + gained, { achievements, questsCompleted: [], streak })
}

/** The streak a request that did not move it reports: where it stands. */
export function steadyStreak(current: number, longest: number): StreakStatus {
  return { current, longest, extended: false, freezeUsed: false }
}

/** Fills in the streak of a draft that does not have one yet. */
export function completeEnvelope(draft: EnvelopeDraft, streak: StreakStatus): RewardsEnvelope {
  return { ...draft, streak: draft.streak ?? streak }
}

function mergeStreaks(first: StreakStatus | null, second: StreakStatus | null): StreakStatus | null {
  if (!first) return second
  if (!second) return first
  return {
    // `second` is the later reading, so it has the current numbers; a flag that happened at any point in the request stays up.
    current: second.current,
    longest: Math.max(first.longest, second.longest),
    extended: first.extended || second.extended,
    freezeUsed: first.freezeUsed || second.freezeUsed,
  }
}

/** Combines two envelopes for the same user, `first` having happened before `second`. */
export function mergeEnvelopes(first: EnvelopeDraft, second: EnvelopeDraft): EnvelopeDraft {
  const seen = new Set<string>()
  const achievements = [...first.achievements, ...second.achievements].filter((item) => {
    if (seen.has(item.slug)) return false
    seen.add(item.slug)
    return true
  })
  const questsSeen = new Set<string>()
  const questsCompleted = [...first.questsCompleted, ...second.questsCompleted].filter((item) => {
    if (questsSeen.has(item.slug)) return false
    questsSeen.add(item.slug)
    return true
  })
  return describe(first.totalXp - first.xpGained, second.totalXp, {
    achievements,
    questsCompleted,
    streak: mergeStreaks(first.streak, second.streak),
  })
}
