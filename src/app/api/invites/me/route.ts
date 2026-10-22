import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { inviteStats } from '@/lib/invites/invites'
import { appBaseUrl } from '@/lib/notify/base-url'

// The caller's own invite code (made on first use) and what it has done: how many joined, how many got started, how many the caller was paid for. docs/INVITES.md.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await inviteStats(prisma, user.id, appBaseUrl()))
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'invites:me' } })
