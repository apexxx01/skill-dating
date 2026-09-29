import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkOwnership, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'

const updateMemberSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
})

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-3)[0]
  const memberId = url.pathname.split('/').pop()

  if (!id || !memberId) {
    return createApiError('Team ID and Member ID required', 400)
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  const bodyResult = await validateBody(updateMemberSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const member = await prisma.teamMember.findUnique({
    where: { userId_teamId: { userId: memberId, teamId: id } }
  })

  if (!member) {
    return createApiError('Member not found', 404)
  }

  if (bodyResult.data.role === 'OWNER' && member.userId !== user.id) {
    await prisma.teamMember.update({
      where: { userId_teamId: { userId: user.id, teamId: id } },
      data: { role: 'ADMIN' }
    })
  }

  const updated = await prisma.teamMember.update({
    where: { userId_teamId: { userId: memberId, teamId: id } },
    data: { role: bodyResult.data.role }
  })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'TEAM_MEMBER_ROLE_CHANGED', targetType: 'TEAM', targetId: id, newValue: { memberId, role: bodyResult.data.role } }
  })

  return createApiResponse(updated)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:member-update' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-3)[0]
  const memberId = url.pathname.split('/').pop()

  if (!id || !memberId) {
    return createApiError('Team ID and Member ID required', 400)
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  const isSelf = memberId === user.id

  if (!isOwner && !isSelf && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  const member = await prisma.teamMember.findUnique({
    where: { userId_teamId: { userId: memberId, teamId: id } }
  })

  if (!member) {
    return createApiError('Member not found', 404)
  }

  if (member.role === 'OWNER' && !isOwner) {
    return createApiError('Cannot remove team owner', 403)
  }

  if (isSelf && member.role === 'OWNER') {
    const ownerCount = await prisma.teamMember.count({
      where: { teamId: id, role: 'OWNER' }
    })

    if (ownerCount === 1) {
      return createApiError("Cannot leave — you're the sole owner. Promote another member or delete the team first.", 400)
    }
  }

  await prisma.teamMember.delete({
    where: { userId_teamId: { userId: memberId, teamId: id } }
  })

  if (isOwner && memberId !== user.id) {
    await prisma.notification.create({
      data: {
        userId: memberId,
        type: 'TEAM_INVITATION',
        title: 'Removed from team',
        message: `You were removed from the team`,
        metadata: { teamId: id }
      }
    })
  }

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'TEAM_MEMBER_REMOVED', targetType: 'TEAM', targetId: id, newValue: { memberId } }
  })

  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:member-remove' } })