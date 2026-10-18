import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { deletePost, getPostFor, updatePost, updatePostSchema } from '@/lib/posts/posts'

const idOf = (request: NextRequest) => new URL(request.url).pathname.split('/').pop() ?? ''

// One post, if the caller may see it. Missing, deleted, hidden by a block and "not for you" (followers-only, crew-only) all answer the same, so a post cannot be found by probing.
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const found = await getPostFor(prisma, user.id, idOf(request))
  if (!found || found.post.deletedAt) return createApiError('POST_NOT_FOUND')
  return createApiResponse({ post: found.view })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'posts:get' } })

// Edits a post: title, body, links, stack tags, visibility. Author only. Each edit counts a revision and marks the post edited; what a post is about (kind, project, crew, co-authors) does not change.
export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(updatePostSchema)(request)
  if (body instanceof Response) return body
  const id = idOf(request)
  const result = await updatePost(prisma, user.id, id, body.data)
  if (!result.ok) return createApiError(result.code, { details: result.details })
  const found = await getPostFor(prisma, user.id, id)
  return createApiResponse({ post: found?.view ?? null })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'posts:edit' } })

// Soft delete: the post leaves every list at once; its Props and comments stay in the table. Author or an admin. Deleting a post that is already gone is "not found".
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const done = await deletePost(prisma, user.id, user.role, idOf(request))
  if (!done) return createApiError('POST_NOT_FOUND')
  return createApiResponse({ deleted: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'posts:delete' } })
