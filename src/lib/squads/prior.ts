import type { PrismaClient } from '@prisma/client'
import type { PriorSignal } from '@/lib/matching/score'

// The squad history the pairwise score reads as its priorSignal (src/lib/matching/score.ts): how reliable each candidate has been as a teammate, and
// whether the viewer said they would build with them again. One query each for a whole batch of candidates.

type Db = Pick<PrismaClient, 'userReliability' | 'peerReview'>

export async function loadPriorSignals(db: Db, viewerId: string, candidateIds: readonly string[]): Promise<Map<string, PriorSignal>> {
  const ids = [...new Set(candidateIds)].filter((id) => id !== viewerId)
  const out = new Map<string, PriorSignal>()
  if (ids.length === 0) return out
  const [reliability, reviews] = await Promise.all([
    db.userReliability.findMany({ where: { userId: { in: ids }, reviews: { gt: 0 } }, select: { userId: true, score: true } }),
    db.peerReview.findMany({ where: { reviewerId: viewerId, revieweeId: { in: ids } }, select: { revieweeId: true, wouldBuildAgain: true }, orderBy: { createdAt: 'asc' } }),
  ])
  for (const row of reliability) out.set(row.userId, { ...out.get(row.userId), reliability: row.score })
  // Oldest first, so the latest review of each person wins.
  for (const row of reviews) out.set(row.revieweeId, { ...out.get(row.revieweeId), wouldBuildAgain: row.wouldBuildAgain })
  return out
}
