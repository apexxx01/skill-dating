import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { grantConsent, grantConsentSchema, loadConsentStates, missingRequired } from '@/lib/privacy/consent'

// GET /api/users/me/consents: each consent type with the current version, what the caller agreed to, and whether it is current or must be given again.
// POST { type, version, source? }: agree to the current version of a document (another version is 400 CONSENT_VERSION_UNKNOWN). Append-only; audited.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const states = await loadConsentStates(prisma, user.id)
  return createApiResponse({ consents: Object.values(states), required: missingRequired(states) })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'consents:get' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(grantConsentSchema)(request)
  if (body instanceof Response) return body
  const record = await grantConsent(prisma, user.id, body.data)
  if (record === 'CONSENT_VERSION_UNKNOWN') return createApiError('CONSENT_VERSION_UNKNOWN', { params: { document: body.data.type.toLowerCase() } })
  await prisma.auditEvent.create({ data: { userId: user.id, action: 'CONSENT_GRANTED', targetType: 'USER', targetId: user.id, newValue: { type: record.type, version: record.version, source: record.source } } })
  const states = await loadConsentStates(prisma, user.id)
  return createApiResponse({ consent: states[record.type], required: missingRequired(states) }, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'consents:grant' } })
