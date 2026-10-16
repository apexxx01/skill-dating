import { describe, it, expect } from 'vitest'
import { boardKey, BOARD_PERIODS, BOARD_SCOPES, ownScopeIds, parseScopeId, periodsAt, scopeRef, scopesOf } from './leaderboard-boards'

const DAY = 24 * 60 * 60 * 1000

describe('periodsAt', () => {
  const now = new Date('2026-10-16T12:00:00Z') // a Friday in week 42
  const season = { id: 'season-3', endsAt: new Date('2026-12-11T00:00:00Z') }

  it('names the week, the month, the season and all time', () => {
    const periods = periodsAt(now, season)
    expect(periods.map((p) => [p.period, p.key])).toEqual([
      ['weekly', 'w:2026-W42'],
      ['monthly', 'm:2026-10'],
      ['season', 's:season-3'],
      ['all-time', 'a'],
    ])
    expect(periods.map((p) => p.period)).toEqual([...BOARD_PERIODS])
  })

  it('has no season board between seasons', () => {
    expect(periodsAt(now, null).map((p) => p.period)).toEqual(['weekly', 'monthly', 'all-time'])
  })

  it('runs weeks Monday to Monday and months from the 1st, in UTC', () => {
    const [week, month] = periodsAt(now, null)
    expect(week.start?.toISOString()).toBe('2026-10-12T00:00:00.000Z')
    expect(week.end?.toISOString()).toBe('2026-10-19T00:00:00.000Z')
    expect(month.start?.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(month.end?.toISOString()).toBe('2026-11-01T00:00:00.000Z')
  })

  it('rolls over at the same instant for everybody: the last millisecond of a week and the first of the next', () => {
    expect(periodsAt(new Date('2026-10-18T23:59:59.999Z'), null)[0].key).toBe('w:2026-W42')
    expect(periodsAt(new Date('2026-10-19T00:00:00Z'), null)[0].key).toBe('w:2026-W43')
    expect(periodsAt(new Date('2026-10-31T23:59:59.999Z'), null)[1].key).toBe('m:2026-10')
    expect(periodsAt(new Date('2026-11-01T00:00:00Z'), null)[1].key).toBe('m:2026-11')
    expect(periodsAt(new Date('2026-12-31T12:00:00Z'), null)[1].key).toBe('m:2026-12')
    expect(periodsAt(new Date('2027-01-01T00:00:00Z'), null)[1].key).toBe('m:2027-01')
  })

  it('names the ISO week even where it belongs to the neighbouring year', () => {
    expect(periodsAt(new Date('2024-12-30T10:00:00Z'), null)[0].key).toBe('w:2025-W01')
    expect(periodsAt(new Date('2027-01-01T10:00:00Z'), null)[0].key).toBe('w:2026-W53')
  })

  it('lets finished boards clean themselves up, and keeps all time forever', () => {
    const [week, month, seasonal, all] = periodsAt(now, season)
    expect(week.ttlMs).toBe(week.end!.getTime() - now.getTime() + 21 * DAY)
    expect(month.ttlMs).toBe(month.end!.getTime() - now.getTime() + 60 * DAY)
    expect(seasonal.ttlMs).toBe(season.endsAt.getTime() - now.getTime() + 120 * DAY)
    expect(all.ttlMs).toBeNull()
    for (const period of [week, month, seasonal]) expect(period.ttlMs!).toBeGreaterThan(0)
  })

  it('still keeps a season board for a while after its end, if XP arrives late', () => {
    const late = periodsAt(new Date('2026-12-12T00:00:00Z'), season)[2]
    expect(late.ttlMs).toBe(120 * DAY)
  })

  it('reads the season’s XP by its id, and the others by time', () => {
    const [week, , seasonal, all] = periodsAt(now, season)
    expect(seasonal.seasonId).toBe('season-3')
    expect(week.seasonId).toBeUndefined()
    expect([all.start, all.end]).toEqual([null, null])
    expect([seasonal.start, seasonal.end]).toEqual([null, null])
  })
})

describe('scopesOf', () => {
  it('puts everybody on the global board', () => {
    expect(scopesOf({ hidden: false, countryCode: null, cityKey: null, campusKey: null }).map((s) => s.key)).toEqual(['g'])
  })

  it('adds the country, the city within it and the campus', () => {
    const scopes = scopesOf({ hidden: false, countryCode: 'IN', cityKey: 'bengaluru', campusKey: 'iisc' })
    expect(scopes.map((s) => [s.scope, s.id, s.key])).toEqual([
      ['global', null, 'g'],
      ['country', 'IN', 'c:IN'],
      ['city', 'IN:bengaluru', 'y:IN:bengaluru'],
      ['campus', 'iisc', 'u:iisc'],
    ])
  })

  it('has no city board without a country, since the same name exists in many countries', () => {
    expect(scopesOf({ hidden: false, countryCode: null, cityKey: 'springfield', campusKey: null }).map((s) => s.scope)).toEqual(['global'])
  })

  it('puts a person who opted out of leaderboards on none', () => {
    expect(scopesOf({ hidden: true, countryCode: 'IN', cityKey: 'pune', campusKey: 'coep' })).toEqual([])
  })

  it('offers a person their own scope ids', () => {
    expect(ownScopeIds({ countryCode: 'IN', cityKey: 'pune', campusKey: 'coep' })).toEqual({ country: 'IN', city: 'IN:pune', campus: 'coep' })
    expect(ownScopeIds({ countryCode: null, cityKey: 'pune', campusKey: null })).toEqual({ country: null, city: null, campus: null })
  })
})

describe('boardKey', () => {
  it('joins the period and the scope', () => {
    const [week] = periodsAt(new Date('2026-10-16T12:00:00Z'), null)
    expect(boardKey(week, scopeRef('global', null))).toBe('lb:w:2026-W42:g')
    expect(boardKey(week, scopeRef('country', 'IN'))).toBe('lb:w:2026-W42:c:IN')
    expect(boardKey('a', 'y:IN:pune')).toBe('lb:a:y:IN:pune')
  })

  it('lists the scopes a client may ask for', () => {
    expect([...BOARD_SCOPES]).toEqual(['global', 'country', 'city', 'campus', 'crew'])
  })
})

describe('parseScopeId', () => {
  it('forgives case and padding for a country, and refuses what is not assigned', () => {
    expect(parseScopeId('country', 'in')).toBe('IN')
    expect(parseScopeId('country', ' gb ')).toBe('GB')
    expect(parseScopeId('country', 'XX')).toBeNull()
    expect(parseScopeId('country', 'India')).toBeNull()
    expect(parseScopeId('country', '')).toBeNull()
  })

  it('wants a country and a city for a city, and tidies the city the way profiles do', () => {
    expect(parseScopeId('city', 'IN:bengaluru')).toBe('IN:bengaluru')
    expect(parseScopeId('city', 'in:Bengaluru')).toBe('IN:bengaluru')
    expect(parseScopeId('city', 'BR:São Paulo')).toBe('BR:sao-paulo')
    expect(parseScopeId('city', 'bengaluru')).toBeNull()
    expect(parseScopeId('city', 'XX:bengaluru')).toBeNull()
    expect(parseScopeId('city', 'IN:')).toBeNull()
    expect(parseScopeId('city', 'IN:a:b')).toBeNull()
  })

  it('tidies a campus', () => {
    expect(parseScopeId('campus', 'IISc Bangalore')).toBe('iisc-bangalore')
    expect(parseScopeId('campus', 'iisc-bangalore')).toBe('iisc-bangalore')
    expect(parseScopeId('campus', '---')).toBeNull()
  })

  it('never lets an id carry a cache key separator through', () => {
    expect(parseScopeId('campus', 'a:b/c*d')).toBe('a-b-c-d')
    expect(parseScopeId('country', 'I:N')).toBeNull()
  })

  it('has no id for the global board', () => {
    expect(parseScopeId('global', 'anything')).toBeNull()
  })
})
