import { NextRequest, NextResponse } from 'next/server'
import { validateQuery } from '@/lib/api/handler'
import { checkInviteCode } from '@/lib/invites/invites'
import { prisma } from '@/lib/prisma'
import { enforceRateLimit } from '@/lib/rate-limiter'
import { querySchema } from './schema'

export async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, { windowMs: 60_000, maxRequests: 10, keyPrefix: 'invites:check' })
  if (limited) return limited
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const valid = await checkInviteCode(prisma, query.data.code)
  return NextResponse.json({ valid }, { headers: { 'Cache-Control': 'no-store' } })
}
