import type { Match, Prisma, PrismaClient } from '@prisma/client'
import { blockedPeerIds } from '@/lib/blocks'
import { can, subjectFor } from '@/lib/entitlements'
import { decodeKeysetCursor, keysetOrderBy, keysetPage, keysetWhere } from '@/lib/api/pagination'
import { getStorage } from '@/lib/infra/storage'
import { ROMANCE_MODE_LABEL } from './config'
import { viewerStatus, type ViewerRevealStatus } from './reveal'
import { toCandidateView, type RomanceCandidateView } from './drop-view'
import type { StoredRomanceProfile } from './profile'

// The romance mode's own lists: its matches and the sparks waiting for the caller. (Unmatching and reporting reuse the existing routes, DELETE /api/matches/{id} and
// POST /api/matches/{id}/report: they work on any match the caller is in.)

type Db = PrismaClient

export interface RomanceMatchItem {
  id: string
  createdAt: string
  conversationId: string | null
  /** Where the photo reveal stands for the caller; the other's photos (and avatar) come with `other` only once it is ACCEPTED. */
  reveal: { status: ViewerRevealStatus }
  other: RomanceCandidateView
}

export interface RomanceMatchesResponse {
  modeLabel: string
  matches: RomanceMatchItem[]
  nextCursor: string | null
  total: number
}

async function toItem(db: Db, match: Match, viewerId: string): Promise<RomanceMatchItem | null> {
  const otherId = match.userAId === viewerId ? match.userBId : match.userAId
  const profile = await db.romanceProfile.findUnique({ where: { userId: otherId } })
  // The other person left the mode: the match was ended with it, and is not listed.
  if (!profile) return null
  const row = await db.revealRequest.findUnique({ where: { matchId: match.id }, select: { status: true, requesterId: true } })
  // Both agreed, and the match is open (it is: listing and reading only reach open ones): the photos are shown. Otherwise only placeholders.
  const other = await toCandidateView(db, otherId, profile as unknown as StoredRomanceProfile, row?.status === 'ACCEPTED' ? { storage: getStorage() } : undefined)
  if (!other) return null
  return { id: match.id, createdAt: match.createdAt.toISOString(), conversationId: match.conversationId, reveal: { status: viewerStatus(row, viewerId) }, other }
}

/** The caller's open romance matches, newest first. A match with someone blocked either way, or whose account is gone, is not listed. */
export async function listRomanceMatches(db: Db, userId: string, options: { cursor?: string; limit: number }): Promise<RomanceMatchesResponse | 'INVALID_CURSOR'> {
  const hidden = await blockedPeerIds(db, userId)
  const visible = (side: 'userA' | 'userB'): Prisma.MatchWhereInput => ({
    endedAt: null,
    connectionType: 'DATING',
    [`${side}Id`]: userId,
    [side === 'userA' ? 'userB' : 'userA']: { deletedAt: null, ...(hidden.length > 0 ? { id: { notIn: hidden } } : {}) },
  })
  const base: Prisma.MatchWhereInput = { OR: [visible('userA'), visible('userB')] }

  let where: Prisma.MatchWhereInput = base
  if (options.cursor !== undefined) {
    const after = decodeKeysetCursor(options.cursor)
    if (!after) return 'INVALID_CURSOR'
    where = { AND: [base, keysetWhere('createdAt', 'desc', after)] }
  }
  const [rows, total] = await Promise.all([
    db.match.findMany({ where, orderBy: keysetOrderBy('createdAt', 'desc') as Prisma.MatchOrderByWithRelationInput[], take: options.limit + 1 }),
    db.match.count({ where: base }),
  ])
  const page = keysetPage(rows, options.limit, (row) => ({ sort: row.createdAt, id: row.id }))
  const matches: RomanceMatchItem[] = []
  for (const match of page.items) {
    const item = await toItem(db, match, userId)
    if (item) matches.push(item)
  }
  return { modeLabel: ROMANCE_MODE_LABEL, matches, nextCursor: page.nextCursor, total }
}

/** One of the caller's open romance matches, or null (not theirs, ended, blocked, or not a romance match: all the same answer). */
export async function getRomanceMatch(db: Db, userId: string, matchId: string): Promise<RomanceMatchItem | null> {
  const match = await db.match.findUnique({ where: { id: matchId } })
  if (!match || match.connectionType !== 'DATING' || match.endedAt || (match.userAId !== userId && match.userBId !== userId)) return null
  const otherId = match.userAId === userId ? match.userBId : match.userAId
  if ((await blockedPeerIds(db, userId)).includes(otherId)) return null
  return toItem(db, match, userId)
}

export interface ReceivedRomanceSpark {
  id: string
  opener: string
  createdAt: string
  from: Pick<RomanceCandidateView, 'id' | 'name' | 'username' | 'headline' | 'builderRole' | 'level' | 'tier' | 'skills' | 'proof' | 'profile'>
}

export interface ReceivedRomanceSparks {
  modeLabel: string
  /** Whether the caller's plan shows who sparked them (SEE_WHO_SPARKED). */
  canSee: boolean
  count: number
  sparks: ReceivedRomanceSpark[]
  nextCursor: string | null
}

/**
 * The romance sparks the caller has not answered. Who sent them, and what they wrote, is a paid feature (SEE_WHO_SPARKED): without it the caller gets the number and nothing else, and
 * can still spark back from a drop. Senders who are blocked either way, or gone, are not counted. A sender is shown the way a candidate is: no photo, no avatar, nothing private.
 */
export async function loadReceivedRomanceSparks(db: Db, userId: string, options: { cursor?: string; limit: number; enforced?: boolean }): Promise<ReceivedRomanceSparks | 'INVALID_CURSOR'> {
  const hidden = await blockedPeerIds(db, userId)
  const base: Prisma.SparkWhereInput = {
    toId: userId,
    status: 'PENDING',
    // A spark a moderator hid is not shown to the person sparked.
    moderatedAt: null,
    connectionType: 'DATING',
    from: { deletedAt: null, ...(hidden.length > 0 ? { id: { notIn: hidden } } : {}) },
  }
  const subject = await subjectFor(db, userId)
  const canSee = can(subject, 'SEE_WHO_SPARKED', { enforced: options.enforced })
  const count = await db.spark.count({ where: base })
  if (!canSee) return { modeLabel: ROMANCE_MODE_LABEL, canSee: false, count, sparks: [], nextCursor: null }

  let where: Prisma.SparkWhereInput = base
  if (options.cursor !== undefined) {
    const after = decodeKeysetCursor(options.cursor)
    if (!after) return 'INVALID_CURSOR'
    where = { AND: [base, keysetWhere('createdAt', 'desc', after)] }
  }
  const rows = await db.spark.findMany({ where, orderBy: keysetOrderBy('createdAt', 'desc') as Prisma.SparkOrderByWithRelationInput[], take: options.limit + 1 })
  const page = keysetPage(rows, options.limit, (row) => ({ sort: row.createdAt, id: row.id }))
  const sparks: ReceivedRomanceSpark[] = []
  for (const spark of page.items) {
    const profile = await db.romanceProfile.findUnique({ where: { userId: spark.fromId } })
    if (!profile) continue
    const card = await toCandidateView(db, spark.fromId, profile as unknown as StoredRomanceProfile)
    if (!card) continue
    const { photos: _photos, ...from } = card
    void _photos
    sparks.push({ id: spark.id, opener: spark.opener, createdAt: spark.createdAt.toISOString(), from })
  }
  return { modeLabel: ROMANCE_MODE_LABEL, canSee: true, count, sparks, nextCursor: page.nextCursor }
}
