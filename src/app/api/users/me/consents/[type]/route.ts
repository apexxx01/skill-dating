import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { loadConsentStates, withdrawConsent } from '@/lib/privacy/consent'
import { withdrawRomanceConsent } from '@/lib/romance/consent'

// DELETE /api/users/me/consents/{ROMANCE_MODE|MARKETING}: withdraw a consent. Withdrawing ROMANCE_MODE turns the mode off and deletes its data (the
// profile, filters, photos, drops, sparks and reveal state). The terms and the privacy notice are withdrawn by deleting the account (DELETE /api/users/me).
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const type = new URL(request.url).pathname.split('/').pop()
  if (type !== 'ROMANCE_MODE' && type !== 'MARKETING') {
    return createApiError('VALIDATION_FAILED', { details: { type: ['Only ROMANCE_MODE and MARKETING can be withdrawn here; delete the account to withdraw the rest'] } })
  }
  if (type === 'ROMANCE_MODE') await withdrawRomanceConsent(prisma, user.id)
  else {
    await withdrawConsent(prisma, user.id, 'MARKETING')
    await prisma.auditEvent.create({ data: { userId: user.id, action: 'CONSENT_WITHDRAWN', targetType: 'USER', targetId: user.id, newValue: { type } } })
  }
  return createApiResponse({ consent: (await loadConsentStates(prisma, user.id))[type] })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'consents:withdraw' } })
