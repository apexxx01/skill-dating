import { describe, it, expect } from 'vitest'
import { INCR_SCRIPT, RedisCache, type RedisCommands, type ScoredMember } from './cache'
import { MemoryCache } from './cache.memory'
import { cacheContract, type Clock } from './cache.contract'

cacheContract('MemoryCache', (clock: Clock) => new MemoryCache(1000, () => clock.now))

// A stand-in for the Redis server behind RedisCommands, just faithful enough to
// check that RedisCache sends the right commands (with its key prefix), runs the
// counter script with the right arguments and reads replies correctly. It proves
// the adapter's mapping, not Redis itself.
class FakeRedis implements RedisCommands {
  readonly keys = new Set<string>()
  readonly scripts: { script: string; keys: string[]; args: (string | number)[] }[] = []
  private readonly strings = new Map<string, { value: string; expiresAt: number | null }>()
  private readonly zsets = new Map<string, Map<string, number>>()

  constructor(private readonly clock: Clock) {}

  private str(key: string) {
    const entry = this.strings.get(key)
    if (entry && entry.expiresAt !== null && this.clock.now >= entry.expiresAt) {
      this.strings.delete(key)
      this.keys.delete(key)
      return undefined
    }
    return entry
  }

  async get(key: string) {
    return this.str(key)?.value ?? null
  }
  async set(key: string, value: string, px?: number) {
    this.keys.add(key)
    this.strings.set(key, { value, expiresAt: px ? this.clock.now + px : null })
  }
  async del(key: string) {
    this.strings.delete(key)
    this.zsets.delete(key)
    this.keys.delete(key)
  }
  async eval(script: string, keys: string[], args: (string | number)[]) {
    this.scripts.push({ script, keys, args })
    if (script !== INCR_SCRIPT) throw new Error('unknown script')
    const [key] = keys
    const by = Number(args[0])
    const ttl = Number(args[1])
    const entry = this.str(key) ?? { value: '0', expiresAt: null }
    entry.value = String(Number(entry.value) + by)
    if (ttl > 0 && entry.expiresAt === null) entry.expiresAt = this.clock.now + ttl
    this.strings.set(key, entry)
    this.keys.add(key)
    return [Number(entry.value), entry.expiresAt === null ? -1 : entry.expiresAt - this.clock.now]
  }

  private zs(key: string) {
    let set = this.zsets.get(key)
    if (!set) {
      set = new Map()
      this.zsets.set(key, set)
    }
    return set
  }
  private sorted(key: string): ScoredMember[] {
    return [...(this.zsets.get(key)?.entries() ?? [])]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : 1))
  }
  async zadd(key: string, score: number, member: string) {
    this.keys.add(key)
    this.zs(key).set(member, score)
  }
  async zincrby(key: string, by: number, member: string) {
    this.keys.add(key)
    const next = (this.zs(key).get(member) ?? 0) + by
    this.zs(key).set(member, next)
    return next
  }
  async zscore(key: string, member: string) {
    return this.zsets.get(key)?.get(member) ?? null
  }
  async zrem(key: string, member: string) {
    return this.zsets.get(key)?.delete(member) ? 1 : 0
  }
  async zcard(key: string) {
    return this.zsets.get(key)?.size ?? 0
  }
  async zrevrank(key: string, member: string) {
    const ordered = this.sorted(key)
    const index = ordered.findIndex((entry) => entry.member === member)
    return index === -1 ? null : ordered.length - 1 - index
  }
  async zrevrangeWithScores(key: string, start: number, stop: number) {
    return this.sorted(key).reverse().slice(start, stop + 1)
  }
  async zrangeByScoreWithScores(key: string, min: number, max: number) {
    return this.sorted(key).filter((entry) => entry.score >= min && entry.score <= max)
  }
  async zremrangebyscore(key: string, min: number, max: number) {
    const set = this.zsets.get(key)
    if (!set) return 0
    let removed = 0
    for (const [member, score] of set) {
      if (score >= min && score <= max) {
        set.delete(member)
        removed += 1
      }
    }
    return removed
  }
  async ping() {}
}

cacheContract('RedisCache', (clock: Clock) => new RedisCache(new FakeRedis(clock), 'test:'))

describe('MemoryCache', () => {
  it('evicts the oldest keys beyond its cap, so fabricated keys cannot grow memory', async () => {
    const cache = new MemoryCache(10)
    for (let i = 0; i < 50; i++) await cache.hit(`attacker-${i}`, 60_000)
    expect(cache.size).toBeLessThanOrEqual(10)
    expect(await cache.get('attacker-0')).toBeNull()
  })

  it('sweeps expired entries even if nobody asks for them again', async () => {
    const clock: Clock = { now: 1_000_000 }
    const cache = new MemoryCache(1000, () => clock.now)
    for (let i = 0; i < 20; i++) await cache.set(`k${i}`, 'x', { ttlMs: 1000 })
    clock.now += 31_000
    await cache.get('anything')
    expect(cache.size).toBe(0)
  })

  it('refuses to use a key as the wrong kind of value, as Redis does', async () => {
    const cache = new MemoryCache()
    await cache.set('s', 'text')
    await expect(cache.zadd('s', 'a', 1)).rejects.toThrow('WRONGTYPE')
    await cache.zadd('z', 'a', 1)
    await expect(cache.incr('z')).rejects.toThrow('WRONGTYPE')
  })

  it('refuses to increment a value that is not an integer', async () => {
    const cache = new MemoryCache()
    await cache.set('s', 'text')
    await expect(cache.incr('s')).rejects.toThrow('not an integer')
  })
})

describe('RedisCache', () => {
  it('prefixes every key it touches, so environments can share one database', async () => {
    const redis = new FakeRedis({ now: 1 })
    const cache = new RedisCache(redis, 'sd:')
    await cache.set('a', '1')
    await cache.hit('b', 1000)
    await cache.zadd('c', 'm', 1)
    expect([...redis.keys].sort()).toEqual(['sd:a', 'sd:b', 'sd:c'])
  })

  it('runs the counter as one script call carrying the amount and the window', async () => {
    const redis = new FakeRedis({ now: 1 })
    const cache = new RedisCache(redis, 'sd:')
    await cache.hit('w', 5000)
    await cache.incr('c', { by: 3 })
    expect(redis.scripts).toEqual([
      { script: INCR_SCRIPT, keys: ['sd:w'], args: [1, 5000] },
      { script: INCR_SCRIPT, keys: ['sd:c'], args: [3, 0] },
    ])
  })

  it('fails loudly on a reply it does not understand rather than guessing', async () => {
    const broken: RedisCommands = { ...new FakeRedis({ now: 1 }), eval: async () => 'OK' } as unknown as RedisCommands
    await expect(new RedisCache(broken).hit('w', 1000)).rejects.toThrow('unexpected reply')
  })

  it('never lets the counter script leave a key without an expiry', () => {
    // The script re-applies the TTL whenever PTTL reports none, so a crash between
    // INCR and EXPIRE in an older client cannot leave a permanent block behind.
    expect(INCR_SCRIPT).toContain("remaining < 0")
    expect(INCR_SCRIPT).toContain("PEXPIRE")
  })
})
