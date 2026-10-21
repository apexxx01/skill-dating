import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'

// POST /api/mutes { userId }: hide a person from your feed, comments and lists without blocking them (they are not told, and can still interact with
// you; block for that). Idempotent: muting twice is one mute. GET: the people you muted.
const bodySchema = z.object({ userId: z.string().min(1).max(64) }).strict()

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const { userId } = body.data
  if (userId === user.id) return createApiError('CANNOT_MUTE_SELF')
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, deletedAt: true } })
  if (!target || target.deletedAt) return createApiError('USER_NOT_FOUND')
  const mute = await prisma.mute.upsert({ where: { muterId_mutedId: { muterId: user.id, mutedId: userId } }, create: { muterId: user.id, mutedId: userId }, update: {} })
  return createApiResponse({ muted: true, userId, createdAt: mute.createdAt }, 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'mutes:create' } })

export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const rows = await prisma.mute.findMany({
    where: { muterId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { createdAt: true, muted: { select: { id: true, username: true, name: true, image: true } } },
  })
  return createApiResponse({ mutes: rows.map((row) => ({ user: row.muted, createdAt: row.createdAt })) })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'mutes:list' } })
