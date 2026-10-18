import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { blockGuard } from '@/lib/blocks'
import { canManageTeam } from '@/lib/squads/access'
import { capacityOf, createSlots, hackathonLimits, isLocked } from '@/lib/squads/membership'
import { slotInputSchema } from '@/lib/squads/schemas'

// A team's role slots (docs/SQUADS.md). Anyone signed in may see them (they are what an applicant applies for), unless blocked with the owner; the
// team's owner and admins add, edit and remove open ones. A slot is filled by accepting an application or invitation for it.

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })

  const team = await prisma.team.findUnique({ where: { id }, select: { id: true, ownerId: true, maxSize: true, hackathonId: true, _count: { select: { members: true } } } })
  if (!team) return createApiError('TEAM_NOT_FOUND')
  const blocked = await blockGuard(prisma, user.id, team.ownerId, 'TEAM_NOT_FOUND')
  if (blocked) return blocked

  const [slots, hackathon] = await Promise.all([
    prisma.teamSlot.findMany({
      where: { teamId: id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: { filledBy: { select: { id: true, name: true, username: true, image: true } } },
    }),
    hackathonLimits(prisma, team.hackathonId),
  ])
  const capacity = capacityOf(team, hackathon)
  return createApiResponse({
    slots,
    capacity,
    memberCount: team._count.members,
    openPlaces: Math.max(0, capacity - team._count.members),
    locked: isLocked(hackathon, new Date()),
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'teams:slots' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!id) return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })

  const team = await prisma.team.findUnique({ where: { id }, select: { id: true, maxSize: true, hackathonId: true, _count: { select: { members: true } } } })
  if (!team) return createApiError('TEAM_NOT_FOUND')
  if (!(await canManageTeam(prisma, user, id))) return createApiError('FORBIDDEN')

  const body = await validateBody(slotInputSchema)(request)
  if (body instanceof Response) return body

  const hackathon = await hackathonLimits(prisma, team.hackathonId)
  if (isLocked(hackathon, new Date())) return createApiError('TEAM_LOCKED')

  const slot = await prisma.$transaction(async (tx) => {
    // Locked so two owners adding the last slot at once cannot both get past the count.
    await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${id} FOR UPDATE`
    const open = await tx.teamSlot.count({ where: { teamId: id, status: 'OPEN' } })
    const free = capacityOf(team, hackathon) - team._count.members
    if (open >= free) return { ok: false as const, free: Math.max(0, free) }
    await createSlots(tx, id, [{ ...body.data, customLabel: body.data.customLabel ?? null }])
    return { ok: true as const, slot: await tx.teamSlot.findFirstOrThrow({ where: { teamId: id }, orderBy: { position: 'desc' } }) }
  })
  if (!slot.ok) return createApiError('SLOT_LIMIT_REACHED', { params: { free: slot.free } })
  return createApiResponse(slot.slot, 201)
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:slot-create' } })
