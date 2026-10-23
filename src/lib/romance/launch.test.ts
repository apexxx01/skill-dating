import { describe, it, expect } from 'vitest'
import type { FlagRecord } from '@/lib/flags'
import { cityFlagKey, isRomanceKind, romanceOpen, romanceOpenAnywhere, romanceOpenFor, romanceOpenForMany } from './launch'
import { isLaunchGateFlag } from './launch-keys'

const flag = (key: string, over: Partial<FlagRecord> = {}): FlagRecord => ({ key, enabled: false, rolloutPercent: 100, allowUserIds: [], ...over })
const PUNE = { countryCode: 'IN', cityKey: 'pune' }

describe('the romance launch gate', () => {
  it('ships closed: no flag, or the flag off, is closed for everybody', () => {
    expect(romanceOpen([], 'u1', PUNE)).toBe(false)
    expect(romanceOpen([flag('romance.enabled')], 'u1', PUNE)).toBe(false)
    expect(romanceOpenAnywhere([])).toBe(false)
    expect(romanceOpenAnywhere([flag('romance.enabled')])).toBe(false)
  })

  it('opens everywhere when the flag is on, and a rollout share of people when it is partial', () => {
    expect(romanceOpen([flag('romance.enabled', { enabled: true })], 'u1', null)).toBe(true)
    const half = [flag('romance.enabled', { enabled: true, rolloutPercent: 50 })]
    const open = Array.from({ length: 200 }, (_, i) => romanceOpen(half, `user-${i}`, null)).filter(Boolean).length
    expect(open).toBeGreaterThan(60)
    expect(open).toBeLessThan(140)
    // A person keeps their answer.
    expect(romanceOpen(half, 'user-7', null)).toBe(romanceOpen(half, 'user-7', null))
  })

  it('opens for an allowlisted person while the flag is off', () => {
    const flags = [flag('romance.enabled', { allowUserIds: ['tester'] })]
    expect(romanceOpen(flags, 'tester', null)).toBe(true)
    expect(romanceOpen(flags, 'someone', null)).toBe(false)
    expect(romanceOpenAnywhere(flags)).toBe(true)
  })

  it('opens city by city with the flag of the city', () => {
    const flags = [flag('romance.city.in-pune', { enabled: true })]
    expect(romanceOpen(flags, 'u1', PUNE)).toBe(true)
    expect(romanceOpen(flags, 'u1', { countryCode: 'IN', cityKey: 'mumbai' })).toBe(false)
    expect(romanceOpen(flags, 'u1', { countryCode: 'GB', cityKey: 'pune' })).toBe(false)
    expect(romanceOpen(flags, 'u1', { countryCode: null, cityKey: null })).toBe(false)
    expect(romanceOpen(flags, 'u1', null)).toBe(false)
    expect(romanceOpenAnywhere(flags)).toBe(true)
  })

  it('is closed everywhere while the kill switch is on, whatever is open', () => {
    const flags = [flag('romance.enabled', { enabled: true }), flag('romance.city.in-pune', { enabled: true }), flag('kill.romance', { enabled: true })]
    expect(romanceOpen(flags, 'u1', PUNE)).toBe(false)
    expect(romanceOpenAnywhere(flags)).toBe(false)
  })

  it('names a city flag from the country code and the city key, and none when the place cannot make a key', () => {
    expect(cityFlagKey('IN', 'pune')).toBe('romance.city.in-pune')
    expect(cityFlagKey('BR', 'sao-paulo')).toBe('romance.city.br-sao-paulo')
    expect(cityFlagKey(null, 'pune')).toBeNull()
    expect(cityFlagKey('IN', null)).toBeNull()
    expect(cityFlagKey('IN', 'x'.repeat(80))).toBeNull() // longer than a flag key can be
  })

  it('knows which flags and which notification kinds belong to the mode', () => {
    expect(['romance.enabled', 'romance.city.in-pune', 'kill.romance'].every(isLaunchGateFlag)).toBe(true)
    expect(['kill.posting', 'feature.x'].some(isLaunchGateFlag)).toBe(false)
    expect(['ROMANCE_DROP', 'ROMANCE_OPEN', 'ROMANCE_SPARK_DIGEST'].every(isRomanceKind)).toBe(true)
    expect(['SPARK', 'MATCH_CREATED', 'CARDS_ADULT'].some(isRomanceKind)).toBe(false)
  })

  it('treats a flag store that cannot be read as closed', async () => {
    const broken = { featureFlag: { findMany: async () => Promise.reject(new Error('down')) }, profile: { findUnique: async () => null, findMany: async () => [] } }
    const cache = { get: async () => null, set: async () => undefined, del: async () => undefined } as never
    expect(await romanceOpenFor(broken as never, 'u1', cache)).toBe(false)
    expect((await romanceOpenForMany(broken as never, ['u1', 'u2'], cache)).size).toBe(0)
  })

  it('looks a person up only when a city flag could matter, and answers a list in one pass', async () => {
    let lookups = 0
    const db = {
      featureFlag: { findMany: async () => [{ key: 'romance.city.in-pune', enabled: true, rolloutPercent: 100, allowUserIds: [] }] },
      profile: {
        findUnique: async () => {
          lookups += 1
          return PUNE
        },
        findMany: async ({ where }: { where: { userId: { in: string[] } } }) => where.userId.in.map((userId) => ({ userId, ...(userId === 'far' ? { countryCode: 'IN', cityKey: 'delhi' } : PUNE) })),
      },
    }
    const cache = { get: async () => null, set: async () => undefined, del: async () => undefined } as never
    expect(await romanceOpenFor(db as never, 'u1', cache)).toBe(true)
    expect(lookups).toBe(1)
    expect([...(await romanceOpenForMany(db as never, ['a', 'b', 'far'], cache))].sort()).toEqual(['a', 'b'])
  })
})
