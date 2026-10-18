import { NextRequest } from 'next/server'
import type { PrismaClient, TeamSlot } from '@prisma/client'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { canManageTeam } from '@/lib/squads/access'
import { hackathonLimits, isLocked, syncLookingFor } from '@/lib/squads/membership'
import { slotUpdateSchema } from '@/lib/squads/schemas'

// Editing and removing one slot: the team's owner and admins, and only while it is open (a filled slot is reopened by the member leaving) and the
// team is not locked.

function ids(request: NextRequest) {
  const parts = new URL(request.url).pathname.split('/')
  return { teamId: parts.slice(-3)[0], slotId: parts.slice(-1)[0] }
}

type Editable = { error: 'SLOT_NOT_FOUND' | 'TEAM_LOCKED' | 'SLOT_NOT_OPEN' } | { slot: TeamSlot }

async function loadEditable(prisma: PrismaClient, teamId: string, slotId: string): Promise<Editable> {
  const slot = await prisma.teamSlot.findUnique({ where: { id: slotId }, include: { team: { select: { hackathonId: true } } } })
  if (!slot || slot.teamId !== teamId) return { error: 'SLOT_NOT_FOUND' as const }
  if (isLocked(await hackathonLimits(prisma, slot.team.hackathonId), new Date())) return { error: 'TEAM_LOCKED' as const }
  if (slot.status !== 'OPEN') return { error: 'SLOT_NOT_OPEN' as const }
  const { team: _team, ...row } = slot
  return { slot: row }
}

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const { teamId, slotId } = ids(request)
  if (!teamId || !slotId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId, slotId' } })
  if (!(await canManageTeam(prisma, user, teamId))) return createApiError('FORBIDDEN')

  const body = await validateBody(slotUpdateSchema)(request)
  if (body instanceof Response) return body

  const loaded = await loadEditable(prisma, teamId, slotId)
  if ('error' in loaded) return createApiError(loaded.error)
  const role = body.data.role ?? loaded.slot.role
  const customLabel = role === 'OTHER' ? (body.data.customLabel !== undefined ? body.data.customLabel : loaded.slot.customLabel) : null
  if (role === 'OTHER' && !customLabel) return createApiError('VALIDATION_FAILED', { details: { customLabel: ['An OTHER slot needs a customLabel'] } })

  const slot = await prisma.$transaction(async (tx) => {
    const updated = await tx.teamSlot.update({
      where: { id: slotId },
      data: { role, customLabel, ...(body.data.requiredSkills ? { requiredSkills: body.data.requiredSkills } : {}), ...(body.data.position !== undefined ? { position: body.data.position } : {}) },
    })
    await syncLookingFor(tx, teamId)
    return updated
  })
  return createApiResponse(slot)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:slot-update' } })

export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const { teamId, slotId } = ids(request)
  if (!teamId || !slotId) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId, slotId' } })
  if (!(await canManageTeam(prisma, user, teamId))) return createApiError('FORBIDDEN')

  const loaded = await loadEditable(prisma, teamId, slotId)
  if ('error' in loaded) return createApiError(loaded.error)

  await prisma.$transaction(async (tx) => {
    // Pending applications and invitations for it stay, without a slot (the foreign key sets it to null).
    await tx.teamSlot.delete({ where: { id: slotId } })
    await syncLookingFor(tx, teamId)
  })
  return createApiResponse({ deleted: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:slot-delete' } })
