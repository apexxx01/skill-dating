import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { deleteComment, editComment, editCommentSchema } from '@/lib/posts/comments'

const idOf = (request: NextRequest) => new URL(request.url).pathname.split('/').pop() ?? ''

// Edits your comment, for 15 minutes after it was posted. Somebody else's comment is "not found".
export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(editCommentSchema)(request)
  if (body instanceof Response) return body
  const result = await editComment(prisma, user.id, idOf(request), body.data.body)
  if (!result.ok) return createApiError(result.code, { params: result.params })
  const { comment } = result
  return createApiResponse({ comment: { id: comment.id, postId: comment.postId, parentId: comment.parentId, body: comment.body, editedAt: comment.editedAt?.toISOString() ?? null } })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'comments:edit' } })

// Soft delete, by its author or an admin. The replies under it stay.
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const done = await deleteComment(prisma, user.id, user.role, idOf(request))
  if (!done) return createApiError('COMMENT_NOT_FOUND')
  return createApiResponse({ deleted: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'comments:delete' } })
