import { describe, it, expect } from 'vitest'
import { activeIntentTags, counterpartType, isMatchType, MATCH_TYPES, NON_DATING_TYPES, pairableTypes, relationshipType } from './types'
import { humanizeTag, INTENT_TAG_PATTERN, KNOWN_INTENTS, sharedIntentReason } from './intents'

describe('match types', () => {
  it('pairs mentors with mentees and every other type with itself', () => {
    expect(counterpartType('MENTOR')).toBe('MENTEE')
    expect(counterpartType('MENTEE')).toBe('MENTOR')
    for (const type of MATCH_TYPES.filter((t) => t !== 'MENTOR' && t !== 'MENTEE')) expect(counterpartType(type)).toBe(type)
    for (const type of MATCH_TYPES) expect(counterpartType(counterpartType(type))).toBe(type)
  })

  it('names the relationship the same from both sides', () => {
    expect(relationshipType('MENTEE')).toBe('MENTOR')
    expect(relationshipType('MENTOR')).toBe('MENTOR')
    expect(relationshipType('COFOUNDER')).toBe('COFOUNDER')
    for (const type of MATCH_TYPES) expect(relationshipType(type)).toBe(relationshipType(counterpartType(type)))
  })

  it('knows its own values', () => {
    expect(isMatchType('DATING')).toBe(true)
    expect(isMatchType('FRIEND')).toBe(false)
    expect(isMatchType(3)).toBe(false)
  })

  it('finds the types two people can be paired on', () => {
    expect(pairableTypes(['COFOUNDER', 'MENTEE'], ['MENTOR', 'COFOUNDER'])).toEqual(['COFOUNDER', 'MENTEE'])
    expect(pairableTypes(['MENTEE'], ['MENTEE'])).toEqual([])
    expect(pairableTypes(['DATING'], ['COFOUNDER', 'COLLABORATOR'])).toEqual([])
    expect(pairableTypes(['DATING', 'COLLABORATOR'], ['DATING'])).toEqual(['DATING'])
  })

  it('keeps DATING out of the other types', () => {
    expect(NON_DATING_TYPES).not.toContain('DATING')
    expect(NON_DATING_TYPES).toHaveLength(MATCH_TYPES.length - 1)
  })
})

describe('intent tags', () => {
  const now = new Date('2026-10-16T12:00:00Z')

  it('drops the tags that have expired, and keeps the ones that never do', () => {
    const tags = [{ tag: 'a1' }, { tag: 'b1', expiresAt: '2026-10-16T12:00:01Z' }, { tag: 'c1', expiresAt: '2026-10-16T12:00:00Z' }, { tag: 'd1', expiresAt: '2026-10-01T00:00:00Z' }]
    expect(activeIntentTags(tags, now).map((t) => t.tag)).toEqual(['a1', 'b1'])
  })

  it('accepts short lower-case dashed tags only', () => {
    for (const ok of ['ab', 'ship-mvp-90-days', 'a1', 'x'.repeat(40)]) expect(INTENT_TAG_PATTERN.test(ok), ok).toBe(true)
    for (const bad of ['a', 'Ship', '-ab', 'a b', 'a_b', 'x'.repeat(41), '', 'a/b']) expect(INTENT_TAG_PATTERN.test(bad), bad).toBe(false)
  })

  it('has a line for each known tag and shows any other as words', () => {
    for (const intent of KNOWN_INTENTS) {
      expect(INTENT_TAG_PATTERN.test(intent.tag)).toBe(true)
      expect(sharedIntentReason(intent.tag)).toBe(intent.both)
    }
    expect(new Set(KNOWN_INTENTS.map((i) => i.tag)).size).toBe(KNOWN_INTENTS.length)
    expect(humanizeTag('rust--and-wasm')).toBe('rust and wasm')
    expect(sharedIntentReason('rust-and-wasm')).toBe('Both are into rust and wasm')
  })
})
