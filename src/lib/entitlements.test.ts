import { describe, it, expect } from 'vitest'
import { can, limit, withinLimit, entitlementsFor, planFor, ENTITLEMENTS, FEATURES, PLANS, type Plan, type SubscriptionState } from './entitlements'

const on = { enforced: true }
const off = { enforced: false }
const subject = (plan: Plan) => ({ plan })

describe('the table', () => {
  it('has the features and free-plan numbers the product started with', () => {
    expect(FEATURES.sort()).toEqual(['ADVANCED_FILTERS', 'BUILD_DATES_PER_WEEK', 'CUSTOM_DOMAIN', 'DAILY_DROPS', 'DAILY_SPARKS', 'PROFILE_ANALYTICS', 'SEE_WHO_SPARKED'])
    expect(ENTITLEMENTS.DAILY_DROPS.plans.FREE).toBe(3)
    expect(ENTITLEMENTS.DAILY_DROPS.plans.PRO).toBe(10)
  })

  it('gives every feature a value for every plan', () => {
    for (const feature of FEATURES) {
      for (const plan of PLANS) expect(ENTITLEMENTS[feature].plans).toHaveProperty(plan)
    }
  })

  it('never gives a lower plan more than a higher one', () => {
    const order: Plan[] = ['FREE', 'PRO', 'CREW_PRO']
    for (const feature of FEATURES) {
      for (let index = 1; index < order.length; index++) {
        const lower = Number(ENTITLEMENTS[feature].plans[order[index - 1]])
        const higher = Number(ENTITLEMENTS[feature].plans[order[index]])
        expect(higher).toBeGreaterThanOrEqual(lower)
      }
    }
  })

  it('keeps every plan limit at or under its hard limit', () => {
    for (const feature of ['DAILY_DROPS', 'BUILD_DATES_PER_WEEK', 'DAILY_SPARKS'] as const) {
      for (const plan of PLANS) expect(ENTITLEMENTS[feature].plans[plan]).toBeLessThanOrEqual(ENTITLEMENTS[feature].hardLimit)
    }
  })
})

describe('enforcement on', () => {
  it('applies the limits of the plan', () => {
    expect(limit(subject('FREE'), 'DAILY_DROPS', on)).toBe(3)
    expect(limit(subject('PRO'), 'DAILY_DROPS', on)).toBe(10)
    expect(limit(subject('FREE'), 'BUILD_DATES_PER_WEEK', on)).toBe(2)
    expect(limit(subject('FREE'), 'DAILY_SPARKS', on)).toBe(5)
    expect(limit(subject('PRO'), 'DAILY_SPARKS', on)).toBe(25)
  })

  it('applies the switches of the plan', () => {
    expect(can(subject('FREE'), 'SEE_WHO_SPARKED', on)).toBe(false)
    expect(can(subject('PRO'), 'SEE_WHO_SPARKED', on)).toBe(true)
    expect(can(subject('PRO'), 'CUSTOM_DOMAIN', on)).toBe(false)
    expect(can(subject('CREW_PRO'), 'CUSTOM_DOMAIN', on)).toBe(true)
    expect(can(subject('ORG'), 'ADVANCED_FILTERS', on)).toBe(true)
  })

  it('treats a counted feature as available while its limit is above zero', () => {
    expect(can(subject('FREE'), 'DAILY_DROPS', on)).toBe(true)
  })

  it('stops at the limit and not before', () => {
    expect(withinLimit(subject('FREE'), 'DAILY_DROPS', 2, on)).toBe(true)
    expect(withinLimit(subject('FREE'), 'DAILY_DROPS', 3, on)).toBe(false)
    expect(withinLimit(subject('PRO'), 'DAILY_DROPS', 3, on)).toBe(true)
  })
})

