import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { isTeamMember } from '@/lib/squads/access'
import { voteIdea } from '@/lib/squads/space'

// POST votes for an idea, DELETE takes the vote back: one vote per member per idea, either is safe to repeat.

function idsOf(request: NextRequest) {
  const parts = new URL(request.url).pathname.split('/')
  return { teamId: parts.slice(-4)[0], ideaId: parts.slice(-2)[0] }
}

async function handle(request: NextRequest, { prisma, user }: Parameters<Parameters<typeof withAuth>[0]>[1], vote: boolean) {
  const { teamId, ideaId } = idsOf(request)
  if (!teamId || !ideaId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId, ideaId' } })
  if (!(await isTeamMember(prisma, user, teamId))) return createApiError('FORBIDDEN')
  const voteCount = await voteIdea(prisma, { teamId, ideaId, userId: user.id, vote })
  if (voteCount === null) return createApiError('IDEA_NOT_FOUND')
  return createApiResponse({ ideaId, voteCount, votedByMe: vote })
}

export const POST = withAuth((request, context) => handle(request, context, true), { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'teams:idea-vote' } })
export const DELETE = withAuth((request, context) => handle(request, context, false), { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'teams:idea-vote' } })
