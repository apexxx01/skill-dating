import type { Prisma } from '@prisma/client'

// What ending a romance match takes with it. Called inside the transaction that ends the match (unmatch, report, block, leaving the mode, a deleted account): the photo reveal
// is revoked, so the other person's photos are blurred again from that moment, and a Duo between the two is dissolved. Nothing here notifies anybody: an ended match is silent
// (docs/MATCHING.md, "Why unmatching is silent").

type Tx = Prisma.TransactionClient

export async function onRomanceMatchEnded(tx: Tx, match: { id: string; userAId: string; userBId: string }, byId: string, now: Date): Promise<void> {
  await tx.revealRequest.updateMany({
    where: { matchId: match.id, status: { in: ['PENDING', 'ACCEPTED'] } },
    data: { status: 'REVOKED', revokedAt: now, revokedById: byId },
  })
  await tx.duo.updateMany({
    where: { userAId: match.userAId, userBId: match.userBId, status: { in: ['PENDING', 'ACTIVE'] } },
    data: { status: 'DISSOLVED', dissolvedAt: now, dissolvedById: byId },
  })
}
