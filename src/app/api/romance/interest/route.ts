import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { interestStateOf, recordInterest, removeInterest } from '@/lib/romance/interest'

// "Tell me when it opens" for the romance mode, which ships closed (docs/ROMANCE.md "Launch"). These are the only romance routes that work while it is closed. The mode's name, in
// `modeLabel` elsewhere, is not in these answers: the page that offers this says what it is.
//
//   GET     { interested, open, eligible }: whether the caller has asked, whether the mode is open for them now, and whether they may ask (an adult with a date of birth on file).
//   POST    asks to be told (idempotent: asking again refreshes the country and city the request is counted under). 403 DATING_BIRTH_DATE_REQUIRED / DATING_UNDERAGE, 409 ROMANCE_ALREADY_OPEN.
//   DELETE  withdraws the request (idempotent).
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await interestStateOf(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'romance:interest-get' } })

export const POST = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const result = await recordInterest(prisma, user.id)
  if (!result.ok) return createApiError(result.code)
  return createApiResponse(result.state)
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'romance:interest-post' } })

export const DELETE = withAuth(async (_request: NextRequest, { prisma, user }) => {
  await removeInterest(prisma, user.id)
  return createApiResponse({ ...(await interestStateOf(prisma, user.id)), interested: false })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'romance:interest-delete' } })
