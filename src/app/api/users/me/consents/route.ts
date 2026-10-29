import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { grantConsent, grantConsentSchema, loadConsentStates, missingRequired } from '@/lib/privacy/consent'
import { romanceOpenFor } from '@/lib/romance/launch'
import { refreshLastEvidenced } from '@/lib/evidence/freshness-db'
import { requestGithubSync } from '@/lib/evidence/sync'

// GET /api/users/me/consents: each consent type with the current version, what the caller agreed to, and whether it is current or must be given again.
// POST { type, version, source? }: agree to the current version of a document (another version is 400 CONSENT_VERSION_UNKNOWN). Append-only; audited.
// While the romance mode is closed for the caller (src/lib/romance/launch.ts) its consent is not listed and cannot be given (503 ROMANCE_PAUSED).
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const states = await loadConsentStates(prisma, user.id)
  const open = await romanceOpenFor(prisma, user.id)
  return createApiResponse({ consents: Object.values(states).filter((state) => open || state.type !== 'ROMANCE_MODE'), required: missingRequired(states) })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'consents:get' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(grantConsentSchema)(request)
  if (body instanceof Response) return body
  if (body.data.type === 'ROMANCE_MODE' && !(await romanceOpenFor(prisma, user.id))) return createApiError('ROMANCE_PAUSED')
  const record = await grantConsent(prisma, user.id, body.data)
  if (record === 'CONSENT_VERSION_UNKNOWN') return createApiError('CONSENT_VERSION_UNKNOWN', { params: { document: body.data.type.toLowerCase() } })
  await prisma.auditEvent.create({ data: { userId: user.id, action: 'CONSENT_GRANTED', targetType: 'USER', targetId: user.id, newValue: { type: record.type, version: record.version, source: record.source } } })
  // Reading GitHub history starts once it is allowed (src/lib/evidence/sync.ts); what an earlier consent found shows again at once.
  if (record.type === 'GITHUB_SYNC') {
    await refreshLastEvidenced(prisma, user.id)
    if ((await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { githubId: true } })).githubId) await requestGithubSync(prisma, user.id, 'consent')
  }
  const states = await loadConsentStates(prisma, user.id)
  return createApiResponse({ consent: states[record.type], required: missingRequired(states) }, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'consents:grant' } })
