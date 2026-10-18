import { describe, it, expect } from 'vitest'
import { selectDrops, type ScoredCandidate } from './select'
import type { MatchType } from './types'

const c = (candidateId: string, connectionType: MatchType, score: number): ScoredCandidate => ({ candidateId, connectionType, score, reasons: [] })
const ids = (picked: ScoredCandidate[]) => picked.map((entry) => `${entry.candidateId}:${entry.connectionType}`)
const opts = (over: Partial<Parameters<typeof selectDrops>[1]> = {}) => ({ count: 3, singleType: false, minScore: 30, ...over })

describe('selectDrops: the floor and the count', () => {
  it('shows nobody below the score floor', () => {
    expect(selectDrops([c('a', 'COFOUNDER', 29), c('b', 'COFOUNDER', 30)], opts({ singleType: true }))).toEqual([c('b', 'COFOUNDER', 30)])
    expect(selectDrops([c('a', 'COFOUNDER', 10)], opts())).toEqual([])
  })

  it('gives nothing for a count of zero or less, and nothing for nobody', () => {
    expect(selectDrops([c('a', 'COFOUNDER', 90)], opts({ count: 0 }))).toEqual([])
    expect(selectDrops([c('a', 'COFOUNDER', 90)], opts({ count: -2 }))).toEqual([])
    expect(selectDrops([], opts())).toEqual([])
  })

  it('never gives more than the count', () => {
    const many = Array.from({ length: 20 }, (_, i) => c(`p${i}`, 'COFOUNDER', 80 - i))
    expect(selectDrops(many, opts({ singleType: true, count: 5 }))).toHaveLength(5)
    expect(selectDrops(many, opts({ singleType: true, count: 50 }))).toHaveLength(20)
  })
})

describe('selectDrops: one type chosen', () => {
  it('takes the best, as many as allowed, best first', () => {
    const picked = selectDrops([c('a', 'COFOUNDER', 50), c('b', 'COFOUNDER', 90), c('c', 'COFOUNDER', 70), c('d', 'COFOUNDER', 60)], opts({ singleType: true, count: 3 }))
    expect(ids(picked)).toEqual(['b:COFOUNDER', 'c:COFOUNDER', 'd:COFOUNDER'])
  })

  it('shows a person once, as the type they fit best', () => {
    const picked = selectDrops([c('a', 'COLLABORATOR', 60), c('a', 'COLLABORATOR', 75), c('b', 'COLLABORATOR', 65)], opts({ singleType: true }))
    expect(ids(picked)).toEqual(['a:COLLABORATOR', 'b:COLLABORATOR'])
    expect(picked[0].score).toBe(75)
  })

  it('breaks a tie by id, so the same input always gives the same drops', () => {
    const entries = [c('z', 'COFOUNDER', 70), c('a', 'COFOUNDER', 70), c('m', 'COFOUNDER', 70)]
    expect(ids(selectDrops(entries, opts({ singleType: true })))).toEqual(['a:COFOUNDER', 'm:COFOUNDER', 'z:COFOUNDER'])
    expect(ids(selectDrops([...entries].reverse(), opts({ singleType: true })))).toEqual(['a:COFOUNDER', 'm:COFOUNDER', 'z:COFOUNDER'])
  })
})

describe('selectDrops: several types chosen', () => {
  it('gives at most one drop per type', () => {
    const picked = selectDrops(
      [c('a', 'COFOUNDER', 90), c('b', 'COFOUNDER', 85), c('c', 'COFOUNDER', 80), c('d', 'MENTEE', 60), c('e', 'MENTEE', 55)],
      opts({ count: 10 })
    )
    expect(ids(picked)).toEqual(['a:COFOUNDER', 'd:MENTEE'])
  })

  it('takes the strongest type first when the allowance is smaller than the number of types', () => {
    const picked = selectDrops([c('a', 'COFOUNDER', 60), c('b', 'MENTEE', 90), c('c', 'COLLABORATOR', 75)], opts({ count: 2 }))
    expect(ids(picked)).toEqual(['b:MENTEE', 'c:COLLABORATOR'])
  })

  it('never shows a person twice: the second type takes its next best', () => {
    const picked = selectDrops(
      [c('x', 'COFOUNDER', 90), c('x', 'COLLABORATOR', 85), c('y', 'COFOUNDER', 70), c('z', 'COLLABORATOR', 65)],
      opts({ count: 5 })
    )
    expect(ids(picked)).toEqual(['x:COFOUNDER', 'z:COLLABORATOR'])
    expect(new Set(picked.map((entry) => entry.candidateId)).size).toBe(picked.length)
  })

  it('leaves a type empty rather than fill it with somebody below the floor', () => {
    const picked = selectDrops([c('a', 'COFOUNDER', 80), c('b', 'MENTEE', 12)], opts({ count: 5 }))
    expect(ids(picked)).toEqual(['a:COFOUNDER'])
  })

  it('is stable when types tie', () => {
    const picked = selectDrops([c('a', 'MENTEE', 70), c('b', 'COFOUNDER', 70)], opts({ count: 5 }))
    expect(ids(picked)).toEqual(['a:MENTEE', 'b:COFOUNDER'])
    expect(ids(selectDrops([c('b', 'COFOUNDER', 70), c('a', 'MENTEE', 70)], opts({ count: 5 })))).toEqual(['a:MENTEE', 'b:COFOUNDER'])
  })

  it('does not depend on the order of the input', () => {
    const entries = [c('a', 'COFOUNDER', 90), c('b', 'MENTEE', 80), c('c', 'COLLABORATOR', 70), c('d', 'COFOUNDER', 60)]
    const forward = ids(selectDrops(entries, opts({ count: 3 })))
    const backward = ids(selectDrops([...entries].reverse(), opts({ count: 3 })))
    expect(backward).toEqual(forward)
  })
})
