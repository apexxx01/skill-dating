import { describe, it, expect } from 'vitest'
import { isWindowOpen, peerReviewSchema, pledgeSchema, reviewWindow, PEER_REVIEW_WINDOW_MS } from './peer-review'

const end = new Date('2026-11-01T18:00:00Z')

describe('reviewWindow', () => {
  it('opens at the end when there are no results yet, and lasts a week', () => {
    const window = reviewWindow({ endDate: end, resultsAt: null })
    expect(window.opensAt).toEqual(end)
    expect(window.closesAt.getTime() - end.getTime()).toBe(PEER_REVIEW_WINDOW_MS)
  })

  it('opens at the results when they come first, and at the end when it comes first', () => {
    const early = new Date(end.getTime() - 3600_000)
    expect(reviewWindow({ endDate: end, resultsAt: early }).opensAt).toEqual(early)
    expect(reviewWindow({ endDate: end, resultsAt: new Date(end.getTime() + 3600_000) }).opensAt).toEqual(end)
  })

  it('is open from its opening up to, not including, its close', () => {
    const window = reviewWindow({ endDate: end, resultsAt: null })
    expect(isWindowOpen(window, new Date(end.getTime() - 1))).toBe(false)
    expect(isWindowOpen(window, end)).toBe(true)
    expect(isWindowOpen(window, new Date(window.closesAt.getTime() - 1))).toBe(true)
    expect(isWindowOpen(window, window.closesAt)).toBe(false)
  })
})

describe('the request shapes', () => {
  it('takes a pledge with dates in order and sensible hours', () => {
    expect(pledgeSchema.safeParse({ attendance: 'REMOTE', hoursAvailable: 20, availableFrom: '2026-11-01', availableUntil: '2026-11-02' }).success).toBe(true)
    expect(pledgeSchema.safeParse({ attendance: 'REMOTE', hoursAvailable: 20, availableFrom: '2026-11-03', availableUntil: '2026-11-02' }).success).toBe(false)
    expect(pledgeSchema.safeParse({ attendance: 'REMOTE', hoursAvailable: 0, availableFrom: '2026-11-01', availableUntil: '2026-11-02' }).success).toBe(false)
    expect(pledgeSchema.safeParse({ attendance: 'MAYBE', hoursAvailable: 5, availableFrom: '2026-11-01', availableUntil: '2026-11-02' }).success).toBe(false)
  })

  it('keeps a review note to one line of 140 characters', () => {
    expect(peerReviewSchema.safeParse({ revieweeId: 'u', showedUp: 'PARTLY', wouldBuildAgain: true, note: 'x'.repeat(140) }).success).toBe(true)
    expect(peerReviewSchema.safeParse({ revieweeId: 'u', showedUp: 'PARTLY', wouldBuildAgain: true, note: 'x'.repeat(141) }).success).toBe(false)
  })
})
