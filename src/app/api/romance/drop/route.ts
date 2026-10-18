import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { loadRomanceDrop } from '@/lib/romance/drop-view'

// This week's romance drop: ONE person, chosen for the caller once a local week (from Monday 08:00 in their time zone), best fit first and last. `drop` is null
// when there is none yet, none this week, or the person left; `nextDropAt` says when the next one is made. The candidate is as much as a stranger may see:
// answers, ambition, direction, rhythm and obsessions, the professional card, and a photo PLACEHOLDER (blur hash) for each photo, never a photo and never the avatar.
// Why this person: `drop.reasons`, up to three lines.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await loadRomanceDrop(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'romance:drop-get' } })
