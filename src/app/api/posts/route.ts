import { contentRejection, recordFlag, screenText } from '@/lib/safety/screen'
import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { getCache } from '@/lib/infra/cache'
import { getJobQueue } from '@/lib/infra/jobs'
import { log } from '@/lib/log'
import { createPost, createPostSchema, getPostFor } from '@/lib/posts/posts'
import { bumpShipDayCounter } from '@/lib/posts/ship-day'
import { userPosts } from '@/lib/posts/timelines'
import { listQuery } from './schema'

// Creates a post: a SHIP (the one ship gate: it ships the project once and pays once), an UPDATE or DEVLOG (counts as a project update, with its existing XP and daily cap) or a DEMO.
// The author must be a member of the project or crew it is about; co-authors must be members too. Made on the author's Friday it carries the Ship Day tag. Creating, so it honours Idempotency-Key.
// The people who watch the project are told by a job after the post has been saved, never inside the request.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(createPostSchema)(request)
  if (body instanceof Response) return body
  const verdict = await screenText(user.id, [body.data.title, body.data.body, ...body.data.links].join('\n'), 'POST')
  if (verdict.verdict === 'REJECT') return contentRejection(verdict)

  const zone = await prisma.user.findUnique({ where: { id: user.id }, select: { timezone: true } })
  const result = await createPost(prisma, { id: user.id, timezone: zone?.timezone ?? null }, body.data)
  if (!result.ok) return createApiError(result.code, { details: result.details })

  const { post } = result
  await recordFlag(prisma, verdict, user.id, { type: 'SHIP_POST', id: post.id })
  if (post.shipDayKey) await bumpShipDayCounter(post.shipDayKey, getCache())
  if (post.projectId && post.visibility !== 'CREW') {
    // A failure to queue is logged, not shown: the post is saved and the notification is a convenience.
    await getJobQueue().enqueue('posts/notify-watchers', { postId: post.id }, { id: `watchers:${post.id}` }).catch((error) => log.warn('could not queue the watcher notifications', { error }))
  }
  const found = await getPostFor(prisma, user.id, post.id)
  return createApiResponse({ post: found?.view ?? null, shipped: result.shipped }, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'posts:create' } })

// The caller's own posts, newest first. Anyone else's are at /api/users/{id}/posts.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(listQuery)(request)
  if (query instanceof Response) return query
  const page = await userPosts(prisma, user.id, user.id, { cursor: query.data.cursor, limit: query.data.limit })
  if (page === 'INVALID_CURSOR') return createApiError('INVALID_CURSOR')
  if (!page) return createApiError('USER_NOT_FOUND')
  return createApiResponse(page)
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'posts:list' } })
