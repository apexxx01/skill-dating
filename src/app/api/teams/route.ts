import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { blockedUserIds } from '@/lib/blocks'
import { cursorParam, paginate } from '@/lib/api/pagination'
import { createSlots } from '@/lib/squads/membership'
import { slotsFromLookingFor } from '@/lib/squads/roles'
import { slotInputSchema, squadRoleSchema } from '@/lib/squads/schemas'

const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(5000).optional(),
  projectId: z.string().max(64).optional(),
  hackathonId: z.string().max(64).optional(),
  maxSize: z.number().min(2).max(10).default(5),
  // The old free-text needs: turned into OTHER (or inferred) slots. `slots` is the structured form; both may be sent.
  lookingFor: z.array(z.string().max(50)).max(20).default([]),
  slots: z.array(slotInputSchema).max(9).default([]),
  // The role the creator plays on the team.
  squadRole: squadRoleSchema.optional(),
  roleLabel: z.string().trim().min(1).max(40).optional(),
  isRecruiting: z.boolean().default(true),
})

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  search: z.string().max(200).optional(),
  isRecruiting: z.coerce.boolean().optional(),
  hackathonId: z.string().max(64).optional(),
  skills: z.string().max(200).optional(),
  // Teams with an open slot for this role.
  role: squadRoleSchema.optional(),
  cursor: cursorParam,
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const search = queryResult.data.search
  const isRecruiting = queryResult.data.isRecruiting
  const hackathonId = queryResult.data.hackathonId
  const skills = queryResult.data.skills
  const role = queryResult.data.role

  // Teams owned by a user blocked in either direction are not shown.
  const hidden = await blockedUserIds(prisma, user.id)
  const where: Record<string, unknown> = hidden.length ? { ownerId: { notIn: hidden } } : {}

  if (hackathonId) where.hackathonId = hackathonId
  if (isRecruiting !== undefined) where.isRecruiting = isRecruiting
  // Dedicated skill-match filter, same ?skills=x,y comma-separated
  // convention as /api/discover - matches a team's actual lookingFor
  // values exactly, unlike `search` below which only substring-matches
  // lookingFor as one of several free-text fields.
  if (skills) {
    const skillTerms = skills.split(',').map(s => s.trim()).filter(Boolean)
    if (skillTerms.length > 0) where.lookingFor = { hasSome: skillTerms }
  }
  if (role) where.slots = { some: { role, status: 'OPEN' } }
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { lookingFor: { hasSome: search.split(',').map(s => s.trim()) } },
    ]
  }

  const result = await paginate({
    cursor: queryResult.data.cursor,
    page,
    limit,
    field: 'createdAt',
    direction: 'desc',
    where,
    find: (args) =>
      prisma.team.findMany({
        ...args,
        where: args.where as Prisma.TeamWhereInput,
        include: {
          owner: { select: { id: true, name: true, username: true, image: true } },
          members: {
            include: { user: { select: { id: true, name: true, username: true, image: true, builderRole: true } } }
          },
          project: { select: { id: true, name: true, slug: true, status: true } },
          hackathon: { select: { id: true, name: true, slug: true } },
          slots: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
          _count: { select: { members: true, applications: true } }
        }
      }),
    count: (w) => prisma.team.count({ where: w as Prisma.TeamWhereInput }),
    sortOf: (row) => row.createdAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')

  return createApiResponse({ teams: result.items, nextCursor: result.nextCursor, pagination: result.pagination })
}, { cache: { maxAge: 20 }, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'teams:list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(createTeamSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const { projectId, hackathonId, slots, lookingFor, squadRole, roleLabel, ...data } = bodyResult.data

  if (projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project || project.ownerId !== user.id) {
      return createApiError('PROJECT_NOT_OWNED')
    }
    const existingTeam = await prisma.team.findUnique({ where: { projectId } })
    if (existingTeam) {
      return createApiError('PROJECT_HAS_TEAM')
    }
  }

  if (hackathonId) {
    const participant = await prisma.hackathonParticipant.findUnique({
      where: { userId_hackathonId: { userId: user.id, hackathonId } },
      include: { hackathon: { select: { maxTeamSize: true } } }
    })
    if (!participant) {
      return createApiError('HACKATHON_REGISTRATION_REQUIRED')
    }
    // A squad never plans for more people than its hackathon allows.
    data.maxSize = Math.min(data.maxSize, participant.hackathon.maxTeamSize)
  }

  // Structured slots are places on the team, so there can be no more of them than the places beside the creator's. A legacy lookingFor list is a list
  // of skills and is taken as it is (one slot each), so an old client's request never starts failing.
  if (slots.length > data.maxSize - 1) {
    return createApiError('SLOT_LIMIT_REACHED', { params: { free: data.maxSize - 1 } })
  }
  const needs = [...slots.map((slot) => ({ ...slot, customLabel: slot.customLabel ?? null })), ...slotsFromLookingFor(lookingFor)]

  const slug = data.name.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '')
  const existingSlug = await prisma.team.findUnique({ where: { slug } })
  const finalSlug = existingSlug ? `${slug}-${Date.now()}` : slug

  // Membership and the team's own coordination channel form together, in
  // one transaction, at creation time — not two things someone has to
  // remember to wire up separately later (that's exactly how the
  // ProjectMember gap and the dead Team.conversation relation happened).
  const team = await prisma.$transaction(async (tx) => {
    const created = await tx.team.create({
      data: {
        ...data,
        slug: finalSlug,
        ownerId: user.id,
        projectId,
        hackathonId,
      },
      include: {
        owner: { select: { id: true, name: true, username: true, image: true } },
        members: { include: { user: { select: { id: true, name: true, username: true, image: true } } } }
      }
    })

    await tx.teamMember.create({
      data: { userId: user.id, teamId: created.id, role: 'OWNER', squadRole: squadRole ?? null, roleLabel: squadRole === 'OTHER' ? (roleLabel ?? null) : null }
    })
    await createSlots(tx, created.id, needs)

    await tx.conversation.create({
      data: {
        type: 'TEAM',
        teamId: created.id,
        members: { create: { userId: user.id, role: 'OWNER' } }
      }
    })

    return { ...created, lookingFor: (await tx.team.findUniqueOrThrow({ where: { id: created.id }, select: { lookingFor: true } })).lookingFor, slots: await tx.teamSlot.findMany({ where: { teamId: created.id }, orderBy: { position: 'asc' } }) }
  })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'TEAM_CREATED', targetType: 'TEAM', targetId: team.id, newValue: { name: team.name } }
  })

  return createApiResponse(team, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'teams:create' } })