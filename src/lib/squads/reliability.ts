// Reliability: how dependable a person has been as a hackathon teammate, from the private peer reviews their squadmates wrote after each hackathon
// (did they show up, would the reviewer build with them again). Pure. The number is NEVER shown to anyone: it moves squad strength, the squad
// builder, the solo-pool optimiser and the pairwise score's priorSignal, and a passport may show a "Reliable teammate" badge once it is high and
// backed by enough reviews.
//
// A few reviews say little, so the score is shrunk toward a neutral prior (a Bayesian average: the prior counts as `priorWeight` reviews), and a
// recent review counts for more than an old one (each review's weight halves every `halfLifeDays`).

export type ShowedUp = 'YES' | 'PARTLY' | 'NO'

export interface ReviewFacts {
  showedUp: ShowedUp
  wouldBuildAgain: boolean
  createdAt: Date
}

export const RELIABILITY_CONFIG = {
  /** What somebody with no reviews is taken to be: most people show up. */
  prior: 0.75,
  /** The prior counts as this many reviews. */
  priorWeight: 3,
  halfLifeDays: 365,
  showedUp: { YES: 1, PARTLY: 0.5, NO: 0 } satisfies Record<ShowedUp, number>,
  /** How much of one review is "would build again" (the rest is showing up). */
  wouldBuildAgainShare: 0.3,
  /** The passport badge: at least this score, from at least this many reviews. */
  badge: { minScore: 0.85, minReviews: 3 },
}

const DAY_MS = 24 * 60 * 60 * 1000

/** One review as a number from 0 to 1. */
export function reviewValue(review: Pick<ReviewFacts, 'showedUp' | 'wouldBuildAgain'>): number {
  const share = RELIABILITY_CONFIG.wouldBuildAgainShare
  return (1 - share) * RELIABILITY_CONFIG.showedUp[review.showedUp] + share * (review.wouldBuildAgain ? 1 : 0)
}

export interface Reliability {
  /** 0 to 1, shrunk toward the prior. */
  score: number
  reviews: number
  /** False with no reviews at all: the score is then just the prior, and nothing should be read into it. */
  known: boolean
  badge: boolean
}

export function reliabilityOf(reviews: readonly ReviewFacts[], now: Date = new Date()): Reliability {
  const { prior, priorWeight, halfLifeDays, badge } = RELIABILITY_CONFIG
  let weighted = 0
  let weights = 0
  for (const review of reviews) {
    const ageDays = Math.max(0, (now.getTime() - review.createdAt.getTime()) / DAY_MS)
    const weight = Math.pow(0.5, ageDays / halfLifeDays)
    weighted += weight * reviewValue(review)
    weights += weight
  }
  const score = (prior * priorWeight + weighted) / (priorWeight + weights)
  return { score, reviews: reviews.length, known: reviews.length > 0, badge: reviews.length >= badge.minReviews && score >= badge.minScore }
}
