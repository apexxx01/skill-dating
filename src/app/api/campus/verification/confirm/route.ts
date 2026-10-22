import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { confirmVerification } from '@/lib/campus/campus'
import { refreshBoards } from '@/lib/campus/boards'

// POST /api/campus/verification/confirm { code }: the person becomes a member of the campus (its leaderboard and feed) when the code is right. Five tries, then the code is void.
const bodySchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'The six digits from the e-mail') }).strict()

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const outcome = await confirmVerification(prisma, user.id, body.data.code)
  if (!outcome.ok) return createApiError(outcome.code, outcome.code === 'CAMPUS_CODE_INVALID' ? { params: { remaining: outcome.remaining ?? 0 } } : undefined)
  await refreshBoards(user.id, outcome.previous)
  return createApiResponse({ campus: outcome.campus })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'campus:verify-confirm' } })
