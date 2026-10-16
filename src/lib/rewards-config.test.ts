import { describe, it, expect } from 'vitest'
import { applicantRewardEligible, canAwardShipXp, dedupeKeyFor, EVENT_REWARDS, MIN_ACCOUNT_AGE_DAYS_FOR_APPLICATION_REWARD, REWARD_ACTIONS, REWARD_RULES } from './rewards-config'
import { DOMAIN_EVENT_NAMES } from './events'

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

  it('pays the community and progress actions what the table says, with their daily caps', () => {
    const table = {
      MILESTONE_COMPLETED: [30, 5],
      PROJECT_UPDATE_POSTED: [15, 3],
      EVIDENCE_ADDED: [20, 3],
      EVIDENCE_ENDORSED: [10, 10],
      CONNECTION_ACCEPTED: [10, 5],
      MESSAGE_SENT_FIRST_IN_CONNECTION: [5, 5],
      TEAM_APPLICATION_ACCEPTED: [50, 3],
    } as const
    for (const [action, [amount, cap]] of Object.entries(table)) {
      const rule = REWARD_RULES[action as keyof typeof table]
      expect([action, rule.amount, rule.dailyCap]).toEqual([action, amount, cap])
    }
  })

  it('takes an achievement amount from the achievement and a quest amount from the quest, not the table', () => {
    expect(REWARD_RULES.ACHIEVEMENT_EARNED.amount).toBeNull()
    expect(REWARD_RULES.QUEST_COMPLETED.amount).toBeNull()
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

  it('pays XP for every event that has a reward rule, and for nothing else', () => {
    const paying = Object.entries(EVENT_REWARDS)
      .filter(([, reward]) => (reward as { xp?: unknown }).xp)
      .map(([name]) => name)
      .sort()
    expect(paying).toEqual(
      [
        'CONNECTION_ACCEPTED',
        'EVIDENCE_ADDED',
        'EVIDENCE_ENDORSED',
        'HACKATHON_JOINED',
        'HACKATHON_WON',
        'MESSAGE_SENT_FIRST_IN_CONNECTION',
        'MILESTONE_COMPLETED',
        'PROJECT_CREATED',
        'PROJECT_SHIPPED',
        'PROJECT_UPDATE_POSTED',
        'TEAM_APPLICATION_ACCEPTED',
        'TEAM_FORMED',
      ].sort()
    )
  })

  it('says nothing about achievements: those are unlocked by the progress engine, from counts', () => {
    for (const reward of Object.values(EVENT_REWARDS)) expect(reward).not.toHaveProperty('achievement')
  })

  it('maps every rule to exactly one event that pays it', () => {
    const paid = Object.values(EVENT_REWARDS)
      .map((reward) => (reward as { xp?: { action: string } }).xp?.action)
      .filter(Boolean)
      .sort()
    // Achievements and quests are paid by the progress engine, which names the amount itself.
    expect(paid).toEqual(REWARD_ACTIONS.filter((action) => action !== 'ACHIEVEMENT_EARNED' && action !== 'QUEST_COMPLETED').sort())
  })

  it('pays a connection to both people, and everything else to the one the event is about', () => {
    const connection = EVENT_REWARDS.CONNECTION_ACCEPTED.xp!
    expect(connection.recipients!({ userId: 'u1', otherUserId: 'u2', connectionId: 'c1' })).toEqual(['u1', 'u2'])
    for (const [name, reward] of Object.entries(EVENT_REWARDS)) {
      if (name !== 'CONNECTION_ACCEPTED') expect((reward as { xp?: { recipients?: unknown } }).xp?.recipients).toBeUndefined()
    }
  })

  it('keys an endorsement by the evidence and the endorser, so each pair pays once', () => {
    const source = EVENT_REWARDS.EVIDENCE_ENDORSED.xp!.source({ userId: 'owner', endorserId: 'u2', evidenceId: 'e1' })
    expect(source).toEqual({ sourceType: 'ENDORSEMENT', sourceId: 'e1:u2' })
  })
})

describe('applicantRewardEligible', () => {
  const now = new Date('2026-06-15T12:00:00Z')
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

  it('asks for seven days', () => {
    expect(MIN_ACCOUNT_AGE_DAYS_FOR_APPLICATION_REWARD).toBe(7)
  })

  it('pays an old enough account with a verified email', () => {
    expect(applicantRewardEligible({ createdAt: daysAgo(30), isEmailVerified: true }, now)).toBe(true)
  })

  it('pays on the exact seven day mark and not a millisecond before', () => {
    expect(applicantRewardEligible({ createdAt: daysAgo(7), isEmailVerified: true }, now)).toBe(true)
    expect(applicantRewardEligible({ createdAt: new Date(daysAgo(7).getTime() + 1), isEmailVerified: true }, now)).toBe(false)
  })

  it('pays nothing to a new account, however verified', () => {
    expect(applicantRewardEligible({ createdAt: daysAgo(0), isEmailVerified: true }, now)).toBe(false)
    expect(applicantRewardEligible({ createdAt: daysAgo(6.9), isEmailVerified: true }, now)).toBe(false)
  })

  it('pays nothing to an account whose email is not verified, however old', () => {
    expect(applicantRewardEligible({ createdAt: daysAgo(400), isEmailVerified: false }, now)).toBe(false)
  })
})
