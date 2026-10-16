import { randomUUID } from 'crypto'
import { Redis } from '@upstash/redis'
import { env } from '@/lib/env'
import { MemoryCache } from './cache.memory'

// Shared fast state: counters, rate-limit windows, sorted sets (leaderboards,
// presence). Callers depend on the `Cache` interface only; Upstash Redis is the
// production implementation and `MemoryCache` (cache.memory.ts) is the in-process
// one used in tests and in development without credentials. Swapping provider
// means writing another `Cache`, nothing else.
//
// Atomicity: `incr` and `hit` are single operations on both implementations (a
// Lua script on Redis), so concurrent callers cannot both observe "first".

export interface ScoredMember {
  member: string
  score: number
}

export interface WindowHit {
  /** The counter after this hit. */
  count: number
  /** Milliseconds until the window ends and the counter disappears. */
  ttlMs: number
}

/** A sorted set under construction (see Cache.zstage). Nothing here is visible to readers until `commit`. */
export interface ZStage {
  /** Sets (overwrites, does not add to) the scores of these members. */
  set(entries: ScoredMember[]): Promise<void>
  remove(members: string[]): Promise<void>
  /**
   * Swaps the staged set in for the real one with one rename. Staging nothing deletes the real key. The result has
   * `ttlMs` as its expiry, or none. A stage is spent once committed or discarded.
   */
  commit(options?: { ttlMs?: number }): Promise<void>
  /** Drops the staged set without touching the real one. */
  discard(): Promise<void>
}

export interface Cache {
  readonly kind: 'memory' | 'upstash'

  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { ttlMs?: number }): Promise<void>
  del(key: string): Promise<void>

  /**
   * Adds `by` (default 1) to a counter and returns the new value. When `ttlMs`
   * is given and the counter has no expiry yet, it starts one, so a counter can
   * never outlive its window.
   */
  incr(key: string, options?: { by?: number; ttlMs?: number }): Promise<number>
  /** `incr` by one with a window, also reporting how long the window has left. */
  hit(key: string, windowMs: number): Promise<WindowHit>

  zadd(key: string, member: string, score: number): Promise<void>
  zincr(key: string, member: string, by: number): Promise<number>
  zscore(key: string, member: string): Promise<number | null>
  zrem(key: string, member: string): Promise<boolean>
  zcard(key: string): Promise<number>
  /** Zero-based position counting from the highest score, or null when absent. */
  zrevrank(key: string, member: string): Promise<number | null>
  /** Highest scores first. Ties are ordered by member, descending. */
  ztop(key: string, limit: number, offset?: number): Promise<ScoredMember[]>
  /** Ascending by score, bounds inclusive. Bounds must be finite (they travel as JSON). */
  zrangeByScore(key: string, min: number, max: number): Promise<ScoredMember[]>
  zremByScore(key: string, min: number, max: number): Promise<number>

  /**
   * Several `zincr`s in ONE round trip (a pipeline on Redis), so a request that has to
   * move a score on many boards pays for one network call, not one per board. When an
   * operation has a `ttlMs`, its key gets that expiry unless it already has one, so a board
   * for a finished week or month cleans itself up.
   */
  zincrMany(operations: { key: string; member: string; by: number; ttlMs?: number }[]): Promise<void>
  /**
   * Replaces the whole sorted set at `key` with `entries`, atomically for readers: the new
   * set is built under a scratch key and swapped in with one rename, so nobody ever sees
   * a half-built board. An empty list deletes the key.
   */
  zreplace(key: string, entries: ScoredMember[], options?: { ttlMs?: number }): Promise<void>
  /**
   * A copy of the sorted set at `key` that is built on the side and swapped in whole: for a rebuild that has to
   * take its time (and be corrected while it runs) without readers ever seeing a half-built board. Starts empty.
   */
  zstage(key: string): ZStage
  /** Gives an existing key an expiry. Does nothing for a key that is not there. */
  expire(key: string, ttlMs: number): Promise<void>

  ping(): Promise<void>
}

