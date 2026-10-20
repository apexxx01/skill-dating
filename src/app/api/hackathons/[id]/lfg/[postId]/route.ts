import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { lfgPostView, lfgUpdateSchema, normalizeStack } from '@/lib/squads/lfg'
import { lockTimeOf } from '@/lib/squads/membership'

// One post on a hackathon's looking-for-group board: its author edits it (PATCH) or takes it down (DELETE, which closes it); a platform admin may
// take any post down.

function idsOf(request: NextRequest) {
  const parts = new URL(request.url).pathname.split('/')
  return { hackathonId: parts.slice(-3)[0], postId: parts.slice(-1)[0] }
}

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const { hackathonId, postId } = idsOf(request)
  if (!hackathonId || !postId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId, postId' } })
  const body = await validateBody(lfgUpdateSchema)(request)
  if (body instanceof Response) return body

  const post = await prisma.lfgPost.findUnique({ where: { id: postId }, include: { hackathon: { select: { endDate: true, submissionDeadline: true } } } })
  const now = new Date()
  if (!post || post.hackathonId !== hackathonId || post.closedAt || post.expiresAt.getTime() <= now.getTime()) return createApiError('LFG_POST_NOT_FOUND')
  if (post.authorId !== user.id) return createApiError('FORBIDDEN')

  const { stack, roles, expiresAt, ...rest } = body.data
  if (expiresAt) {
    const at = new Date(expiresAt)
    if (at.getTime() <= now.getTime() || at.getTime() > lockTimeOf(post.hackathon).getTime()) {
      return createApiError('VALIDATION_FAILED', { details: { expiresAt: ['Must be in the future and no later than when the teams lock'] } })
    }
  }
  await prisma.lfgPost.update({
    where: { id: postId },
    data: { ...rest, ...(stack ? { stack: normalizeStack(stack) } : {}), ...(roles ? { roles: [...new Set(roles)] } : {}), ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}) },
  })
  return createApiResponse(await lfgPostView(prisma, postId, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'hackathons:lfg-update' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const { hackathonId, postId } = idsOf(request)
  if (!hackathonId || !postId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId, postId' } })
  const post = await prisma.lfgPost.findUnique({ where: { id: postId }, select: { hackathonId: true, authorId: true, closedAt: true } })
  if (!post || post.hackathonId !== hackathonId || post.closedAt) return createApiError('LFG_POST_NOT_FOUND')
  if (post.authorId !== user.id && user.role !== 'ADMIN') return createApiError('FORBIDDEN')
  await prisma.lfgPost.update({ where: { id: postId }, data: { closedAt: new Date() } })
  return createApiResponse({ closed: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'hackathons:lfg-delete' } })
