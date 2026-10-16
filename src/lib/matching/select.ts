import type { MatchType } from './types'

// Which of a viewer's scored candidates become today's drops. Pure.
//
//  - Anybody scoring under the floor is not shown.
//  - Each person is shown once a day, as the relationship they fit best.
//  - A viewer who chose several types sees at most ONE drop per type in a day, so a day's drops are varied: the best cofounder, the best
//    teammate, the best mentor. A viewer who chose only one type has no such limit and gets as many as they are allowed.

export interface ScoredCandidate {
  candidateId: string
  /** The relationship from the viewer's side. */
  connectionType: MatchType
  score: number
  reasons: string[]
}

export interface SelectOptions {
  /** How many drops the viewer may be given (their daily allowance less what they already have). */
  count: number
  /** Whether the viewer chose exactly one type, which lifts the one-per-type limit. */
  singleType: boolean
  minScore: number
}

const byScoreThenId = (a: ScoredCandidate, b: ScoredCandidate) => b.score - a.score || a.candidateId.localeCompare(b.candidateId)

export function selectDrops(scored: readonly ScoredCandidate[], { count, singleType, minScore }: SelectOptions): ScoredCandidate[] {
  if (count <= 0) return []
  const eligible = scored.filter((entry) => entry.score >= minScore)

  if (singleType) {
    // One entry per person (the best), best first.
    const best = new Map<string, ScoredCandidate>()
    for (const entry of [...eligible].sort(byScoreThenId)) if (!best.has(entry.candidateId)) best.set(entry.candidateId, entry)
    return [...best.values()].slice(0, count)
  }

  // Several types: the best candidate for each, taking the strongest type first and never one person twice.
  const byType = new Map<MatchType, ScoredCandidate[]>()
  for (const entry of [...eligible].sort(byScoreThenId)) byType.set(entry.connectionType, [...(byType.get(entry.connectionType) ?? []), entry])

  const picked: ScoredCandidate[] = []
  const people = new Set<string>()
  const used = new Set<MatchType>()
  while (picked.length < count) {
    let best: ScoredCandidate | undefined
    for (const [type, entries] of byType) {
      if (used.has(type)) continue
      const next = entries.find((entry) => !people.has(entry.candidateId))
      if (next && (!best || byScoreThenId(next, best) < 0 || (byScoreThenId(next, best) === 0 && next.connectionType < best.connectionType))) best = next
    }
    if (!best) break
    picked.push(best)
    people.add(best.candidateId)
    used.add(best.connectionType)
  }
  return picked
}
