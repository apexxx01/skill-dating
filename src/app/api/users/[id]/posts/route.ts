import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { userPosts } from '@/lib/posts/timelines'

const query = z.object({ cursor: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })

// A person's posts, newest first, including the ones they co-authored; only those the caller may see (visibility, blocks, soft delete).
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const parsed = validateQuery(query)(request)
  if (parsed instanceof Response) return parsed
  const id = new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''
  const page = await userPosts(prisma, user.id, id, { cursor: parsed.data.cursor, limit: parsed.data.limit })
  if (page === 'INVALID_CURSOR') return createApiError('INVALID_CURSOR')
  if (!page) return createApiError('USER_NOT_FOUND')
  return createApiResponse(page)
}, { cache: { maxAge: 10 }, rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'users:posts' } })
