import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { loadOwnMatchingProfile, matchingProfileSchema, profileData, referenceProblems } from '@/lib/matching/profile'

// The caller's own matching profile. GET answers `{ exists, profile }` (a profile with defaults until the first save). PUT saves the whole profile. The professional
// types only: the romance mode has its own profile (/api/romance/profile) and is never a connection type here.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await loadOwnMatchingProfile(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'matching:profile-get' } })

export const PUT = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(matchingProfileSchema)(request)
  if (body instanceof Response) return body
  const input = body.data

  const problems = await referenceProblems(prisma, input)
  if (problems) return createApiError('VALIDATION_FAILED', { details: problems })

  const data = profileData(input)
  await prisma.matchingProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data })
  return createApiResponse(await loadOwnMatchingProfile(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'matching:profile-put' } })
