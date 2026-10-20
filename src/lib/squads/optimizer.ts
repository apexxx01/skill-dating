// The squad optimiser, shared by the squad builder ("Find my squad") and the solo-pool auto-formation. Pure and generic: it only knows people by
// id, a function that scores a squad (squad strength, src/lib/squads/strength.ts) and a function that says which two people must never be on one
// squad (a block either way, a mutual "would not build again", someone failing the trust gate is never in the pool at all). Deterministic for a
// given seed, and bounded by a number of evaluations rather than by time, so the same input always gives the same squads.

export interface Person {
  id: string
}

/** mulberry32: a small, fast PRNG that is the same everywhere for the same 32-bit seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A seed from any string (a hackathon id and a round), for runs that must be repeatable without anyone choosing a number. */
export function seedFrom(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return hash >>> 0
}

/** The largest seed a proposal stores (SquadProposal.seed is a 32-bit signed integer). */
export const MAX_SEED = 0x7fffffff

/** A seed from text, within what a proposal stores. */
export const storedSeedFrom = (text: string) => seedFrom(text) & MAX_SEED

/** The people in id order, then shuffled by the seed: the order every tie is broken in. */
export function seededOrder<P extends Person>(people: readonly P[], seed: number): P[] {
  const random = seededRandom(seed)
  const out = [...people].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export interface OptimizerLimits {
  /** The most squad evaluations a run may make. */
  maxEvaluations: number
}

export const DEFAULT_LIMITS: OptimizerLimits = { maxEvaluations: 20_000 }

class Budget {
  used = 0
  constructor(private readonly max: number) {}
  get spent() {
    return this.used >= this.max
  }
}

const fits = <P extends Person>(squad: readonly P[], candidate: P, forbidden: (a: string, b: string) => boolean) => squad.every((member) => member.id !== candidate.id && !forbidden(member.id, candidate.id))

// --- One squad around a person ---------------------------------------------------------------------------------

export interface BuildSquadInput<P extends Person> {
  /** Who the squad is built around and is never swapped out: the requester, and their team's members. */
  anchor: readonly P[]
  pool: readonly P[]
  size: number
  evaluate: (members: readonly P[]) => number
  forbidden: (a: string, b: string) => boolean
  seed: number
  /** A cheap score of one candidate (their fit to the requester); the best `shortlist` of them are the ones considered. */
  prescore?: (candidate: P) => number
  shortlist?: number
  limits?: OptimizerLimits
}

export interface BuildSquadResult<P extends Person> {
  members: P[]
  score: number
  evaluations: number
}

/**
 * A complete squad of `size` around the anchor: greedy (add whoever raises the squad's score most, again and again), then a local search that swaps
 * one added member for one candidate outside while that raises the score, until no swap does or the budget is spent. A squad that cannot be filled
 * (too few candidates who may sit together) comes back smaller.
 */
export function buildSquad<P extends Person>(input: BuildSquadInput<P>): BuildSquadResult<P> {
  const budget = new Budget((input.limits ?? DEFAULT_LIMITS).maxEvaluations)
  const evaluate = (members: readonly P[]) => {
    budget.used += 1
    return input.evaluate(members)
  }
  const anchorIds = new Set(input.anchor.map((p) => p.id))
  const ordered = seededOrder(input.pool.filter((p) => !anchorIds.has(p.id)), input.seed)
  const prescores = new Map(ordered.map((p) => [p.id, input.prescore ? input.prescore(p) : 0]))
  // A stable sort keeps the seeded order among equal prescores.
  const candidates = [...ordered].sort((a, b) => prescores.get(b.id)! - prescores.get(a.id)!).slice(0, input.shortlist ?? 40)

  const squad: P[] = [...input.anchor]
  let score = evaluate(squad)
  while (squad.length < input.size && !budget.spent) {
    let best: { candidate: P; score: number } | null = null
    for (const candidate of candidates) {
      if (!fits(squad, candidate, input.forbidden)) continue
      const value = evaluate([...squad, candidate])
      if (!best || value > best.score) best = { candidate, score: value }
      if (budget.spent) break
    }
    if (!best) break
    squad.push(best.candidate)
    score = best.score
  }

  let improved = true
  while (improved && !budget.spent) {
    improved = false
    for (let position = input.anchor.length; position < squad.length && !budget.spent; position++) {
      const rest = squad.filter((_, index) => index !== position)
      for (const candidate of candidates) {
        if (squad.some((member) => member.id === candidate.id) || !fits(rest, candidate, input.forbidden)) continue
        const next = [...rest.slice(0, position), candidate, ...rest.slice(position)]
        const value = evaluate(next)
        if (value > score) {
          squad.splice(0, squad.length, ...next)
          score = value
          improved = true
          break
        }
        if (budget.spent) break
      }
    }
  }
  return { members: squad, score, evaluations: budget.used }
}

// --- The whole pool into squads ----------------------------------------------------------------------------------

/**
 * How many squads, of which sizes, `count` people make: as close to `target` each as the bounds allow, as even as possible, and nobody left out
 * unless there are fewer people than `min`. Pure.
 */
export function squadSizes(count: number, min: number, max: number, target: number): number[] {
  const lo = Math.max(1, min)
  const hi = Math.max(lo, max)
  if (count < lo) return []
  let squads = Math.max(1, Math.round(count / Math.min(hi, Math.max(lo, target))))
  while (squads > 1 && count / squads < lo) squads -= 1
  while (count / squads > hi) squads += 1
  const base = Math.floor(count / squads)
  const extra = count % squads
  return Array.from({ length: squads }, (_, index) => base + (index < extra ? 1 : 0))
}

export interface PartitionInput<P extends Person> {
  people: readonly P[]
  minSize: number
  maxSize: number
  targetSize: number
  evaluate: (members: readonly P[]) => number
  forbidden: (a: string, b: string) => boolean
  seed: number
  limits?: OptimizerLimits
}

export interface PartitionResult<P extends Person> {
  squads: P[][]
  scores: number[]
  /** People who could not be placed: too few to make a squad, or nobody they may sit with had room. */
  leftovers: P[]
  evaluations: number
}

const objective = (scores: readonly number[]) => ({ min: scores.length ? Math.min(...scores) : 0, sum: scores.reduce((total, value) => total + value, 0) })
const better = (a: { min: number; sum: number }, b: { min: number; sum: number }) => a.min > b.min || (a.min === b.min && a.sum > b.sum)

/**
 * Splits the pool into balanced squads, maximising the WEAKEST squad's strength first and the total second: nobody's squad is sacrificed to make
 * another great. A greedy placement (each person, in seeded order, to the squad with room that they raise most) and then swaps between the weakest
 * squad and the others while a swap improves that objective, within the evaluation budget.
 */
export function partitionPool<P extends Person>(input: PartitionInput<P>): PartitionResult<P> {
  const budget = new Budget((input.limits ?? DEFAULT_LIMITS).maxEvaluations)
  const evaluate = (members: readonly P[]) => {
    budget.used += 1
    return input.evaluate(members)
  }
  const sizes = squadSizes(input.people.length, input.minSize, input.maxSize, input.targetSize)
  if (sizes.length === 0) return { squads: [], scores: [], leftovers: [...input.people], evaluations: 0 }

  const squads: P[][] = sizes.map(() => [])
  const scores: number[] = sizes.map(() => 0)
  const leftovers: P[] = []
  for (const person of seededOrder(input.people, input.seed)) {
    let best: { index: number; gain: number } | null = null
    for (let index = 0; index < squads.length; index++) {
      if (squads[index].length >= sizes[index] || !fits(squads[index], person, input.forbidden)) continue
      const gain = evaluate([...squads[index], person]) - (squads[index].length === 0 ? 0 : scores[index])
      // Ties go to the emptier squad, so the first people spread out instead of piling into squad 0.
      if (!best || gain > best.gain || (gain === best.gain && squads[index].length < squads[best.index].length)) best = { index, gain }
    }
    if (!best) {
      leftovers.push(person)
      continue
    }
    squads[best.index].push(person)
    scores[best.index] = evaluate(squads[best.index])
  }

  // A squad left below the minimum (people who could not be placed elsewhere made it short) is broken up into leftovers.
  for (let index = squads.length - 1; index >= 0; index--) {
    if (squads[index].length < input.minSize) {
      leftovers.push(...squads[index])
      squads.splice(index, 1)
      scores.splice(index, 1)
    }
  }

  let improved = true
  while (improved && !budget.spent && squads.length > 1) {
    improved = false
    const weakest = scores.indexOf(Math.min(...scores))
    search: for (let other = 0; other < squads.length; other++) {
      if (other === weakest) continue
      for (let i = 0; i < squads[weakest].length; i++) {
        for (let j = 0; j < squads[other].length; j++) {
          if (budget.spent) break search
          const x = squads[weakest][i]
          const y = squads[other][j]
          const weakRest = squads[weakest].filter((_, index) => index !== i)
          const otherRest = squads[other].filter((_, index) => index !== j)
          if (!fits(weakRest, y, input.forbidden) || !fits(otherRest, x, input.forbidden)) continue
          const nextWeak = [...weakRest, y]
          const nextOther = [...otherRest, x]
          const nextScores = [...scores]
          nextScores[weakest] = evaluate(nextWeak)
          nextScores[other] = evaluate(nextOther)
          if (better(objective(nextScores), objective(scores))) {
            squads[weakest] = nextWeak
            squads[other] = nextOther
            scores.splice(0, scores.length, ...nextScores)
            improved = true
            break search
          }
        }
      }
    }
  }
  return { squads, scores, leftovers, evaluations: budget.used }
}
