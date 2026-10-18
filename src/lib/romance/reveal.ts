import type { Match, Prisma, PrismaClient, RevealStatus } from '@prisma/client'
import { track } from '@/lib/infra/analytics'
import { createNotification } from '@/lib/notifications'
import { advisoryLock } from '@/lib/progress'
import { romanceCopy } from './config'

// The photo reveal. A person's photos are returned blurred (a placeholder with the blur hash) to everybody else until the two people of a romance match have BOTH agreed, and only while
// the match is open. One RevealRequest per match:
//
//   nobody asked        NONE
//   one asked           PENDING (the asker has agreed by asking; the other has not)
//   the other agrees    ACCEPTED: both see the other's photos (and avatar)
//   the other declines  DECLINED (either may ask again)
//   either revokes      REVOKED, at any time, at once (either may ask again)
//
// If both ask at the same moment the second ask is the agreement. Ending the match revokes it (src/lib/romance/ended.ts). Phase 2 may also set `buildDateId`, a Build Date that
// unlocks the reveal; nothing does yet.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export type ViewerRevealStatus = 'NONE' | 'PENDING_MINE' | 'PENDING_THEIRS' | 'ACCEPTED' | 'DECLINED' | 'REVOKED'

export function viewerStatus(row: { status: RevealStatus; requesterId: string } | null, viewerId: string): ViewerRevealStatus {
  if (!row) return 'NONE'
  if (row.status === 'PENDING') return row.requesterId === viewerId ? 'PENDING_MINE' : 'PENDING_THEIRS'
  return row.status
}

/** Whether the photos of the two are visible to each other right now. */
export async function photosRevealed(db: Pick<Db, 'revealRequest'>, matchId: string): Promise<boolean> {
  const row = await db.revealRequest.findUnique({ where: { matchId }, select: { status: true } })
  return row?.status === 'ACCEPTED'
}

export async function revealStatusFor(db: Pick<Db, 'revealRequest'>, matchId: string, viewerId: string): Promise<ViewerRevealStatus> {
  return viewerStatus(await db.revealRequest.findUnique({ where: { matchId }, select: { status: true, requesterId: true } }), viewerId)
}

async function openMatch(tx: Tx, matchId: string, userId: string): Promise<Match | null> {
  const match = await tx.match.findUnique({ where: { id: matchId } })
  if (!match || match.connectionType !== 'DATING' || match.endedAt || (match.userAId !== userId && match.userBId !== userId)) return null
  return match
}

export type RevealResult = { kind: 'NOT_FOUND' } | { kind: 'OK'; status: ViewerRevealStatus }

async function namesOf(tx: Tx, userId: string): Promise<string> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { name: true, username: true } })
  return user?.name || user?.username || 'Someone'
}

/** Agrees to share photos. Asks, or (when the other has already asked) accepts. Repeating it changes nothing. */
export async function agreeToReveal(db: Db, userId: string, matchId: string, now: Date = new Date()): Promise<RevealResult> {
  const out = await db.$transaction(async (tx) => {
    await advisoryLock(tx, `reveal:${matchId}`)
    const match = await openMatch(tx, matchId, userId)
    if (!match) return { kind: 'NOT_FOUND' as const }
    const otherId = match.userAId === userId ? match.userBId : match.userAId
    const row = await tx.revealRequest.findUnique({ where: { matchId } })

    if (row?.status === 'ACCEPTED' || (row?.status === 'PENDING' && row.requesterId === userId)) return { kind: 'OK' as const, status: viewerStatus(row, userId), accepted: false }
    if (row?.status === 'PENDING') {
      const updated = await tx.revealRequest.update({ where: { matchId }, data: { status: 'ACCEPTED', respondedAt: now } })
      await createNotification(tx, { userId: otherId, kind: 'ROMANCE_REVEAL', title: romanceCopy.modeName, message: romanceCopy.revealAccepted(await namesOf(tx, userId)), link: `/romance/matches/${matchId}`, metadata: { matchId } })
      return { kind: 'OK' as const, status: viewerStatus(updated, userId), accepted: true }
    }
    const data = { requesterId: userId, status: 'PENDING' as const, respondedAt: null, revokedAt: null, revokedById: null }
    const saved = row ? await tx.revealRequest.update({ where: { matchId }, data }) : await tx.revealRequest.create({ data: { matchId, ...data } })
    await createNotification(tx, { userId: otherId, kind: 'ROMANCE_REVEAL', title: romanceCopy.modeName, message: romanceCopy.revealAsked(await namesOf(tx, userId)), link: `/romance/matches/${matchId}`, metadata: { matchId } })
    return { kind: 'OK' as const, status: viewerStatus(saved, userId), accepted: false }
  })
  if (out.kind === 'OK' && out.accepted) await track(userId, 'romance_reveal_agreed', { matchId })
  return out.kind === 'OK' ? { kind: 'OK', status: out.status } : out
}

/**
 * Withdraws: cancels the caller's own pending ask, declines the other's, or revokes an accepted reveal. At once, for both: the photos are blurred again from this moment. Repeating it
 * changes nothing.
 */
export async function withdrawReveal(db: Db, userId: string, matchId: string, now: Date = new Date()): Promise<RevealResult> {
  return db.$transaction(async (tx) => {
    await advisoryLock(tx, `reveal:${matchId}`)
    const match = await openMatch(tx, matchId, userId)
    if (!match) return { kind: 'NOT_FOUND' as const }
    const row = await tx.revealRequest.findUnique({ where: { matchId } })
    if (!row || row.status === 'DECLINED' || row.status === 'REVOKED') return { kind: 'OK' as const, status: viewerStatus(row, userId) }
    const declined = row.status === 'PENDING' && row.requesterId !== userId
    const updated = await tx.revealRequest.update({
      where: { matchId },
      data: declined ? { status: 'DECLINED', respondedAt: now } : { status: 'REVOKED', revokedAt: now, revokedById: userId },
    })
    return { kind: 'OK' as const, status: viewerStatus(updated, userId) }
  })
}
