import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { passportCard } from '@/lib/og/data'
import { cardRoute } from '@/lib/og/render'

// GET /api/og/passport/{username}: the share card (1200 by 630 PNG) of a passport. Public by design, so it shows only what a person has not kept to themselves
// (src/lib/og/data.ts). Cached for a day, with an ETag.
export const dynamic = 'force-dynamic'

export const GET = (request: NextRequest) => cardRoute(request, () => passportCard(prisma, decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '').slice(0, 64)))
