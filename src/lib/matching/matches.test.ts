import { describe, it, expect } from 'vitest'
import type { Match } from '@prisma/client'
import type { MatchPerson } from '@/types/api'
import { toMatchItem } from './matches'
import { pairOf } from './sparks'

const person = { id: 'b', name: 'B', username: 'b', image: null, headline: null, builderRole: null, location: null, level: 1, tier: 'BRONZE', skills: [], proof: { verifiedEvidence: 0, shipped: 0 } } as MatchPerson

const match = {
  id: 'm1',
  userAId: 'a',
  userBId: 'b',
  userARole: 'MENTEE',
  userBRole: 'MENTOR',
  connectionType: 'MENTOR',
  conversationId: 'c1',
  createdAt: new Date('2026-10-16T12:00:00Z'),
  endedAt: null,
  endedById: null,
  endReason: null,
} as Match

describe('toMatchItem', () => {
  it('shows each side its own role and the other’s', () => {
    expect(toMatchItem(match, 'a', person)).toMatchObject({ connectionType: 'MENTOR', yourRole: 'MENTEE', theirRole: 'MENTOR' })
    expect(toMatchItem(match, 'b', person)).toMatchObject({ connectionType: 'MENTOR', yourRole: 'MENTOR', theirRole: 'MENTEE' })
  })

  it('carries the conversation and the time, as text', () => {
    expect(toMatchItem(match, 'a', person)).toMatchObject({ id: 'm1', conversationId: 'c1', createdAt: '2026-10-16T12:00:00.000Z', other: person })
  })

  it('has exactly the documented keys, and nothing private', () => {
    expect(Object.keys(toMatchItem(match, 'a', person)).sort()).toEqual(['conversationId', 'connectionType', 'createdAt', 'id', 'other', 'theirRole', 'yourRole'].sort())
  })
})

describe('pairOf', () => {
  it('puts the smaller id first whichever way round', () => {
    expect(pairOf('a', 'b')).toEqual(['a', 'b'])
    expect(pairOf('b', 'a')).toEqual(['a', 'b'])
    expect(pairOf('cmv2', 'cmv10')).toEqual(['cmv10', 'cmv2'])
  })
})
