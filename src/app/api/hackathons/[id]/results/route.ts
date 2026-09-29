import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'
import { awardXp } from '@/lib/xp'
import { recordActivity } from '@/lib/activity'
import { grantAchievement } from '@/lib/achievements'

const resultsSchema = z.object({
  results: z.array(z.object({
    hackathonTeamId: z.string().min(1),
    rank: z.number().min(1),
    score: z.number().optional(),
  })).min(1),
})

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  if (user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
    return createApiError('Forbidden', 403)
  }

  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('Hackathon ID required', 400)
  }

  const hackathon = await prisma.hackathon.findUnique({ where: { id } })
  if (!hackathon) {
    return createApiError('Hackathon not found', 404)
  }

  // Results are final placements - only meaningful (and only awarded) once
  // the hackathon has actually ended, so a mid-competition rank can't
  // accidentally hand out win XP/achievements before judging is done.
  if (hackathon.status !== 'ENDED') {
    return createApiError('Results can only be recorded once the hackathon has ENDED', 400)
  }

  const bodyResult = await validateBody(resultsSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const hackathonTeamIds = bodyResult.data.results.map(r => r.hackathonTeamId)
  const hackathonTeams = await prisma.hackathonTeam.findMany({
    where: { id: { in: hackathonTeamIds }, hackathonId: id },
    include: { members: true, team: { select: { name: true, slug: true } } }
  })

  if (hackathonTeams.length !== hackathonTeamIds.length) {
    return createApiError('One or more hackathonTeamId does not belong to this hackathon', 400)
  }

  const teamById = new Map(hackathonTeams.map(t => [t.id, t]))

  // Each team's rank/score write, and - for the winner - every member's XP,
  // activity, and achievement grant, commit together in one transaction so
  // a partial failure can't leave some winners rewarded and others not.
  const updated = await prisma.$transaction(async (tx) => {
    const rows = []
    for (const entry of bodyResult.data.results) {
      const hackathonTeam = teamById.get(entry.hackathonTeamId)!

      const wasAlreadyWinner = hackathonTeam.rank === 1

      const row = await tx.hackathonTeam.update({
        where: { id: entry.hackathonTeamId },
        data: { rank: entry.rank, score: entry.score }
      })
      rows.push(row)

      // Win XP/activity must fire exactly once per team, ever - not once
      // per PATCH call that happens to set rank 1. grantAchievement's own
      // idempotency already covers the achievement grant, but XPEvent and
      // Activity have no such guard by default (they're append-only logs,
      // not a users-earned-this-once table), so re-recording results for a
      // team that was already rank 1 must not re-run the reward block.
      if (entry.rank === 1 && !wasAlreadyWinner) {
        for (const member of hackathonTeam.members) {
          await awardXp(tx, member.userId, 'HACKATHON_WIN', `Won "${hackathon.name}" with ${hackathonTeam.team.name}`)
          await recordActivity(tx, member.userId, 'HACKATHON_WON', `Won "${hackathon.name}"`, {
            link: `/hackathons/${hackathon.slug}`,
            metadata: { hackathonTeamId: hackathonTeam.id, teamName: hackathonTeam.team.name }
          })
          await grantAchievement(tx, member.userId, 'hackathon-winner')

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

  return createApiResponse({ success: true, results: updated })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'hackathons:results' } })
