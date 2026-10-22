import { describe, it, expect } from 'vitest'
import { addDays, daysBetween, formatDay, isDay, mondayOf, parseDay, weekKeyOf, windowStart, yesterday } from './days'
import { METRIC_DEFINITIONS, METRIC_KEYS, definitionOf } from './definitions'
import { MAX_RANGE_DAYS, parseRange, snapshotsCsv } from './query'
import { ACTIVE_EVENTS, MEANINGFUL_EVENTS, OWN_ACTION_XP_TYPES } from './activity'
import { ANALYTICS_EVENTS } from '@/lib/infra/analytics'
import { REWARD_RULES } from '@/lib/rewards-config'
import { ratio, row } from './types'

describe('days', () => {
  it('recognises real calendar days only', () => {
    expect(isDay('2026-10-22')).toBe(true)
    for (const bad of ['2026-02-30', '2026-13-01', '22-10-2026', '2026-10-22T00:00:00Z', '', 'today']) expect(isDay(bad), bad).toBe(false)
    expect(() => parseDay('2026-02-30')).toThrow()
  })

  it('moves by days across month ends and leap days, without a time zone', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
    expect(daysBetween('2026-10-30', '2026-10-30')).toEqual(['2026-10-30'])
    expect(daysBetween('2026-10-31', '2026-10-30')).toEqual([])
  })

  it('names the day that is over, and a window that ends with a day', () => {
    expect(yesterday(new Date('2026-10-22T00:00:01Z'))).toBe('2026-10-21')
    expect(yesterday(new Date('2026-10-22T23:59:59Z'))).toBe('2026-10-21')
    expect(windowStart('2026-10-22', 7)).toBe('2026-10-16')
    expect(windowStart('2026-10-22', 1)).toBe('2026-10-22')
    expect(formatDay(parseDay('2026-10-22'))).toBe('2026-10-22')
  })

  it('names ISO weeks the way the rest of the platform does', () => {
    expect(weekKeyOf('2026-06-15')).toBe('2026-W25')
    expect(weekKeyOf('2026-01-01')).toBe('2026-W01')
    expect(weekKeyOf('2027-01-01')).toBe('2026-W53')
    expect(mondayOf('2026-06-18')).toBe('2026-06-15')
  })
})

describe('what counts as activity', () => {
  it('uses only events the analytics catalogue has', () => {
    for (const name of [...ACTIVE_EVENTS, ...MEANINGFUL_EVENTS]) expect(ANALYTICS_EVENTS as readonly string[], name).toContain(name)
  })

  it('counts a real thing as activity, and never counts the romance mode', () => {
    for (const name of MEANINGFUL_EVENTS) expect(ACTIVE_EVENTS as readonly string[], name).toContain(name)
    for (const name of [...ACTIVE_EVENTS, ...MEANINGFUL_EVENTS]) expect(name).not.toMatch(/romance/)
  })

  it('leaves out what looking and following are worth to "a real thing"', () => {
    expect(MEANINGFUL_EVENTS as readonly string[]).not.toContain('drop_viewed')
    expect(MEANINGFUL_EVENTS as readonly string[]).not.toContain('follow_created')
    expect(MEANINGFUL_EVENTS as readonly string[]).not.toContain('onboarding_completed')
    expect(MEANINGFUL_EVENTS as readonly string[]).not.toContain('signup')
  })

  it('takes XP for an action of the person’s own, not what others do for them', () => {
    expect(OWN_ACTION_XP_TYPES).toEqual(expect.arrayContaining(['PROJECT_CREATED', 'PROJECT_SHIP', 'PROJECT_UPDATE_POSTED', 'EVIDENCE_ADDED']))
    for (const type of ['PROPS_RECEIVED', 'EVIDENCE_ENDORSED', 'TEAM_APPLICATION_ACCEPTED', 'HACKATHON_WIN', 'ACHIEVEMENT_EARNED', 'QUEST_COMPLETED', 'INVITE_QUALIFIED']) {
      expect(OWN_ACTION_XP_TYPES, type).not.toContain(type)
    }
    for (const type of OWN_ACTION_XP_TYPES) expect(REWARD_RULES[type as keyof typeof REWARD_RULES].streak).toBe(true)
  })
})

