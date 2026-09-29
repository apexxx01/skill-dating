import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError, authorize } from '@/lib/api/handler'
import { z } from 'zod'
import { awardXp } from '@/lib/xp'
import { recordActivity } from '@/lib/activity'
import { grantAchievement } from '@/lib/achievements'

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(5000).optional(),
  shortDesc: z.string().max(300).optional(),
  githubUrl: z.string().url().optional().or(z.literal('')),
  demoUrl: z.string().url().optional().or(z.literal('')),
  websiteUrl: z.string().url().optional().or(z.literal('')),
  techStack: z.array(z.string().max(50)).max(20).default([]),
  lookingFor: z.array(z.string().max(50)).max(20).default([]),
  maxTeamSize: z.number().min(1).max(10).default(5),
  hackathonId: z.string().optional(),
  isPublic: z.boolean().default(true),
})

const updateProjectSchema = createProjectSchema.partial()

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(['IDEA', 'PLANNING', 'BUILDING', 'TESTING', 'SHIPPED', 'ARCHIVED']).optional(),
  search: z.string().optional(),
  techStack: z.string().optional(),
  ownerId: z.string().optional(),
})

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const status = queryResult.data.status
  const search = queryResult.data.search
  const techStack = queryResult.data.techStack
  const ownerId = queryResult.data.ownerId
  const skip = (page - 1) * limit

  // Each filter is its own AND-ed clause (rather than assigning `where.OR`
  // more than once) so the visibility rule below and the search/techStack
  // OR-groups don't stomp on each other — that collision was exactly why
  // an authenticated caller's own private/member projects never actually
  // appeared in their unscoped listing before this fix.
  const andConditions: Record<string, unknown>[] = []

  if (ownerId) {
    andConditions.push({ isPublic: true, ownerId })
  } else {
    andConditions.push({
      OR: [
        { isPublic: true },
        { ownerId: user.id },
        { members: { some: { userId: user.id } } }
      ]
    })
  }

  if (status) andConditions.push({ status })
  if (search) {
    andConditions.push({
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { shortDesc: { contains: search, mode: 'insensitive' } },
      ]
    })
  }
  if (techStack) {
    const stack = techStack.split(',').map(s => s.trim())
    andConditions.push({ techStack: { hasSome: stack } })
  }

  const where: Record<string, unknown> = { AND: andConditions }

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      skip,
      take: limit,
      orderBy: { updatedAt: 'desc' },
      include: {
        owner: { select: { id: true, name: true, username: true, image: true } },
        members: {
          select: { userId: true, role: true, user: { select: { id: true, name: true, username: true, image: true } } }
        },
        hackathon: { select: { id: true, name: true, slug: true } },
        _count: { select: { members: true, updates: true, milestones: true } }
      }
    }),
    prisma.project.count({ where })
  ])

  return createApiResponse({
    projects,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'projects:list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(createProjectSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const slug = bodyResult.data.name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const existingSlug = await prisma.project.findUnique({ where: { slug } })
  const finalSlug = existingSlug ? `${slug}-${Date.now()}` : slug

  // Membership and the project's own coordination channel form together,
  // in one transaction, at creation time — same reasoning as team
  // creation: don't leave a second step for someone to forget to wire up.
  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        ...bodyResult.data,
        slug: finalSlug,
        ownerId: user.id,
        teamSize: 1,
      },
      include: {
        owner: { select: { id: true, name: true, username: true, image: true } },
        members: { select: { userId: true, role: true } }
      }
    })

    await tx.projectMember.create({
      data: { userId: user.id, projectId: created.id, role: 'OWNER' }
    })

    await tx.conversation.create({
      data: {
        type: 'PROJECT',
        projectId: created.id,
        members: { create: { userId: user.id, role: 'OWNER' } }
      }
    })

    await awardXp(tx, user.id, 'PROJECT_CREATED', `Created project "${created.name}"`)
    await recordActivity(tx, user.id, 'PROJECT_CREATED', `Created project "${created.name}"`, {
      projectId: created.id,
      link: `/projects/${created.slug}`
    })
    await grantAchievement(tx, user.id, 'first-project')

    return created
  })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'PROJECT_CREATED', targetType: 'PROJECT', targetId: project.id, newValue: { name: project.name } }
  })

  return createApiResponse(project, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'projects:create' } })