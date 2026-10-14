import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'

const submitSchema = z.object({
  teamId: z.string().min(1),
})

// Submission is a team action, not an individual one - any member of the
// registered team can call this, and it moves every teammate's own
// HackathonParticipant row to SUBMITTED together, not just the caller's.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })
  }

  const hackathon = await prisma.hackathon.findUnique({ where: { id } })
  if (!hackathon) {
    return createApiError('HACKATHON_NOT_FOUND')
  }

  if (hackathon.status !== 'ACTIVE') {
    return createApiError('HACKATHON_SUBMISSIONS_CLOSED')
  }

  const bodyResult = await validateBody(submitSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { teamId } = bodyResult.data

  const hackathonTeam = await prisma.hackathonTeam.findUnique({
    where: { teamId },
    include: { members: true, team: { select: { projectId: true } } }
  })

  if (!hackathonTeam || hackathonTeam.hackathonId !== id) {
    return createApiError('TEAM_NOT_IN_HACKATHON')
  }

  const isTeamMember = hackathonTeam.members.some((m: { userId: string }) => m.userId === user.id)
  if (!isTeamMember) {
    return createApiError('FORBIDDEN')
  }

  if (!hackathonTeam.team.projectId) {
    return createApiError('TEAM_NO_PROJECT')
  }

  const updateResult = await prisma.hackathonParticipant.updateMany({
    where: { hackathonId: id, teamId, status: { not: 'SUBMITTED' } },
    data: { status: 'SUBMITTED' }
  })

  return createApiResponse({
    success: true,
    hackathonTeamId: hackathonTeam.id,
    participantsUpdated: updateResult.count
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'hackathons:submit' } })
