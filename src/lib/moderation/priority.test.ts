import { describe, it, expect } from 'vitest'
import { reportPriority, type PriorityFacts } from './priority'

const plain: PriorityFacts = { reason: 'SPAM', romance: false, reporter: { trusted: true, stronglyVerified: false, highRisk: false }, otherReporters: 0 }
const p = (over: Partial<PriorityFacts>) => reportPriority({ ...plain, ...over })

describe('reportPriority', () => {
  it('puts minor safety first, then the romance mode, then impersonation, whatever the rest says', () => {
    const minor = p({ reason: 'MINOR_SAFETY', reporter: null })
    const romanceSpam = p({ reason: 'SPAM', romance: true, reporter: null })
    const impersonation = p({ reason: 'IMPERSONATION', otherReporters: 5, reporter: { trusted: true, stronglyVerified: true, highRisk: false } })
    expect(minor).toBeGreaterThan(romanceSpam)
    expect(romanceSpam).toBeGreaterThan(impersonation)
    expect(impersonation).toBeGreaterThan(p({ reason: 'HARASSMENT', otherReporters: 5 }))
  })

  it('orders a band by the reporter’s standing', () => {
    const verified = p({ reporter: { trusted: true, stronglyVerified: true, highRisk: false } })
    const trusted = p({})
    const fresh = p({ reporter: { trusted: false, stronglyVerified: false, highRisk: false } })
    const risky = p({ reporter: { trusted: true, stronglyVerified: true, highRisk: true } })
    expect(verified).toBeGreaterThan(trusted)
    expect(trusted).toBeGreaterThan(fresh)
    expect(fresh).toBeGreaterThan(risky)
  })

  it('rises with the number of other reporters, up to a cap', () => {
    expect(p({ otherReporters: 2 }) - p({})).toBe(80)
    expect(p({ otherReporters: 50 }) - p({})).toBe(200)
  })

  it('gives a platform report no reporter bonus', () => {
    expect(p({ reporter: null })).toBe(200)
  })
})