/** The Redis commands the adapter needs, so it can be tested without a server. */
export interface RedisCommands {
  get(key: string): Promise<string | null>
  set(key: string, value: string, px?: number): Promise<void>
  del(key: string): Promise<void>
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>
  zadd(key: string, score: number, member: string): Promise<void>
  zincrby(key: string, by: number, member: string): Promise<number>
  zscore(key: string, member: string): Promise<number | null>
  zrem(key: string, member: string): Promise<number>
  zcard(key: string): Promise<number>
  zrevrank(key: string, member: string): Promise<number | null>
  zrevrangeWithScores(key: string, start: number, stop: number): Promise<ScoredMember[]>
  zrangeByScoreWithScores(key: string, min: number, max: number): Promise<ScoredMember[]>
  zremrangebyscore(key: string, min: number, max: number): Promise<number>
  /** One request: every increment, then `PEXPIRE ... NX` for the ones that carry a ttl. */
  zincrbyPipeline(operations: { key: string; member: string; by: number; ttlMs?: number }[]): Promise<void>
  /** One request adding many members (the scratch key of a rebuild is filled in chunks). */
  zaddMany(key: string, entries: ScoredMember[]): Promise<void>
  rename(from: string, to: string): Promise<void>
  pexpire(key: string, ttlMs: number): Promise<void>
  /** Removes a key's expiry. */
  persist(key: string): Promise<void>
  ping(): Promise<void>
}

// INCRBY, then start the expiry if the key has none (a key without a TTL would
// otherwise block its caller forever), then report the remaining TTL.
export const INCR_SCRIPT = `
local count = redis.call('INCRBY', KEYS[1], ARGV[1])
local ttl = tonumber(ARGV[2])
local remaining = redis.call('PTTL', KEYS[1])
if ttl > 0 and remaining < 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
  remaining = ttl
end
return {count, remaining}
`

function parseIncrReply(reply: unknown): WindowHit {
  if (!Array.isArray(reply) || reply.length < 2) throw new Error('unexpected reply from the cache')
  const count = Number(reply[0])
  const ttlMs = Number(reply[1])
  if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) throw new Error('unexpected reply from the cache')
  return { count, ttlMs: Math.max(0, ttlMs) }
}

export class RedisCache implements Cache {
  readonly kind = 'upstash' as const

  constructor(
    private readonly redis: RedisCommands,
    private readonly prefix: string = ''
  ) {}

  private k(key: string): string {
    return this.prefix + key
  }

  get(key: string) {
    return this.redis.get(this.k(key))
  }

  set(key: string, value: string, options: { ttlMs?: number } = {}) {
    return this.redis.set(this.k(key), value, options.ttlMs && options.ttlMs > 0 ? options.ttlMs : undefined)
  }

  del(key: string) {
    return this.redis.del(this.k(key))
  }

  async incr(key: string, { by = 1, ttlMs = 0 }: { by?: number; ttlMs?: number } = {}) {
    return (await this.run(key, by, ttlMs)).count
  }

  hit(key: string, windowMs: number) {
    return this.run(key, 1, windowMs)
  }

  private async run(key: string, by: number, ttlMs: number): Promise<WindowHit> {
    return parseIncrReply(await this.redis.eval(INCR_SCRIPT, [this.k(key)], [by, ttlMs]))
  }

  zadd(key: string, member: string, score: number) {
    return this.redis.zadd(this.k(key), score, member)
  }

  zincr(key: string, member: string, by: number) {
    return this.redis.zincrby(this.k(key), by, member)
  }

  zscore(key: string, member: string) {
    return this.redis.zscore(this.k(key), member)
  }

  async zrem(key: string, member: string) {
    return (await this.redis.zrem(this.k(key), member)) > 0
  }

  zcard(key: string) {
    return this.redis.zcard(this.k(key))
  }

  zrevrank(key: string, member: string) {
    return this.redis.zrevrank(this.k(key), member)
  }

  async ztop(key: string, limit: number, offset = 0) {
    if (limit <= 0) return []
    return this.redis.zrevrangeWithScores(this.k(key), offset, offset + limit - 1)
  }

  zrangeByScore(key: string, min: number, max: number) {
    return this.redis.zrangeByScoreWithScores(this.k(key), min, max)
  }

  zremByScore(key: string, min: number, max: number) {
    return this.redis.zremrangebyscore(this.k(key), min, max)
  }

