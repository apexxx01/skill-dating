import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { isTeamMember } from '@/lib/squads/access'
import { demoPostSchema, postDemo } from '@/lib/squads/space'

// POST /api/teams/{id}/demo-post ("post our demo"): a DEMO post on the Ship Feed for the squad and its project, co-authored by the other members.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  if (!(await prisma.team.findUnique({ where: { id }, select: { id: true } }))) return createApiError('TEAM_NOT_FOUND')
  if (!(await isTeamMember(prisma, user, id))) return createApiError('FORBIDDEN')
  const body = await validateBody(demoPostSchema)(request)
  if (body instanceof Response) return body

  const author = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, timezone: true } })
  const result = await postDemo(prisma, { teamId: id, author, body: body.data })
  if (!result.ok) return createApiError(result.code, result.details ? { details: result.details } : undefined)
  return createApiResponse({ post: result.post }, 201)
}, { idempotent: true, rateLimit: { windowMs: 60 * 60 * 1000, maxRequests: 10, keyPrefix: 'teams:demo-post' } })
