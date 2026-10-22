import { describe, it, expect } from 'vitest'
import { formatMinutes, inQuietHours, minutesOfDay, parseClock, quietEndsAt } from './quiet'

const night = { enabled: true, start: 22 * 60, end: 8 * 60 }
const at = (iso: string) => new Date(iso)

describe('quiet hours', () => {
  it('reads the minute of the local day in the person’s own zone', () => {
    expect(minutesOfDay(at('2026-10-22T20:00:00Z'), 'Asia/Kolkata')).toBe(1 * 60 + 30)
    expect(minutesOfDay(at('2026-10-22T20:00:00Z'), 'America/New_York')).toBe(16 * 60)
    expect(minutesOfDay(at('2026-10-22T20:00:00Z'), null)).toBe(20 * 60)
  })

  it('is quiet across midnight: from 22:00 up to, not including, 08:00', () => {
    const quiet = (iso: string) => inQuietHours(at(iso), 'UTC', night)
    expect(quiet('2026-10-22T21:59:00Z')).toBe(false)
    expect(quiet('2026-10-22T22:00:00Z')).toBe(true)
    expect(quiet('2026-10-23T03:00:00Z')).toBe(true)
    expect(quiet('2026-10-23T07:59:00Z')).toBe(true)
    expect(quiet('2026-10-23T08:00:00Z')).toBe(false)
  })

  it('is quiet inside one day too, when the window does not cross midnight', () => {
    const nap = { enabled: true, start: 13 * 60, end: 15 * 60 }
    expect(inQuietHours(at('2026-10-22T13:30:00Z'), 'UTC', nap)).toBe(true)
    expect(inQuietHours(at('2026-10-22T15:00:00Z'), 'UTC', nap)).toBe(false)
  })

  it('follows the person’s time zone, not the server’s', () => {
    // 20:00 UTC is 01:30 the next morning in Kolkata (quiet) and 16:00 in New York (not).
    expect(inQuietHours(at('2026-10-22T20:00:00Z'), 'Asia/Kolkata', night)).toBe(true)
    expect(inQuietHours(at('2026-10-22T20:00:00Z'), 'America/New_York', night)).toBe(false)
  })

  it('has no quiet hours when switched off or when the start equals the end', () => {
    expect(inQuietHours(at('2026-10-23T03:00:00Z'), 'UTC', { ...night, enabled: false })).toBe(false)
    expect(inQuietHours(at('2026-10-23T03:00:00Z'), 'UTC', { enabled: true, start: 480, end: 480 })).toBe(false)
  })

  it('ends at the next 08:00 local: this morning when it is the small hours, tomorrow morning when it is evening', () => {
    expect(quietEndsAt(at('2026-10-23T03:00:00Z'), 'UTC', night).toISOString()).toBe('2026-10-23T08:00:00.000Z')
    expect(quietEndsAt(at('2026-10-22T23:00:00Z'), 'UTC', night).toISOString()).toBe('2026-10-23T08:00:00.000Z')
    // Kolkata is UTC+5:30, so 08:00 there is 02:30 UTC.
    expect(quietEndsAt(at('2026-10-22T20:00:00Z'), 'Asia/Kolkata', night).toISOString()).toBe('2026-10-23T02:30:00.000Z')
  })

  it('converts clock times for the API', () => {
    expect(formatMinutes(1320)).toBe('22:00')
    expect(formatMinutes(485)).toBe('08:05')
    expect(parseClock('22:00')).toBe(1320)
    expect(parseClock('7:00')).toBeNull()
    expect(parseClock('24:00')).toBeNull()
    expect(parseClock('08:60')).toBeNull()
  })
})
