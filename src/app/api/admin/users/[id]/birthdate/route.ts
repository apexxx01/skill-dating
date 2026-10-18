import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { MIN_PLATFORM_AGE } from '@/lib/age-policy'
import { correctBirthDate, correctBirthDateSchema } from '@/lib/birth-date-admin'
import { purgeRomanceForMinor } from '@/lib/romance/lifecycle'

// POST /api/admin/users/{id}/birthdate  body: { birthDate: "YYYY-MM-DD", reason }
//
// Admin only. Corrects a person's locked date of birth (they ask through POST /api/reports with the reason BIRTHDATE_CORRECTION). The reason is required, and the
// old and the new date go into the audit trail. The response never carries a date: it says what the account is now (`ageBand`) and whether anything changed.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''
  const body = await validateBody(correctBirthDateSchema)(request)
  if (body instanceof Response) return body

  // A correction to 16 or 17 takes the person out of the romance mode (it is 18+), in the same transaction.
  const result = await correctBirthDate(prisma, user.id, id, body.data, { onMinor: purgeRomanceForMinor })
  if (result.kind === 'NOT_FOUND') return createApiError('USER_NOT_FOUND')
  if (result.kind === 'UNDER_MINIMUM') return createApiError('AGE_BELOW_MINIMUM', { params: { minAge: MIN_PLATFORM_AGE } })
  return createApiResponse({ id, ageBand: result.band, isMinor: result.band === 'MINOR', changed: result.changed })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'admin:birthdate' } })
