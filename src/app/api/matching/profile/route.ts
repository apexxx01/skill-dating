import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { checkDatingGate, loadOwnMatchingProfile, matchingProfileSchema, profileData, referenceProblems } from '@/lib/matching/profile'

// The caller's own matching profile. GET answers `{ exists, profile, dating }` (a profile with defaults until the first save,
// and whether the dating gate is open for them and, if not, what is missing). PUT saves the whole profile.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await loadOwnMatchingProfile(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'matching:profile-get' } })

export const PUT = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(matchingProfileSchema)(request)
  if (body instanceof Response) return body
  const input = body.data

  // DATING is opt-in and gated: a verified email and a phone or GitHub, and a date of birth that makes them 18 or older.
  if (input.connectionTypes.includes('DATING')) {
    const refusal = await checkDatingGate(prisma, user.id)
    if (refusal) return createApiError(refusal.code, { details: { blockers: refusal.blockers } })
  }

  const problems = await referenceProblems(prisma, input)
  if (problems) return createApiError('VALIDATION_FAILED', { details: problems })

  const data = profileData(input)
  await prisma.matchingProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data })
  return createApiResponse(await loadOwnMatchingProfile(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'matching:profile-put' } })
