import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse } from '@/lib/api/handler'
import { getJobQueue } from '@/lib/infra/jobs'
import { loadMembership } from '@/lib/leaderboard-write'
import { log } from '@/lib/log'
import { privacySchema, readPrivacy, savePrivacy } from '@/lib/privacy/settings'

// Privacy settings in one place (src/lib/privacy/settings.ts): passport field visibility, leaderboards, recruiters, pausing matching, invisible mode, who
// can message me, activity. GET returns all of them; PATCH changes any subset and returns all of them. Audited.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await readPrivacy(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'users:me:privacy-get' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(privacySchema)(request)
  if (body instanceof Response) return body
  const before = await loadMembership(prisma, user.id)
  const { leaderboardChanged } = await savePrivacy(prisma, user.id, body.data)
  if (leaderboardChanged) {
    // Moving the person's leaderboard entries is a job; the nightly rebuild repairs a failure to queue it.
    await getJobQueue().enqueue('leaderboards/refresh-user', { userId: user.id, previous: before }).catch((error) => log.warn('could not queue the leaderboard refresh', { error, userId: user.id }))
  }
  return createApiResponse(await readPrivacy(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'users:me:privacy-patch' } })
