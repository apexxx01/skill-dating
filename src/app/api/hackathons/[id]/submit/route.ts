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
    return createApiError('Hackathon ID required', 400)
  }

  const hackathon = await prisma.hackathon.findUnique({ where: { id } })
  if (!hackathon) {
    return createApiError('Hackathon not found', 404)
  }

  if (hackathon.status !== 'ACTIVE') {
    return createApiError('Submissions are only open while the hackathon is active', 400)
  }

  const bodyResult = await validateBody(submitSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { teamId } = bodyResult.data

  const hackathonTeam = await prisma.hackathonTeam.findUnique({
    where: { teamId },
    include: { members: true, team: { select: { projectId: true } } }
  })

  if (!hackathonTeam || hackathonTeam.hackathonId !== id) {
    return createApiError('This team is not registered for this hackathon', 404)
  }

  const isTeamMember = hackathonTeam.members.some((m: { userId: string }) => m.userId === user.id)
  if (!isTeamMember) {
    return createApiError('Forbidden', 403)
  }

  if (!hackathonTeam.team.projectId) {
    return createApiError('This team has no linked project to submit', 400)
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
