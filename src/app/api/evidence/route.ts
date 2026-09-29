import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { recordActivity } from '@/lib/activity'
import { grantAchievement } from '@/lib/achievements'
import {
  ENDORSEMENT_TYPE,
  MAX_EVIDENCE_PER_SKILL,
  USER_EVIDENCE_TYPES,
  endorsementSummaries,
  isHttpUrl,
  lockKey,
} from '@/lib/skill-evidence'

// .strict(): a body that tries to set verifiedAt, metadata or any other
// server-controlled field is rejected outright instead of being silently
// dropped, so an attempt to forge verification is visible as a 400.
const createEvidenceSchema = z
  .object({
    skillId: z.string().min(1).max(64),
    type: z.enum(USER_EVIDENCE_TYPES),
    title: z.string().trim().min(1).max(200),
    url: z
      .string()
      .trim()
      .max(2048)
      .url()
      .refine(isHttpUrl, 'URL must start with http:// or https://')
      .optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .strict()

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  userId: z.string().min(1).max(64).optional(),
  skillId: z.string().min(1).max(64).optional(),
})

const skillSelect = { id: true, name: true, slug: true, category: true } as const

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const { userId, skillId } = queryResult.data
  const ownerId = userId ?? user.id
  const skip = (page - 1) * limit

  if (ownerId !== user.id) {
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } })
    if (!owner) return createApiError('User not found', 404)
  }

  const where = {
    userId: ownerId,
    type: { not: ENDORSEMENT_TYPE },
    ...(skillId ? { skillId } : {}),
  }

  const [rows, total] = await Promise.all([
    prisma.skillEvidence.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        skillId: true,
        type: true,
        title: true,
        description: true,
        url: true,
        verifiedAt: true,
        createdAt: true,
        skill: { select: skillSelect },
      },
    }),
    prisma.skillEvidence.count({ where }),
  ])

  const summaries = await endorsementSummaries(prisma, rows.map((r) => r.id), user.id)

  return createApiResponse({
    evidence: rows.map((row) => ({
      ...row,
      endorsementCount: summaries.get(row.id)?.count ?? 0,
      endorsedByMe: summaries.get(row.id)?.byViewer ?? false,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'evidence:list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(createEvidenceSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { skillId, type, title, url, description } = bodyResult.data

  const result = await prisma.$transaction(async (tx) => {
    const held = await tx.userSkill.findUnique({
      where: { userId_skillId: { userId: user.id, skillId } },
      select: { id: true },
    })
    if (!held) return { outcome: 'not_held' as const }

    // Serialise creators for this (user, skill) so parallel requests cannot
    // slip past the per-skill cap between the count and the insert.
    await lockKey(tx, `evidence-cap:${user.id}:${skillId}`)
    const existing = await tx.skillEvidence.count({
      where: { userId: user.id, skillId, type: { not: ENDORSEMENT_TYPE } },
    })
    if (existing >= MAX_EVIDENCE_PER_SKILL) return { outcome: 'cap' as const }

    const created = await tx.skillEvidence.create({
      data: { userId: user.id, skillId, type, title, url, description },
      select: {
        id: true,
        userId: true,
        skillId: true,
        type: true,
        title: true,
        description: true,
        url: true,
        verifiedAt: true,
        createdAt: true,
        skill: { select: skillSelect },
      },
    })

    await recordActivity(tx, user.id, 'SKILL_EVIDENCE_ADDED', `Added evidence "${title}"`, {
      metadata: { evidenceId: created.id, skillId },
    })
    await grantAchievement(tx, user.id, 'first-evidence')

    return { outcome: 'created' as const, created }
  })

  if (result.outcome === 'not_held') {
    return createApiError('You can only attach evidence to a skill you have added to your profile', 400)
  }
  if (result.outcome === 'cap') {
    return createApiError(`You can attach at most ${MAX_EVIDENCE_PER_SKILL} pieces of evidence to one skill`, 400)
  }

  return createApiResponse({ ...result.created, endorsementCount: 0, endorsedByMe: false }, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'evidence:create' } })
