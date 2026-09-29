import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'

const reviewSchema = z.object({
  status: z.enum(['ACCEPTED', 'REJECTED']),
})

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const teamId = url.pathname.split('/').slice(-3)[0]
  const applicationId = url.pathname.split('/').pop()

  if (!teamId || !applicationId) {
    return createApiError('Team ID and Application ID required', 400)
  }

  const bodyResult = await validateBody(reviewSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  // Real authorization: only a team OWNER/ADMIN (TeamMember.role, not just
  // the single Team.ownerId) or a platform ADMIN can review. Client-supplied
  // identity is never trusted — this is looked up from the caller's own
  // session-derived user.id.
  if (user.role !== 'ADMIN') {
    const membership = await prisma.teamMember.findUnique({
      where: { userId_teamId: { userId: user.id, teamId } }
    })
    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
      return createApiError('Forbidden', 403)
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const application = await tx.teamApplication.findUnique({
      where: { id: applicationId },
      include: { team: true }
    })

    if (!application || application.teamId !== teamId) {
      return { outcome: 'not_found' as const }
    }

    if (bodyResult.data.status === 'ACCEPTED') {
      // Lock the team row before counting members: two concurrent accepts
      // for the same team (different applications, so they don't share a
      // row lock on teamApplication) would otherwise both read the same
      // "N of maxSize" count and both think there's a free slot, then both
      // write — a check-then-write race exactly like the original
      // accept-route bug, just one hop over. FOR UPDATE forces the second
      // transaction to wait for the first to commit its new TeamMember
      // before it re-counts, so the count it sees is always current.
      const [lockedTeam] = await tx.$queryRaw<{ maxSize: number }[]>`
        SELECT "maxSize" FROM "Team" WHERE id = ${teamId} FOR UPDATE
      `
      const memberCount = await tx.teamMember.count({ where: { teamId } })
      if (lockedTeam && memberCount >= lockedTeam.maxSize) {
        return { outcome: 'team_full' as const }
      }

      // A team's own maxSize (checked above) is independent of the
      // maxTeamSize its linked project separately declares - a team within
      // its own cap can still overfill a smaller project. Same lock-then-
      // count pattern, on the Project row this time, for the same race-
      // safety reason.
      if (application.team.projectId) {
        const alreadyProjectMember = await tx.projectMember.findUnique({
          where: { userId_projectId: { userId: application.userId, projectId: application.team.projectId } }
        })
        // Only a genuinely new project slot needs the capacity check - an
        // existing member being accepted onto a second team pointing at the
        // same project is a no-op upsert below, not a new row.
        if (!alreadyProjectMember) {
          const [lockedProject] = await tx.$queryRaw<{ maxTeamSize: number }[]>`
            SELECT "maxTeamSize" FROM "Project" WHERE id = ${application.team.projectId} FOR UPDATE
          `
          const projectMemberCount = await tx.projectMember.count({ where: { projectId: application.team.projectId } })
          if (lockedProject && projectMemberCount >= lockedProject.maxTeamSize) {
            return { outcome: 'project_full' as const }
          }
        }
      }
    }

    // Atomic compare-and-swap: the WHERE clause only matches a row still
    // PENDING, so two concurrent accepts on the same application race on
    // this single UPDATE — Postgres serializes them via the row lock, and
    // only the first to commit affects a row. The loser sees count: 0 and
    // reports "already reviewed" instead of double-processing.
    const updateResult = await tx.teamApplication.updateMany({
      where: { id: applicationId, teamId, status: 'PENDING' },
      data: { status: bodyResult.data.status }
    })

    if (updateResult.count === 0) {
      return { outcome: 'already_reviewed' as const }
    }

    if (bodyResult.data.status === 'ACCEPTED') {
      // Team membership and project access form together, atomically, in
      // the same transaction as the status flip — not two steps someone
      // has to remember to wire up separately (that's how this gap
      // happened the first time: TeamMember existed, ProjectMember never did).
      await tx.teamMember.upsert({
        where: { userId_teamId: { userId: application.userId, teamId } },
        create: { userId: application.userId, teamId, role: 'MEMBER' },
        update: {}
      })

      if (application.team.projectId) {
        await tx.projectMember.upsert({
          where: { userId_projectId: { userId: application.userId, projectId: application.team.projectId } },
          create: { userId: application.userId, projectId: application.team.projectId, role: 'MEMBER' },
          update: {}
        })
      }

      // Same reasoning again, one hop further: a team's Conversation is
      // created atomically with the team (see team creation), but a new
      // member accepted afterward needs to join it too, in this same
      // transaction — not a third thing to forget to wire up. A team
      // created before that fix shipped may have no Conversation yet;
      // skip rather than crash.
      const conversation = await tx.conversation.findUnique({ where: { teamId } })
      if (conversation) {
        await tx.conversationMember.upsert({
          where: { userId_conversationId: { userId: application.userId, conversationId: conversation.id } },
          create: { userId: application.userId, conversationId: conversation.id, role: 'MEMBER' },
          update: {}
        })
      }
    }

    return { outcome: 'reviewed' as const, application }
  })

  if (result.outcome === 'not_found') {
    return createApiError('Application not found', 404)
  }
  if (result.outcome === 'already_reviewed') {
    return createApiError('Application already reviewed', 400)
  }
  if (result.outcome === 'team_full') {
    return createApiError('Team is full', 400)
  }
  if (result.outcome === 'project_full') {
    return createApiError("This team's linked project is already at its max team size", 400)
  }

  const { application } = result

  await prisma.notification.create({
    data: bodyResult.data.status === 'ACCEPTED'
      ? {
          userId: application.userId,
          type: 'APPLICATION_RESPONSE',
          title: 'Application accepted',
          message: `Your application to join ${application.team.name} was accepted`,
          link: `/teams/${application.team.slug}`,
          metadata: { teamId: application.team.id }
        }
      : {
          userId: application.userId,
          type: 'APPLICATION_RESPONSE',
          title: 'Application declined',
          message: `Your application to join ${application.team.name} was declined`,
          metadata: { teamId: application.team.id }
        }
  })

  return createApiResponse({ status: bodyResult.data.status, applicationId: application.id })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:review' } })
