import { describe, it, expect } from 'vitest'
import { cardPath, versionOf } from './links'

describe('versionOf', () => {
  const stamps = [new Date('2026-10-23T10:00:00Z'), new Date('2026-10-22T09:00:00Z'), null, 3]

  it('is 12 hex characters, and the same for the same stamps', () => {
    expect(versionOf(stamps)).toMatch(/^[0-9a-f]{12}$/)
    expect(versionOf(stamps)).toBe(versionOf([...stamps]))
  })

  it('changes when any stamp changes, however slightly, and with the order', () => {
    const base = versionOf(stamps)
    expect(versionOf([new Date('2026-10-23T10:00:00.001Z'), ...stamps.slice(1)])).not.toBe(base)
    expect(versionOf([stamps[0], stamps[1], new Date('2026-10-01T00:00:00Z'), 3])).not.toBe(base)
    expect(versionOf([stamps[0], stamps[1], null, 4])).not.toBe(base)
    expect(versionOf([stamps[1], stamps[0], null, 3])).not.toBe(base)
  })

  it('tells nothing from something, and does not confuse one stamp with two', () => {
    expect(versionOf([])).not.toBe(versionOf([null]))
    expect(versionOf(['a|b'])).not.toBe(versionOf(['a', 'b']))
  })
})

describe('cardPath', () => {
  it('is the path the card routes serve, with the version, and the name or id escaped', () => {
    expect(cardPath({ kind: 'passport', id: 'ada' }, 'abc123abc123')).toBe('/api/og/passport/ada?v=abc123abc123')
    expect(cardPath({ kind: 'post', id: 'p1' }, 'v')).toBe('/api/og/post/p1?v=v')
    expect(cardPath({ kind: 'squad', id: 't 1/2' }, 'v')).toBe('/api/og/squad/t%201%2F2?v=v')
    expect(cardPath({ kind: 'achievement', id: 'first-ship', user: 'ada&x=1' }, 'v')).toBe('/api/og/achievement/first-ship?user=ada%26x%3D1&v=v')
  })
})
