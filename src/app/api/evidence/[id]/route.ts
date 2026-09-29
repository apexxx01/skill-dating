import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { ENDORSEMENT_TYPE, deleteEvidenceWithEndorsements } from '@/lib/skill-evidence'

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop()
  if (!id) return createApiError('Evidence ID required', 400)

  const evidence = await prisma.skillEvidence.findUnique({
    where: { id },
    select: { id: true, userId: true, type: true },
  })
  // Endorsement rows are not evidence a user manages: they are removed by the
  // endorser (unendorse) or together with the evidence they point at.
  if (!evidence || evidence.type === ENDORSEMENT_TYPE) {
    return createApiError('Evidence not found', 404)
  }
  if (evidence.userId !== user.id) {
    return createApiError('Forbidden', 403)
  }

  await deleteEvidenceWithEndorsements(prisma, id)
  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'evidence:delete' } })
