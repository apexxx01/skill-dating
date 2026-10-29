import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { paginateOffset, withNextCursor } from '@/lib/api/pagination'
import { blockRelation } from '@/lib/blocks'
import { trackOnboardingIfComplete } from '@/lib/onboarding'
import { addUserSkillSchema, listQuerySchema } from './schema'
import { freshnessView } from '@/lib/evidence/freshness'
import { NO_PROOF, skillProofs } from '@/lib/evidence/passport'
import { evidenceFreshnessSetting } from '@/lib/settings'

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'userId' } })
  }

  if (id !== user.id && (await blockRelation(prisma, user.id, id)) === 'BLOCKED_BY_THEM') {
    return createApiError('USER_NOT_FOUND')
  }

  const query = validateQuery(listQuerySchema)(request)
  if (query instanceof Response) return query

  // The answer is a bare array, so the cursor for the next page is in the X-Next-Cursor header.
  // Ordered by level and then name, so the cursor is a position in that order.
  const result = await paginateOffset({
    cursor: query.data.cursor,
    page: 1,
    limit: query.data.limit ?? 100,
    where: { userId: id },
    find: (args) =>
      prisma.userSkill.findMany({
        ...args,
        include: {
          skill: { select: { id: true, name: true, slug: true, category: true, subcategory: true, icon: true, color: true } }
        },
        orderBy: [{ level: 'desc' }, { skill: { name: 'asc' } }, { id: 'asc' }]
      }),
    count: async () => 0,
  })
  if ('invalidCursor' in result) return createApiError('INVALID_CURSOR')

  // Each skill's proof (the strongest engine evidence behind it, while its owner's GITHUB_SYNC consent is in force) and freshness (docs/PROOF.md).
  // Display and, from Stage 1L, matching weight: neither touches XP or a level.
  const now = new Date()
  const [proofs, freshness] = await Promise.all([skillProofs(prisma, [id]), evidenceFreshnessSetting(prisma)])
  const items = result.items.map((row) => ({ ...row, proof: proofs.get(id)?.get(row.skillId) ?? NO_PROOF, freshness: freshnessView(row.lastEvidencedAt, now, freshness) }))
  return withNextCursor(createApiResponse(items), result.nextCursor)
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'user-skills:get' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'userId' } })
  }

  if (id !== user.id && user.role !== 'ADMIN') {
    return createApiError('FORBIDDEN')
  }

  const bodyResult = await validateBody(addUserSkillSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const skill = await prisma.skill.findUnique({ where: { id: bodyResult.data.skillId } })
  if (!skill) {
    return createApiError('SKILL_NOT_FOUND')
  }

  const existing = await prisma.userSkill.findUnique({
    where: { userId_skillId: { userId: id, skillId: bodyResult.data.skillId } }
  })
  if (existing) {
    return createApiError('SKILL_ALREADY_ADDED')
  }

  const userSkill = await prisma.userSkill.create({
    data: {
      userId: id,
      skillId: bodyResult.data.skillId,
      level: bodyResult.data.level,
      yearsExperience: bodyResult.data.yearsExperience || 0,
    },
    include: { skill: true }
  })

  if (id === user.id) await trackOnboardingIfComplete(prisma, id)

  return createApiResponse(userSkill, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'user-skills:add' } })