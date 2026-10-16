import { describe, it, expect } from 'vitest'
import {
  addDaysToDateKey,
  daysBetweenDateKeys,
  isLocalWeekend,
  isoWeekKeyOfDateKey,
  isoWeekdayOfDateKey,
  isValidTimeZone,
  localDateKey,
  localDateStart,
  localDayEnd,
  localDayStart,
  localHour,
  localIsoWeekday,
  localWeekEnd,
  localWeekKey,
  localWeekStart,
  mondayOfDateKey,
  resolveTimeZone,
} from './time'

const at = (iso: string) => new Date(iso)
const start = (nowIso: string, zone: string | null | undefined) => localDayStart(at(nowIso), zone).toISOString()

describe('time zone resolution', () => {
  it('accepts IANA names and rejects everything else', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone(null)).toBe(false)
    expect(isValidTimeZone(undefined)).toBe(false)
    expect(isValidTimeZone('x'.repeat(100))).toBe(false)
  })

  it('falls back to UTC', () => {
    expect(resolveTimeZone('Europe/Paris')).toBe('Europe/Paris')
    expect(resolveTimeZone('garbage')).toBe('UTC')
    expect(resolveTimeZone(null)).toBe('UTC')
  })
})

describe('localDateKey', () => {
  it('is the calendar date in the zone', () => {
    const instant = at('2026-03-10T20:00:00Z')
    expect(localDateKey(instant, 'UTC')).toBe('2026-03-10')
    expect(localDateKey(instant, 'Asia/Kolkata')).toBe('2026-03-11')
    expect(localDateKey(instant, 'America/Los_Angeles')).toBe('2026-03-10')
    expect(localDateKey(instant, 'Pacific/Kiritimati')).toBe('2026-03-11')
    expect(localDateKey(instant, undefined)).toBe('2026-03-10')
  })
})

describe('localDayStart', () => {
  it('is UTC midnight with no zone, or an invalid one', () => {
    expect(start('2026-03-10T15:30:00Z', null)).toBe('2026-03-10T00:00:00.000Z')
    expect(start('2026-03-10T15:30:00Z', 'nonsense')).toBe('2026-03-10T00:00:00.000Z')
    expect(start('2026-03-10T00:00:00Z', 'UTC')).toBe('2026-03-10T00:00:00.000Z')
  })

  it('handles a half-hour zone', () => {
    // 20:00Z is 01:30 on the 11th in Kolkata.
    expect(start('2026-03-10T20:00:00Z', 'Asia/Kolkata')).toBe('2026-03-10T18:30:00.000Z')
    // 18:29Z is still the 10th (23:59 local).
    expect(start('2026-03-10T18:29:59Z', 'Asia/Kolkata')).toBe('2026-03-09T18:30:00.000Z')
  })

  it('handles the extreme offsets on both sides', () => {
    expect(start('2026-03-10T09:00:00Z', 'Pacific/Kiritimati')).toBe('2026-03-09T10:00:00.000Z')
    expect(start('2026-03-10T05:00:00Z', 'Pacific/Pago_Pago')).toBe('2026-03-09T11:00:00.000Z')
  })

  it('resets exactly at local midnight, not before', () => {
    expect(start('2026-03-10T03:59:59Z', 'America/New_York')).toBe('2026-03-09T04:00:00.000Z')
    expect(start('2026-03-10T04:00:00Z', 'America/New_York')).toBe('2026-03-10T04:00:00.000Z')
  })

  it('is right on the 23-hour spring-forward day and the 25-hour fall-back day', () => {
    expect(start('2026-03-08T20:00:00Z', 'America/New_York')).toBe('2026-03-08T05:00:00.000Z')
    expect(start('2026-03-09T03:59:00Z', 'America/New_York')).toBe('2026-03-08T05:00:00.000Z')
    expect(start('2026-11-01T20:00:00Z', 'America/New_York')).toBe('2026-11-01T04:00:00.000Z')
    expect(start('2026-11-02T04:30:00Z', 'America/New_York')).toBe('2026-11-01T04:00:00.000Z')
  })

  it('uses the moment of the jump when a zone skips midnight', () => {
    // Beirut moves from 00:00 to 01:00 on 2026-03-29, so local midnight never happens.
    expect(start('2026-03-29T08:00:00Z', 'Asia/Beirut')).toBe('2026-03-28T22:00:00.000Z')
  })

  it('uses the first midnight when a zone repeats it', () => {
    // Havana moves from 01:00 back to 00:00 on 2026-11-01, so 00:00 happens twice.
    expect(start('2026-11-01T12:00:00Z', 'America/Havana')).toBe('2026-11-01T04:00:00.000Z')
  })

  it('has the same start for every instant of one local day, and a new one after', () => {
    for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Chatham', 'America/Sao_Paulo']) {
      const first = localDayStart(at('2026-10-04T12:00:00Z'), zone)
      for (let minutes = 0; minutes < 26 * 60; minutes += 17) {
        const now = new Date(first.getTime() + minutes * 60_000)
        const sameDay = localDateKey(now, zone) === localDateKey(first, zone)
        const computed = localDayStart(now, zone)
        if (sameDay) expect(computed.toISOString()).toBe(first.toISOString())
        else expect(computed.getTime()).toBeGreaterThan(first.getTime())
      }
    }
  })

  it('never returns an instant after now, or more than 25 hours before it', () => {
    const zones = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Australia/Lord_Howe', 'Europe/Dublin']
    for (const zone of zones) {
      for (let day = 0; day < 365; day += 7) {
        for (const hour of [0, 5, 11, 17, 23]) {
          const now = new Date(Date.UTC(2026, 0, 1 + day, hour, 7))
          const dayStart = localDayStart(now, zone)
          expect(dayStart.getTime()).toBeLessThanOrEqual(now.getTime())
          expect(now.getTime() - dayStart.getTime()).toBeLessThan(25 * 3_600_000)
          expect(localDateKey(dayStart, zone)).toBe(localDateKey(now, zone))
          expect(localDateKey(new Date(dayStart.getTime() - 1), zone)).not.toBe(localDateKey(now, zone))
        }
      }
    }
  })
})

