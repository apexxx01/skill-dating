import { describe, it, expect } from 'vitest'
import { createLeaderboard, createPresence, type Cache } from './cache'

// Behaviour every Cache implementation must have. Each implementation's test
// file calls this with a factory that returns a fresh cache on a clock the test
// controls, so expiry can be checked without waiting.

export interface Clock {
  now: number
}

export function cacheContract(name: string, make: (clock: Clock) => Cache) {
  const fresh = () => {
    const clock: Clock = { now: 1_000_000 }
    return { clock, cache: make(clock) }
  }

  describe(`${name}: strings`, () => {
    it('stores, reads and deletes a value', async () => {
      const { cache } = fresh()
      expect(await cache.get('a')).toBeNull()
      await cache.set('a', 'hello')
      expect(await cache.get('a')).toBe('hello')
      await cache.del('a')
      expect(await cache.get('a')).toBeNull()
    })

    it('keeps values that look like JSON or numbers as the strings they are', async () => {
      const { cache } = fresh()
      await cache.set('n', '007')
      await cache.set('j', '{"a":1}')
      expect(await cache.get('n')).toBe('007')
      expect(await cache.get('j')).toBe('{"a":1}')
    })

    it('expires a value after its ttl', async () => {
      const { cache, clock } = fresh()
      await cache.set('a', 'x', { ttlMs: 1000 })
      clock.now += 999
      expect(await cache.get('a')).toBe('x')
      clock.now += 2
      expect(await cache.get('a')).toBeNull()
    })
  })

  describe(`${name}: counters and windows`, () => {
    it('counts up, by one or by an amount', async () => {
      const { cache } = fresh()
      expect(await cache.incr('c')).toBe(1)
      expect(await cache.incr('c')).toBe(2)
      expect(await cache.incr('c', { by: 5 })).toBe(7)
    })

    it('starts the window on the first hit and does not extend it', async () => {
      const { cache, clock } = fresh()
      const first = await cache.hit('w', 10_000)
      expect(first.count).toBe(1)
      expect(first.ttlMs).toBe(10_000)

      clock.now += 4000
      const second = await cache.hit('w', 10_000)
      expect(second.count).toBe(2)
      expect(second.ttlMs).toBe(6000)
    })

    it('starts a new window once the old one has ended', async () => {
      const { cache, clock } = fresh()
      await cache.hit('w', 1000)
      await cache.hit('w', 1000)
      clock.now += 1001
      const next = await cache.hit('w', 1000)
      expect(next.count).toBe(1)
      expect(next.ttlMs).toBe(1000)
    })

    it('keeps separate keys apart', async () => {
      const { cache } = fresh()
      await cache.hit('a', 1000)
      await cache.hit('a', 1000)
      expect((await cache.hit('b', 1000)).count).toBe(1)
    })
  })

  describe(`${name}: sorted sets`, () => {
    it('answers sensibly for a set that does not exist', async () => {
      const { cache } = fresh()
      expect(await cache.zscore('z', 'a')).toBeNull()
      expect(await cache.zrevrank('z', 'a')).toBeNull()
      expect(await cache.zcard('z')).toBe(0)
      expect(await cache.ztop('z', 5)).toEqual([])
      expect(await cache.zrem('z', 'a')).toBe(false)
    })

    it('orders highest first and breaks ties by member, descending', async () => {
      const { cache } = fresh()
      await cache.zadd('z', 'low', 1)
      await cache.zadd('z', 'high', 10)
      await cache.zadd('z', 'mid-a', 5)
      await cache.zadd('z', 'mid-b', 5)
      expect((await cache.ztop('z', 10)).map((e) => e.member)).toEqual(['high', 'mid-b', 'mid-a', 'low'])
      expect(await cache.zrevrank('z', 'high')).toBe(0)
      expect(await cache.zrevrank('z', 'mid-a')).toBe(2)
      expect(await cache.zrevrank('z', 'low')).toBe(3)
    })

    it('pages with a limit and an offset, and returns the scores', async () => {
      const { cache } = fresh()
      for (const [member, score] of [['a', 1], ['b', 2], ['c', 3], ['d', 4]] as const) await cache.zadd('z', member, score)
      expect(await cache.ztop('z', 2)).toEqual([{ member: 'd', score: 4 }, { member: 'c', score: 3 }])
      expect(await cache.ztop('z', 2, 2)).toEqual([{ member: 'b', score: 2 }, { member: 'a', score: 1 }])
      expect(await cache.ztop('z', 0)).toEqual([])
    })

    it('overwrites with zadd and adds with zincr', async () => {
      const { cache } = fresh()
      await cache.zadd('z', 'a', 3)
      await cache.zadd('z', 'a', 8)
      expect(await cache.zscore('z', 'a')).toBe(8)
      expect(await cache.zincr('z', 'a', 2)).toBe(10)
      expect(await cache.zincr('z', 'new', 4)).toBe(4)
      expect(await cache.zcard('z')).toBe(2)
    })

    it('removes members, singly and by score range', async () => {
      const { cache } = fresh()
      for (const [member, score] of [['a', 1], ['b', 2], ['c', 3], ['d', 4]] as const) await cache.zadd('z', member, score)
      expect(await cache.zrem('z', 'a')).toBe(true)
      expect(await cache.zrem('z', 'a')).toBe(false)
      expect(await cache.zremByScore('z', 2, 3)).toBe(2)
      expect((await cache.ztop('z', 10)).map((e) => e.member)).toEqual(['d'])
    })

    it('selects by score range, inclusive, ascending', async () => {
      const { cache } = fresh()
      for (const [member, score] of [['a', 1], ['b', 2], ['c', 3], ['d', 4]] as const) await cache.zadd('z', member, score)
      expect(await cache.zrangeByScore('z', 2, 3)).toEqual([{ member: 'b', score: 2 }, { member: 'c', score: 3 }])
      expect(await cache.zrangeByScore('z', 10, 20)).toEqual([])
    })

    it('keeps members that look like numbers as strings', async () => {
      const { cache } = fresh()
      await cache.zadd('z', '42', 1)
      await cache.zadd('z', '007', 2)
      expect((await cache.ztop('z', 5)).map((e) => e.member)).toEqual(['007', '42'])
    })
  })

  describe(`${name}: batched and replaced sorted sets`, () => {
    it('applies many increments at once, across boards', async () => {
      const { cache } = fresh()
      await cache.zincrMany([
        { key: 'week', member: 'ann', by: 10 },
        { key: 'all', member: 'ann', by: 10 },
        { key: 'all', member: 'bob', by: 3 },
        { key: 'all', member: 'ann', by: 5 },
      ])
      expect(await cache.zscore('week', 'ann')).toBe(10)
      expect(await cache.zscore('all', 'ann')).toBe(15)
      expect(await cache.zscore('all', 'bob')).toBe(3)
      await cache.zincrMany([])
    })

    it('starts a board expiry on the first increment and does not push it back', async () => {
      const { cache, clock } = fresh()
      await cache.zincrMany([{ key: 'week', member: 'ann', by: 1, ttlMs: 1000 }])
      clock.now += 600
      await cache.zincrMany([{ key: 'week', member: 'ann', by: 1, ttlMs: 1000 }])
      expect(await cache.zscore('week', 'ann')).toBe(2)
      clock.now += 401
      expect(await cache.zscore('week', 'ann')).toBeNull()
    })

    it('replaces a whole board, dropping members that are not in the new list', async () => {
      const { cache } = fresh()
      await cache.zadd('z', 'old', 100)
      await cache.zadd('z', 'kept', 1)
      await cache.zreplace('z', [{ member: 'kept', score: 7 }, { member: 'new', score: 9 }])
      expect(await cache.ztop('z', 10)).toEqual([{ member: 'new', score: 9 }, { member: 'kept', score: 7 }])
      expect(await cache.zscore('z', 'old')).toBeNull()
      expect(await cache.zrevrank('z', 'kept')).toBe(1)
    })

    it('replaces with nothing by deleting, and creates a board that was not there', async () => {
      const { cache } = fresh()
      await cache.zreplace('fresh', [{ member: 'a', score: 1 }])
      expect(await cache.zcard('fresh')).toBe(1)
      await cache.zreplace('fresh', [])
      expect(await cache.zcard('fresh')).toBe(0)
    })

    it('can give a replaced board an expiry, and an existing key one later', async () => {
      const { cache, clock } = fresh()
      await cache.zreplace('z', [{ member: 'a', score: 1 }], { ttlMs: 1000 })
      clock.now += 1001
      expect(await cache.zcard('z')).toBe(0)

      await cache.zadd('y', 'a', 1)
      await cache.expire('y', 500)
      await cache.expire('missing', 500)
      clock.now += 501
      expect(await cache.zcard('y')).toBe(0)
    })
  })

  describe(`${name}: presence`, () => {
    it('lists who has been seen recently, newest first, and forgets the rest', async () => {
      const { cache, clock } = fresh()
      const presence = createPresence(cache, { ttlMs: 60_000, now: () => clock.now })

      await presence.touch('room', 'ann')
      clock.now += 10_000
      await presence.touch('room', 'bob')
      expect(await presence.online('room')).toEqual(['bob', 'ann'])
      expect(await presence.count('room')).toBe(2)

      clock.now += 55_000 // ann was last seen 65s ago, bob 55s ago
      expect(await presence.online('room')).toEqual(['bob'])

      await presence.touch('room', 'ann')
      expect(await presence.online('room')).toEqual(['ann', 'bob'])
    })

    it('drops a member who leaves, and keeps rooms apart', async () => {
      const { cache, clock } = fresh()
      const presence = createPresence(cache, { now: () => clock.now })
      await presence.touch('a', 'ann')
      await presence.touch('b', 'bob')
      await presence.leave('a', 'ann')
      expect(await presence.online('a')).toEqual([])
      expect(await presence.online('b')).toEqual(['bob'])
    })
  })

  describe(`${name}: leaderboard`, () => {
    it('accumulates points and ranks from one', async () => {
      const { cache } = fresh()
      const board = createLeaderboard(cache, 'xp')
      await board.add('ann', 50)
      await board.add('bob', 80)
      await board.add('ann', 40)
      expect(await board.score('ann')).toBe(90)
      expect(await board.rank('ann')).toBe(1)
      expect(await board.rank('bob')).toBe(2)
      expect(await board.rank('nobody')).toBeNull()
      expect((await board.top(5)).map((e) => e.member)).toEqual(['ann', 'bob'])

      await board.remove('ann')
      expect(await board.rank('bob')).toBe(1)
    })

    it('keeps boards apart by name', async () => {
      const { cache } = fresh()
      await createLeaderboard(cache, 'one').add('ann', 1)
      expect(await createLeaderboard(cache, 'two').score('ann')).toBeNull()
    })
  })
}
