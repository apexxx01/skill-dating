import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError, authorize } from '@/lib/api/handler'
import { z } from 'zod'
import { awardXp } from '@/lib/xp'

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(5000).optional(),
  shortDesc: z.string().max(300).optional(),
  githubUrl: z.string().url().optional().or(z.literal('')),
  demoUrl: z.string().url().optional().or(z.literal('')),
  websiteUrl: z.string().url().optional().or(z.literal('')),
  techStack: z.array(z.string()).default([]),
  lookingFor: z.array(z.string()).default([]),
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

  const where: Record<string, unknown> = {
    isPublic: true,
  }

  if (ownerId) {
    where.ownerId = ownerId
  } else {
    where.OR = [
      { isPublic: true },
      { ownerId: user.id },
      { members: { some: { userId: user.id } } }
    ]
  }

  if (status) where.status = status
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { shortDesc: { contains: search, mode: 'insensitive' } },
    ]
  }
  if (techStack) {
    const stack = techStack.split(',').map(s => s.trim())
    where.techStack = { hasSome: stack }
  }

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

  const project = await prisma.project.create({
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

  await prisma.projectMember.create({
    data: { userId: user.id, projectId: project.id, role: 'OWNER' }
  })

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'PROJECT_CREATED', targetType: 'PROJECT', targetId: project.id, newValue: { name: project.name } }
  })

  await awardXp(prisma, user.id, 'PROJECT_CREATED', `Created project "${project.name}"`)

  return createApiResponse(project, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'projects:create' } })