import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { emit, transactWithEvents } from '@/lib/events'
import { blockGuard } from '@/lib/blocks'
import { track } from '@/lib/infra/analytics'
import { addMember, checkJoin } from '@/lib/squads/membership'
import { reviewSchema } from './schema'

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const teamId = url.pathname.split('/').slice(-3)[0]
  const applicationId = url.pathname.split('/').pop()

  if (!teamId || !applicationId) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId, applicationId' } })
  }

  const bodyResult = await validateBody(reviewSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  // WITHDRAWN is the applicant closing their own application - a completely
  // different actor and authorization path from ACCEPTED/REJECTED (which is
  // the team reviewing someone else's application), so it's checked first
  // and returns early rather than falling into the owner/admin gate below.
  if (bodyResult.data.status === 'WITHDRAWN') {
    const updateResult = await prisma.teamApplication.updateMany({
      where: { id: applicationId, teamId, userId: user.id, status: 'PENDING' },
      data: { status: 'WITHDRAWN' }
    })

    if (updateResult.count === 0) {
      // Either it doesn't exist, isn't this caller's application, or isn't
      // PENDING anymore - don't distinguish "not yours" from "not found" in
      // the error, so this can't be used to probe for other users' application IDs.
      return createApiError('APPLICATION_NOT_PENDING')
    }

    return createApiResponse({ status: 'WITHDRAWN', applicationId })
  }

  // Real authorization: two different actors depending on which direction
  // this row represents. A self-initiated application (invitedById null) is
  // reviewed by a team OWNER/ADMIN, same as always. An owner-sent invitation
  // (invitedById set) is instead responded to by the invitee themselves -
  // they're not a team member yet, so the membership check below would
  // always fail for them; it's the invitedById+userId match that authorizes
  // them here. Platform ADMIN can always do either.
  if (user.role !== 'ADMIN') {
    const target = await prisma.teamApplication.findUnique({
      where: { id: applicationId },
      select: { userId: true, invitedById: true }
    })
    const isInviteeResponding = !!target?.invitedById && target.userId === user.id

    if (!isInviteeResponding) {
      const membership = await prisma.teamMember.findUnique({
        where: { userId_teamId: { userId: user.id, teamId } }
      })
      if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
        return createApiError('FORBIDDEN')
      }
    }
  }

  // Accepting brings two people into the same team, so it is refused while
  // either has blocked the other. For an invitation the counterpart is the
  // inviter; for an application it is the applicant.
  if (bodyResult.data.status === 'ACCEPTED') {
    const pending = await prisma.teamApplication.findUnique({
      where: { id: applicationId },
      select: { userId: true, invitedById: true, teamId: true },
    })
    if (pending && pending.teamId === teamId) {
      const counterpart = pending.invitedById && pending.userId === user.id ? pending.invitedById : pending.userId
      const blocked = await blockGuard(prisma, user.id, counterpart)
      if (blocked) return blocked
    }
  }

  const { value: result, scope } = await transactWithEvents(prisma, async (tx) => {
    const application = await tx.teamApplication.findUnique({
      where: { id: applicationId },
      include: { team: true }
    })

    if (!application || application.teamId !== teamId) {
      return { outcome: 'not_found' as const }
    }

    if (bodyResult.data.status === 'ACCEPTED') {
      // An invitation nobody answered within its 48 hours cannot be accepted any more; it is marked so (and that much commits).
      if (application.status === 'PENDING' && application.invitedById && application.expiresAt && application.expiresAt.getTime() <= Date.now()) {
        await tx.teamApplication.updateMany({ where: { id: applicationId, status: 'PENDING' }, data: { status: 'EXPIRED' } })
        return { outcome: 'expired' as const }
      }

      // The race-safe join check every path into a team shares (src/lib/squads/membership.ts): it locks the team row (and the project's, and the
      // slot's) before counting, so two concurrent accepts for the last place cannot both see a free one; it applies the hackathon's maxTeamSize and
      // the submission-deadline lock, and keeps a person to one squad per hackathon.
      const refusal = await checkJoin(tx, application.team, application.userId, { slotId: application.slotId })
      if (refusal) return { outcome: refusal }
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
      // Team, project and conversation membership, the slot it fills and the hackathon registration form together, in this transaction
      // (src/lib/squads/membership.ts addMember).
      await addMember(tx, application.team, application.userId, { slotId: application.slotId })
      // The other side of the acceptance: who sent the invitation the applicant just accepted, or the reviewer who accepted the application.
      const counterpartyId = application.invitedById && application.userId === user.id ? application.invitedById : user.id
      await emit(tx, 'TEAM_APPLICATION_ACCEPTED', { userId: application.userId, teamId, applicationId, counterpartyId })
    }

    return { outcome: 'reviewed' as const, application }
  })

  if (result.outcome === 'not_found') {
    return createApiError('APPLICATION_NOT_FOUND')
  }
  if (result.outcome === 'already_reviewed') {
    return createApiError('APPLICATION_ALREADY_REVIEWED')
  }
  if (result.outcome === 'team_full') {
    return createApiError('TEAM_FULL')
  }
  if (result.outcome === 'project_full') {
    return createApiError('TEAM_PROJECT_FULL')
  }
  if (result.outcome === 'expired') {
    return createApiError('INVITATION_EXPIRED')
  }
  if (result.outcome === 'team_locked') {
    return createApiError('TEAM_LOCKED')
  }
  if (result.outcome === 'already_in_squad') {
    return createApiError('ALREADY_IN_HACKATHON_TEAM')
  }
  if (result.outcome === 'slot_not_open') {
    return createApiError('SLOT_NOT_OPEN')
  }
  if (result.outcome !== 'reviewed') {
    return createApiError('TEAM_FULL')
  }

  const { application } = result
  if (bodyResult.data.status === 'ACCEPTED' && application.proposalId) {
    await track(application.userId, 'squad_proposal_accepted', { hackathonId: application.team.hackathonId, kind: 'BUILDER' })
  }

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

  // The caller's own rewards: non-empty when they accepted an invitation to themselves. The applicant
  // whose application was accepted is told by a notification.
  return createApiResponse({ status: bodyResult.data.status, applicationId: application.id, rewards: await scope.rewardsFor(prisma, user.id) })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:review' } })
