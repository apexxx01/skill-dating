import { contentRejection, recordFlag, screenText } from '@/lib/safety/screen'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { commentSchema, createComment, listComments } from '@/lib/posts/comments'

const postIdOf = (request: NextRequest) => new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''

const listQuery = z.object({ cursor: z.string().min(1).max(64).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })

// The comments on a post, oldest first, each with up to a few replies (one level only). Authors the caller has a block with are left out.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const query = validateQuery(listQuery)(request)
  if (query instanceof Response) return query
  const page = await listComments(prisma, user.id, postIdOf(request), { after: query.data.cursor, limit: query.data.limit })
  if (!page) return createApiError('POST_NOT_FOUND')
  return createApiResponse(page)
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'posts:comments' } })

// Comments on a post, or replies to a comment (`parentId`, one level). Whoever can see the post can comment on it, unless blocked with the author. Creating, so it honours Idempotency-Key.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(commentSchema)(request)
  if (body instanceof Response) return body
  const verdict = await screenText(user.id, body.data.body, 'COMMENT')
  if (verdict.verdict === 'REJECT') return contentRejection(verdict)
  const result = await createComment(prisma, user.id, postIdOf(request), body.data)
  if (!result.ok) return createApiError(result.code, { params: result.params })
  const { comment } = result
  await recordFlag(prisma, verdict, user.id, { type: 'COMMENT', id: comment.id })
  return createApiResponse({ comment: { id: comment.id, postId: comment.postId, parentId: comment.parentId, authorId: comment.authorId, body: comment.body, createdAt: comment.createdAt.toISOString() } }, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'posts:comment-create' } })
