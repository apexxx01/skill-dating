import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { recordActivity } from '@/lib/activity'
import { emit, transactWithEvents } from '@/lib/events'
import { blockRelation } from '@/lib/blocks'
import { paginate } from '@/lib/api/pagination'
import { ENDORSEMENT_TYPE, MAX_EVIDENCE_PER_SKILL, endorsementSummaries, lockKey } from '@/lib/skill-evidence'
import { createEvidenceSchema, querySchema } from './schema'

const skillSelect = { id: true, name: true, slug: true, category: true } as const

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const queryResult = validateQuery(querySchema)(request)
  if (queryResult instanceof Response) return queryResult

  const page = queryResult.data.page ?? 1
  const limit = queryResult.data.limit ?? 20
  const { userId, skillId } = queryResult.data
  const ownerId = userId ?? user.id

  // Same rule as the profile itself: someone who has blocked the viewer looks
  // like an account that does not exist.
  if (ownerId !== user.id && (await blockRelation(prisma, user.id, ownerId)) === 'BLOCKED_BY_THEM') {
    return createApiError('USER_NOT_FOUND')
  }
  if (ownerId !== user.id) {
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } })
    if (!owner) return createApiError('USER_NOT_FOUND')
  }

  const where = {
    userId: ownerId,
    type: { not: ENDORSEMENT_TYPE },
    ...(skillId ? { skillId } : {}),
  }

  const result = await paginate({
    cursor: queryResult.data.cursor,
    page,
    limit,
    field: 'createdAt',
    direction: 'desc',
    where,
    find: (args) =>
      prisma.skillEvidence.findMany({
        ...args,
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
    count: (w) => prisma.skillEvidence.count({ where: w }),
    sortOf: (row) => row.createdAt,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')
  const rows = result.items

  const summaries = await endorsementSummaries(prisma, rows.map((r) => r.id), user.id)

  return createApiResponse({
    evidence: rows.map((row) => ({
      ...row,
      endorsementCount: summaries.get(row.id)?.count ?? 0,
      endorsedByMe: summaries.get(row.id)?.byViewer ?? false,
    })),
    nextCursor: result.nextCursor,
    pagination: result.pagination,
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'evidence:list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const bodyResult = await validateBody(createEvidenceSchema)(request)
  if (bodyResult instanceof Response) return bodyResult
  const { skillId, type, title, url, description } = bodyResult.data

  const { value: result, scope } = await transactWithEvents(prisma, async (tx) => {
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
    await emit(tx, 'EVIDENCE_ADDED', { userId: user.id, evidenceId: created.id, skillId })

    return { outcome: 'created' as const, created }
  })

  if (result.outcome === 'not_held') {
    return createApiError('EVIDENCE_SKILL_NOT_ON_PROFILE')
  }
  if (result.outcome === 'cap') {
    return createApiError('EVIDENCE_LIMIT_REACHED', { params: { max: MAX_EVIDENCE_PER_SKILL } })
  }

  return createApiResponse({ ...result.created, endorsementCount: 0, endorsedByMe: false, rewards: await scope.rewardsFor(prisma, user.id) }, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'evidence:create' } })
