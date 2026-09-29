import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'

const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(5000).optional(),
  projectId: z.string().optional(),
  hackathonId: z.string().optional(),
  maxSize: z.number().min(2).max(10).default(5),
  lookingFor: z.array(z.string()).default([]),
  isRecruiting: z.boolean().default(true),
})

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  search: z.string().optional(),
  isRecruiting: z.coerce.boolean().optional(),
  hackathonId: z.string().optional(),
  skills: z.string().optional(),
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
  const skip = (page - 1) * limit

  const where: Record<string, unknown> = {}

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
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { lookingFor: { hasSome: search.split(',').map(s => s.trim()) } },
    ]
  }

  const [teams, total] = await Promise.all([
    prisma.team.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        owner: { select: { id: true, name: true, username: true, image: true } },
        members: {
          include: { user: { select: { id: true, name: true, username: true, image: true, builderRole: true } } }
        },
        project: { select: { id: true, name: true, slug: true, status: true } },
        hackathon: { select: { id: true, name: true, slug: true } },
        _count: { select: { members: true, applications: true } }
      }
    }),
    prisma.team.count({ where })
  ])

  return createApiResponse({
    teams,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'teams:list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(createTeamSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const { projectId, hackathonId, ...data } = bodyResult.data

  if (projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project || project.ownerId !== user.id) {
      return createApiError('Project not found or not owned by you', 404)
    }
    const existingTeam = await prisma.team.findUnique({ where: { projectId } })
    if (existingTeam) {
      return createApiError('Project already has a team', 400)
    }
  }

  if (hackathonId) {
    const participant = await prisma.hackathonParticipant.findUnique({
      where: { userId_hackathonId: { userId: user.id, hackathonId } }
    })
    if (!participant) {
      return createApiError('You must be registered for this hackathon', 400)
    }
  }

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
      data: { userId: user.id, teamId: created.id, role: 'OWNER' }
    })

    await tx.conversation.create({
      data: {
        type: 'TEAM',
        teamId: created.id,
        members: { create: { userId: user.id, role: 'OWNER' } }
      }
    })

    return created
  })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'TEAM_CREATED', targetType: 'TEAM', targetId: team.id, newValue: { name: team.name } }
  })

  return createApiResponse(team, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'teams:create' } })