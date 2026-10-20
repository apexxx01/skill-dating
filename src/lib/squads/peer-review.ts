import type { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { blockRelation } from '@/lib/blocks'
import { KIND_SPECS } from '@/lib/notification-kinds'
import { accountDistrust } from '@/lib/trust'
import { reliabilityOf } from './reliability'

// Commitment pledges and peer reviews (docs/SQUADS.md, "Reliability and peer review"): the number one hackathon pain is a teammate who ghosts.
// Before a hackathon each squad member pledges how they will take part; after it, each reviews each teammate in private (showed up, would build
// again, a one-line note only admins see). A person's reviews add up to their reliability (src/lib/squads/reliability.ts), which is never shown as
// a number: it moves squad strength, the squad builder, the solo pool and the pairwise score, and a passport may show a "Reliable teammate" badge.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

const DAY_MS = 24 * 60 * 60 * 1000

export const PEER_REVIEW_WINDOW_MS = 7 * DAY_MS

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date, YYYY-MM-DD')

export const pledgeSchema = z
  .object({
    attendance: z.enum(['IN_PERSON', 'REMOTE']),
    hoursAvailable: z.number().int().min(1).max(168),
    availableFrom: dateOnly,
    availableUntil: dateOnly,
  })
  .strict()
  .refine((pledge) => pledge.availableFrom <= pledge.availableUntil, { message: 'availableFrom is after availableUntil', path: ['availableFrom'] })

export const peerReviewSchema = z
  .object({
    revieweeId: z.string().min(1).max(64),
    showedUp: z.enum(['YES', 'PARTLY', 'NO']),
    wouldBuildAgain: z.boolean(),
    note: z.string().trim().max(140).optional(),
  })
  .strict()

/** The peer-review window of a hackathon: it opens when the results come in or the hackathon ends, whichever is first, and lasts a week. */
export function reviewWindow(hackathon: { endDate: Date; resultsAt: Date | null }): { opensAt: Date; closesAt: Date } {
  const opensAt = new Date(Math.min(hackathon.endDate.getTime(), hackathon.resultsAt?.getTime() ?? Infinity))
  return { opensAt, closesAt: new Date(opensAt.getTime() + PEER_REVIEW_WINDOW_MS) }
}

export const isWindowOpen = (window: { opensAt: Date; closesAt: Date }, now: Date) => now.getTime() >= window.opensAt.getTime() && now.getTime() < window.closesAt.getTime()

/** The teammates of `userId` for a hackathon: the other members of their registered squad for it (kept even after it became a crew). */
export async function teammatesOf(db: Db | Tx, hackathonId: string, userId: string): Promise<{ hackathonTeamId: string; teamId: string; userIds: string[] } | null> {
  const membership = await db.hackathonTeamMember.findFirst({ where: { userId, hackathonTeam: { hackathonId } }, select: { hackathonTeam: { select: { id: true, teamId: true, members: { select: { userId: true } } } } } })
  if (!membership) return null
  const team = membership.hackathonTeam
  return { hackathonTeamId: team.id, teamId: team.teamId, userIds: team.members.map((m) => m.userId).filter((id) => id !== userId) }
}

/** Recomputes a person's reliability from their counted reviews. Call in the transaction that wrote a review. */
export async function recomputeReliability(tx: Tx, userId: string, now: Date): Promise<void> {
  const reviews = await tx.peerReview.findMany({ where: { revieweeId: userId, counted: true }, select: { showedUp: true, wouldBuildAgain: true, createdAt: true } })
  const reliability = reliabilityOf(reviews, now)
  await tx.userReliability.upsert({
    where: { userId },
    create: { userId, score: reliability.score, reviews: reliability.reviews, badge: reliability.badge },
    update: { score: reliability.score, reviews: reliability.reviews, badge: reliability.badge },
  })
}

export type ReviewFailure = 'WINDOW_CLOSED' | 'NOT_TEAMMATES' | 'ALREADY_REVIEWED' | 'BLOCKED' | 'SELF'

/**
 * Writes one review of one teammate, once. A review from an account the trust gate does not trust is kept but not counted (it changes nothing). The
 * reviewee's reliability is recomputed in the same transaction.
 */
export async function writePeerReview(
  db: Db,
  input: { hackathon: { id: string; endDate: Date; resultsAt: Date | null }; reviewerId: string; body: z.infer<typeof peerReviewSchema>; now?: Date }
): Promise<{ ok: true; reviewId: string; counted: boolean } | { ok: false; reason: ReviewFailure }> {
  const now = input.now ?? new Date()
  const { hackathon, reviewerId, body } = input
  if (body.revieweeId === reviewerId) return { ok: false, reason: 'SELF' }
  if (!isWindowOpen(reviewWindow(hackathon), now)) return { ok: false, reason: 'WINDOW_CLOSED' }
  const mates = await teammatesOf(db, hackathon.id, reviewerId)
  if (!mates || !mates.userIds.includes(body.revieweeId)) return { ok: false, reason: 'NOT_TEAMMATES' }
  if (await blockRelation(db, reviewerId, body.revieweeId)) return { ok: false, reason: 'BLOCKED' }

  const reviewer = await db.user.findUnique({ where: { id: reviewerId }, select: { createdAt: true, isEmailVerified: true } })
  const counted = accountDistrust(reviewer, now) === null
  return db.$transaction(async (tx) => {
    const created = await tx.peerReview.createMany({
      data: [{ hackathonId: hackathon.id, teamId: mates.teamId, reviewerId, revieweeId: body.revieweeId, showedUp: body.showedUp, wouldBuildAgain: body.wouldBuildAgain, note: body.note || null, counted, createdAt: now }],
      skipDuplicates: true,
    })
    if (created.count === 0) return { ok: false as const, reason: 'ALREADY_REVIEWED' as const }
    if (counted) await recomputeReliability(tx, body.revieweeId, now)
    const review = await tx.peerReview.findUniqueOrThrow({ where: { hackathonId_reviewerId_revieweeId: { hackathonId: hackathon.id, reviewerId, revieweeId: body.revieweeId } }, select: { id: true } })
    return { ok: true as const, reviewId: review.id, counted }
  })
}

export interface ReviewTodo {
  window: { opensAt: string; closesAt: string; open: boolean }
  teammates: { userId: string; name: string | null; username: string | null; image: string | null; reviewed: boolean; mine: { showedUp: string; wouldBuildAgain: boolean } | null }[]
}

/** The caller's side of a hackathon's reviews: the window and their teammates, with what they said. Never what anyone said about them. */
export async function reviewTodo(db: Db, hackathon: { id: string; endDate: Date; resultsAt: Date | null }, userId: string, now: Date = new Date()): Promise<ReviewTodo | null> {
  const mates = await teammatesOf(db, hackathon.id, userId)
  if (!mates) return null
  const [people, mine] = await Promise.all([
    db.user.findMany({ where: { id: { in: mates.userIds }, deletedAt: null }, select: { id: true, name: true, username: true, image: true } }),
    db.peerReview.findMany({ where: { hackathonId: hackathon.id, reviewerId: userId }, select: { revieweeId: true, showedUp: true, wouldBuildAgain: true } }),
  ])
  const said = new Map(mine.map((review) => [review.revieweeId, review]))
  const window = reviewWindow(hackathon)
  return {
    window: { opensAt: window.opensAt.toISOString(), closesAt: window.closesAt.toISOString(), open: isWindowOpen(window, now) },
    teammates: people.map((person) => {
      const review = said.get(person.id)
      return { userId: person.id, name: person.name, username: person.username, image: person.image, reviewed: Boolean(review), mine: review ? { showedUp: review.showedUp, wouldBuildAgain: review.wouldBuildAgain } : null }
    }),
  }
}

/**
 * Asks every member of a hackathon's squads to review their teammates, once per person and hackathon (coalesceKey `peer-review:<hackathon>`), for
 * hackathons whose window opened in the last week. Run by the hourly squad sweep.
 */
export async function sendPeerReviewPrompts(db: Db, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - PEER_REVIEW_WINDOW_MS)
  const hackathons = await db.hackathon.findMany({
    where: { OR: [{ endDate: { gt: since, lte: now } }, { resultsAt: { gt: since, lte: now } }] },
    select: { id: true, name: true, slug: true, endDate: true, resultsAt: true },
    take: 200,
  })
  let written = 0
  for (const hackathon of hackathons) {
    if (!isWindowOpen(reviewWindow(hackathon), now)) continue
    const members = await db.hackathonTeamMember.findMany({ where: { hackathonTeam: { hackathonId: hackathon.id, members: { some: {} } } }, select: { userId: true, hackathonTeam: { select: { _count: { select: { members: true } } } } } })
    const ids = members.filter((member) => member.hackathonTeam._count.members > 1).map((member) => member.userId)
    if (ids.length === 0) continue
    const muted = new Set((await db.notificationPreference.findMany({ where: { userId: { in: ids }, kind: 'PEER_REVIEW', enabled: false }, select: { userId: true } })).map((row) => row.userId))
    const data = ids
      .filter((id) => !muted.has(id))
      .map((userId) => ({
        userId,
        type: KIND_SPECS.PEER_REVIEW.type,
        title: 'How did your squad do?',
        message: `Tell us privately how your teammates from ${hackathon.name} did: it takes a minute and only you see what you said`,
        link: `/hackathons/${hackathon.slug}`,
        metadata: { kind: 'PEER_REVIEW', hackathonId: hackathon.id },
        coalesceKey: `peer-review:${hackathon.id}`,
        count: 1,
      }))
    if (data.length > 0) written += (await db.notification.createMany({ data, skipDuplicates: true })).count
  }
  return written
}
