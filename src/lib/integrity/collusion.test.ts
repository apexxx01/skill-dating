import { describe, it, expect } from 'vitest'
import { clusterFingerprint, detectCollusion, isWeakAccount, weightFor, type AccountFacts, type Interaction, type InteractionKind } from './collusion'

const now = new Date('2026-10-20T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const young: AccountFacts = { createdAt: new Date(now.getTime() - 5 * DAY), strongVerification: false, proofCount: 0 }
const established: AccountFacts = { createdAt: new Date(now.getTime() - 400 * DAY), strongVerification: true, proofCount: 4 }
const oldButNoProof: AccountFacts = { createdAt: new Date(now.getTime() - 400 * DAY), strongVerification: false, proofCount: 0 }

/** Everybody in `ids` gives everybody else `times` interactions of `kind`. */
function ring(ids: string[], kind: InteractionKind = 'ENDORSEMENT', times = 1): Interaction[] {
  const out: Interaction[] = []
  for (const from of ids) for (const to of ids) if (from !== to) for (let i = 0; i < times; i++) out.push({ from, to, kind })
  return out
}

const accounts = (entries: Record<string, AccountFacts>) => new Map(Object.entries(entries))

describe('isWeakAccount', () => {
  it('is weak when young, or old without proof of work or strong verification', () => {
    expect(isWeakAccount(young, now)).toBe(true)
    expect(isWeakAccount(oldButNoProof, now)).toBe(true)
    expect(isWeakAccount({ ...oldButNoProof, proofCount: 1 }, now)).toBe(false)
    expect(isWeakAccount({ ...oldButNoProof, strongVerification: true }, now)).toBe(false)
    expect(isWeakAccount(established, now)).toBe(false)
    expect(isWeakAccount(undefined, now)).toBe(true)
  })
})

describe('detectCollusion', () => {
  it('flags a dense ring of young accounts endorsing each other, with a high score', () => {
    const ids = ['a', 'b', 'c', 'd']
    const found = detectCollusion([...ring(ids), ...ring(ids, 'PROP', 2)], accounts({ a: young, b: young, c: young, d: young }), now)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ memberIds: ['a', 'b', 'c', 'd'], density: 1, weakShare: 1 })
    expect(found[0].counts).toMatchObject({ ENDORSEMENT: 12, PROP: 24 })
    expect(found[0].score).toBeGreaterThanOrEqual(90)
    expect(found[0].fingerprint).toBe(clusterFingerprint(['d', 'c', 'b', 'a']))
  })

  it('leaves alone established builders who endorse each other, however much', () => {
    const ids = ['a', 'b', 'c', 'd']
    expect(detectCollusion(ring(ids, 'ENDORSEMENT', 5), accounts({ a: established, b: established, c: established, d: established }), now)).toEqual([])
  })

  it('leaves alone one-way attention: a new account endorsing many people is not a ring', () => {
    const edges: Interaction[] = ['a', 'b', 'c', 'd'].map((to) => ({ from: 'n', to, kind: 'ENDORSEMENT' }))
    expect(detectCollusion(edges, accounts({ n: young, a: young, b: young, c: young, d: young }), now)).toEqual([])
  })

  it('does not flag a sparse group, where few of the possible pairs boost each other', () => {
    // A chain a-b-c-d-e-f: reciprocal, all weak, but each only with a neighbour.
    const chain = ['a', 'b', 'c', 'd', 'e', 'f']
    const edges = chain.slice(1).flatMap((id, i) => ring([chain[i], id]))
    const all = Object.fromEntries(chain.map((id) => [id, young]))
    expect(detectCollusion(edges, accounts(all), now)).toEqual([])
  })

  it('does not flag a group where weak accounts are a small minority', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const found = detectCollusion(ring(ids), accounts({ a: young, b: established, c: established, d: established, e: established }), now)
    expect(found).toEqual([])
  })

  it('flags a pair of weak accounts only when they trade many interactions both ways', () => {
    const pair = ['x', 'y']
    expect(detectCollusion(ring(pair, 'PROP', 2), accounts({ x: young, y: young }), now)).toEqual([])
    const found = detectCollusion(ring(pair, 'PROP', 3), accounts({ x: young, y: young }), now)
    expect(found.map((c) => c.memberIds)).toEqual([['x', 'y']])
    expect(detectCollusion(ring(pair, 'PROP', 10), accounts({ x: young, y: established }), now)).toEqual([])
  })

  it('counts a connection accept both ways and ignores interactions with oneself', () => {
    const edges: Interaction[] = [
      ...ring(['a', 'b', 'c'], 'CONNECTION'),
      { from: 'a', to: 'a', kind: 'PROP' },
    ]
    const found = detectCollusion(edges, accounts({ a: young, b: young, c: young }), now)
    expect(found[0].counts).toMatchObject({ CONNECTION: 6, PROP: 0 })
  })

  it('finds two separate rings as two clusters, the stronger first', () => {
    const edges = [...ring(['a', 'b', 'c'], 'ENDORSEMENT', 3), ...ring(['p', 'q', 'r'])]
    const all = Object.fromEntries(['a', 'b', 'c', 'p', 'q', 'r'].map((id) => [id, young]))
    const found = detectCollusion(edges, accounts(all), now)
    expect(found.map((c) => c.memberIds)).toEqual([['a', 'b', 'c'], ['p', 'q', 'r']])
    expect(found[0].score).toBeGreaterThan(found[1].score)
  })
})

describe('weightFor', () => {
  it('lowers more for a higher score, between 0.1 and 0.5', () => {
    expect(weightFor(100)).toBe(0.1)
    expect(weightFor(95)).toBe(0.1)
    expect(weightFor(70)).toBe(0.3)
    expect(weightFor(40)).toBe(0.5)
    expect(weightFor(0)).toBe(0.5)
  })
})
