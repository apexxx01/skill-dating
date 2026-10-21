// A person's risk score, 0 to 100, from the signals the platform already records about them. Pure; the nightly job (risk-job.ts) gathers the facts and
// writes the result. The score never bans anyone. A HIGH level reduces reach (drops, the feed, the squad builder) and tightens rate limits, and an admin
// can override the level either way; every change is in the audit log.
//
//   factor        what it is                                                  points
//   collusion     the highest score of an open or confirmed fraud signal       0.4 x score       (max 40)
//                 the person is in
//   reports       distinct people who reported them in 90 days (not dismissed) 8 each            (max 25)
//   blocks        people who blocked them in 90 days                           3 each            (max 15)
//   throttles     rate limits they ran into in 30 days                         2 each            (max 10)
//   velocity      bursts and content flags recorded about them in 30 days       2 each            (max 10)
//   unverified    no date of birth on file (5); email not verified (5)                           (max 10)
//
// LOW below 40, ELEVATED from 40, HIGH from 70.

export type RiskLevelName = 'LOW' | 'ELEVATED' | 'HIGH'

export interface RiskFacts {
  /** The highest score (0 to 100) of an OPEN or CONFIRMED fraud signal the person is a member of; 0 when none. */
  collusionScore: number
  distinctReporters90d: number
  blocksReceived90d: number
  throttleHits30d: number
  velocitySignals30d: number
  hasBirthDate: boolean
  emailVerified: boolean
}

export const RISK_CONFIG = {
  collusion: { perPoint: 0.4, max: 40 },
  reports: { each: 8, max: 25 },
  blocks: { each: 3, max: 15 },
  throttles: { each: 2, max: 10 },
  velocity: { each: 2, max: 10 },
  unverified: { birthDate: 5, email: 5 },
  levels: { elevated: 40, high: 70 },
} as const

export interface RiskResult {
  score: number
  level: RiskLevelName
  factors: { collusion: number; reports: number; blocks: number; throttles: number; velocity: number; unverified: number }
}

const capped = (count: number, each: number, max: number) => Math.min(max, Math.max(0, count) * each)

export function levelForScore(score: number): RiskLevelName {
  if (score >= RISK_CONFIG.levels.high) return 'HIGH'
  if (score >= RISK_CONFIG.levels.elevated) return 'ELEVATED'
  return 'LOW'
}

export function riskOf(facts: RiskFacts): RiskResult {
  const c = RISK_CONFIG
  const factors = {
    collusion: Math.min(c.collusion.max, Math.round(Math.max(0, facts.collusionScore) * c.collusion.perPoint)),
    reports: capped(facts.distinctReporters90d, c.reports.each, c.reports.max),
    blocks: capped(facts.blocksReceived90d, c.blocks.each, c.blocks.max),
    throttles: capped(facts.throttleHits30d, c.throttles.each, c.throttles.max),
    velocity: capped(facts.velocitySignals30d, c.velocity.each, c.velocity.max),
    unverified: (facts.hasBirthDate ? 0 : c.unverified.birthDate) + (facts.emailVerified ? 0 : c.unverified.email),
  }
  const score = Math.min(100, Object.values(factors).reduce((sum, value) => sum + value, 0))
  return { score, level: levelForScore(score), factors }
}

/** The level in force: an admin's override wins over the computed one. */
export function effectiveLevel(row: { level: RiskLevelName; overrideLevel: RiskLevelName | null } | null | undefined): RiskLevelName {
  if (!row) return 'LOW'
  return row.overrideLevel ?? row.level
}
