import { DEFAULT_FRESHNESS, type FreshnessSetting } from './strength-config'

// Skill freshness: how recently a skill was evidenced, as a half-life decay from the newest evidence behind it (UserSkill.lastEvidencedAt), and a label.
// Pure. Freshness changes what a passport shows and (from Stage 1L) how much a skill weighs in matching. It never touches XP or a level.

export type FreshnessLabel = 'ACTIVE' | 'WARM' | 'RUSTY'

const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000

/** 1 when evidenced now, 0.5 after one half-life, 0.25 after two. Null when the skill has never been evidenced. */
export function freshnessOf(lastEvidencedAt: Date | null | undefined, now: Date, setting: FreshnessSetting = DEFAULT_FRESHNESS): number | null {
  if (!lastEvidencedAt) return null
  const months = Math.max(0, now.getTime() - lastEvidencedAt.getTime()) / MONTH_MS
  return Math.round(Math.pow(0.5, months / setting.halfLifeMonths) * 1000) / 1000
}

export function freshnessLabel(freshness: number | null, setting: FreshnessSetting = DEFAULT_FRESHNESS): FreshnessLabel | null {
  if (freshness === null) return null
  if (freshness >= setting.activeAtLeast) return 'ACTIVE'
  if (freshness >= setting.warmAtLeast) return 'WARM'
  return 'RUSTY'
}

export interface Freshness {
  lastEvidencedAt: string | null
  freshness: number | null
  label: FreshnessLabel | null
}

export function freshnessView(lastEvidencedAt: Date | null | undefined, now: Date, setting: FreshnessSetting = DEFAULT_FRESHNESS): Freshness {
  const freshness = freshnessOf(lastEvidencedAt, now, setting)
  return { lastEvidencedAt: lastEvidencedAt ? lastEvidencedAt.toISOString() : null, freshness, label: freshnessLabel(freshness, setting) }
}
