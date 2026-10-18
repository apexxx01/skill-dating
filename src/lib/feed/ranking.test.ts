import { describe, it, expect } from 'vitest'
import { closestNetwork, networkBoostOf, pageAt, pickPage, proofBoost, propsFactor, rankPost, rankPosts, recencyDecay, RANKING_CONFIG, type Rankable } from './ranking'

const now = new Date('2026-10-18T12:00:00Z')
const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000)

describe('recencyDecay', () => {
  it('halves every 24 hours', () => {
    expect(recencyDecay(now, now)).toBe(1)
    expect(recencyDecay(ago(24), now)).toBeCloseTo(0.5, 10)
    expect(recencyDecay(ago(48), now)).toBeCloseTo(0.25, 10)
    expect(recencyDecay(ago(12), now)).toBeCloseTo(Math.SQRT1_2, 10)
  })

  it('counts a post from the future as new and never exceeds 1', () => {
    expect(recencyDecay(new Date(now.getTime() + 3_600_000), now)).toBe(1)
  })

  it('decreases monotonically with age', () => {
    let last = 2
    for (let hours = 0; hours <= 200; hours += 7) {
      const value = recencyDecay(ago(hours), now)
      expect(value).toBeLessThan(last)
      last = value
    }
  })
})

describe('the other factors', () => {
  it('props: 1 with none, grows with the log of the score, never below 1', () => {
    expect(propsFactor(0)).toBe(1)
    expect(propsFactor(-5)).toBe(1)
    expect(propsFactor(Math.E - 1)).toBeCloseTo(2, 10)
    expect(propsFactor(1000)).toBeLessThan(8)
    expect(propsFactor(10)).toBeGreaterThan(propsFactor(5))
  })

  it('proof: 1.0 for Bronze up to 1.25 for Mythic', () => {
    expect(proofBoost('BRONZE')).toBe(1)
    expect(proofBoost('GOLD')).toBeCloseTo(1.1, 10)
    expect(proofBoost('MYTHIC')).toBeCloseTo(1.25, 10)
  })

  it('network: the closest tie counts and they do not multiply', () => {
    expect(closestNetwork({})).toBe('none')
    expect(closestNetwork({ follows: true })).toBe('follow')
    expect(closestNetwork({ follows: true, crew: true })).toBe('crew')
    expect(closestNetwork({ follows: true, crew: true, match: true })).toBe('match')
    expect(networkBoostOf('none')).toBe(1)
    expect(networkBoostOf('match')).toBe(2.2)
  })
})