  async zincrMany(operations: { key: string; member: string; by: number; ttlMs?: number }[]) {
    if (operations.length === 0) return
    await this.redis.zincrbyPipeline(operations.map((operation) => ({ ...operation, key: this.k(operation.key) })))
  }

  async zreplace(key: string, entries: ScoredMember[], { ttlMs }: { ttlMs?: number } = {}) {
    if (entries.length === 0) {
      await this.redis.del(this.k(key))
      return
    }
    // Built beside the real key and swapped in with one rename. A scratch key from a
    // rebuild that died halfway is overwritten by the next one.
    const scratch = this.k(`${key}:rebuild`)
    await this.redis.del(scratch)
    for (let start = 0; start < entries.length; start += ZADD_CHUNK) {
      await this.redis.zaddMany(scratch, entries.slice(start, start + ZADD_CHUNK))
    }
    await this.redis.rename(scratch, this.k(key))
    if (ttlMs && ttlMs > 0) await this.redis.pexpire(this.k(key), ttlMs)
  }

  zstage(key: string): ZStage {
    const live = this.k(key)
    // Beside the real key, under a name of its own so two rebuilds at once cannot trample each other. A scratch
    // key that nobody commits (a rebuild that died) expires by itself.
    const scratch = this.k(`${key}:stage:${randomUUID()}`)
    let started = false
    return {
      set: async (entries) => {
        for (let start = 0; start < entries.length; start += ZADD_CHUNK) {
          await this.redis.zaddMany(scratch, entries.slice(start, start + ZADD_CHUNK))
          if (!started) {
            started = true
            await this.redis.pexpire(scratch, STAGE_TTL_MS)
          }
        }
      },
      remove: async (members) => {
        for (const member of members) await this.redis.zrem(scratch, member)
      },
      commit: async ({ ttlMs } = {}) => {
        // RENAME fails on a key that is not there, and an emptied set is not a key: that board is simply gone.
        if (!started || (await this.redis.zcard(scratch)) === 0) {
          await this.redis.del(scratch)
          await this.redis.del(live)
          return
        }
        await this.redis.rename(scratch, live)
        if (ttlMs && ttlMs > 0) await this.redis.pexpire(live, ttlMs)
        else await this.redis.persist(live)
      },
      discard: async () => {
        await this.redis.del(scratch)
      },
    }
  }

  async expire(key: string, ttlMs: number) {
    await this.redis.pexpire(this.k(key), ttlMs)
  }

  ping() {
    return this.redis.ping()
  }
}

// How long a half-built board is kept if nobody commits it.
const STAGE_TTL_MS = 6 * 60 * 60 * 1000

// Members added per request while a board is rebuilt: a few thousand fit comfortably under a REST request's size limit.
const ZADD_CHUNK = 2000

// `zrange ... withScores` answers with a flat [member, score, member, score, ...].
function pairs(flat: unknown): ScoredMember[] {
  if (!Array.isArray(flat)) return []
  const out: ScoredMember[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ member: String(flat[i]), score: Number(flat[i + 1]) })
  return out
}

/** Maps the Upstash REST client onto the commands the adapter uses. */
export function upstashCommands(redis: Redis): RedisCommands {
  return {
    get: async (key) => ((await redis.get<string>(key)) ?? null),
    set: async (key, value, px) => {
      await (px ? redis.set(key, value, { px }) : redis.set(key, value))
    },
    del: async (key) => {
      await redis.del(key)
    },
    eval: (script, keys, args) => redis.eval(script, keys, args),
    zadd: async (key, score, member) => {
      await redis.zadd(key, { score, member })
    },
    zincrby: (key, by, member) => redis.zincrby(key, by, member),
    zscore: (key, member) => redis.zscore(key, member),
    zrem: (key, member) => redis.zrem(key, member),
    zcard: (key) => redis.zcard(key),
    zrevrank: (key, member) => redis.zrevrank(key, member),
    zrevrangeWithScores: async (key, start, stop) =>
      pairs(await redis.zrange(key, start, stop, { rev: true, withScores: true })),
    zrangeByScoreWithScores: async (key, min, max) =>
      pairs(await redis.zrange(key, min, max, { byScore: true, withScores: true })),
    zremrangebyscore: (key, min, max) => redis.zremrangebyscore(key, min, max),
    zincrbyPipeline: async (operations) => {
      const pipeline = redis.pipeline()
      for (const { key, member, by, ttlMs } of operations) {
        pipeline.zincrby(key, by, member)
        if (ttlMs && ttlMs > 0) pipeline.pexpire(key, ttlMs, 'NX')
      }
      await pipeline.exec()
    },
    zaddMany: async (key, entries) => {
      if (entries.length === 0) return
      const [first, ...rest] = entries.map(({ member, score }) => ({ score, member }))
      await redis.zadd(key, first, ...rest)
    },
    rename: async (from, to) => {
      await redis.rename(from, to)
    },
    pexpire: async (key, ttlMs) => {
      await redis.pexpire(key, ttlMs)
    },
    persist: async (key) => {
      await redis.persist(key)
    },
    ping: async () => {
      await redis.ping()
    },
  }
}

