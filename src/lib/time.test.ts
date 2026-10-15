import { describe, it, expect } from 'vitest'
import { isValidTimeZone, resolveTimeZone, localDayStart, localDateKey } from './time'

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
