import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { proposeSquad } from '@/lib/squads/builder'
import { bodySchema } from './schema'

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })

  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body

  const result = await proposeSquad(prisma, { hackathonId: id, requesterId: user.id, ...body.data })
  if (!result.ok) return createApiError(result.code, result.params ? { params: result.params } : undefined)
  return createApiResponse({ proposal: result.proposal }, 201)
}, { rateLimit: { windowMs: 60 * 60 * 1000, maxRequests: 20, keyPrefix: 'hackathons:squad-builder' } })
