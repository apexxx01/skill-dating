import { describe, it, expect } from 'vitest'
import { assembleDaily, assembleWeekly, digestDue, relativeWhen, type DailyFacts, type WeeklyFacts } from './digest'

const BASE = 'https://app.example.com'
const NOW = new Date('2026-10-22T10:00:00Z')
const quietFor = { enabled: true, start: 22 * 60, end: 8 * 60 }
const nothing: DailyFacts = { drops: 0, sparks: 0, registrationClosing: [], submissionsDue: [], openDailyQuests: 0, weeklyQuestsEndAt: null }

describe('assembleDaily', () => {
  it('has nothing to send when nothing is waiting, however many quests are open', () => {
    expect(assembleDaily(nothing, BASE, NOW, 'en')).toBeNull()
    expect(assembleDaily({ ...nothing, openDailyQuests: 3, weeklyQuestsEndAt: new Date('2026-10-23T00:00:00Z') }, BASE, NOW, 'en')).toBeNull()
  })

  it('counts today’s Drops and the people who sparked, as numbers and never as names', () => {
    const digest = assembleDaily({ ...nothing, drops: 3, sparks: 2 }, BASE, NOW, 'en')!
    expect(digest.subject).toBe('2 things are waiting for you today')
    const lines = digest.sections.flatMap((section) => section.items.map((item) => item.text))
    expect(lines).toEqual(['3 people picked for you today', '2 people sparked you'])
    expect(digest.sections[0].items[0].url).toBe(`${BASE}/discover`)
  })

  it('uses the singular for one', () => {
    const digest = assembleDaily({ ...nothing, drops: 1 }, BASE, NOW, 'en')!
    expect(digest.subject).toBe('1 thing is waiting for you today')
    expect(digest.sections[0].items[0].text).toBe('1 person picked for you today')
  })

  it('lists squad deadlines with how far off they are, and counts them as worth sending', () => {
    const digest = assembleDaily(
      { ...nothing, registrationClosing: [{ id: 'h1', name: 'HackNight', at: new Date('2026-10-24T10:00:00Z') }], submissionsDue: [{ id: 'h2', name: 'ShipIt', at: new Date('2026-10-22T20:00:00Z') }] },
      BASE,
      NOW,
      'en'
    )!
    const squads = digest.sections.find((section) => section.heading === 'Squads')!
    expect(squads.items[0].text).toBe('HackNight: registration closes in 2 days. You do not have a squad yet.')
    expect(squads.items[1].text).toBe('ShipIt: your squad’s submission is due in 10 hours.')
    expect(squads.items[0].url).toBe(`${BASE}/hackathons/h1`)
  })

  it('adds the quest lines beside something worth sending, not on their own', () => {
    const digest = assembleDaily({ ...nothing, drops: 1, openDailyQuests: 2, weeklyQuestsEndAt: new Date('2026-10-23T10:00:00Z') }, BASE, NOW, 'en')!
    const quests = digest.sections.find((section) => section.heading === 'Quests')!
    expect(quests.items.map((item) => item.text)).toEqual(['2 daily quests are still open and reset at midnight', 'Your weekly quests end in 24 hours'])
  })
})

describe('assembleWeekly', () => {
  const quiet: WeeklyFacts = { shipDay: null, streak: { current: 0, activeDays: 0 }, season: null }

  it('has nothing to send for a week with nothing of the reader’s in it, even when Ship Day happened', () => {
    expect(assembleWeekly(quiet, BASE, 'en')).toBeNull()
    expect(assembleWeekly({ ...quiet, shipDay: { total: 40, yourPosts: 0, yourProps: 0, topTitle: 'Someone’s launch' } }, BASE, 'en')).toBeNull()
  })

  it('recaps the reader’s Ship Day, streak and season standing', () => {
    const digest = assembleWeekly(
      { shipDay: { total: 42, yourPosts: 1, yourProps: 7, topTitle: 'A tiny compiler' }, streak: { current: 5, activeDays: 4 }, season: { name: 'Season 2', rank: 12, score: 340 } },
      BASE,
      'en'
    )!
    const lines = digest.sections.flatMap((section) => section.items.map((item) => item.text))
    expect(lines).toEqual(
      expect.arrayContaining(['You shipped 1 post and got 7 Props on it', '42 builders shipped on Ship Day', 'The week’s top post: “A tiny compiler”', 'Your streak is 5 days', 'You were active on 4 of the last 7 days', 'You are #12 in Season 2 with 340 XP'])
    )
    expect(digest.subject).toBe('Your week on the platform')
  })

  it('is worth sending for a streak alone', () => {
    expect(assembleWeekly({ ...quiet, streak: { current: 2, activeDays: 2 } }, BASE, 'en')).not.toBeNull()
  })
})

