import { describe, it, expect } from 'vitest'
import { decodeFeedCursor, encodeFeedCursor, feedQuerySchema, FEED_CONFIG } from './feed'

const now = new Date('2026-10-16T10:00:00Z')

describe('feed cursor', () => {
  it('round-trips the instant and the page', () => {
    const raw = encodeFeedCursor({ asOf: now.getTime(), page: 3 })
    expect(decodeFeedCursor(raw, now)).toEqual({ asOf: now.getTime(), page: 3 })
  })

  it('is opaque url-safe text', () => {
    expect(encodeFeedCursor({ asOf: now.getTime(), page: 0 })).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('refuses garbage, other versions, bad numbers and absurd pages', () => {
    for (const raw of ['', 'garbage', Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ v: 2, a: now.getTime(), p: 0 })).toString('base64url'), Buffer.from(JSON.stringify({ v: 1, a: 'x', p: 0 })).toString('base64url'), Buffer.from(JSON.stringify({ v: 1, a: now.getTime(), p: -1 })).toString('base64url'), Buffer.from(JSON.stringify({ v: 1, a: now.getTime(), p: 5000 })).toString('base64url'), Buffer.from(JSON.stringify({ v: 1, a: 1.5, p: 0 })).toString('base64url')]) {
      expect(decodeFeedCursor(raw, now), raw).toBeNull()
    }
  })

  it('expires after an hour and refuses one from the future', () => {
    const old = encodeFeedCursor({ asOf: now.getTime() - FEED_CONFIG.cursorMaxAgeMs - 1, page: 1 })
    expect(decodeFeedCursor(old, now)).toBeNull()
    const edge = encodeFeedCursor({ asOf: now.getTime() - FEED_CONFIG.cursorMaxAgeMs, page: 1 })
    expect(decodeFeedCursor(edge, now)).not.toBeNull()
    const future = encodeFeedCursor({ asOf: now.getTime() + 5 * 60_000, page: 1 })
    expect(decodeFeedCursor(future, now)).toBeNull()
  })
})

describe('feed query', () => {
  it('defaults to the for-you tab and a page of 20', () => {
    expect(feedQuerySchema.parse({})).toEqual({ tab: 'for-you', limit: 20 })
  })

  it('accepts the four tabs and refuses others', () => {
    for (const tab of ['for-you', 'following', 'city', 'campus']) expect(feedQuerySchema.safeParse({ tab }).success).toBe(true)
    expect(feedQuerySchema.safeParse({ tab: 'trending' }).success).toBe(false)
  })

  it('bounds the limit between 1 and 50', () => {
    expect(feedQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(feedQuerySchema.safeParse({ limit: '51' }).success).toBe(false)
    expect(feedQuerySchema.parse({ limit: '50' }).limit).toBe(50)
  })
})
