import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TransactionalContext } from './events'
import type { DomainEventName } from './events'

vi.mock('@/lib/infra/analytics', () => ({ track: vi.fn() }))
const grant = vi.fn()
vi.mock('@/lib/rewards', () => ({ grant: (...args: unknown[]) => grant(...args) }))
const grantAchievement = vi.fn()
vi.mock('@/lib/achievements', () => ({ grantAchievement: (...args: unknown[]) => grantAchievement(...args) }))

import { payForEvent } from './subscribers'

const DAY = 24 * 60 * 60 * 1000

function context(applicant: { createdAt: Date; isEmailVerified: boolean } | null): TransactionalContext<DomainEventName> {
  return {
    name: 'TEAM_APPLICATION_ACCEPTED',
    payload: { userId: 'applicant', teamId: 't1', applicationId: 'a1' },
    tx: { user: { findUnique: vi.fn(async () => applicant) } },
  } as unknown as TransactionalContext<DomainEventName>
}

beforeEach(() => {
  grant.mockReset().mockResolvedValue({ granted: true, xp: 50, envelope: {} })
  grantAchievement.mockReset().mockResolvedValue({ granted: true })
})

describe('payForEvent: accepted team applications', () => {
  it('pays XP and the achievement to an applicant whose account is old enough and verified', async () => {
    const result = await payForEvent(context({ createdAt: new Date(Date.now() - 30 * DAY), isEmailVerified: true }))
    expect(result).toEqual({ rewarded: true })
    expect(grant).toHaveBeenCalledWith(expect.anything(), 'applicant', 'TEAM_APPLICATION_ACCEPTED', expect.objectContaining({ sourceId: 'a1' }))
    expect(grantAchievement).toHaveBeenCalledWith(expect.anything(), 'applicant', 'team-player')
  })

  it('pays nothing, not even the achievement, to an account younger than seven days', async () => {
    const result = await payForEvent(context({ createdAt: new Date(Date.now() - 2 * DAY), isEmailVerified: true }))
    expect(result).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
    expect(grantAchievement).not.toHaveBeenCalled()
  })

  it('pays nothing to an old account whose email is not verified', async () => {
    const result = await payForEvent(context({ createdAt: new Date(Date.now() - 90 * DAY), isEmailVerified: false }))
    expect(result).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
    expect(grantAchievement).not.toHaveBeenCalled()
  })

  it('pays nothing to an applicant that no longer exists', async () => {
    expect(await payForEvent(context(null))).toEqual({ rewarded: false })
    expect(grant).not.toHaveBeenCalled()
  })
})