describe('digestDue', () => {
  const at = (iso: string) => new Date(iso)

  it('sends the daily digest an hour after the drop time, once a local day', () => {
    expect(digestDue('DIGEST_DAILY', at('2026-10-22T09:30:00Z'), 'UTC', '09:00', null, quietFor)).toBe(false)
    expect(digestDue('DIGEST_DAILY', at('2026-10-22T10:00:00Z'), 'UTC', '09:00', null, quietFor)).toBe(true)
    expect(digestDue('DIGEST_DAILY', at('2026-10-22T10:00:00Z'), 'UTC', '09:00', at('2026-10-22T08:00:00Z'), quietFor)).toBe(false)
    expect(digestDue('DIGEST_DAILY', at('2026-10-22T10:00:00Z'), 'UTC', '09:00', at('2026-10-21T10:00:00Z'), quietFor)).toBe(true)
  })

  it('follows the person’s own clock', () => {
    // 04:30 UTC is 10:00 in Kolkata: due there, not due in New York (00:30).
    expect(digestDue('DIGEST_DAILY', at('2026-10-22T04:30:00Z'), 'Asia/Kolkata', '09:00', null, quietFor)).toBe(true)
    expect(digestDue('DIGEST_DAILY', at('2026-10-22T04:30:00Z'), 'America/New_York', '09:00', null, quietFor)).toBe(false)
  })

  it('does not send in the evening, or during quiet hours', () => {
    expect(digestDue('DIGEST_DAILY', at('2026-10-22T20:30:00Z'), 'UTC', '09:00', null, quietFor)).toBe(false)
    expect(digestDue('DIGEST_DAILY', at('2026-10-22T10:00:00Z'), 'UTC', '09:00', null, { enabled: true, start: 8 * 60, end: 12 * 60 })).toBe(false)
  })

  it('sends the weekly digest on Monday from 09:00 local, once a week', () => {
    // 2026-10-26 is a Monday.
    expect(digestDue('DIGEST_WEEKLY', at('2026-10-26T08:59:00Z'), 'UTC', '09:00', null, { ...quietFor, enabled: false })).toBe(false)
    expect(digestDue('DIGEST_WEEKLY', at('2026-10-26T09:00:00Z'), 'UTC', '09:00', null, quietFor)).toBe(true)
    expect(digestDue('DIGEST_WEEKLY', at('2026-10-27T10:00:00Z'), 'UTC', '09:00', null, quietFor)).toBe(false)
    expect(digestDue('DIGEST_WEEKLY', at('2026-10-26T12:00:00Z'), 'UTC', '09:00', at('2026-10-26T09:05:00Z'), quietFor)).toBe(false)
    expect(digestDue('DIGEST_WEEKLY', at('2026-10-26T12:00:00Z'), 'UTC', '09:00', at('2026-10-19T09:05:00Z'), quietFor)).toBe(true)
  })
})

describe('relativeWhen', () => {
  it('says hours up to a day and a half, then days', () => {
    expect(relativeWhen(NOW, new Date('2026-10-22T15:00:00Z'), 'en')).toBe('in 5 hours')
    expect(relativeWhen(NOW, new Date('2026-10-23T10:00:00Z'), 'en')).toBe('in 24 hours')
    expect(relativeWhen(NOW, new Date('2026-10-25T10:00:00Z'), 'en')).toBe('in 3 days')
  })
})