export function createUpstashCache(url: string, token: string, prefix = 'sd:'): Cache {
  // Values are plain strings: the client must not try to parse them as JSON, or a
  // member that happens to look like a number would come back as one.
  const redis = new Redis({ url, token, automaticDeserialization: false })
  return new RedisCache(upstashCommands(redis), prefix)
}

/** Upstash when it is configured, otherwise the in-process stand-in. */
export function createCache(): Cache {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return createUpstashCache(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN)
  }
  return new MemoryCache()
}

// Survives dev-server module reloads, so state is not silently dropped by HMR.
const globalForCache = globalThis as unknown as { __cache?: Cache }

export function getCache(): Cache {
  if (!globalForCache.__cache) globalForCache.__cache = createCache()
  return globalForCache.__cache
}

/** Replaces the process-wide cache (tests). */
export function setCache(cache: Cache | undefined) {
  globalForCache.__cache = cache
}

// --- Presence -------------------------------------------------------------
// Who is around, kept as a sorted set of last-seen times. A member who stops
// calling `touch` drops out once `ttlMs` has passed; nothing has to notice they left.

export interface Presence {
  touch(scope: string, memberId: string): Promise<void>
  leave(scope: string, memberId: string): Promise<void>
  /** Members seen within the window, most recently seen first. */
  online(scope: string): Promise<string[]>
  count(scope: string): Promise<number>
}

export function createPresence(
  cache: Cache,
  { ttlMs = 60_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {}
): Presence {
  const key = (scope: string) => `presence:${scope}`
  const live = async (scope: string) => {
    const cutoff = now() - ttlMs
    await cache.zremByScore(key(scope), 0, cutoff)
    return cache.zrangeByScore(key(scope), cutoff, Number.MAX_SAFE_INTEGER)
  }
  return {
    touch: (scope, memberId) => cache.zadd(key(scope), memberId, now()),
    leave: async (scope, memberId) => {
      await cache.zrem(key(scope), memberId)
    },
    online: async (scope) => (await live(scope)).reverse().map((entry) => entry.member),
    count: async (scope) => (await live(scope)).length,
  }
}

// --- Leaderboards ---------------------------------------------------------

export interface Leaderboard {
  add(memberId: string, points: number): Promise<number>
  set(memberId: string, score: number): Promise<void>
  top(limit: number, offset?: number): Promise<ScoredMember[]>
  /** One-based rank, or null when the member has no score. */
  rank(memberId: string): Promise<number | null>
  score(memberId: string): Promise<number | null>
  remove(memberId: string): Promise<void>
}

export function createLeaderboard(cache: Cache, name: string): Leaderboard {
  const key = `leaderboard:${name}`
  return {
    add: (memberId, points) => cache.zincr(key, memberId, points),
    set: (memberId, score) => cache.zadd(key, memberId, score),
    top: (limit, offset) => cache.ztop(key, limit, offset),
    rank: async (memberId) => {
      const position = await cache.zrevrank(key, memberId)
      return position === null ? null : position + 1
    },
    score: (memberId) => cache.zscore(key, memberId),
    remove: async (memberId) => {
      await cache.zrem(key, memberId)
    },
  }
}
