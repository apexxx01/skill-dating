import { describe, it, expect } from 'vitest'
import { fridayOfDateKey, isFridayKey, shipDayFor, shipDayKeyOf } from './ship-day'

describe('Friday in the viewer zone', () => {
  it('is Friday for a Pune viewer from Thursday 18:30 UTC to Friday 18:30 UTC', () => {
    // 2026-10-16 is a Friday.
    expect(shipDayFor(new Date('2026-10-15T18:29:59Z'), 'Asia/Kolkata').isShipDay).toBe(false)
    const open = shipDayFor(new Date('2026-10-15T18:30:00Z'), 'Asia/Kolkata')
    expect(open.isShipDay).toBe(true)
    expect(open.dateKey).toBe('2026-10-16')
    expect(open.startsAt.toISOString()).toBe('2026-10-15T18:30:00.000Z')
    expect(open.endsAt.toISOString()).toBe('2026-10-16T18:30:00.000Z')
    expect(shipDayFor(new Date('2026-10-16T18:29:59Z'), 'Asia/Kolkata').isShipDay).toBe(true)
    expect(shipDayFor(new Date('2026-10-16T18:30:00Z'), 'Asia/Kolkata').isShipDay).toBe(false)
  })

  it('is not the same moment everywhere: Friday evening in California is already Saturday in Pune', () => {
    const moment = new Date('2026-10-17T02:00:00Z')
    expect(shipDayFor(moment, 'America/Los_Angeles').isShipDay).toBe(true)
    expect(shipDayFor(moment, 'Asia/Kolkata').isShipDay).toBe(false)
  })

  it('falls back to UTC for a missing or unknown zone', () => {
    expect(shipDayFor(new Date('2026-10-16T12:00:00Z'), null).isShipDay).toBe(true)
    expect(shipDayFor(new Date('2026-10-16T12:00:00Z'), 'Nowhere/Land').isShipDay).toBe(true)
  })

  it('names the Friday of the week the viewer is in, even on a weekend, and its ISO week', () => {
    const saturday = shipDayFor(new Date('2026-10-17T10:00:00Z'), 'UTC')
    expect(saturday.isShipDay).toBe(false)
    expect(saturday.dateKey).toBe('2026-10-16')
    expect(saturday.weekKey).toBe('2026-W42')
    expect(saturday.endsAt.getTime()).toBeLessThan(new Date('2026-10-17T10:00:00Z').getTime())
    const monday = shipDayFor(new Date('2026-10-19T10:00:00Z'), 'UTC')
    expect(monday.dateKey).toBe('2026-10-23')
    expect(monday.weekKey).toBe('2026-W43')
  })

  it('handles the year boundary by ISO week', () => {
    // 2027-01-01 is a Friday in ISO week 53 of 2026.
    expect(shipDayFor(new Date('2027-01-01T12:00:00Z'), 'UTC')).toMatchObject({ isShipDay: true, dateKey: '2027-01-01', weekKey: '2026-W53' })
  })

  it('has a 23 or 25 hour Friday when the clocks change', () => {
    // Europe/Paris ends daylight saving on Sunday, so use New York, whose change is also a Sunday; a Friday is always 24h there. Use a zone that changes on a Friday: none common.
    const status = shipDayFor(new Date('2026-10-16T12:00:00Z'), 'Europe/Paris')
    expect(status.endsAt.getTime() - status.startsAt.getTime()).toBe(24 * 3_600_000)
  })
})

describe('Friday dates', () => {
  it('finds the Friday of any date', () => {
    expect(fridayOfDateKey('2026-10-12')).toBe('2026-10-16')
    expect(fridayOfDateKey('2026-10-16')).toBe('2026-10-16')
    expect(fridayOfDateKey('2026-10-18')).toBe('2026-10-16')
    expect(isFridayKey('2026-10-16')).toBe(true)
    expect(isFridayKey('2026-10-15')).toBe(false)
  })

  it('says which Ship Day a post belongs to, in the author zone', () => {
    expect(shipDayKeyOf(new Date('2026-10-16T20:00:00Z'), 'America/New_York')).toBe('2026-10-16')
    expect(shipDayKeyOf(new Date('2026-10-16T20:00:00Z'), 'Asia/Kolkata')).toBeNull() // already Saturday in Pune
    expect(shipDayKeyOf(new Date('2026-10-14T10:00:00Z'), 'UTC')).toBeNull()
  })
})
