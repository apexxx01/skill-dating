import { describe, it, expect, vi, beforeEach } from 'vitest'

const track = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/infra/analytics', () => ({ track: (...args: unknown[]) => track(...args) }))

import { trackOnboardingIfComplete } from './onboarding'
import { MemoryCache } from './infra/cache.memory'

function db(state: { headline: string | null; skills: number; tracked?: boolean }) {
  return {
    user: { findUnique: vi.fn().mockResolvedValue({ headline: state.headline }) },
    userSkill: { count: vi.fn().mockResolvedValue(state.skills) },
    productEvent: { findFirst: vi.fn().mockResolvedValue(state.tracked ? { id: 'e1' } : null) },
  } as never
}

beforeEach(() => track.mockClear())

describe('trackOnboardingIfComplete', () => {
  it('records the event when there is a headline and a skill', async () => {
    expect(await trackOnboardingIfComplete(db({ headline: 'Builder', skills: 1 }), 'u1', new MemoryCache())).toBe(true)
    expect(track).toHaveBeenCalledWith('u1', 'onboarding_completed')
  })

  it.each([
    ['no headline', { headline: null, skills: 3 }],
    ['an empty headline', { headline: '', skills: 3 }],
    ['no skills', { headline: 'Builder', skills: 0 }],
  ])('records nothing with %s', async (_label, state) => {
    expect(await trackOnboardingIfComplete(db(state), 'u1', new MemoryCache())).toBe(false)
    expect(track).not.toHaveBeenCalled()
  })

  it('records it once however many times it is asked', async () => {
    const cache = new MemoryCache()
    const source = db({ headline: 'Builder', skills: 2 })
    for (let index = 0; index < 5; index++) await trackOnboardingIfComplete(source, 'u1', cache)
    expect(track).toHaveBeenCalledTimes(1)
  })

  it('records it once when asked at the same moment', async () => {
    const cache = new MemoryCache()
    const source = db({ headline: 'Builder', skills: 2 })
    await Promise.all(Array.from({ length: 8 }, () => trackOnboardingIfComplete(source, 'u1', cache)))
    expect(track).toHaveBeenCalledTimes(1)
  })

  it('does not record it again when the table already has it, even with an empty cache', async () => {
    expect(await trackOnboardingIfComplete(db({ headline: 'Builder', skills: 1, tracked: true }), 'u1', new MemoryCache())).toBe(false)
    expect(track).not.toHaveBeenCalled()
  })

  it('keeps users apart', async () => {
    const cache = new MemoryCache()
    const source = db({ headline: 'Builder', skills: 1 })
    await trackOnboardingIfComplete(source, 'u1', cache)
    await trackOnboardingIfComplete(source, 'u2', cache)
    expect(track).toHaveBeenCalledTimes(2)
  })

  it('never throws, even when the cache or the database fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const cache = new MemoryCache()
    cache.incr = vi.fn().mockRejectedValue(new Error('redis down'))
    expect(await trackOnboardingIfComplete(db({ headline: 'Builder', skills: 1 }), 'u1', cache)).toBe(false)
    const broken = { user: { findUnique: vi.fn().mockRejectedValue(new Error('db down')) }, userSkill: { count: vi.fn() }, productEvent: {} } as never
    expect(await trackOnboardingIfComplete(broken, 'u1', new MemoryCache())).toBe(false)
    warn.mockRestore()
  })
})
