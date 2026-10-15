import { describe, it, expect, vi } from 'vitest'
import { evaluateFlag, rolloutBucket, loadFlags, invalidateFlags, isEnabled, flagsFor, FLAG_KEY_PATTERN, FLAGS_CACHE_KEY, type FlagRecord } from './flags'
import { MemoryCache } from './infra/cache.memory'

const flag = (overrides: Partial<FlagRecord> = {}): FlagRecord => ({ key: 'new-feed', enabled: true, rolloutPercent: 100, allowUserIds: [], ...overrides })
const users = Array.from({ length: 5000 }, (_, index) => `user_${index}`)
const share = (record: FlagRecord) => users.filter((id) => evaluateFlag(record, id)).length / users.length

describe('evaluateFlag', () => {
  it('is off for a flag that does not exist', () => {
    expect(evaluateFlag(null, 'u1')).toBe(false)
    expect(evaluateFlag(undefined, 'u1')).toBe(false)
  })

  it('is on for everyone when enabled at 100%, signed in or not', () => {
    expect(evaluateFlag(flag(), 'u1')).toBe(true)
    expect(evaluateFlag(flag(), null)).toBe(true)
  })

  it('is off for everyone when disabled', () => {
    expect(evaluateFlag(flag({ enabled: false }), 'u1')).toBe(false)
    expect(share(flag({ enabled: false }))).toBe(0)
  })

  it('is off at 0% even while enabled', () => {
    expect(share(flag({ rolloutPercent: 0 }))).toBe(0)
  })

  it('puts a user on the allowlist in regardless of the switch and the percentage', () => {
    expect(evaluateFlag(flag({ enabled: false, allowUserIds: ['u1'] }), 'u1')).toBe(true)
    expect(evaluateFlag(flag({ rolloutPercent: 0, allowUserIds: ['u1'] }), 'u1')).toBe(true)
    expect(evaluateFlag(flag({ enabled: false, allowUserIds: ['u1'] }), 'u2')).toBe(false)
  })

  it('keeps an anonymous caller out of a partial rollout, and out of an allowlist', () => {
    expect(evaluateFlag(flag({ rolloutPercent: 50 }), null)).toBe(false)
    expect(evaluateFlag(flag({ rolloutPercent: 50, allowUserIds: ['u1'] }), undefined)).toBe(false)
  })
})

describe('percentage rollout', () => {
  it('gives each user the same answer every time', () => {
    const record = flag({ rolloutPercent: 37 })
    for (const id of users.slice(0, 200)) expect(evaluateFlag(record, id)).toBe(evaluateFlag(record, id))
    expect(rolloutBucket('new-feed', 'user_1')).toBe(rolloutBucket('new-feed', 'user_1'))
  })

  it('puts about the requested share of users in', () => {
    for (const percent of [1, 10, 25, 50, 75, 99]) {
      expect(Math.abs(share(flag({ rolloutPercent: percent })) * 100 - percent)).toBeLessThan(2.5)
    }
  })

  it('only ever adds users as the percentage grows', () => {
    let previous = new Set<string>()
    for (const percent of [5, 20, 40, 60, 80, 100]) {
      const current = new Set(users.filter((id) => evaluateFlag(flag({ rolloutPercent: percent }), id)))
      for (const id of previous) expect(current.has(id)).toBe(true)
      previous = current
    }
  })

  it('rolls different flags out to different users', () => {
    const a = users.filter((id) => evaluateFlag(flag({ key: 'flag-a', rolloutPercent: 50 }), id))
    const b = new Set(users.filter((id) => evaluateFlag(flag({ key: 'flag-b', rolloutPercent: 50 }), id)))
    const overlap = a.filter((id) => b.has(id)).length / a.length
    expect(overlap).toBeGreaterThan(0.35)
    expect(overlap).toBeLessThan(0.65)
  })

  it('uses buckets 0 to 99 only, with 1% meaning exactly bucket 0', () => {
    for (const id of users.slice(0, 500)) {
      const bucket = rolloutBucket('k', id)
      expect(bucket).toBeGreaterThanOrEqual(0)
      expect(bucket).toBeLessThan(100)
      expect(evaluateFlag(flag({ key: 'k', rolloutPercent: 1 }), id)).toBe(bucket === 0)
    }
  })
})

describe('FLAG_KEY_PATTERN', () => {
  it('accepts lower-case keys', () => {
    for (const key of ['new-feed', 'a1', 'beta.search', 'ship_posts']) expect(FLAG_KEY_PATTERN.test(key)).toBe(true)
  })

  it('rejects anything else', () => {
    for (const key of ['', 'a', 'New-Feed', '1abc', 'has space', 'x'.repeat(65), '../etc', 'a:b']) expect(FLAG_KEY_PATTERN.test(key)).toBe(false)
  })
})

describe('loading', () => {
  const rows = [
    { key: 'on', enabled: true, rolloutPercent: 100, allowUserIds: [] },
    { key: 'off', enabled: false, rolloutPercent: 100, allowUserIds: ['vip'] },
  ]
  const db = () => ({ featureFlag: { findMany: vi.fn().mockResolvedValue(rows) } }) as never

  it('reads the database once and then the cache', async () => {
    const cache = new MemoryCache()
    const source = db()
    expect(await loadFlags(source, cache)).toEqual(rows)
    await loadFlags(source, cache)
    await isEnabled(source, 'on', 'u1', cache)
    expect((source as { featureFlag: { findMany: ReturnType<typeof vi.fn> } }).featureFlag.findMany).toHaveBeenCalledTimes(1)
  })

  it('reads the database again after invalidation', async () => {
    const cache = new MemoryCache()
    const source = db()
    await loadFlags(source, cache)
    await invalidateFlags(cache)
    expect(await cache.get(FLAGS_CACHE_KEY)).toBeNull()
    await loadFlags(source, cache)
    expect((source as { featureFlag: { findMany: ReturnType<typeof vi.fn> } }).featureFlag.findMany).toHaveBeenCalledTimes(2)
  })

  it('expires the cached set after its time to live', async () => {
    let now = 0
    const cache = new MemoryCache(1000, () => now)
    const source = db()
    await loadFlags(source, cache)
    now += 31_000
    await loadFlags(source, cache)
    expect((source as { featureFlag: { findMany: ReturnType<typeof vi.fn> } }).featureFlag.findMany).toHaveBeenCalledTimes(2)
  })

  it('answers per user for one flag and for all of them', async () => {
    const cache = new MemoryCache()
    const source = db()
    expect(await isEnabled(source, 'on', 'u1', cache)).toBe(true)
    expect(await isEnabled(source, 'off', 'u1', cache)).toBe(false)
    expect(await isEnabled(source, 'off', 'vip', cache)).toBe(true)
    expect(await isEnabled(source, 'missing', 'u1', cache)).toBe(false)
    expect(await flagsFor(source, 'vip', cache)).toEqual({ on: true, off: true })
    expect(await flagsFor(source, 'u1', cache)).toEqual({ on: true, off: false })
  })

  it('still answers from the database when the cache is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken = new MemoryCache()
    broken.get = vi.fn().mockRejectedValue(new Error('redis down'))
    broken.set = vi.fn().mockRejectedValue(new Error('redis down'))
    expect(await isEnabled(db(), 'on', 'u1', broken)).toBe(true)
    warn.mockRestore()
  })
})