describe('enforcement off', () => {
  it('opens every switch for every plan', () => {
    for (const plan of PLANS) {
      for (const feature of ['SEE_WHO_SPARKED', 'ADVANCED_FILTERS', 'PROFILE_ANALYTICS', 'CUSTOM_DOMAIN'] as const) {
        expect(can(subject(plan), feature, off)).toBe(true)
      }
    }
  })

  it('lifts the counted limits that are not scarce to the hard safety ceiling, the same for every plan', () => {
    for (const plan of PLANS) expect(limit(subject(plan), 'BUILD_DATES_PER_WEEK', off)).toBe(ENTITLEMENTS.BUILD_DATES_PER_WEEK.hardLimit)
  })

  it('keeps scarcity the product: three drops and five sparks a day for every plan, not the ceiling', () => {
    for (const plan of PLANS) {
      expect(limit(subject(plan), 'DAILY_DROPS', off)).toBe(3)
      expect(limit(subject(plan), 'DAILY_SPARKS', off)).toBe(5)
      expect(limit(subject(plan), 'DAILY_DROPS', off)).toBe(ENTITLEMENTS.DAILY_DROPS.plans.FREE)
      expect(limit(subject(plan), 'DAILY_SPARKS', off)).toBe(ENTITLEMENTS.DAILY_SPARKS.plans.FREE)
    }
  })

  it('lets a plan lift scarcity once plans are enforced, still under the hard ceiling', () => {
    expect(limit(subject('PRO'), 'DAILY_DROPS', on)).toBe(10)
    expect(limit(subject('PRO'), 'DAILY_SPARKS', on)).toBe(25)
    expect(limit(subject('FREE'), 'DAILY_SPARKS', on)).toBe(5)
  })

  it('marks exactly the scarce features', () => {
    const scarce = Object.entries(ENTITLEMENTS).filter(([, spec]) => 'scarce' in spec).map(([name]) => name)
    expect(scarce.sort()).toEqual(['DAILY_DROPS', 'DAILY_SPARKS'])
  })

  it('still stops at the hard ceiling for a feature that is not scarce', () => {
    const ceiling = ENTITLEMENTS.BUILD_DATES_PER_WEEK.hardLimit
    expect(withinLimit(subject('FREE'), 'BUILD_DATES_PER_WEEK', ceiling - 1, off)).toBe(true)
    expect(withinLimit(subject('FREE'), 'BUILD_DATES_PER_WEEK', ceiling, off)).toBe(false)
  })

  it('is what the environment says when no option is given', () => {
    // The unit-test environment leaves ENTITLEMENTS_ENFORCED unset, which means off.
    expect(can(subject('FREE'), 'CUSTOM_DOMAIN')).toBe(true)
    expect(limit(subject('FREE'), 'DAILY_DROPS')).toBe(3)
  })
})

describe('entitlementsFor', () => {
  it('lists every feature with its number or switch', () => {
    expect(entitlementsFor(subject('FREE'), on)).toEqual({
      DAILY_DROPS: 3,
      DAILY_SPARKS: 5,
      BUILD_DATES_PER_WEEK: 2,
      SEE_WHO_SPARKED: false,
      ADVANCED_FILTERS: false,
      PROFILE_ANALYTICS: false,
      CUSTOM_DOMAIN: false,
    })
    expect(entitlementsFor(subject('FREE'), off).SEE_WHO_SPARKED).toBe(true)
  })
})

describe('planFor', () => {
  const now = new Date('2026-06-15T12:00:00Z')
  const future = new Date('2026-07-15T12:00:00Z')
  const past = new Date('2026-05-15T12:00:00Z')
  const sub = (status: SubscriptionState['status'], currentPeriodEnd: Date | null, plan: SubscriptionState['plan'] = 'PRO'): SubscriptionState => ({ plan, status, currentPeriodEnd })

  it('is FREE without a subscription', () => {
    expect(planFor(null, now)).toBe('FREE')
    expect(planFor(undefined, now)).toBe('FREE')
  })

  it('is the plan while the subscription is active', () => {
    expect(planFor(sub('ACTIVE', future), now)).toBe('PRO')
    expect(planFor(sub('ACTIVE', null, 'ORG'), now)).toBe('ORG')
    expect(planFor(sub('TRIALING', future, 'CREW_PRO'), now)).toBe('CREW_PRO')
  })

  it('falls back to FREE when the paid period has ended', () => {
    expect(planFor(sub('ACTIVE', past), now)).toBe('FREE')
    expect(planFor(sub('ACTIVE', now), now)).toBe('FREE')
  })

  it('keeps a late payer on the plan until the period ends', () => {
    expect(planFor(sub('PAST_DUE', future), now)).toBe('PRO')
    expect(planFor(sub('PAST_DUE', past), now)).toBe('FREE')
  })

  it('keeps a cancelled plan only to the end of the period it paid for', () => {
    expect(planFor(sub('CANCELED', future), now)).toBe('PRO')
    expect(planFor(sub('CANCELED', past), now)).toBe('FREE')
    expect(planFor(sub('CANCELED', null), now)).toBe('FREE')
  })

  it('is FREE once expired, whatever the dates say', () => {
    expect(planFor(sub('EXPIRED', future), now)).toBe('FREE')
    expect(planFor(sub('EXPIRED', null), now)).toBe('FREE')
  })

  it('treats a FREE row as FREE', () => {
    expect(planFor(sub('ACTIVE', null, 'FREE'), now)).toBe('FREE')
  })
})
