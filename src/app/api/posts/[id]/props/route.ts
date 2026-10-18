import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { giveProps, removeProps } from '@/lib/posts/props'

const postIdOf = (request: NextRequest) => new URL(request.url).pathname.split('/').slice(-2)[0] ?? ''

// Gives Props to a post: one per person per post, a second answers the same. Never your own post. The weight of a Prop comes from the giver's tier, account age and verification and is stored on the row;
// a giver the trust gate does not trust, or who has a block with the author, adds nothing to the post's score and earns the author nothing. Creating, so it honours Idempotency-Key.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const result = await giveProps(prisma, user.id, postIdOf(request))
  if (!result.ok) return createApiError(result.code)
  return createApiResponse({ propsScore: result.propsScore, propsCount: result.propsCount, yourProps: true, created: result.created }, result.created ? 201 : 200)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'posts:props' } })

// Takes your Props back. The author's score drops by the same weight; XP already paid is not clawed back. Taking back what was never given answers the same.
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const result = await removeProps(prisma, user.id, postIdOf(request))
  if (!result) return createApiError('POST_NOT_FOUND')
  return createApiResponse({ propsScore: result.propsScore, propsCount: result.propsCount, yourProps: false })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'posts:props-remove' } })
