import { NextRequest } from 'next/server'
import { withAuth, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { projectTimeline } from '@/lib/posts/timelines'
import { query } from './schema'

// A project's posts, newest first: its ships, updates, devlogs and demos that the caller may see. A private project's timeline is for its members; for anyone else it does not exist.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const parsed = validateQuery(query)(request)
  if (parsed instanceof Response) return parsed
  const id = new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''
  const page = await projectTimeline(prisma, user.id, id, { cursor: parsed.data.cursor, limit: parsed.data.limit })
  if (page === 'INVALID_CURSOR') return createApiError('INVALID_CURSOR')
  if (!page) return createApiError('PROJECT_NOT_FOUND')
  return createApiResponse(page)
}, { cache: { maxAge: 20 }, rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'projects:timeline' } })
