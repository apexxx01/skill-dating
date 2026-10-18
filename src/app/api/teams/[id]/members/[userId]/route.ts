import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkOwnership, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'
import { hackathonLimits, isLocked, removeMember } from '@/lib/squads/membership'
import { squadRoleSchema } from '@/lib/squads/schemas'

// `role` is the member's permissions (owner only); `squadRole` (+ `roleLabel` for OTHER) is what they do on the squad, which a member may declare
// for themselves and the owner for anyone.
const updateMemberSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional(),
  squadRole: squadRoleSchema.nullable().optional(),
  roleLabel: z.string().trim().min(1).max(40).nullable().optional(),
}).refine((value) => value.role !== undefined || value.squadRole !== undefined, 'Send role or squadRole')

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-3)[0]
  const memberId = url.pathname.split('/').pop()

  if (!id || !memberId) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId, memberId' } })
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  const isSelf = memberId === user.id

  const bodyResult = await validateBody(updateMemberSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  // Changing permissions is the owner's; declaring a squad role is also the member's own.
  const allowed = isOwner || user.role === 'ADMIN' || (isSelf && bodyResult.data.role === undefined)
  if (!allowed) {
    return createApiError('FORBIDDEN')
  }

  const member = await prisma.teamMember.findUnique({
    where: { userId_teamId: { userId: memberId, teamId: id } }
  })

  if (!member) {
    return createApiError('MEMBER_NOT_FOUND')
  }

  if (bodyResult.data.squadRole !== undefined && bodyResult.data.role === undefined) {
    const squadRole = bodyResult.data.squadRole
    const roleLabel = squadRole === 'OTHER' ? (bodyResult.data.roleLabel ?? member.roleLabel) : null
    if (squadRole === 'OTHER' && !roleLabel) {
      return createApiError('VALIDATION_FAILED', { details: { roleLabel: ['An OTHER role needs a roleLabel'] } })
    }
    const updated = await prisma.teamMember.update({
      where: { userId_teamId: { userId: memberId, teamId: id } },
      data: { squadRole, roleLabel }
    })
    return createApiResponse(updated)
  }

  if (bodyResult.data.role === 'OWNER' && member.userId !== user.id) {
    await prisma.teamMember.update({
      where: { userId_teamId: { userId: user.id, teamId: id } },
      data: { role: 'ADMIN' }
    })
  }

  const squadRole = bodyResult.data.squadRole
  const updated = await prisma.teamMember.update({
    where: { userId_teamId: { userId: memberId, teamId: id } },
    data: {
      role: bodyResult.data.role,
      ...(squadRole !== undefined ? { squadRole, roleLabel: squadRole === 'OTHER' ? (bodyResult.data.roleLabel ?? member.roleLabel) : null } : {})
    }
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
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId, memberId' } })
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  const isSelf = memberId === user.id

  if (!isOwner && !isSelf && user.role !== 'ADMIN') {
    return createApiError('FORBIDDEN')
  }

  const member = await prisma.teamMember.findUnique({
    where: { userId_teamId: { userId: memberId, teamId: id } }
  })

  if (!member) {
    return createApiError('MEMBER_NOT_FOUND')
  }

  if (member.role === 'OWNER' && !isOwner) {
    return createApiError('CANNOT_REMOVE_OWNER')
  }

  if (isSelf && member.role === 'OWNER') {
    const ownerCount = await prisma.teamMember.count({
      where: { teamId: id, role: 'OWNER' }
    })

    if (ownerCount === 1) {
      return createApiError('SOLE_OWNER_CANNOT_LEAVE')
    }
  }

  // No member changes once the hackathon's submission deadline has passed.
  const team = await prisma.team.findUnique({ where: { id }, select: { id: true, hackathonId: true } })
  if (!team) {
    return createApiError('TEAM_NOT_FOUND')
  }
  if (isLocked(await hackathonLimits(prisma, team.hackathonId), new Date())) {
    return createApiError('TEAM_LOCKED')
  }

  // Leaving reopens the slot the member filled and unlinks their hackathon registration (src/lib/squads/membership.ts).
  const reopened = await prisma.$transaction((tx) => removeMember(tx, team, memberId))

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

  return createApiResponse({ success: true, reopenedSlotId: reopened?.id ?? null })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:member-remove' } })