import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkMembership } from '@/lib/api/handler'
import { blockGuard } from '@/lib/blocks'
import { hackathonLimits, isLocked } from '@/lib/squads/membership'
import { INVITATION_TTL_MS } from '@/lib/squads/lifecycle'
import { inviteSchema } from './schema'

// Team invitations reuse the TeamApplication table (invitedById set marks a
// row as owner-initiated rather than applicant-initiated) so the accept
// path - see PATCH .../applications/[applicationId] - is the exact same
// atomic membership+project+conversation transaction and maxSize guard
// already built for the applicant-initiated flow, not a second copy of it.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  }

  const team = await prisma.team.findUnique({ where: { id } })
  if (!team) {
    return createApiError('TEAM_NOT_FOUND')
  }

  if (user.role !== 'ADMIN') {
    const membership = await prisma.teamMember.findUnique({
      where: { userId_teamId: { userId: user.id, teamId: id } }
    })
    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
      return createApiError('FORBIDDEN')
    }
  }

  const bodyResult = await validateBody(inviteSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { userId: inviteeId, message, slotId } = bodyResult.data

  if (isLocked(await hackathonLimits(prisma, team.hackathonId), new Date())) {
    return createApiError('TEAM_LOCKED')
  }
  if (slotId) {
    const slot = await prisma.teamSlot.findUnique({ where: { id: slotId }, select: { teamId: true, status: true } })
    if (!slot || slot.teamId !== id) return createApiError('SLOT_NOT_FOUND')
    if (slot.status !== 'OPEN') return createApiError('SLOT_NOT_OPEN')
  }

  const invitee = await prisma.user.findUnique({ where: { id: inviteeId }, select: { id: true } })
  if (!invitee) {
    return createApiError('USER_NOT_FOUND')
  }

  const blocked = await blockGuard(prisma, user.id, inviteeId)
  if (blocked) return blocked

  const alreadyMember = await checkMembership(prisma, inviteeId, 'team', id)
  if (alreadyMember) {
    return createApiError('ALREADY_TEAM_MEMBER')
  }

  const existing = await prisma.teamApplication.findUnique({
    where: { userId_teamId: { userId: inviteeId, teamId: id } }
  })
  if (existing && existing.status === 'PENDING') {
    return createApiError(existing.invitedById ? 'INVITATION_PENDING' : 'APPLICATION_PENDING')
  }

  // A prior resolved row (REJECTED/DECLINED/WITHDRAWN/EXPIRED) for this pairing is
  // reused rather than fighting the [userId,teamId] unique constraint. An invitation
  // is good for 48 hours (src/lib/squads/lifecycle.ts).
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)
  const invitation = existing
    ? await prisma.teamApplication.update({
        where: { id: existing.id },
        data: { status: 'PENDING', message, invitedById: user.id, slotId: slotId ?? null, expiresAt },
        include: { team: { select: { id: true, name: true, slug: true } }, slot: true }
      })
    : await prisma.teamApplication.create({
        data: { userId: inviteeId, teamId: id, message, invitedById: user.id, slotId, expiresAt },
        include: { team: { select: { id: true, name: true, slug: true } }, slot: true }
      })

  await prisma.notification.create({
    data: {
      userId: inviteeId,
      type: 'TEAM_INVITATION',
      title: 'Team invitation',
      message: `${user.name || user.username} invited you to join ${team.name}`,
      link: `/teams/${team.slug}`,
      metadata: { teamId: id, invitationId: invitation.id, slotId: slotId ?? null, expiresAt: expiresAt.toISOString() }
    }
  })

  return createApiResponse(invitation, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'teams:invite' } })
