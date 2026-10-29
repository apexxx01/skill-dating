import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { loadConsentStates, withdrawConsent } from '@/lib/privacy/consent'
import { withdrawRomanceConsent } from '@/lib/romance/consent'
import { refreshLastEvidenced } from '@/lib/evidence/freshness-db'

// DELETE /api/users/me/consents/{ROMANCE_MODE|MARKETING|GITHUB_SYNC}: withdraw a consent. Withdrawing ROMANCE_MODE turns the mode off and deletes its data (the
// profile, filters, photos, drops, sparks and reveal state). Withdrawing GITHUB_SYNC stops every GitHub sync and hides what the evidence engine found, from
// the passport, the receipt pages and every count; it is kept and comes back if the consent is given again. The terms and the privacy notice are withdrawn
// by deleting the account (DELETE /api/users/me).
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const type = new URL(request.url).pathname.split('/').pop()
  if (type !== 'ROMANCE_MODE' && type !== 'MARKETING' && type !== 'GITHUB_SYNC') {
    return createApiError('VALIDATION_FAILED', { details: { type: ['Only ROMANCE_MODE, MARKETING and GITHUB_SYNC can be withdrawn here; delete the account to withdraw the rest'] } })
  }
  if (type === 'ROMANCE_MODE') await withdrawRomanceConsent(prisma, user.id)
  else {
    await withdrawConsent(prisma, user.id, type)
    await prisma.auditEvent.create({ data: { userId: user.id, action: 'CONSENT_WITHDRAWN', targetType: 'USER', targetId: user.id, newValue: { type } } })
    if (type === 'GITHUB_SYNC') {
      // No sync runs without it (the job checks), and skill freshness stops counting the engine's evidence.
      await prisma.githubSyncState.updateMany({ where: { userId: user.id }, data: { status: 'IDLE' } })
      await refreshLastEvidenced(prisma, user.id)
    }
  }
  return createApiResponse({ consent: (await loadConsentStates(prisma, user.id))[type] })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'consents:withdraw' } })
