import { describe, it, expect } from 'vitest'
import { buildSquad, partitionPool, seededOrder, seededRandom, seedFrom, squadSizes } from './optimizer'

interface P {
  id: string
  role: string
  tz: number
}

// A toy strength: ten points per distinct role, minus the spread of time zones. Enough structure for the optimiser to have something to find.
const evaluate = (members: readonly P[]) => {
  if (members.length === 0) return 0
  const roles = new Set(members.map((m) => m.role)).size
  const tzs = members.map((m) => m.tz)
  return roles * 10 - (Math.max(...tzs) - Math.min(...tzs))
}
const none = () => false
const person = (id: string, role: string, tz = 0): P => ({ id, role, tz })

describe('seeded randomness', () => {
  it('is the same sequence for the same seed and a different one for another', () => {
    const a = seededRandom(42)
    const b = seededRandom(42)
    const c = seededRandom(43)
    const first = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(first)
    expect([c(), c(), c()]).not.toEqual(first)
    for (const value of first) expect(value >= 0 && value < 1).toBe(true)
  })

  it('makes a stable seed from text', () => {
    expect(seedFrom('hackathon-1:1')).toBe(seedFrom('hackathon-1:1'))
    expect(seedFrom('hackathon-1:1')).not.toBe(seedFrom('hackathon-1:2'))
  })

  it('orders people the same way for a seed, whatever order they came in', () => {
    const people = ['d', 'a', 'c', 'b', 'e'].map((id) => person(id, 'x'))
    const once = seededOrder(people, 7).map((p) => p.id)
    expect(seededOrder([...people].reverse(), 7).map((p) => p.id)).toEqual(once)
    expect([...once].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('squadSizes', () => {
  it.each([
    [10, 2, 5, 4, [4, 3, 3]],
    [8, 2, 5, 4, [4, 4]],
    [7, 3, 4, 4, [4, 3]],
    [9, 3, 3, 3, [3, 3, 3]],
    [5, 4, 6, 4, [5]],
    [4, 1, 5, 4, [4]],
    [3, 4, 5, 4, []],
    [0, 1, 5, 4, []],
  ])('%i people, %i to %i, aiming for %i: %j', (count, min, max, target, expected) => {
    expect(squadSizes(count, min, max, target)).toEqual(expected)
  })

  it('never makes a squad bigger than the maximum', () => {
    for (let count = 1; count < 60; count++) for (const size of squadSizes(count, 2, 4, 4)) expect(size).toBeLessThanOrEqual(4)
  })
})

describe('buildSquad', () => {
  const pool = [person('fe1', 'FE'), person('fe2', 'FE'), person('be1', 'BE'), person('de1', 'DE', 3), person('de2', 'DE', 0), person('pi1', 'PI', 1)]

  it('completes a squad of the asked size around the anchor with complementary roles', () => {
    const result = buildSquad({ anchor: [person('me', 'FE')], pool, size: 4, evaluate, forbidden: none, seed: 1 })
    expect(result.members[0].id).toBe('me')
    expect(result.members).toHaveLength(4)
    expect(new Set(result.members.map((m) => m.role)).size).toBe(4)
    // The designer in the same time zone, not the one three hours away.
    expect(result.members.map((m) => m.id)).toContain('de2')
    expect(result.score).toBe(evaluate(result.members))
  })

  it('reaches the best squad a brute-force search finds on a small pool', () => {
    const anchor = [person('me', 'FE', 2)]
    const result = buildSquad({ anchor, pool, size: 3, evaluate, forbidden: none, seed: 3 })
    let best = -Infinity
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) best = Math.max(best, evaluate([...anchor, pool[i], pool[j]]))
    expect(result.score).toBe(best)
  })

  it('never puts two people who must not sit together on the squad, and comes back short when it has to', () => {
    const forbidden = (a: string, b: string) => [a, b].includes('me') && [a, b].some((id) => id.startsWith('de'))
    const result = buildSquad({ anchor: [person('me', 'FE')], pool, size: 4, evaluate, forbidden, seed: 1 })
    expect(result.members.some((m) => m.role === 'DE')).toBe(false)
    const short = buildSquad({ anchor: [person('me', 'FE')], pool: [person('x', 'BE')], size: 4, evaluate, forbidden: none, seed: 1 })
    expect(short.members.map((m) => m.id)).toEqual(['me', 'x'])
  })

  it('is deterministic for a seed and stays within its evaluation budget', () => {
    const big = Array.from({ length: 200 }, (_, i) => person(`p${String(i).padStart(3, '0')}`, ['FE', 'BE', 'DE', 'PI', 'ML'][i % 5], i % 7))
    const run = () => buildSquad({ anchor: [person('me', 'FE')], pool: big, size: 5, evaluate, forbidden: none, seed: 99, limits: { maxEvaluations: 500 } })
    const first = run()
    expect(run().members.map((m) => m.id)).toEqual(first.members.map((m) => m.id))
    expect(first.evaluations).toBeLessThanOrEqual(500)
  })

  it('keeps every anchor member', () => {
    const anchor = [person('me', 'FE'), person('mate', 'BE')]
    const result = buildSquad({ anchor, pool, size: 4, evaluate, forbidden: none, seed: 5 })
    expect(result.members.slice(0, 2).map((m) => m.id)).toEqual(['me', 'mate'])
  })
})

describe('partitionPool', () => {
  const twoOfEach = [person('a1', 'A'), person('a2', 'A'), person('b1', 'B'), person('b2', 'B'), person('c1', 'C'), person('c2', 'C')]

  it('balances the pool so the weakest squad is as strong as possible', () => {
    const result = partitionPool({ people: twoOfEach, minSize: 3, maxSize: 3, targetSize: 3, evaluate, forbidden: none, seed: 1 })
    expect(result.squads).toHaveLength(2)
    // The best split puts one of each role in each squad: both score 30.
    expect(result.scores).toEqual([30, 30])
    expect(result.leftovers).toEqual([])
    for (const squad of result.squads) expect(new Set(squad.map((m) => m.role)).size).toBe(3)
  })

  it('matches a brute-force max-min on a small pool with time zones', () => {
    const people = [person('a1', 'A', 0), person('a2', 'A', 5), person('b1', 'B', 0), person('b2', 'B', 5), person('c1', 'C', 1), person('c2', 'C', 4)]
    const result = partitionPool({ people, minSize: 3, maxSize: 3, targetSize: 3, evaluate, forbidden: none, seed: 11 })
    let best = -Infinity
    const ids = people.map((_, i) => i)
    for (let i = 1; i < 6; i++) for (let j = i + 1; j < 6; j++) {
      const first = [0, i, j]
      const second = ids.filter((index) => !first.includes(index))
      best = Math.max(best, Math.min(evaluate(first.map((index) => people[index])), evaluate(second.map((index) => people[index]))))
    }
    expect(Math.min(...result.scores)).toBe(best)
  })

  it('never seats two forbidden people together', () => {
    const forbidden = (a: string, b: string) => (a === 'a1' && b === 'b1') || (a === 'b1' && b === 'a1')
    const result = partitionPool({ people: twoOfEach, minSize: 3, maxSize: 3, targetSize: 3, evaluate, forbidden, seed: 2 })
    for (const squad of result.squads) expect(squad.map((m) => m.id).filter((id) => id === 'a1' || id === 'b1').length).toBeLessThan(2)
  })

  it('leaves people over when there are too few for a squad, or when they cannot be seated', () => {
    expect(partitionPool({ people: twoOfEach.slice(0, 2), minSize: 3, maxSize: 4, targetSize: 4, evaluate, forbidden: none, seed: 1 }).leftovers).toHaveLength(2)
    const everyoneHatesX = (a: string, b: string) => a === 'x' || b === 'x'
    const result = partitionPool({ people: [...twoOfEach, person('x', 'D')], minSize: 3, maxSize: 4, targetSize: 4, evaluate, forbidden: everyoneHatesX, seed: 1 })
    expect(result.leftovers.map((p) => p.id)).toEqual(['x'])
    expect(result.squads.flat()).toHaveLength(6)
  })

  it('places everybody exactly once, deterministically for a seed', () => {
    const people = Array.from({ length: 37 }, (_, i) => person(`p${i}`, ['A', 'B', 'C', 'D'][i % 4], i % 6))
    const run = () => partitionPool({ people, minSize: 2, maxSize: 5, targetSize: 4, evaluate, forbidden: none, seed: 5, limits: { maxEvaluations: 5000 } })
    const first = run()
    const placed = [...first.squads.flat(), ...first.leftovers].map((p) => p.id).sort()
    expect(placed).toEqual(people.map((p) => p.id).sort())
    expect(new Set(placed).size).toBe(37)
    expect(run().squads.map((s) => s.map((m) => m.id))).toEqual(first.squads.map((s) => s.map((m) => m.id)))
    expect(first.evaluations).toBeLessThanOrEqual(5000)
    for (const squad of first.squads) expect(squad.length >= 2 && squad.length <= 5).toBe(true)
  })
})
