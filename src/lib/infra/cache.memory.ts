import type { Cache, ScoredMember, WindowHit } from './cache'

// In-process `Cache`. Used by tests, and in development when no Redis is
// configured. Two properties matter for safety, carried over from the rate
// limiter this replaces: expired entries are swept periodically, and the total
// key count is hard-capped (oldest evicted first), so a client that fabricates
// many distinct keys cannot grow memory without bound. State is per process:
// with several instances each has its own, which is exactly the case the Redis
// implementation exists for.

type Entry =
  | { type: 'string'; value: string; expiresAt: number | null }
  | { type: 'zset'; members: Map<string, number>; expiresAt: number | null }

const SWEEP_INTERVAL_MS = 30_000
const DEFAULT_MAX_KEYS = 50_000

export class MemoryCache implements Cache {
  readonly kind = 'memory' as const
  private readonly entries = new Map<string, Entry>()
  private lastSweep = 0

  constructor(
    private readonly maxKeys: number = DEFAULT_MAX_KEYS,
    private readonly now: () => number = () => Date.now()
  ) {}

  get size(): number {
    return this.entries.size
  }

  private live(key: string): Entry | undefined {
    const now = this.now()
    this.sweep(now)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== null && now >= entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  private sweep(now: number) {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return
    this.lastSweep = now
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) this.entries.delete(key)
    }
  }

  private store(key: string, entry: Entry) {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  private string(key: string): Extract<Entry, { type: 'string' }> | undefined {
    const entry = this.live(key)
    if (entry && entry.type !== 'string') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
    return entry
  }

  private zset(key: string, create: boolean): Extract<Entry, { type: 'zset' }> | undefined {
    const entry = this.live(key)
    if (entry && entry.type !== 'zset') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
    if (entry) return entry
    if (!create) return undefined
    const fresh: Extract<Entry, { type: 'zset' }> = { type: 'zset', members: new Map(), expiresAt: null }
    this.store(key, fresh)
    return fresh
  }

  async get(key: string) {
    return this.string(key)?.value ?? null
  }

  async set(key: string, value: string, { ttlMs }: { ttlMs?: number } = {}) {
    this.live(key)
    this.store(key, { type: 'string', value, expiresAt: ttlMs && ttlMs > 0 ? this.now() + ttlMs : null })
  }

  async del(key: string) {
    this.entries.delete(key)
  }

  private bump(key: string, by: number, ttlMs: number): WindowHit {
    const now = this.now()
    const existing = this.string(key)
    const current = existing ? Number(existing.value) : 0
    if (!Number.isInteger(current)) throw new Error('ERR value is not an integer or out of range')
    const entry: Extract<Entry, { type: 'string' }> = existing ?? { type: 'string', value: '0', expiresAt: null }
    entry.value = String(current + by)
    // A counter with no expiry gets one, so it can never outlive its window.
    if (ttlMs > 0 && entry.expiresAt === null) entry.expiresAt = now + ttlMs
    if (!existing) this.store(key, entry)
    return { count: current + by, ttlMs: entry.expiresAt === null ? 0 : Math.max(0, entry.expiresAt - now) }
  }

  async incr(key: string, { by = 1, ttlMs = 0 }: { by?: number; ttlMs?: number } = {}) {
    return this.bump(key, by, ttlMs).count
  }

  async hit(key: string, windowMs: number) {
    return this.bump(key, 1, windowMs)
  }

  async zadd(key: string, member: string, score: number) {
    this.zset(key, true)!.members.set(member, score)
  }

  async zincr(key: string, member: string, by: number) {
    const set = this.zset(key, true)!
    const next = (set.members.get(member) ?? 0) + by
    set.members.set(member, next)
    return next
  }

  async zscore(key: string, member: string) {
    return this.zset(key, false)?.members.get(member) ?? null
  }

  async zrem(key: string, member: string) {
    const set = this.zset(key, false)
    if (!set) return false
    const removed = set.members.delete(member)
    if (set.members.size === 0) this.entries.delete(key)
    return removed
  }

  async zcard(key: string) {
    return this.zset(key, false)?.members.size ?? 0
  }

  // Ascending by score, ties by member: the order Redis keeps.
  private ascending(key: string): ScoredMember[] {
    const set = this.zset(key, false)
    if (!set) return []
    return [...set.members.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0))
  }

  async zrevrank(key: string, member: string) {
    const ordered = this.ascending(key)
    const index = ordered.findIndex((entry) => entry.member === member)
    return index === -1 ? null : ordered.length - 1 - index
  }

  async ztop(key: string, limit: number, offset = 0) {
    if (limit <= 0) return []
    return this.ascending(key).reverse().slice(offset, offset + limit)
  }

  async zrangeByScore(key: string, min: number, max: number) {
    return this.ascending(key).filter((entry) => entry.score >= min && entry.score <= max)
  }

  async zremByScore(key: string, min: number, max: number) {
    const set = this.zset(key, false)
    if (!set) return 0
    let removed = 0
    for (const [member, score] of set.members) {
      if (score >= min && score <= max) {
        set.members.delete(member)
        removed += 1
      }
    }
    if (set.members.size === 0) this.entries.delete(key)
    return removed
  }

  async zincrMany(operations: { key: string; member: string; by: number; ttlMs?: number }[]) {
    for (const { key, member, by, ttlMs } of operations) {
      await this.zincr(key, member, by)
      if (ttlMs && ttlMs > 0) {
        const entry = this.zset(key, false)
        if (entry && entry.expiresAt === null) entry.expiresAt = this.now() + ttlMs
      }
    }
  }

  async zreplace(key: string, entries: ScoredMember[], { ttlMs }: { ttlMs?: number } = {}) {
    this.live(key)
    if (entries.length === 0) {
      this.entries.delete(key)
      return
    }
    this.store(key, {
      type: 'zset',
      members: new Map(entries.map(({ member, score }) => [member, score])),
      expiresAt: ttlMs && ttlMs > 0 ? this.now() + ttlMs : null,
    })
  }

  async expire(key: string, ttlMs: number) {
    const entry = this.live(key)
    if (entry) entry.expiresAt = this.now() + ttlMs
  }

  async ping() {}
}
