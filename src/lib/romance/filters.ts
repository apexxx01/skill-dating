import type { Gender, Scope } from './config'

// The private filters under a romance profile, as a pure rule. They are what a person wants of a partner: who (gender), how old, how far. A
// romance match needs BOTH sides to accept each other, so the rule is always applied in both directions and the stricter side wins:
//
//   A and B fit when  B's gender is among A's "interested in"  AND  B's age is inside A's range  AND  A and B are close enough for A's scope
//                     and the same three for B, with A and B swapped.
//
// "Close enough": CITY needs the same city (Profile.cityKey) and COUNTRY the same country (Profile.countryCode); a person with no place
// on file is not close to anybody for those scopes. ANYWHERE asks nothing. Scope is symmetric by construction (it compares the two places),
// so the stricter of the two scopes is the one that decides.
//
// The inbox gate ("only people endorsed by at least N builders can spark me") is not a filter of this kind: it is about who may START a
// conversation, not who fits, and is checked separately (inboxAllows). The same rule exists as SQL in candidates.ts; the integration test
// compares the two for every combination.

export interface FilterFacts {
  gender: Gender
  interestedIn: readonly Gender[]
  ageMin: number
  ageMax: number
  scope: Scope
  /** Whole years old today. */
  age: number
  cityKey: string | null
  countryCode: string | null
}

export type FilterRefusal = 'GENDER' | 'AGE' | 'SCOPE'

function closeEnough(scope: Scope, a: FilterFacts, b: FilterFacts): boolean {
  if (scope === 'ANYWHERE') return true
  if (scope === 'CITY') return a.cityKey !== null && a.cityKey === b.cityKey
  return a.countryCode !== null && a.countryCode === b.countryCode
}

/** Whether `viewer` would accept `other` as a partner (one direction). The reason is the first filter that said no. */
export function accepts(viewer: FilterFacts, other: FilterFacts): FilterRefusal | null {
  if (!viewer.interestedIn.includes(other.gender)) return 'GENDER'
  if (other.age < viewer.ageMin || other.age > viewer.ageMax) return 'AGE'
  if (!closeEnough(viewer.scope, viewer, other)) return 'SCOPE'
  return null
}

/** Whether the two accept each other. The refusal names the side that said no (`by`), for tests and logs only: it is never shown to anybody. */
export function mutuallyAccept(a: FilterFacts, b: FilterFacts): { ok: true } | { ok: false; by: 'A' | 'B'; reason: FilterRefusal } {
  const fromA = accepts(a, b)
  if (fromA) return { ok: false, by: 'A', reason: fromA }
  const fromB = accepts(b, a)
  if (fromB) return { ok: false, by: 'B', reason: fromB }
  return { ok: true }
}

/** The inbox gate: a sender with `senderEndorsements` builders vouching for them may spark a receiver who asks for `required`. */
export function inboxAllows(required: number, senderEndorsements: number): boolean {
  return senderEndorsements >= required
}
