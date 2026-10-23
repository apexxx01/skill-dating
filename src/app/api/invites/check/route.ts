import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { validateQuery } from '@/lib/api/handler'
import { checkInviteCode } from '@/lib/invites/invites'
import { prisma } from '@/lib/prisma'
import { enforceRateLimit } from '@/lib/rate-limiter'

// GET /api/invites/check?code=: for the sign-up page, before the person has an account. Public, so limited by address, tightly: it answers only { valid }, the same
// no for a code that never existed and one that was switched off, ran out or expired, and never whose it is or which campus it names (docs/INVITES.md).
const querySchema = z.object({ code: z.string().trim().min(1).max(64) }).strict()

export async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, { windowMs: 60_000, maxRequests: 10, keyPrefix: 'invites:check' })
  if (limited) return limited
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const valid = await checkInviteCode(prisma, query.data.code)
  return NextResponse.json({ valid }, { headers: { 'Cache-Control': 'no-store' } })
}
