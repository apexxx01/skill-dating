import { describe, it, expect } from 'vitest'
import { canAwardShipXp, dedupeKeyFor, EVENT_REWARDS, REWARD_ACTIONS, REWARD_RULES } from './rewards-config'
import { DOMAIN_EVENT_NAMES } from './events'
import { ACHIEVEMENT_DEFINITIONS } from './achievement-definitions'

describe('canAwardShipXp', () => {
  it('allows the award on first ship', () => {
    expect(canAwardShipXp({ status: 'BUILDING', shippedAt: null }, 'SHIPPED')).toBe(true)
  })

  it('blocks re-awarding on a repeated SHIPPED PATCH', () => {
    const alreadyShipped = { status: 'SHIPPED', shippedAt: new Date('2024-01-01') }
    expect(canAwardShipXp(alreadyShipped, 'SHIPPED')).toBe(false)
  })

  it('blocks farming via SHIPPED -> BUILDING -> SHIPPED cycling', () => {
    // Once shippedAt is set, it is never cleared by a later status change,
    // so re-declaring SHIPPED after reverting to BUILDING must not re-award.
    const previouslyShipped = { status: 'BUILDING', shippedAt: new Date('2024-01-01') }
    expect(canAwardShipXp(previouslyShipped, 'SHIPPED')).toBe(false)
  })

  it('does not award for any non-SHIPPED transition', () => {
    expect(canAwardShipXp({ status: 'IDEA', shippedAt: null }, 'BUILDING')).toBe(false)
    expect(canAwardShipXp({ status: 'IDEA', shippedAt: null }, undefined)).toBe(false)
  })
})

describe('REWARD_RULES', () => {
  it('keeps the amounts the platform has always paid', () => {
    expect(REWARD_RULES.PROJECT_CREATED.amount).toBe(50)
    expect(REWARD_RULES.PROJECT_SHIP.amount).toBe(200)
    expect(REWARD_RULES.HACKATHON_JOIN.amount).toBe(100)
    expect(REWARD_RULES.TEAM_FORMED.amount).toBe(50)
    expect(REWARD_RULES.HACKATHON_WIN.amount).toBe(500)
  })

  it('takes an achievement amount from the achievement, not the table', () => {
    expect(REWARD_RULES.ACHIEVEMENT_EARNED.amount).toBeNull()
  })

  it('caps project creation at 3 a day and leaves one-off actions uncapped', () => {
    expect(REWARD_RULES.PROJECT_CREATED.dailyCap).toBe(3)
    expect(REWARD_RULES.PROJECT_SHIP.dailyCap).toBe(3)
    expect(REWARD_RULES.HACKATHON_WIN.dailyCap).toBeNull()
  })

  it('makes every action once-per-source and caps with whole positive numbers', () => {
    for (const action of REWARD_ACTIONS) {
      const rule = REWARD_RULES[action]
      expect(rule.oncePer).toBe('source')
      if (rule.amount !== null) expect(Number.isInteger(rule.amount) && rule.amount > 0).toBe(true)
      if (rule.dailyCap !== null) expect(Number.isInteger(rule.dailyCap) && rule.dailyCap > 0).toBe(true)
    }
  })
})

describe('dedupeKeyFor', () => {
  it('is the lower-case source type and the id', () => {
    expect(dedupeKeyFor({ sourceType: 'PROJECT', sourceId: 'abc' })).toBe('project:abc')
    expect(dedupeKeyFor({ sourceType: 'ACHIEVEMENT', sourceId: 'first-ship' })).toBe('achievement:first-ship')
  })

  it('differs by source, so two projects are two awards', () => {
    expect(dedupeKeyFor({ sourceType: 'PROJECT', sourceId: 'a' })).not.toBe(dedupeKeyFor({ sourceType: 'PROJECT', sourceId: 'b' }))
  })
})

describe('EVENT_REWARDS', () => {
  it('has an entry for every domain event', () => {
    for (const name of DOMAIN_EVENT_NAMES) expect(EVENT_REWARDS).toHaveProperty(name)
    expect(Object.keys(EVENT_REWARDS).sort()).toEqual([...DOMAIN_EVENT_NAMES].sort())
  })

  it('only names achievements that exist', () => {
    for (const reward of Object.values(EVENT_REWARDS) as { achievement?: string }[]) {
      if (reward.achievement) expect(ACHIEVEMENT_DEFINITIONS).toHaveProperty(reward.achievement)
    }
  })

  it('attaches each XP award to the source type its rule expects', () => {
    const samples = { projectId: 'p1', projectName: 'Alpha', hackathonId: 'h1', hackathonName: 'Hack' } as never
    for (const reward of Object.values(EVENT_REWARDS) as { xp?: { action: keyof typeof REWARD_RULES; source: (p: never) => { sourceType: string; sourceId: string }; description: (p: never) => string } }[]) {
      if (!reward.xp) continue
      const source = reward.xp.source(samples)
      expect(source.sourceType).toBe(REWARD_RULES[reward.xp.action].sourceType)
      expect(source.sourceId.length).toBeGreaterThan(0)
      expect(reward.xp.description(samples).length).toBeGreaterThan(0)
    }
  })

  it('pays XP for exactly the actions that used to pay it', () => {
    const paying = Object.entries(EVENT_REWARDS)
      .filter(([, reward]) => (reward as { xp?: unknown }).xp)
      .map(([name]) => name)
      .sort()
    expect(paying).toEqual(['HACKATHON_JOINED', 'HACKATHON_WON', 'PROJECT_CREATED', 'PROJECT_SHIPPED', 'TEAM_FORMED'])
  })

  it('announces connection events without paying for them yet', () => {
    expect(EVENT_REWARDS.CONNECTION_ACCEPTED).toEqual({})
    expect(EVENT_REWARDS.MESSAGE_SENT_FIRST_IN_CONNECTION).toEqual({})
  })
})