describe('calendar arithmetic on date keys', () => {
  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDaysToDateKey('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDaysToDateKey('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysToDateKey('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDaysToDateKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDaysToDateKey('2026-06-15', 0)).toBe('2026-06-15')
  })

  it('counts days between dates, signed', () => {
    expect(daysBetweenDateKeys('2026-03-01', '2026-03-01')).toBe(0)
    expect(daysBetweenDateKeys('2026-03-01', '2026-03-02')).toBe(1)
    expect(daysBetweenDateKeys('2026-03-02', '2026-03-01')).toBe(-1)
    expect(daysBetweenDateKeys('2025-12-31', '2026-12-31')).toBe(365)
    expect(daysBetweenDateKeys('2028-01-01', '2029-01-01')).toBe(366)
  })

  it('is not thrown off by daylight saving, because it never leaves the calendar', () => {
    expect(daysBetweenDateKeys('2026-03-07', '2026-03-09')).toBe(2)
    expect(daysBetweenDateKeys('2026-10-31', '2026-11-02')).toBe(2)
  })

  it('refuses something that is not a date', () => {
    expect(() => addDaysToDateKey('tomorrow', 1)).toThrow()
    expect(() => daysBetweenDateKeys('2026-3-1', '2026-03-02')).toThrow()
  })
})

describe('localDateStart and localDayEnd', () => {
  it('is the first instant of any date in the zone, not only today', () => {
    expect(localDateStart('2026-03-10', 'Asia/Kolkata').toISOString()).toBe('2026-03-09T18:30:00.000Z')
    expect(localDateStart('2026-03-10', 'UTC').toISOString()).toBe('2026-03-10T00:00:00.000Z')
    expect(localDateStart('2026-03-10', 'garbage').toISOString()).toBe('2026-03-10T00:00:00.000Z')
  })

  it('agrees with localDayStart', () => {
    const now = at('2026-07-04T09:15:00Z')
    for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      expect(localDateStart(localDateKey(now, zone), zone).toISOString()).toBe(localDayStart(now, zone).toISOString())
    }
  })

  it('lets a day end where the next one starts, 23 hours later on a spring-forward day', () => {
    // New York: clocks go forward on 2026-03-08.
    const start = localDayStart(at('2026-03-08T15:00:00Z'), 'America/New_York')
    const end = localDayEnd(at('2026-03-08T15:00:00Z'), 'America/New_York')
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(end.toISOString()).toBe('2026-03-09T04:00:00.000Z')
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23)
  })

  it('lets a day be 25 hours on a fall-back day', () => {
    const now = at('2026-11-01T15:00:00Z')
    expect((localDayEnd(now, 'America/New_York').getTime() - localDayStart(now, 'America/New_York').getTime()) / 3_600_000).toBe(25)
  })
})

