import { NextRequest, NextResponse } from 'next/server'
import { withAuth, createApiError } from '@/lib/api/handler'
import { teamsCsv } from '@/lib/squads/organizer'

// GET /api/admin/hackathons/{id}/teams.csv: every registered team of a hackathon, one row per member, with roles, rank and what it submitted, for
// organizers (admins only for now).
export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })
  const hackathon = await prisma.hackathon.findUnique({ where: { id }, select: { slug: true } })
  if (!hackathon) return createApiError('HACKATHON_NOT_FOUND')
  const csv = await teamsCsv(prisma, id)
  return new NextResponse(csv, {
    status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${hackathon.slug}-teams.csv"`, 'Cache-Control': 'no-store' },
  })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'admin:teams-csv' } })
