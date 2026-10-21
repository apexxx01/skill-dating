// The moderation queue's order (docs/SAFETY.md, "The queue"). Pure. Higher first; ties go to the oldest.
//
//   1. anything that puts a minor at risk                                  2000 (above anything the rest can add up to)
//   2. anything in the romance mode (its profiles, sparks, messages)       +800
//   3. impersonation                                                        600
//   4. harassment and scams                                                 400
//   5. inappropriate content and fake profiles                              300
//   6. spam                                                                 200
//   7. date-of-birth corrections, copyright                                 150
//   8. anything else                                                        100
// then, inside a band, by the reporter's standing (a trusted account +50, strongly verified +25 more, a HIGH risk reporter -100) and by volume (+40 for
// each other person who reported the same thing while it is open, up to +200). Platform reports (flagged content, photos for review) carry no
// reporter bonus.

export type ReasonName =
  | 'SPAM'
  | 'HARASSMENT'
  | 'INAPPROPRIATE_CONTENT'
  | 'FAKE_PROFILE'
  | 'SCAM'
  | 'COPYRIGHT'
  | 'OTHER'
  | 'BIRTHDATE_CORRECTION'
  | 'IMPERSONATION'
  | 'MINOR_SAFETY'

export const REASON_PRIORITY: Record<ReasonName, number> = {
  MINOR_SAFETY: 2000,
  IMPERSONATION: 600,
  HARASSMENT: 400,
  SCAM: 400,
  INAPPROPRIATE_CONTENT: 300,
  FAKE_PROFILE: 300,
  SPAM: 200,
  BIRTHDATE_CORRECTION: 150,
  COPYRIGHT: 150,
  OTHER: 100,
}

export const PRIORITY_CONFIG = {
  romance: 800,
  trustedReporter: 50,
  verifiedReporter: 25,
  riskyReporter: -100,
  perOtherReporter: 40,
  maxVolume: 200,
} as const

export interface PriorityFacts {
  reason: ReasonName
  /** The report is about something in the romance mode. */
  romance: boolean
  reporter: { trusted: boolean; stronglyVerified: boolean; highRisk: boolean } | null
  /** Other people with an open report about the same thing. */
  otherReporters: number
}

export function reportPriority(facts: PriorityFacts): number {
  const c = PRIORITY_CONFIG
  let score = REASON_PRIORITY[facts.reason] + (facts.romance ? c.romance : 0)
  if (facts.reporter) {
    if (facts.reporter.highRisk) score += c.riskyReporter
    else if (facts.reporter.trusted) score += c.trustedReporter + (facts.reporter.stronglyVerified ? c.verifiedReporter : 0)
  }
  score += Math.min(c.maxVolume, Math.max(0, facts.otherReporters) * c.perOtherReporter)
  return score
}
