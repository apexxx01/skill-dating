import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { listFollows } from '@/lib/posts/social'

const query = z.object({ cursor: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })

// The people who follow this person, newest first. People the caller has a block with are left out.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const parsed = validateQuery(query)(request)
  if (parsed instanceof Response) return parsed
  const id = new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''
  const page = await listFollows(prisma, user.id, id, 'followers', { cursor: parsed.data.cursor, limit: parsed.data.limit })
  if (page === 'INVALID_CURSOR') return createApiError('INVALID_CURSOR')
  if (!page) return createApiError('USER_NOT_FOUND')
  return createApiResponse(page)
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'users:followers' } })
