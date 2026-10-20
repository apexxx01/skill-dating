import type { PrismaClient } from '@prisma/client'
import { blockedUserIds } from '@/lib/blocks'
import { recommendationsFor } from '@/lib/matching/recommend'
import { createNotification } from '@/lib/notifications'
import { roleLabel } from './roles'
import { trustedIds } from './people'

// When someone leaves a squad (or is removed), the slot they filled reopens and its owner is told, with up to three people from the hackathon's
// solo pool who would like to play that role, best fit to the owner first (the pairwise score). Run as a job, after the leaving has committed.

type Db = PrismaClient

export const REFILL_SUGGESTIONS = 3

export async function suggestRefill(db: Db, input: { teamId: string; slotId: string; now?: Date }): Promise<{ notified: boolean; suggestions: string[] }> {
  const now = input.now ?? new Date()
  const slot = await db.teamSlot.findUnique({
    where: { id: input.slotId },
    select: { status: true, role: true, customLabel: true, team: { select: { id: true, name: true, slug: true, ownerId: true, hackathonId: true, members: { select: { userId: true } } } } },
  })
  if (!slot || slot.status !== 'OPEN' || slot.team.id !== input.teamId) return { notified: false, suggestions: [] }
  const { team } = slot

  let suggestions: string[] = []
  if (team.hackathonId) {
    const memberIds = team.members.map((member) => member.userId)
    const blocked = await blockedUserIds(db, team.ownerId)
    const pool = await db.hackathonParticipant.findMany({
      where: { hackathonId: team.hackathonId, teamId: null, lookingForTeam: true, preferredRoles: { has: slot.role }, userId: { notIn: [...memberIds, ...blocked] } },
      orderBy: { registeredAt: 'desc' },
      take: 100,
      select: { userId: true },
    })
    const trusted = await trustedIds(db, pool.map((row) => row.userId), now)
    const fits = await recommendationsFor(db, team.ownerId, [...trusted], now)
    suggestions = [...trusted].sort((a, b) => (fits.get(b)?.score ?? 0) - (fits.get(a)?.score ?? 0) || a.localeCompare(b)).slice(0, REFILL_SUGGESTIONS)
  }

  const label = roleLabel({ role: slot.role, customLabel: slot.customLabel })
  const written = await createNotification(db, {
    userId: team.ownerId,
    kind: 'SQUAD_UPDATE',
    title: `Your ${label} slot is open again`,
    message: suggestions.length > 0 ? `${suggestions.length} people in the pool would like to be your ${label}` : `Try Find my squad or the looking-for-group board to fill it`,
    link: `/teams/${team.slug}`,
    metadata: { teamId: team.id, slotId: input.slotId, suggestions },
  })
  return { notified: written !== null, suggestions }
}

/** `squads/refill-suggestion`. */
export async function runRefillSuggestionJob(data: { teamId: string; slotId: string }) {
  const { prisma } = await import('@/lib/prisma')
  return suggestRefill(prisma, data)
}