describe('local hour and weekday', () => {
  it('reads the hour in the zone', () => {
    const instant = at('2026-03-10T20:30:00Z')
    expect(localHour(instant, 'UTC')).toBe(20)
    expect(localHour(instant, 'Asia/Kolkata')).toBe(2)
    expect(localHour(instant, 'America/Los_Angeles')).toBe(13)
    expect(localHour(at('2026-03-10T00:00:00Z'), 'UTC')).toBe(0)
    expect(localHour(at('2026-03-10T23:59:59Z'), 'UTC')).toBe(23)
  })

  it('numbers weekdays from Monday = 1 to Sunday = 7', () => {
    expect(isoWeekdayOfDateKey('2026-06-15')).toBe(1) // a Monday
    expect(isoWeekdayOfDateKey('2026-06-20')).toBe(6)
    expect(isoWeekdayOfDateKey('2026-06-21')).toBe(7)
  })

  it('takes the weekday from the local date, which can differ from the UTC one', () => {
    const instant = at('2026-06-20T20:00:00Z') // Saturday evening UTC, already Sunday in Kolkata
    expect(localIsoWeekday(instant, 'UTC')).toBe(6)
    expect(localIsoWeekday(instant, 'Asia/Kolkata')).toBe(7)
    expect(isLocalWeekend(at('2026-06-19T23:00:00Z'), 'UTC')).toBe(false)
    expect(isLocalWeekend(at('2026-06-19T23:00:00Z'), 'Asia/Kolkata')).toBe(true)
    expect(isLocalWeekend(at('2026-06-22T00:00:00Z'), 'UTC')).toBe(false)
  })
})

describe('weeks', () => {
  it('runs Monday to Sunday', () => {
    expect(mondayOfDateKey('2026-06-15')).toBe('2026-06-15')
    expect(mondayOfDateKey('2026-06-17')).toBe('2026-06-15')
    expect(mondayOfDateKey('2026-06-21')).toBe('2026-06-15')
    expect(mondayOfDateKey('2026-06-22')).toBe('2026-06-22')
  })

  it('starts the local week at Monday 00:00 in the zone and ends it seven days later', () => {
    const now = at('2026-06-17T12:00:00Z')
    expect(localWeekStart(now, 'UTC').toISOString()).toBe('2026-06-15T00:00:00.000Z')
    expect(localWeekEnd(now, 'UTC').toISOString()).toBe('2026-06-22T00:00:00.000Z')
    expect(localWeekStart(now, 'Asia/Kolkata').toISOString()).toBe('2026-06-14T18:30:00.000Z')
    // Sunday evening UTC is already the next week in Kolkata.
    expect(localWeekStart(at('2026-06-21T20:00:00Z'), 'Asia/Kolkata').toISOString()).toBe('2026-06-21T18:30:00.000Z')
    expect(localWeekStart(at('2026-06-21T20:00:00Z'), 'UTC').toISOString()).toBe('2026-06-15T00:00:00.000Z')
  })

  it('keeps a week that spans a daylight saving change seven calendar days long', () => {
    const now = at('2026-03-10T12:00:00Z')
    const start = localWeekStart(now, 'America/New_York')
    const end = localWeekEnd(now, 'America/New_York')
    expect(start.toISOString()).toBe('2026-03-09T04:00:00.000Z')
    expect(end.toISOString()).toBe('2026-03-16T04:00:00.000Z')
    const spring = localWeekStart(at('2026-03-05T12:00:00Z'), 'America/New_York')
    expect((localWeekEnd(at('2026-03-05T12:00:00Z'), 'America/New_York').getTime() - spring.getTime()) / 3_600_000).toBe(7 * 24 - 1)
  })

  it('names ISO weeks, including the ones that belong to the neighbouring year', () => {
    expect(isoWeekKeyOfDateKey('2026-06-15')).toBe('2026-W25')
    expect(isoWeekKeyOfDateKey('2026-01-01')).toBe('2026-W01') // a Thursday
    expect(isoWeekKeyOfDateKey('2024-12-30')).toBe('2025-W01') // a Monday that starts next year's week 1
    expect(isoWeekKeyOfDateKey('2021-01-03')).toBe('2020-W53') // a Sunday that ends last year's week 53
    expect(isoWeekKeyOfDateKey('2026-12-31')).toBe('2026-W53')
    expect(isoWeekKeyOfDateKey('2027-01-01')).toBe('2026-W53')
  })

  it('names the local week at an instant, using the local date', () => {
    expect(localWeekKey(at('2026-06-21T20:00:00Z'), 'UTC')).toBe('2026-W25')
    expect(localWeekKey(at('2026-06-21T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-W26')
  })
})
