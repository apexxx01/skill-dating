import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'
import { recordActivity } from '@/lib/activity'
import { emit, transactWithEvents } from '@/lib/events'
import { hackathonPaysRewards } from '@/lib/squads/membership'

const resultsSchema = z.object({
  results: z.array(z.object({
    hackathonTeamId: z.string().max(64).min(1),
    rank: z.number().min(1),
    score: z.number().optional(),
  })).min(1).max(500),
})

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  if (user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
    return createApiError('FORBIDDEN')
  }

  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })
  }

  const hackathon = await prisma.hackathon.findUnique({ where: { id } })
  if (!hackathon) {
    return createApiError('HACKATHON_NOT_FOUND')
  }

  // Results are final placements - only meaningful (and only awarded) once
  // the hackathon has actually ended, so a mid-competition rank can't
  // accidentally hand out win XP/achievements before judging is done.
  if (hackathon.status !== 'ENDED') {
    return createApiError('HACKATHON_NOT_ENDED')
  }

  const bodyResult = await validateBody(resultsSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const hackathonTeamIds = bodyResult.data.results.map(r => r.hackathonTeamId)
  const hackathonTeams = await prisma.hackathonTeam.findMany({
    where: { id: { in: hackathonTeamIds }, hackathonId: id },
    include: { members: true, team: { select: { name: true, slug: true } } }
  })

  if (hackathonTeams.length !== hackathonTeamIds.length) {
    return createApiError('HACKATHON_TEAM_MISMATCH')
  }

  const teamById = new Map(hackathonTeams.map(t => [t.id, t]))

  // Each team's rank/score write, and - for the winner - every member's XP,
  // activity, and achievement grant, commit together in one transaction so
  // a partial failure can't leave some winners rewarded and others not.
  const { value: updated, scope } = await transactWithEvents(prisma, async (tx) => {
    // When the results first came in: the peer-review window opens then (docs/SQUADS.md, "Reliability").
    if (!hackathon.resultsAt) await tx.hackathon.update({ where: { id }, data: { resultsAt: new Date() } })
    const rows = []
    for (const entry of bodyResult.data.results) {
      const hackathonTeam = teamById.get(entry.hackathonTeamId)!

      const wasAlreadyWinner = hackathonTeam.rank === 1

      const row = await tx.hackathonTeam.update({
        where: { id: entry.hackathonTeamId },
        data: { rank: entry.rank, score: entry.score }
      })
      rows.push(row)

      // The win must fire exactly once per team, ever - not once per PATCH
      // call that happens to set rank 1. The rewards engine already pays each
      // member once per hackathon, but the activity entry and notification
      // have no such guard (they're append-only), so re-recording results for
      // a team that was already rank 1 must not re-run this block.
      if (entry.rank === 1 && !wasAlreadyWinner) {
        for (const member of hackathonTeam.members) {
          await recordActivity(tx, member.userId, 'HACKATHON_WON', `Won "${hackathon.name}"`, {
            link: `/hackathons/${hackathon.slug}`,
            metadata: { hackathonTeamId: hackathonTeam.id, teamName: hackathonTeam.team.name }
          })
          if (hackathonPaysRewards(hackathon)) await emit(tx, 'HACKATHON_WON', { userId: member.userId, hackathonId: id, hackathonName: hackathon.name, hackathonTeamId: hackathonTeam.id })

          await tx.notification.create({
            data: {
              userId: member.userId,
              type: 'ACHIEVEMENT',
              title: 'You won!',
              message: `${hackathonTeam.team.name} placed 1st in ${hackathon.name}`,
              link: `/hackathons/${hackathon.slug}`,
              metadata: { hackathonId: id, hackathonTeamId: hackathonTeam.id }
            }
          })
        }
      }
    }
    return rows
  })

  return createApiResponse({ success: true, results: updated, rewards: await scope.rewardsFor(prisma, user.id) })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'hackathons:results' } })
