import { describe, expect, it } from 'vitest'
import { readOnboardingState } from './onboarding-state'

describe('readOnboardingState', () => {
  it('reads a definite answer from a successful response', () => {
    expect(readOnboardingState(200, { onboardingComplete: true })).toBe('complete')
    expect(readOnboardingState(200, { onboardingComplete: false })).toBe('incomplete')
  })

  it('treats a 401 as unknown, even when the body looks like an answer', () => {
    expect(readOnboardingState(401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })).toBe('unknown')
    expect(readOnboardingState(401, { onboardingComplete: false })).toBe('unknown')
  })

  it.each([403, 404, 429, 500, 503])('treats a %i as unknown', (status) => {
    expect(readOnboardingState(status, null)).toBe('unknown')
  })

  it.each([null, undefined, 'text', 42, {}, { onboardingComplete: 'yes' }, { onboardingComplete: null }])(
    'treats a 200 without a boolean answer as unknown: %j',
    (body) => {
      expect(readOnboardingState(200, body)).toBe('unknown')
    }
  )
})
