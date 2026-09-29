import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkOwnership } from '@/lib/api/handler'
import { z } from 'zod'

const transferSchema = z.object({
  newOwnerId: z.string().min(1),
})

// Team.ownerId is the field every ownership-gated action actually checks
// (checkOwnership -> team PATCH/DELETE, and DELETE .../members/[userId]'s
// "isOwner" branch) - it's a different thing from TeamMember.role, which
// the existing PATCH .../members/[userId] endpoint can already set to
// OWNER without ever touching Team.ownerId. That gap is exactly why the
// sole-owner self-removal block had no real way out: promoting someone via
// role alone never made them the *actual* owner by the field everything
// else checks. This endpoint is that real transfer.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('Team ID required', 400)
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  const bodyResult = await validateBody(transferSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { newOwnerId } = bodyResult.data

  const team = await prisma.team.findUnique({ where: { id } })
  if (!team) {
    return createApiError('Team not found', 404)
  }

  if (newOwnerId === team.ownerId) {
    return createApiError('That user is already the owner', 400)
  }

  const newOwnerMembership = await prisma.teamMember.findUnique({
    where: { userId_teamId: { userId: newOwnerId, teamId: id } }
  })
  if (!newOwnerMembership) {
    return createApiError('The new owner must already be a team member', 400)
  }

  // The ownerId flip, the role swap on both sides, and the notification all
  // commit atomically - a failure partway through must never leave the
  // team with a stale ownerId pointing at someone whose role no longer
  // says OWNER, or vice versa.
  await prisma.$transaction(async (tx) => {
    await tx.team.update({ where: { id }, data: { ownerId: newOwnerId } })

    await tx.teamMember.update({
      where: { userId_teamId: { userId: newOwnerId, teamId: id } },
      data: { role: 'OWNER' }
    })

    // The previous owner's own TeamMember row may not exist (edge case: an
    // ADMIN transferred it on the owner's behalf and the prior owner
    // already left) - only demote if they're still actually a member.
    const previousOwnerMembership = await tx.teamMember.findUnique({
      where: { userId_teamId: { userId: team.ownerId, teamId: id } }
    })
    if (previousOwnerMembership && previousOwnerMembership.role === 'OWNER') {
      await tx.teamMember.update({
        where: { userId_teamId: { userId: team.ownerId, teamId: id } },
        data: { role: 'ADMIN' }
      })
    }

    await tx.notification.create({
      data: {
        userId: newOwnerId,
        type: 'TEAM_INVITATION',
        title: 'You are now the team owner',
        message: `You've been made the owner of ${team.name}`,
        link: `/teams/${team.slug}`,
        metadata: { teamId: id }
      }
    })

    await tx.auditEvent.create({
      data: {
        userId: user.id,
        action: 'TEAM_OWNERSHIP_TRANSFERRED',
        targetType: 'TEAM',
        targetId: id,
        oldValue: { ownerId: team.ownerId },
        newValue: { ownerId: newOwnerId }
      }
    })
  })

  return createApiResponse({ success: true, teamId: id, newOwnerId })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'teams:transfer-ownership' } })
