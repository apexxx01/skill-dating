import { describe, it, expect } from 'vitest'
import { DAILY_QUESTS, QUEST_DEFINITIONS, QUEST_METRICS, QUESTS_PER_PERIOD, WEEKLY_QUESTS, questBySlug } from './quest-definitions'
import { METRICS } from './metrics'

describe('the quest pool', () => {
  it('has about 20 daily and 13 weekly quests', () => {
    expect(DAILY_QUESTS).toHaveLength(20)
    expect(WEEKLY_QUESTS).toHaveLength(13)
    expect(QUEST_DEFINITIONS).toHaveLength(33)
  })

  it('has unique slugs, prefixed by their kind, and unique names within a kind', () => {
    expect(new Set(QUEST_DEFINITIONS.map((quest) => quest.slug)).size).toBe(33)
    for (const quest of DAILY_QUESTS) expect(quest.slug).toMatch(/^daily-/)
    for (const quest of WEEKLY_QUESTS) expect(quest.slug).toMatch(/^weekly-/)
    expect(new Set(DAILY_QUESTS.map((quest) => quest.name)).size).toBe(20)
    expect(new Set(WEEKLY_QUESTS.map((quest) => quest.name)).size).toBe(13)
  })

  it('asks only for a counted action a person can do on their own, never for engagement', () => {
    for (const quest of QUEST_DEFINITIONS) {
      expect(METRICS, quest.slug).toContain(quest.metric)
      expect(QUEST_METRICS, quest.slug).toContain(quest.metric)
    }
    // Not asked for: things that depend on somebody else (an endorsement received, a win, an accepted application).
    for (const metric of ['endorsements_received', 'hackathon_wins', 'teams_joined'])
      expect(QUEST_METRICS as readonly string[]).not.toContain(metric)
  })

  it('never rewards opening, visiting, viewing or logging in', () => {
    const engagement = /\b(open|opening|visit|visiting|view|viewing|browse|browsing|scroll|log ?in|sign ?in|check ?in|launch|click|tap|read|login)\b/i
    for (const quest of QUEST_DEFINITIONS) {
      expect(`${quest.name} ${quest.description}`, quest.slug).not.toMatch(engagement)
    }
  })

  it('describes each quest as an action, in a sentence', () => {
    for (const quest of QUEST_DEFINITIONS) {
      expect(quest.description.endsWith('.'), quest.slug).toBe(true)
      expect(quest.name.length, quest.slug).toBeGreaterThan(5)
    }
  })

  it('names a real target and a modest reward, bigger for bigger asks', () => {
    for (const quest of QUEST_DEFINITIONS) {
      expect(Number.isInteger(quest.target) && quest.target >= 1, quest.slug).toBe(true)
      expect(Number.isInteger(quest.xpReward) && quest.xpReward > 0, quest.slug).toBe(true)
      expect(quest.xpReward, quest.slug).toBeLessThanOrEqual(quest.type === 'DAILY' ? 20 : 75)
    }
    // Within one metric, asking for more pays more.
    for (const pool of [DAILY_QUESTS, WEEKLY_QUESTS]) {
      for (const metric of QUEST_METRICS) {
        const sameMetric = pool.filter((quest) => quest.metric === metric).sort((a, b) => a.target - b.target)
        for (let index = 1; index < sameMetric.length; index++) expect(sameMetric[index].xpReward, sameMetric[index].slug).toBeGreaterThan(sameMetric[index - 1].xpReward)
      }
    }
  })

  it('keeps the daily asks within the daily caps of the action behind them', () => {
    const caps: Record<string, number> = { projects_created: 3, ships: 3, milestones: 5, updates: 3, evidence_added: 3, endorsements_given: 10, connections: 5, first_messages: 5 }
    for (const quest of DAILY_QUESTS) if (quest.metric in caps) expect(quest.target, quest.slug).toBeLessThanOrEqual(caps[quest.metric])
  })

  it('has enough variety that three different actions can always be picked', () => {
    expect(new Set(DAILY_QUESTS.map((quest) => quest.metric)).size).toBeGreaterThanOrEqual(QUESTS_PER_PERIOD * 2)
    expect(new Set(WEEKLY_QUESTS.map((quest) => quest.metric)).size).toBeGreaterThanOrEqual(QUESTS_PER_PERIOD * 2)
  })

  it('looks a quest up by slug', () => {
    expect(questBySlug('daily-update-1')?.metric).toBe('updates')
    expect(questBySlug('nope')).toBeUndefined()
  })
})
