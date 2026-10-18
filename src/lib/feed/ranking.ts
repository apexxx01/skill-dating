import { TIERS, type Tier } from '@/lib/levels'

// Feed ranking v1. Deterministic, pure and documented in docs/FEED.md (with a worked example). A post's score for one viewer is
//
//   score = recencyDecay(age) * (1 + ln(1 + propsScore)) * networkBoost * proofBoost
//
//   recencyDecay  0.5 ^ (ageHours / 24): a day-old post is worth half of a fresh one, two days a quarter.
//   propsScore    the post's weighted props (props.ts); the log keeps a viral post from burying everything else.
//   networkBoost  how close the viewer is to the author: 1 for a stranger, 1.5 for someone they follow, 1.8 for a crewmate, 2.2 for a match
//                 (the closest tie counts, they do not multiply).
//   proofBoost    the author's tier: 1 + 0.05 per tier above Bronze (1.0 to 1.25), so proof of work lifts a post a little and never decides.
//
// Then a page is chosen from the ranked list with a diversity rule: at most two posts per author on a page. Blocked and hidden authors are
// removed before ranking (the candidate window never contains them).

export const RANKING_CONFIG = {
  halfLifeHours: 24,
  networkBoost: { none: 1, follow: 1.5, crew: 1.8, match: 2.2 },
  proofBoostPerTier: 0.05,
  maxPostsPerAuthorPerPage: 2,
} as const

export type Network = keyof typeof RANKING_CONFIG.networkBoost

export interface RankInput {
  createdAt: Date
  propsScore: number
  authorId: string
  authorTier: Tier
  /** The closest tie the viewer has to the author. */
  network: Network
}

const HOUR_MS = 60 * 60 * 1000

/** 1 for a post made now, 0.5 a half-life ago. A post from the future (clock skew) counts as new. */
export function recencyDecay(createdAt: Date, now: Date, halfLifeHours: number = RANKING_CONFIG.halfLifeHours): number {
  const ageHours = Math.max(0, (now.getTime() - createdAt.getTime()) / HOUR_MS)
  return Math.pow(0.5, ageHours / halfLifeHours)
}

export const propsFactor = (propsScore: number): number => 1 + Math.log1p(Math.max(0, propsScore))

export const proofBoost = (tier: Tier): number => 1 + RANKING_CONFIG.proofBoostPerTier * Math.max(0, TIERS.indexOf(tier))

export const networkBoostOf = (network: Network): number => RANKING_CONFIG.networkBoost[network]

/** The closest tie wins: a match beats a crewmate beats a follow. */
export function closestNetwork(ties: { follows?: boolean; crew?: boolean; match?: boolean }): Network {
  if (ties.match) return 'match'
  if (ties.crew) return 'crew'
  if (ties.follows) return 'follow'
  return 'none'
}

export interface RankBreakdown {
  recency: number
  props: number
  network: number
  proof: number
  score: number
}

export function rankPost(input: RankInput, now: Date): RankBreakdown {
  const recency = recencyDecay(input.createdAt, now)
  const props = propsFactor(input.propsScore)
  const network = networkBoostOf(input.network)
  const proof = proofBoost(input.authorTier)
  return { recency, props, network, proof, score: recency * props * network * proof }
}

export interface Rankable extends RankInput {
  id: string
}

/** Best first. Ties (and equal scores) go to the newer post, then to the larger id, so the order never depends on the order of the input. */
export function rankPosts<T extends Rankable>(posts: readonly T[], now: Date): (T & { score: number })[] {
  return posts
    .map((post) => ({ ...post, score: rankPost(post, now).score }))
    .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/**
 * One page from a ranked list: walks it in order and takes a post unless its author already has `maxPerAuthor` posts on this page. What the cap held
 * back stays, in order, in `rest`, so it is not lost: it leads the next page's candidates (and is capped again there).
 */
export function pickPage<T extends { id: string; authorId: string }>(ranked: readonly T[], options: { limit: number; maxPerAuthor?: number }): { items: T[]; rest: T[] } {
  const max = options.maxPerAuthor ?? RANKING_CONFIG.maxPostsPerAuthorPerPage
  const perAuthor = new Map<string, number>()
  const items: T[] = []
  const rest: T[] = []
  for (const post of ranked) {
    const taken = perAuthor.get(post.authorId) ?? 0
    if (items.length < options.limit && taken < max) {
      perAuthor.set(post.authorId, taken + 1)
      items.push(post)
    } else rest.push(post)
  }
  return { items, rest }
}

/**
 * Page number `page` (from 0) of a ranked window. Pages are worked out from the top each time, so the position is just a number and a cursor
 * stays small: a window is at most a few hundred posts, so this is a few hundred steps, not a query.
 */
export function pageAt<T extends { id: string; authorId: string }>(ranked: readonly T[], page: number, limit: number, maxPerAuthor?: number): { items: T[]; hasMore: boolean } {
  let remaining: readonly T[] = ranked
  let items: T[] = []
  for (let index = 0; index <= page; index++) {
    const picked = pickPage(remaining, { limit, maxPerAuthor })
    items = picked.items
    remaining = picked.rest
    if (remaining.length === 0 && index < page) return { items: [], hasMore: false }
  }
  return { items, hasMore: remaining.length > 0 }
}
