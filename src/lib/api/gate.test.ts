import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/moderation/restrictions', () => ({ accountState: vi.fn() }))
vi.mock('@/lib/ops/kill-switches', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/ops/kill-switches')>()), isKilled: vi.fn() }))
vi.mock('@/lib/privacy/consent', () => ({ staleConsents: vi.fn() }))
vi.mock('@/lib/integrity/risk-job', () => ({ isHighRisk: vi.fn() }))
vi.mock('@/lib/rate-limiter', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/rate-limiter')>()), consumeSafely: vi.fn() }))

import { gateRequest } from './gate'
import { accountState } from '@/lib/moderation/restrictions'
import { isKilled } from '@/lib/ops/kill-switches'
import { staleConsents } from '@/lib/privacy/consent'
import { isHighRisk } from '@/lib/integrity/risk-job'
import { consumeSafely } from '@/lib/rate-limiter'

const db = {} as never
const user = { id: 'u1' }
const open = { suspendedUntil: null, banned: false, restricted: {} }
const codeOf = async (res: Response | null) => (res ? (await res.json()).error.code : null)

beforeEach(() => {
  vi.mocked(accountState).mockResolvedValue(open)
  vi.mocked(isKilled).mockResolvedValue(false)
  vi.mocked(staleConsents).mockResolvedValue([])
  vi.mocked(isHighRisk).mockResolvedValue(false)
  vi.mocked(consumeSafely).mockResolvedValue({ allowed: true, remaining: 1, retryAfterSeconds: 0 })
})

describe('gateRequest', () => {
  it('lets an ordinary request through', async () => {
    expect(await gateRequest(db, user, 'POST', '/api/posts')).toBeNull()
  })

  it('closes a banned or suspended account except its own account, data and appeals', async () => {
    vi.mocked(accountState).mockResolvedValue({ ...open, banned: true })
    expect(await codeOf(await gateRequest(db, user, 'GET', '/api/feed'))).toBe('ACCOUNT_BANNED')
    expect(await gateRequest(db, user, 'POST', '/api/appeals')).toBeNull()
    vi.mocked(accountState).mockResolvedValue({ ...open, suspendedUntil: '2026-11-01T00:00:00.000Z' })
    const res = await gateRequest(db, user, 'GET', '/api/feed')
    expect((await res!.json()).error).toMatchObject({ code: 'ACCOUNT_SUSPENDED', params: { until: '2026-11-01T00:00:00.000Z' } })
    expect(await gateRequest(db, user, 'DELETE', '/api/users/me')).toBeNull()
  })

  it('answers a killed feature with its own code, and leaves the others alone', async () => {
    vi.mocked(isKilled).mockImplementation(async (_db, name) => name === 'posting')
    expect(await codeOf(await gateRequest(db, user, 'POST', '/api/posts'))).toBe('POSTING_PAUSED')
    expect(await gateRequest(db, user, 'POST', '/api/conversations')).toBeNull()
  })

  it('answers a restricted feature with the feature and its end', async () => {
    vi.mocked(accountState).mockResolvedValue({ ...open, restricted: { messaging: '2026-10-25T00:00:00.000Z' } })
    const res = await gateRequest(db, user, 'POST', '/api/conversations/c1')
    expect((await res!.json()).error).toMatchObject({ code: 'FEATURE_RESTRICTED', params: { feature: 'messaging', until: '2026-10-25T00:00:00.000Z' } })
    expect(await gateRequest(db, user, 'POST', '/api/posts')).toBeNull()
  })

  it('asks for re-consent on writes only, and never on the consent route itself', async () => {
    vi.mocked(staleConsents).mockResolvedValue(['PRIVACY'])
    const res = await gateRequest(db, user, 'POST', '/api/posts')
    expect((await res!.json()).error).toMatchObject({ code: 'CONSENT_REQUIRED', details: { consents: ['PRIVACY'] } })
    expect(await gateRequest(db, user, 'GET', '/api/feed')).toBeNull()
    expect(await gateRequest(db, user, 'POST', '/api/users/me/consents')).toBeNull()
  })

  it('adds a write limit for a HIGH risk account', async () => {
    vi.mocked(isHighRisk).mockResolvedValue(true)
    vi.mocked(consumeSafely).mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 60 })
    expect((await gateRequest(db, user, 'POST', '/api/posts'))!.status).toBe(429)
    expect(await gateRequest(db, user, 'GET', '/api/feed')).toBeNull()
  })
})
