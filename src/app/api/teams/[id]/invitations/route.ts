import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'

const inviteSchema = z.object({
  userId: z.string().min(1),
  message: z.string().max(1000).optional(),
})

// Team invitations reuse the TeamApplication table (invitedById set marks a
// row as owner-initiated rather than applicant-initiated) so the accept
// path - see PATCH .../applications/[applicationId] - is the exact same
// atomic membership+project+conversation transaction and maxSize guard
// already built for the applicant-initiated flow, not a second copy of it.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('Team ID required', 400)
  }

  const team = await prisma.team.findUnique({ where: { id } })
  if (!team) {
    return createApiError('Team not found', 404)
  }

  if (user.role !== 'ADMIN') {
    const membership = await prisma.teamMember.findUnique({
      where: { userId_teamId: { userId: user.id, teamId: id } }
    })
    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
      return createApiError('Forbidden', 403)
    }
  }

  const bodyResult = await validateBody(inviteSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { userId: inviteeId, message } = bodyResult.data

  const invitee = await prisma.user.findUnique({ where: { id: inviteeId }, select: { id: true } })
  if (!invitee) {
    return createApiError('User not found', 404)
  }

  const alreadyMember = await checkMembership(prisma, inviteeId, 'team', id)
  if (alreadyMember) {
    return createApiError('That user is already a member of this team', 400)
  }

  const existing = await prisma.teamApplication.findUnique({
    where: { userId_teamId: { userId: inviteeId, teamId: id } }
  })
  if (existing && existing.status === 'PENDING') {
    return createApiError(
      existing.invitedById ? 'An invitation to this user is already pending' : 'This user already has a pending application to this team',
      409
    )
  }

  // A prior resolved row (REJECTED/DECLINED/WITHDRAWN) for this pairing is
  // reused rather than fighting the [userId,teamId] unique constraint.
  const invitation = existing
    ? await prisma.teamApplication.update({
        where: { id: existing.id },
        data: { status: 'PENDING', message, invitedById: user.id },
        include: { team: { select: { id: true, name: true, slug: true } } }
      })
    : await prisma.teamApplication.create({
        data: { userId: inviteeId, teamId: id, message, invitedById: user.id },
        include: { team: { select: { id: true, name: true, slug: true } } }
      })

  await prisma.notification.create({
    data: {
      userId: inviteeId,
      type: 'TEAM_INVITATION',
      title: 'Team invitation',
      message: `${user.name || user.username} invited you to join ${team.name}`,
      link: `/teams/${team.slug}`,
      metadata: { teamId: id, invitationId: invitation.id }
    }
  })

  return createApiResponse(invitation, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'teams:invite' } })
