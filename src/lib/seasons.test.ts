import { describe, it, expect } from 'vitest'
import { nextSeasonWindow, SEASON_LENGTH_DAYS, seasonName } from './seasons'

const DAY = 24 * 60 * 60 * 1000

describe('nextSeasonWindow', () => {
  it('is eight weeks', () => {
    expect(SEASON_LENGTH_DAYS).toBe(56)
  })

  it('starts where the last season stopped, so seasons are back to back', () => {
    const previousEnd = new Date('2026-12-11T12:00:00Z')
    const window = nextSeasonWindow(previousEnd, new Date('2026-12-11T12:30:00Z'))
    expect(window.startsAt.toISOString()).toBe('2026-12-11T12:00:00.000Z')
    expect(window.endsAt.toISOString()).toBe('2027-02-05T12:00:00.000Z')
    expect((window.endsAt.getTime() - window.startsAt.getTime()) / DAY).toBe(56)
  })

  it('still follows on when the job ran a few days late', () => {
    const previousEnd = new Date('2026-12-11T12:00:00Z')
    const window = nextSeasonWindow(previousEnd, new Date('2026-12-20T00:00:00Z'))
    expect(window.startsAt).toEqual(previousEnd)
  })

  it('starts now when the job was down so long that the following season is over too', () => {
    const previousEnd = new Date('2026-12-11T12:00:00Z')
    const now = new Date('2027-04-01T00:00:00Z')
    const window = nextSeasonWindow(previousEnd, now)
    expect(window.startsAt).toEqual(now)
    expect(window.endsAt.getTime() - now.getTime()).toBe(56 * DAY)
  })

  it('starts now at exactly the moment the following season would end', () => {
    const previousEnd = new Date('2026-12-11T12:00:00Z')
    const now = new Date(previousEnd.getTime() + 56 * DAY)
    expect(nextSeasonWindow(previousEnd, now).startsAt).toEqual(now)
    expect(nextSeasonWindow(previousEnd, new Date(now.getTime() - 1)).startsAt).toEqual(previousEnd)
  })
})

describe('seasonName', () => {
  it('numbers them', () => {
    expect(seasonName(1)).toBe('Season 1')
    expect(seasonName(12)).toBe('Season 12')
  })
})
