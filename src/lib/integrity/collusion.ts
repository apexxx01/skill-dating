import { createHash } from 'crypto'

// Collusion detection: groups of accounts that boost each other. Pure; the nightly job (collusion-job.ts) loads the last 30 days of interactions and
// writes what this finds.
//
// The graph: one directed edge per interaction that one person gave another (an endorsement, a Prop, a peer review, an accepted team application or
// invitation) and, since accepting a connection is mutual by nature, one edge each way per accepted connection. Real friends endorse each other too, so
// reciprocity alone proves nothing. What farming looks like is reciprocity that is DENSE (most members boost most others) and DOMINATED BY WEAK
// ACCOUNTS (young or without proof of work), because a farm needs cheap accounts:
//
//   1. keep the reciprocal pairs (both directions seen) where at least one of the two is a weak account;
//   2. split them into connected groups;
//   3. flag a group of 3 or more whose reciprocal density and weak share are both high, or a pair of weak accounts trading many interactions;
//   4. score it 0 to 100 from density, weak share and intensity.
//
// A flag never bans anyone. It lowers the weight of what the members gave EACH OTHER inside the window (weightFor), feeds their risk scores, and goes to
// an admin, who can dismiss it (everything is restored) or confirm it.

export type InteractionKind = 'ENDORSEMENT' | 'PROP' | 'CONNECTION' | 'PEER_REVIEW' | 'TEAM_ACCEPT'

export interface Interaction {
  from: string
  to: string
  kind: InteractionKind
}

export interface AccountFacts {
  createdAt: Date
  /** Verified beyond an email (phone, GitHub, portfolio, organisation or identity). */
  strongVerification: boolean
  /** Shipped projects and verified evidence: proof of work. */
  proofCount: number
}

export const COLLUSION_CONFIG = {
  windowDays: 30,
  /** Younger than this is a young account. */
  youngAccountDays: 30,
  /** A group of three or more: at least this share of the possible reciprocal pairs present... */
  minDensity: 0.6,
  /** ...and at least this share of weak members. */
  minWeakShare: 0.5,
  minGroupSize: 3,
  /** A pair alone is flagged only when both are weak and each gave the other at least this many interactions. */
  pairMinEachWay: 3,
  /** A group is never bigger than this; a bigger reciprocal component is not a farm this rule describes, and is left for a person to look at. */
  maxGroupSize: 50,
  /** What the members' interactions with each other count for afterwards, as a function of the score (see weightFor). */
  minWeight: 0.1,
  maxWeight: 0.5,
} as const

export interface Cluster {
  memberIds: string[]
  score: number
  density: number
  weakShare: number
  /** Interactions inside the group, per kind. */
  counts: Record<InteractionKind, number>
  /** Interactions inside the group per member. */
  intensity: number
  fingerprint: string
}

const DAY_MS = 24 * 60 * 60 * 1000

export function isWeakAccount(account: AccountFacts | undefined, now: Date): boolean {
  if (!account) return true
  const young = now.getTime() - account.createdAt.getTime() < COLLUSION_CONFIG.youngAccountDays * DAY_MS
  const lowProof = !account.strongVerification && account.proofCount === 0
  return young || lowProof
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** The same member set always has the same fingerprint, whatever order they come in. */
export function clusterFingerprint(memberIds: readonly string[]): string {
  return createHash('sha256').update([...memberIds].sort().join(',')).digest('hex').slice(0, 40)
}

/** What the members' interactions with each other count for once their group is flagged: lower for a higher score, between minWeight and maxWeight. */
export function weightFor(score: number): number {
  const { minWeight, maxWeight } = COLLUSION_CONFIG
  const raw = 1 - Math.max(0, Math.min(100, score)) / 100
  return Math.round(Math.max(minWeight, Math.min(maxWeight, raw)) * 100) / 100
}

function emptyCounts(): Record<InteractionKind, number> {
  return { ENDORSEMENT: 0, PROP: 0, CONNECTION: 0, PEER_REVIEW: 0, TEAM_ACCEPT: 0 }
}

export function detectCollusion(interactions: readonly Interaction[], accounts: ReadonlyMap<string, AccountFacts>, now: Date = new Date()): Cluster[] {
  const config = COLLUSION_CONFIG
  // Directed counts per ordered pair.
  const directed = new Map<string, number>()
  for (const edge of interactions) {
    if (edge.from === edge.to) continue
    const key = `${edge.from}>${edge.to}`
    directed.set(key, (directed.get(key) ?? 0) + 1)
  }
  const gave = (from: string, to: string) => directed.get(`${from}>${to}`) ?? 0
  const weak = new Map<string, boolean>()
  const isWeak = (id: string) => {
    if (!weak.has(id)) weak.set(id, isWeakAccount(accounts.get(id), now))
    return weak.get(id)!
  }

  // 1. Reciprocal pairs touching a weak account.
  const reciprocal = new Map<string, [string, string]>()
  for (const key of directed.keys()) {
    const [from, to] = key.split('>')
    if (gave(to, from) === 0) continue
    if (!isWeak(from) && !isWeak(to)) continue
    reciprocal.set(pairKey(from, to), from < to ? [from, to] : [to, from])
  }

  // 2. Connected groups (union-find).
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    let node = id
    while (node !== root) {
      const next = parent.get(node)!
      parent.set(node, root)
      node = next
    }
    return root
  }
  for (const [a, b] of reciprocal.values()) {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb)
  }
  const groups = new Map<string, string[]>()
  for (const id of parent.keys()) {
    const root = find(id)
    groups.set(root, [...(groups.get(root) ?? []), id])
  }

  // 3 and 4. Judge each group.
  const clusters: Cluster[] = []
  for (const members of groups.values()) {
    const n = members.length
    if (n < 2 || n > config.maxGroupSize) continue
    const memberSet = new Set(members)
    let pairs = 0
    for (const [a, b] of reciprocal.values()) if (memberSet.has(a) && memberSet.has(b)) pairs += 1
    const density = n === 2 ? 1 : pairs / ((n * (n - 1)) / 2)
    const weakShare = members.filter(isWeak).length / n
    const counts = emptyCounts()
    let inside = 0
    for (const edge of interactions) {
      if (edge.from !== edge.to && memberSet.has(edge.from) && memberSet.has(edge.to)) {
        counts[edge.kind] += 1
        inside += 1
      }
    }
    const intensity = inside / n

    const flagged =
      n >= config.minGroupSize
        ? density >= config.minDensity && weakShare >= config.minWeakShare
        : weakShare === 1 && gave(members[0], members[1]) >= config.pairMinEachWay && gave(members[1], members[0]) >= config.pairMinEachWay
    if (!flagged) continue

    const score = Math.round(100 * (0.4 * density + 0.4 * weakShare + 0.2 * Math.min(1, intensity / 5)))
    const memberIds = [...members].sort()
    clusters.push({ memberIds, score, density: round2(density), weakShare: round2(weakShare), counts, intensity: round2(intensity), fingerprint: clusterFingerprint(memberIds) })
  }
  return clusters.sort((a, b) => b.score - a.score || a.fingerprint.localeCompare(b.fingerprint))
}

const round2 = (value: number) => Math.round(value * 100) / 100
