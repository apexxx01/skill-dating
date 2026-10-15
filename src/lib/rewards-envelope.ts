import type { RewardsEnvelope } from '@/types/api'
import { levelFor } from './levels'

// The RewardsEnvelope is built from two XP totals, so it is pure and cannot
// disagree with the level curve: levels, tiers and the "changed" flags are all
// derived from the before and after totals, never tracked separately.

function describe(oldXp: number, newXp: number, parts: Pick<RewardsEnvelope, 'achievements' | 'questsCompleted'>): RewardsEnvelope {
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
    streak: null,
  }
}

/** Nothing was earned: the user stays where they are. */
export function emptyEnvelope(totalXp: number): RewardsEnvelope {
  return describe(totalXp, totalXp, { achievements: [], questsCompleted: [] })
}

/** `gained` XP was added on top of `oldXp`. */
export function envelopeForGain(
  oldXp: number,
  gained: number,
  achievements: RewardsEnvelope['achievements'] = []
): RewardsEnvelope {
  return describe(oldXp, oldXp + gained, { achievements, questsCompleted: [] })
}

/** Combines two envelopes for the same user, `first` having happened before `second`. */
export function mergeEnvelopes(first: RewardsEnvelope, second: RewardsEnvelope): RewardsEnvelope {
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
  return describe(first.totalXp - first.xpGained, second.totalXp, { achievements, questsCompleted })
}
