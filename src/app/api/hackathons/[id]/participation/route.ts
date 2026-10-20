import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { track } from '@/lib/infra/analytics'
import { squadRoleSchema } from '@/lib/squads/schemas'

// PATCH /api/hackathons/{id}/participation: the caller's place in the hackathon's solo pool (docs/SQUADS.md): looking for a team (the squad builder
// and the board draw from these people), the roles they would like to play, and whether the automatic squads two days before the registration
// deadline may place them.
const bodySchema = z
  .object({
    lookingForTeam: z.boolean(),
    preferredRoles: z.array(squadRoleSchema).max(4),
    openToAutoTeam: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field')

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })

  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body

  const participant = await prisma.hackathonParticipant.findUnique({ where: { userId_hackathonId: { userId: user.id, hackathonId: id } } })
  if (!participant) return createApiError('HACKATHON_REGISTRATION_REQUIRED')

  const data = { ...body.data, ...(body.data.preferredRoles ? { preferredRoles: [...new Set(body.data.preferredRoles)] } : {}) }
  // Being open to an automatic squad means looking for one.
  if (data.openToAutoTeam === true) data.lookingForTeam = true
  if (data.lookingForTeam === false) data.openToAutoTeam = false
  const updated = await prisma.hackathonParticipant.update({ where: { id: participant.id }, data })

  if (updated.lookingForTeam && !participant.lookingForTeam) await track(user.id, 'solo_pool_joined', { hackathonId: id, auto: updated.openToAutoTeam })
  return createApiResponse({
    hackathonId: id,
    teamId: updated.teamId,
    status: updated.status,
    lookingForTeam: updated.lookingForTeam,
    preferredRoles: updated.preferredRoles,
    openToAutoTeam: updated.openToAutoTeam,
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'hackathons:participation' } })
