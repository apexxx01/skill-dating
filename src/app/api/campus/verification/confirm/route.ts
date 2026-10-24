import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { confirmVerification } from '@/lib/campus/campus'
import { refreshBoards } from '@/lib/campus/boards'
import { bodySchema } from './schema'

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const outcome = await confirmVerification(prisma, user.id, body.data.code)
  if (!outcome.ok) return createApiError(outcome.code, outcome.code === 'CAMPUS_CODE_INVALID' ? { params: { remaining: outcome.remaining ?? 0 } } : undefined)
  await refreshBoards(user.id, outcome.previous)
  return createApiResponse({ campus: outcome.campus })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'campus:verify-confirm' } })
