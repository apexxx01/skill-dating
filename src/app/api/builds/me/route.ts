import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { z } from 'zod'

const buildSchema = z.object({
  title: z.string().min(1).max(150),
  description: z.string().max(5000).optional(),
  status: z.enum(['IDEA', 'PLANNING', 'BUILDING', 'TESTING', 'SHIPPED', 'ARCHIVED']).default('BUILDING'),
  progress: z.number().min(0).max(100).default(0),
  techStack: z.array(z.string()).default([]),
  teamSize: z.number().min(1).max(20).default(1),
  maxTeamSize: z.number().min(1).max(20).default(5),
  rolesNeeded: z.array(z.string()).default([]),
  hackathonId: z.string().optional(),
  githubUrl: z.string().url().optional().or(z.literal('')),
  demoUrl: z.string().url().optional().or(z.literal('')),
  isPublic: z.boolean().default(true),
})

export const PUT = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(buildSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const data = bodyResult.data

  if (data.hackathonId) {
    const hackathon = await prisma.hackathon.findUnique({ where: { id: data.hackathonId } })
    if (!hackathon) {
      return createApiError('Hackathon not found', 404)
    }
  }

  // Normalize empty-string URL fields to undefined so Prisma doesn't try to
  // store an empty string in a nullable String column.
  const githubUrl = data.githubUrl || undefined
  const demoUrl = data.demoUrl || undefined

  const existing = await prisma.currentBuild.findUnique({ where: { userId: user.id } })

  const build = await prisma.currentBuild.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      title: data.title,
      description: data.description,
      status: data.status,
      progress: data.progress,
      techStack: data.techStack,
      teamSize: data.teamSize,
      maxTeamSize: data.maxTeamSize,
      rolesNeeded: data.rolesNeeded,
      hackathonId: data.hackathonId,
      githubUrl,
      demoUrl,
      isPublic: data.isPublic,
    },
    update: {
      title: data.title,
      description: data.description,
      status: data.status,
      progress: data.progress,
      techStack: data.techStack,
      teamSize: data.teamSize,
      maxTeamSize: data.maxTeamSize,
      rolesNeeded: data.rolesNeeded,
      hackathonId: data.hackathonId,
      githubUrl,
      demoUrl,
      isPublic: data.isPublic,
    },
    include: {
      user: { select: { id: true, name: true, username: true, image: true, headline: true } },
      hackathon: { select: { id: true, name: true, slug: true } },
    },
  })

  return createApiResponse(build, existing ? 200 : 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'builds:upsert' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const existing = await prisma.currentBuild.findUnique({ where: { userId: user.id } })
  if (!existing) {
    return createApiError('No current build found', 404)
  }

  await prisma.currentBuild.delete({ where: { userId: user.id } })

  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'builds:delete' } })
