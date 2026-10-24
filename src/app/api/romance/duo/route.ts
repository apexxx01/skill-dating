import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { dissolveDuo, loadDuo, requestDuo } from '@/lib/romance/duo'
import { requestDuoSchema } from './schema'

// The caller's Duo: a page two people of a romance match share by consent, with their joint projects and a combined heatmap. It is for the two of them only.
//   GET     `{ duo }`: null, or `{ id, status (PENDING|ACTIVE), requestedByMe, partner, shared }`; `shared` is set only while ACTIVE.
//   POST    `{ matchId }`: asks the other person of that match, or accepts when they have already asked. `{ id, status }`. `409 DUO_BUSY` if either is in another Duo.
//   DELETE  dissolves it (or declines/cancels a pending one), at once, for both. `{ dissolved }`.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse({ duo: await loadDuo(prisma, user.id) })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'romance:duo-get' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(requestDuoSchema)(request)
  if (body instanceof Response) return body
  const result = await requestDuo(prisma, user.id, body.data.matchId)
  if (result.kind === 'NOT_FOUND') return createApiError('MATCH_NOT_FOUND')
  if (result.kind === 'BUSY') return createApiError('DUO_BUSY')
  return createApiResponse({ id: result.id, status: result.status })
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'romance:duo-request' } })

export const DELETE = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await dissolveDuo(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'romance:duo-dissolve' } })
