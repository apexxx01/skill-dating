import { describe, it, expect } from 'vitest'
import { stateFrom } from './restrictions'

const now = new Date('2026-10-20T00:00:00Z')
const later = (days: number) => new Date(now.getTime() + days * 86_400_000)

describe('stateFrom', () => {
  it('is open with nothing in force', () => {
    expect(stateFrom([], now)).toEqual({ suspendedUntil: null, banned: false, restricted: {} })
  })

  it('ignores lifted and ended restrictions', () => {
    expect(stateFrom([{ kind: 'BANNED', endsAt: null, liftedAt: now }, { kind: 'SUSPENDED', endsAt: later(-1), liftedAt: null }], now)).toEqual({ suspendedUntil: null, banned: false, restricted: {} })
  })

  it('reports a ban, the longest suspension and each feature with its end', () => {
    const state = stateFrom(
      [
        { kind: 'SUSPENDED', endsAt: later(3), liftedAt: null },
        { kind: 'SUSPENDED', endsAt: later(7), liftedAt: null },
        { kind: 'MESSAGING', endsAt: later(2), liftedAt: null },
        { kind: 'ROMANCE', endsAt: null, liftedAt: null },
        { kind: 'ROMANCE', endsAt: later(5), liftedAt: null },
        { kind: 'BANNED', endsAt: null, liftedAt: null },
      ],
      now
    )
    expect(state.banned).toBe(true)
    expect(state.suspendedUntil).toBe(later(7).toISOString())
    expect(state.restricted).toEqual({ messaging: later(2).toISOString(), romance: null })
  })
})
