import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'
import { emit, transactWithEvents } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { hackathonPaysRewards } from '@/lib/squads/membership'

const submitSchema = z.object({
  teamId: z.string().max(64).min(1),
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
    include: { members: true, team: { select: { projectId: true, ownerId: true, _count: { select: { members: true } } } } }
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

  // A squad below the hackathon's minimum cannot submit (squads made by the builder or the pool are registered before they are full).
  if (hackathonTeam.team._count.members < hackathon.minTeamSize) {
    return createApiError('HACKATHON_TEAM_TOO_SMALL', { params: { min: hackathon.minTeamSize } })
  }

  const memberIds = hackathonTeam.members.map((m) => m.userId)
  const pays = hackathonPaysRewards(hackathon)

  // The participants' status and the squad rewards commit together. Each reward is once per hackathon, so a second submit pays nothing again.
  const { value: updateResult, scope } = await transactWithEvents(prisma, async (tx) => {
    const updated = await tx.hackathonParticipant.updateMany({
      where: { hackathonId: id, teamId, status: { not: 'SUBMITTED' } },
      data: { status: 'SUBMITTED' }
    })
    if (pays) {
      // A reunion: an earlier hackathon's squad of theirs shares two or more people (them included) with this one.
      const earlier = await tx.hackathonTeamMember.findMany({
        where: { userId: { in: memberIds }, hackathonTeam: { hackathonId: { not: id } } },
        select: { userId: true, hackathonTeamId: true },
      })
      const byTeam = new Map<string, Set<string>>()
      for (const row of earlier) byTeam.set(row.hackathonTeamId, (byTeam.get(row.hackathonTeamId) ?? new Set()).add(row.userId))
      const reunited = new Set<string>()
      for (const together of byTeam.values()) if (together.size >= 2) for (const userId of together) reunited.add(userId)

      for (const userId of [...memberIds].sort()) {
        await emit(tx, 'SQUAD_SUBMITTED', { userId, teamId, hackathonId: id, hackathonName: hackathon.name })
        if (userId !== hackathonTeam.team.ownerId) {
          await emit(tx, 'SQUAD_JOIN_CONFIRMED', { userId, ownerId: hackathonTeam.team.ownerId, teamId, hackathonId: id, hackathonName: hackathon.name })
        }
        if (reunited.has(userId)) await emit(tx, 'SQUAD_REUNITED', { userId, teamId, hackathonId: id })
      }
    }
    return updated
  })

  if (updateResult.count > 0) await track(user.id, 'squad_submitted', { hackathonId: id, size: memberIds.length })

  return createApiResponse({
    success: true,
    hackathonTeamId: hackathonTeam.id,
    participantsUpdated: updateResult.count,
    rewards: await scope.rewardsFor(prisma, user.id)
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'hackathons:submit' } })
