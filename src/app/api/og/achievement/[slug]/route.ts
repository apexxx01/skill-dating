import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { achievementCard } from '@/lib/og/data'
import { cardRoute } from '@/lib/og/render'

// GET /api/og/achievement/{slug}?user={username}: the card of an achievement a person earned. No card for one they have not earned.
export const dynamic = 'force-dynamic'

export const GET = (request: NextRequest) =>
  cardRoute(request, () => {
    const url = new URL(request.url)
    const user = (url.searchParams.get('user') ?? '').slice(0, 64)
    return user ? achievementCard(prisma, decodeURIComponent(url.pathname.split('/').pop() ?? '').slice(0, 100), user) : Promise.resolve(null)
  })
