import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { squadCard } from '@/lib/og/data'
import { cardRoute } from '@/lib/og/render'

// GET /api/og/squad/{teamId}: the recap card of a squad, after its hackathon has ended. Minors and people who chose not to be found are counted, not named.
export const dynamic = 'force-dynamic'

export const GET = (request: NextRequest) => cardRoute(request, () => squadCard(prisma, (new URL(request.url).pathname.split('/').pop() ?? '').slice(0, 64)))
