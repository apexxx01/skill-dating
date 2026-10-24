import { NextRequest, NextResponse } from 'next/server'
import { validateQuery } from '@/lib/api/handler'
import { appBaseUrl } from '@/lib/notify/base-url'
import { cardLink, type CardRef } from '@/lib/og/links'
import { prisma } from '@/lib/prisma'
import { enforceRateLimit } from '@/lib/rate-limiter'
import { querySchema } from './schema'

// GET /api/og/link?kind=passport|post|squad|achievement&id=&user=: the address of a share card with its version in it (src/lib/og/links.ts), for the page's og:image tag. Public like
// the cards, limited by address like them. `{ path: null, url: null }` when the card may not be shown, which is as much as asking for the card would tell.
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, { windowMs: 60_000, maxRequests: 60, keyPrefix: 'og:links' })
  if (limited) return limited
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  const { kind, id, user } = query.data
  const ref: CardRef | null = kind === 'achievement' ? (user ? { kind, id, user } : null) : { kind, id }
  const path = ref ? await cardLink(prisma, ref) : null
  return NextResponse.json({ path, url: path ? `${appBaseUrl()}${path}` : null }, { headers: { 'Cache-Control': 'no-store' } })
}
