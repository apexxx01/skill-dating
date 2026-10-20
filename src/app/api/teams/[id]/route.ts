import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, authorize, checkOwnership, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'
import { replaceOpenSlotsFromLookingFor } from '@/lib/squads/membership'
import { canonicalTracks, tracksOf, unknownTracks } from '@/lib/squads/tracks'

const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  maxSize: z.number().min(2).max(10).optional(),
  lookingFor: z.array(z.string().max(50)).max(20).optional(),
  isRecruiting: z.boolean().optional(),
  // The hackathon tracks the squad goes for (by name, as the hackathon has them); the squad builder's template follows them.
  targetTracks: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  }

  const team = await prisma.team.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true, username: true, image: true, headline: true } },
      members: {
        include: { user: { select: { id: true, name: true, username: true, image: true, headline: true, builderRole: true } } }
      },
      project: { select: { id: true, name: true, slug: true, status: true } },
      hackathon: { select: { id: true, name: true, slug: true, startDate: true, endDate: true, minTeamSize: true, maxTeamSize: true, submissionDeadline: true } },
      slots: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
      applications: {
        include: { user: { select: { id: true, name: true, username: true, image: true, headline: true, builderRole: true, skills: { include: { skill: true } } } } },
        orderBy: { createdAt: 'desc' }
      },
      _count: { select: { members: true, applications: true } }
    }
  })

  if (!team) {
    return createApiError('TEAM_NOT_FOUND')
  }

  const isOwner = team.ownerId === user.id
  const isMember = team.members.some((m: { userId: string }) => m.userId === user.id)
  const canView = isOwner || isMember

  if (!canView) {
    return createApiError('FORBIDDEN')
  }

  return createApiResponse({ ...team, isOwner, isMember })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'teams:get' } })

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('FORBIDDEN')
  }

  const bodyResult = await validateBody(updateTeamSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { lookingFor, ...changes } = bodyResult.data

  const current = await prisma.team.findUnique({
    where: { id },
    select: { hackathon: { select: { maxTeamSize: true, tracks: true } }, _count: { select: { members: true } } }
  })
  if (!current) {
    return createApiError('TEAM_NOT_FOUND')
  }
  if (changes.targetTracks !== undefined) {
    if (!current.hackathon) return createApiError('NOT_A_HACKATHON_TEAM')
    const tracks = tracksOf(current.hackathon.tracks)
    const unknown = unknownTracks(tracks, changes.targetTracks)
    if (unknown.length > 0) return createApiError('TRACK_NOT_FOUND', { params: { tracks: unknown.join(', ') } })
    changes.targetTracks = canonicalTracks(tracks, changes.targetTracks)
  }
  if (changes.maxSize !== undefined) {
    // Never below the members it has, never above what its hackathon allows.
    if (current.hackathon && changes.maxSize > current.hackathon.maxTeamSize) {
      return createApiError('HACKATHON_TEAM_TOO_LARGE', { params: { max: current.hackathon.maxTeamSize } })
    }
    if (changes.maxSize < current._count.members) {
      return createApiError('VALIDATION_FAILED', { details: { maxSize: [`The team already has ${current._count.members} members`] } })
    }
  }

  // lookingFor is derived from the open slots now: an old client that writes it replaces the open slots with one per entry.
  const team = await prisma.$transaction(async (tx) => {
    if (lookingFor) await replaceOpenSlotsFromLookingFor(tx, id, lookingFor)
    return tx.team.update({
      where: { id },
      data: changes,
      include: {
        owner: { select: { id: true, name: true, username: true, image: true } },
        members: { include: { user: { select: { id: true, name: true, username: true, image: true } } } },
        slots: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }
      }
    })
  })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'TEAM_UPDATED', targetType: 'TEAM', targetId: id, newValue: bodyResult.data }
  })

  return createApiResponse(team)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:update' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('FORBIDDEN')
  }

  await prisma.team.delete({ where: { id } })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'TEAM_DELETED', targetType: 'TEAM', targetId: id }
  })

  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'teams:delete' } })