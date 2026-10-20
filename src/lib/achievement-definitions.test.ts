import { describe, it, expect } from 'vitest'
import { ACHIEVEMENT_DEFINITIONS, ACHIEVEMENT_SLUGS, achievementSeries, isSecretAchievement, type AchievementDefinition } from './achievement-definitions'
import { METRICS } from './metrics'

const MATCH_ACHIEVEMENTS: string[] = ['first-match', 'matches-10', 'match-teamed']
const defs = ACHIEVEMENT_SLUGS.map((slug) => ({ slug, def: ACHIEVEMENT_DEFINITIONS[slug] as AchievementDefinition }))

describe('the achievement catalog', () => {
  it('has 51 achievements, 6 of them secret', () => {
    expect(defs).toHaveLength(51)
    expect(defs.filter(({ def }) => def.isSecret)).toHaveLength(6)
    expect(ACHIEVEMENT_SLUGS.filter(isSecretAchievement)).toHaveLength(6)
  })

  it('keeps the slugs the first ten achievements always had', () => {
    for (const slug of ['first-project', 'first-ship', 'first-hackathon', 'team-builder', 'team-player', 'hackathon-winner', 'first-evidence', 'endorsed', 'first-update', 'first-milestone']) {
      expect(ACHIEVEMENT_DEFINITIONS, slug).toHaveProperty(slug)
    }
  })

  it('gives every achievement a name, a description, an icon, a category, XP and a place in the order', () => {
    const orders = new Set<number>()
    for (const { slug, def } of defs) {
      expect(def.name.length, slug).toBeGreaterThan(2)
      expect(def.description.endsWith('.'), slug).toBe(true)
      expect(def.icon, slug).toMatch(/^[a-z0-9-]+$/)
      expect(['BUILDING', 'HACKATHON', 'TEAM', 'REPUTATION', 'STREAK', 'SECRET']).toContain(def.category)
      expect(Number.isInteger(def.xpReward) && def.xpReward > 0, slug).toBe(true)
      orders.add(def.order)
    }
    expect([...orders].sort((a, b) => a - b)).toEqual(Array.from({ length: 51 }, (_, index) => index + 1))
    expect(new Set(defs.map(({ def }) => def.name)).size).toBe(51)
  })

  it('files every secret achievement under SECRET and nothing else there', () => {
    for (const { slug, def } of defs) expect(def.category === 'SECRET', slug).toBe(Boolean(def.isSecret))
  })

  it('asks only for metrics that exist, and secret rules that are named', () => {
    const secretRules = new Set<string>()
    for (const { slug, def } of defs) {
      const criteria = def.criteria
      expect(criteria.target >= 1, slug).toBe(true)
      if ('metric' in criteria) expect([...METRICS, 'streak_days'], slug).toContain(criteria.metric)
      else secretRules.add(criteria.secret)
    }
    expect([...secretRules].sort()).toEqual(['clean-run', 'comeback', 'gold-vouch', 'hat-trick', 'night-owl-ship', 'weekend-shipper'])
  })

  describe('tiered series', () => {
    const targets = (metric: Parameters<typeof achievementSeries>[0]) => achievementSeries(metric).map((entry) => entry.target)

    it('matches 1 / 10, and the first match that became a team once', () => {
      expect(targets('matches')).toEqual([1, 10])
      expect(targets('match_teams')).toEqual([1])
    })
    it('pays a one-off amount for each match milestone: 25, 50 and 100', () => {
      const xp = (slug: string) => (ACHIEVEMENT_DEFINITIONS as Record<string, AchievementDefinition>)[slug].xpReward
      expect([xp('first-match'), xp('matches-10'), xp('match-teamed')]).toEqual([25, 50, 100])
    })
    it('ships 1 / 5 / 25 / 100', () => expect(targets('ships')).toEqual([1, 5, 25, 100]))
    it('hackathon wins 1 / 3 / 10', () => expect(targets('hackathon_wins')).toEqual([1, 3, 10]))
    it('endorsements given 1 / 10 / 50', () => expect(targets('endorsements_given')).toEqual([1, 10, 50]))
    it('endorsements received 1 / 10 / 50', () => expect(targets('endorsements_received')).toEqual([1, 10, 50]))
    it('streaks 7 / 30 / 100 / 365', () => expect(targets('streak_days')).toEqual([7, 30, 100, 365]))
    it('milestones 1 / 10 / 50', () => expect(targets('milestones')).toEqual([1, 10, 50]))
    it('project updates 1 / 25 / 100', () => expect(targets('updates')).toEqual([1, 25, 100]))
    it('evidence added 1 / 10', () => expect(targets('evidence_added')).toEqual([1, 10]))
    it('has series for crews formed and teams joined', () => {
      expect(targets('crews_formed')[0]).toBe(1)
      expect(targets('crews_formed').length).toBeGreaterThan(1)
      expect(targets('teams_joined')[0]).toBe(1)
      expect(targets('teams_joined').length).toBeGreaterThan(1)
    })

    it('never pays less for a higher tier than for the one before, and pays more at the top than at the start', () => {
      for (const metric of [...METRICS, 'streak_days' as const]) {
        const xp = achievementSeries(metric).map((entry) => (ACHIEVEMENT_DEFINITIONS[entry.slug] as AchievementDefinition).xpReward)
        for (let index = 1; index < xp.length; index++) expect(xp[index], metric).toBeGreaterThanOrEqual(xp[index - 1])
        if (xp.length > 1) expect(xp[xp.length - 1], metric).toBeGreaterThan(xp[0])
      }
    })

    it('is sorted from the lowest target, and a target is never repeated within a series', () => {
      for (const metric of [...METRICS, 'streak_days' as const]) {
        const t = targets(metric)
        expect(t).toEqual([...t].sort((a, b) => a - b))
        expect(new Set(t).size).toBe(t.length)
      }
    })
  })

  it('does not pay unreasonable one-off amounts for the first tier of anything', () => {
    for (const { def } of defs) if (!def.isSecret && def.criteria.target === 1) expect(def.xpReward).toBeLessThanOrEqual(250)
  })
})
