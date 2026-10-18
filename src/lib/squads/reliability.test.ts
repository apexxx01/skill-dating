import { describe, it, expect } from 'vitest'
import { RELIABILITY_CONFIG, reliabilityOf, reviewValue, type ReviewFacts } from './reliability'

const now = new Date('2026-10-19T12:00:00Z')
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
const review = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({ showedUp: 'YES', wouldBuildAgain: true, createdAt: daysAgo(10), ...over })

describe('reviewValue', () => {
  it('is mostly showing up, partly would-build-again', () => {
    expect(reviewValue({ showedUp: 'YES', wouldBuildAgain: true })).toBe(1)
    expect(reviewValue({ showedUp: 'YES', wouldBuildAgain: false })).toBeCloseTo(0.7)
    expect(reviewValue({ showedUp: 'PARTLY', wouldBuildAgain: true })).toBeCloseTo(0.65)
    expect(reviewValue({ showedUp: 'NO', wouldBuildAgain: false })).toBe(0)
  })
})

describe('reliabilityOf', () => {
  it('is the neutral prior, unknown, with no reviews', () => {
    expect(reliabilityOf([], now)).toEqual({ score: RELIABILITY_CONFIG.prior, reviews: 0, known: false, badge: false })
  })

  it('shrinks a single review toward the prior', () => {
    const one = reliabilityOf([review({ createdAt: now })], now)
    // (0.75 * 3 + 1) / 4
    expect(one.score).toBeCloseTo(0.8125)
    expect(one.known).toBe(true)
    const ghost = reliabilityOf([review({ showedUp: 'NO', wouldBuildAgain: false, createdAt: now })], now)
    expect(ghost.score).toBeCloseTo(0.5625)
  })

  it('moves further from the prior with more reviews', () => {
    const many = reliabilityOf(Array.from({ length: 20 }, () => review({ showedUp: 'NO', wouldBuildAgain: false, createdAt: now })), now)
    expect(many.score).toBeLessThan(0.15)
  })

  it('weighs a recent review more than an old one', () => {
    const recentGood = reliabilityOf([review({ createdAt: daysAgo(0) }), review({ showedUp: 'NO', wouldBuildAgain: false, createdAt: daysAgo(730) })], now)
    const recentBad = reliabilityOf([review({ createdAt: daysAgo(730) }), review({ showedUp: 'NO', wouldBuildAgain: false, createdAt: daysAgo(0) })], now)
    expect(recentGood.score).toBeGreaterThan(recentBad.score)
  })

  it('earns the badge only with enough, good enough reviews', () => {
    expect(reliabilityOf([review(), review()], now).badge).toBe(false)
    expect(reliabilityOf([review(), review(), review()], now).badge).toBe(true)
    expect(reliabilityOf([review(), review(), review({ showedUp: 'PARTLY' })], now).badge).toBe(false)
  })
})
