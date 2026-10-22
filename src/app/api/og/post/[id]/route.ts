import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { postCard } from '@/lib/og/data'
import { cardRoute } from '@/lib/og/render'

// GET /api/og/post/{id}: the share card of a public post. A post that is not public, or was hidden or removed, has no card.
export const dynamic = 'force-dynamic'

export const GET = (request: NextRequest) => cardRoute(request, () => postCard(prisma, (new URL(request.url).pathname.split('/').pop() ?? '').slice(0, 64)))