describe('the catalogue', () => {
  it('defines every metric once, in words', () => {
    expect(new Set(METRIC_KEYS).size).toBe(METRIC_KEYS.length)
    for (const definition of METRIC_DEFINITIONS) {
      expect(definition.key, definition.key).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(definition.definition.length, definition.key).toBeGreaterThan(30)
      expect(definition.label.length, definition.key).toBeGreaterThan(3)
    }
    expect(definitionOf('weekly_active_shippers')?.group).toBe('North star')
    expect(definitionOf('nope')).toBeUndefined()
  })

  it('has the numbers a YC partner asks for', () => {
    for (const key of ['weekly_active_shippers', 'wau', 'mau', 'stickiness_dau_mau', 'retention_d1', 'retention_d7', 'retention_d30', 'activation_7d', 'spark_to_match_rate', 'match_to_first_message_rate', 'drops_viewed_rate', 'drops_acted_rate', 'hackathon_squad_rate', 'time_to_squad_median_hours', 'squads_submitted_rate', 'crews_shipped_30d_rate', 'ship_day_participation', 'props_per_post', 'delivery_open_rate', 'delivery_act_rate', 'reports_per_1k_wau', 'moderation_time_to_action_median_hours', 'users_by_place', 'invites_per_active_user_28d', 'invite_conversion_14d']) {
      expect(METRIC_KEYS, key).toContain(key)
    }
  })

  it('says what the dimension is for every metric that has one', () => {
    for (const key of ['retention_d1', 'activation_7d', 'delivery_open_rate', 'users_by_place', 'invite_conversion_14d', 'ship_day_participation']) expect(definitionOf(key)?.dimension, key).toBeTruthy()
  })
})

describe('parseRange', () => {
  const now = new Date('2026-10-22T10:00:00Z')

  it('defaults to the last 30 days that are over', () => {
    expect(parseRange({}, now)).toEqual({ ok: true, from: '2026-09-22', to: '2026-10-21', keys: null })
  })

  it('takes a range and a list of keys', () => {
    expect(parseRange({ from: '2026-10-01', to: '2026-10-10', keys: ' dau, wau,dau ' }, now)).toEqual({ ok: true, from: '2026-10-01', to: '2026-10-10', keys: ['dau', 'wau'] })
  })

  it('refuses a backwards range, one that is too long, and a key it does not know', () => {
    expect(parseRange({ from: '2026-10-10', to: '2026-10-01' }, now)).toMatchObject({ ok: false, field: 'from' })
    expect(parseRange({ from: '2024-01-01', to: '2026-10-01' }, now)).toMatchObject({ ok: false, field: 'to' })
    expect(parseRange({ from: addDays('2026-10-01', -(MAX_RANGE_DAYS - 1)), to: '2026-10-01' }, now)).toMatchObject({ ok: true })
    expect(parseRange({ keys: 'dau,secret_thing' }, now)).toMatchObject({ ok: false, field: 'keys' })
  })
})

describe('snapshotsCsv', () => {
  it('writes a header and a line per row, with the detail as JSON', () => {
    const csv = snapshotsCsv([{ day: '2026-10-21', key: 'retention_d1', dimension: '2026-W42', value: 0.5, detail: { cohort: 10 } }])
    expect(csv).toBe('day,key,dimension,value,detail\r\n2026-10-21,retention_d1,2026-W42,0.5,"{""cohort"":10}"\r\n')
  })

  it('keeps a spreadsheet from running a cell as a formula', () => {
    const csv = snapshotsCsv([{ day: '2026-10-21', key: 'users_by_place', dimension: '=HYPERLINK("http://evil.example")', value: 3, detail: null }])
    const line = csv.split('\r\n')[1]
    expect(line).not.toMatch(/,=HYPERLINK/)
    expect(line).toContain("'=HYPERLINK")
  })
})

describe('helpers', () => {
  it('makes a ratio only where there is something to divide by', () => {
    expect(ratio(1, 4)).toBe(0.25)
    expect(ratio(0, 4)).toBe(0)
    expect(ratio(1, 0)).toBeNull()
    expect(row('k', null)).toEqual([])
    expect(row('k', Number.NaN)).toEqual([])
    expect(row('k', 0.5, { a: 1 }, 'd')).toEqual([{ key: 'k', dimension: 'd', value: 0.5, detail: { a: 1 } }])
  })
})
