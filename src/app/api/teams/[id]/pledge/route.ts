import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { isTeamMember } from '@/lib/squads/access'
import { pledgeSchema } from '@/lib/squads/peer-review'

// PUT /api/teams/{id}/pledge: the caller's commitment pledge for their squad's hackathon (how they attend, the hours they have, the dates), made or
// changed until the hackathon starts. Squad strength flags members who have not made one.
const DAY_MS = 24 * 60 * 60 * 1000

export const PUT = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  const team = await prisma.team.findUnique({ where: { id }, select: { hackathon: { select: { id: true, startDate: true, endDate: true } } } })
  if (!team) return createApiError('TEAM_NOT_FOUND')
  if (!(await isTeamMember(prisma, user, id))) return createApiError('FORBIDDEN')
  if (!team.hackathon) return createApiError('NOT_A_HACKATHON_TEAM')
  const body = await validateBody(pledgeSchema)(request)
  if (body instanceof Response) return body

  const { hackathon } = team
  const now = new Date()
  if (now.getTime() >= hackathon.startDate.getTime()) return createApiError('PLEDGE_CLOSED')
  const from = new Date(`${body.data.availableFrom}T00:00:00Z`)
  const until = new Date(`${body.data.availableUntil}T00:00:00Z`)
  // A day of slack either side, for time zones.
  if (from.getTime() < hackathon.startDate.getTime() - 2 * DAY_MS || until.getTime() > hackathon.endDate.getTime() + DAY_MS) return createApiError('PLEDGE_DATES_OUTSIDE')

  const data = { teamId: id, attendance: body.data.attendance, hoursAvailable: body.data.hoursAvailable, availableFrom: from, availableUntil: until, confirmedAt: now }
  const pledge = await prisma.commitmentPledge.upsert({
    where: { hackathonId_userId: { hackathonId: hackathon.id, userId: user.id } },
    create: { hackathonId: hackathon.id, userId: user.id, ...data },
    update: data,
  })
  return createApiResponse({
    hackathonId: pledge.hackathonId,
    teamId: pledge.teamId,
    attendance: pledge.attendance,
    hoursAvailable: pledge.hoursAvailable,
    availableFrom: body.data.availableFrom,
    availableUntil: body.data.availableUntil,
    confirmedAt: pledge.confirmedAt,
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:pledge' } })