describe('a worked example (the one in docs/FEED.md)', () => {
  // Three posts for one viewer, at 12:00 UTC.
  //   A: 2 hours old, no props, a stranger of Bronze tier
  //   B: 26 hours old, propsScore 6.4, someone the viewer follows, Silver
  //   C: 30 hours old, propsScore 40, a stranger, Gold
  const a = { id: 'a', authorId: 'u1', createdAt: ago(2), propsScore: 0, authorTier: 'BRONZE', network: 'none' } as const
  const b = { id: 'b', authorId: 'u2', createdAt: ago(26), propsScore: 6.4, authorTier: 'SILVER', network: 'follow' } as const
  const c = { id: 'c', authorId: 'u3', createdAt: ago(30), propsScore: 40, authorTier: 'GOLD', network: 'none' } as const

  it('multiplies the four factors', () => {
    const scoreA = rankPost(a, now)
    expect(scoreA.recency).toBeCloseTo(0.9440, 3)
    expect(scoreA.props).toBe(1)
    expect(scoreA.network).toBe(1)
    expect(scoreA.proof).toBe(1)
    expect(scoreA.score).toBeCloseTo(0.9440, 3)

    const scoreB = rankPost(b, now)
    expect(scoreB.recency).toBeCloseTo(0.4719, 3)
    expect(scoreB.props).toBeCloseTo(3.0, 1)
    expect(scoreB.network).toBe(1.5)
    expect(scoreB.proof).toBeCloseTo(1.05, 10)
    expect(scoreB.score).toBeCloseTo(2.23, 1)

    const scoreC = rankPost(c, now)
    expect(scoreC.recency).toBeCloseTo(0.4204, 3)
    expect(scoreC.props).toBeCloseTo(4.7136, 3)
    expect(scoreC.proof).toBeCloseTo(1.1, 10)
    expect(scoreC.score).toBeCloseTo(2.18, 1)
  })

  it('ranks B, then C, then A', () => {
    expect(rankPosts([a, b, c], now).map((post) => post.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('rankPosts', () => {
  it('does not depend on the order of the input', () => {
    const posts: Rankable[] = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`,
      authorId: `u${i % 7}`,
      createdAt: ago((i * 5) % 70),
      propsScore: (i * 3) % 11,
      authorTier: (['BRONZE', 'SILVER', 'GOLD'] as const)[i % 3],
      network: (['none', 'follow', 'crew', 'match'] as const)[i % 4],
    }))
    const forward = rankPosts(posts, now).map((post) => post.id)
    expect(rankPosts([...posts].reverse(), now).map((post) => post.id)).toEqual(forward)
  })

  it('breaks an exact tie by recency, then by id', () => {
    const base = { authorId: 'u', propsScore: 0, authorTier: 'BRONZE', network: 'none' } as const
    const same = (id: string) => ({ ...base, id, createdAt: ago(1), authorId: id })
    expect(rankPosts([same('a'), same('b')], now).map((post) => post.id)).toEqual(['b', 'a'])
  })
})

describe('pickPage and pageAt', () => {
  const ranked = [
    ...['a1', 'a2', 'a3', 'a4'].map((id) => ({ id, authorId: 'A' })),
    ...['b1', 'b2'].map((id) => ({ id, authorId: 'B' })),
    { id: 'c1', authorId: 'C' },
  ]
  const ids = (items: { id: string }[]) => items.map((post) => post.id)

  it('takes at most two posts per author on a page and keeps the rest for later', () => {
    const picked = pickPage(ranked, { limit: 5 })
    expect(ids(picked.items)).toEqual(['a1', 'a2', 'b1', 'b2', 'c1'])
    expect(ids(picked.rest)).toEqual(['a3', 'a4'])
    expect(RANKING_CONFIG.maxPostsPerAuthorPerPage).toBe(2)
  })

  it('stops at the limit', () => {
    const picked = pickPage(ranked, { limit: 3 })
    expect(ids(picked.items)).toEqual(['a1', 'a2', 'b1'])
    expect(ids(picked.rest)).toEqual(['a3', 'a4', 'b2', 'c1'])
  })

  it('walks every post exactly once across the pages, each page honouring the cap', () => {
    const seen: string[] = []
    for (let page = 0; ; page++) {
      const { items, hasMore } = pageAt(ranked, page, 3)
      const perAuthor = new Map<string, number>()
      for (const post of items) perAuthor.set(post.authorId, (perAuthor.get(post.authorId) ?? 0) + 1)
      for (const count of perAuthor.values()) expect(count).toBeLessThanOrEqual(2)
      seen.push(...ids(items))
      if (!hasMore) break
      expect(page).toBeLessThan(20)
    }
    expect([...seen].sort()).toEqual(ids(ranked).sort())
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('is empty past the end', () => {
    expect(pageAt(ranked, 50, 3)).toEqual({ items: [], hasMore: false })
    expect(pageAt([], 0, 3)).toEqual({ items: [], hasMore: false })
  })

  it('gives page 0 the same posts however far the cursor goes', () => {
    expect(ids(pageAt(ranked, 0, 3).items)).toEqual(['a1', 'a2', 'b1'])
    expect(ids(pageAt(ranked, 1, 3).items)).toEqual(['a3', 'a4', 'b2'])
    expect(ids(pageAt(ranked, 2, 3).items)).toEqual(['c1'])
  })
})
