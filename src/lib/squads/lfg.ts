import { Prisma, type LfgKind, type PrismaClient, type SquadRole } from '@prisma/client'
import { z } from 'zod'
import { blockedUserIds } from '@/lib/blocks'
import { recommendationsFor } from '@/lib/matching/recommend'
import { loadPersonSummaries } from '@/lib/matching/summary'
import { advisoryLock } from '@/lib/progress'
import { isValidTimeZone, utcOffsetMinutes } from '@/lib/time'
import type { MatchPerson } from '@/types/api'
import { lockTimeOf, otherSquadFor } from './membership'
import { squadRoleSchema } from './schemas'

// The looking-for-group board of a hackathon (docs/SQUADS.md): a person looking for a squad, or a team looking for people, says which roles, which
// stack and which time zone. The board is ranked for the viewer by the pairwise score of the post's author (src/lib/matching/score.ts) and then by
// recency, with blocked people left out both ways. One active post per person per hackathon; a post expires on its own (by default when the
// hackathon's teams lock).

type Db = PrismaClient

export const LFG_CONFIG = {
  /** How many active posts one board read considers before ranking (the newest). */
  candidates: 500,
  /** A time-zone filter keeps posts within this many hours of the zone asked for. */
  tzWindowHours: 3,
  maxNoteLength: 500,
}

export const lfgStackSchema = z.array(z.string().trim().min(1).max(40)).max(15)

export const lfgCreateSchema = z
  .object({
    kind: z.enum(['PERSON', 'TEAM']),
    teamId: z.string().max(64).min(1).optional(),
    roles: z.array(squadRoleSchema).min(1).max(12),
    stack: lfgStackSchema.default([]),
    timezone: z.string().max(60).refine(isValidTimeZone, 'Not an IANA time zone').optional(),
    note: z.string().trim().min(1).max(LFG_CONFIG.maxNoteLength),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((post) => post.kind !== 'TEAM' || Boolean(post.teamId), { message: 'A TEAM post needs a teamId', path: ['teamId'] })
  .refine((post) => post.kind !== 'PERSON' || !post.teamId, { message: 'A PERSON post has no teamId', path: ['teamId'] })

export const lfgUpdateSchema = z
  .object({
    roles: z.array(squadRoleSchema).min(1).max(12),
    stack: lfgStackSchema,
    timezone: z.string().max(60).refine(isValidTimeZone, 'Not an IANA time zone').nullable(),
    note: z.string().trim().min(1).max(LFG_CONFIG.maxNoteLength),
    expiresAt: z.string().datetime(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field')

export const lfgQuerySchema = z.object({
  role: squadRoleSchema.optional(),
  stack: z.string().trim().min(1).max(40).optional(),
  tz: z.string().max(60).refine(isValidTimeZone, 'Not an IANA time zone').optional(),
  kind: z.enum(['PERSON', 'TEAM']).optional(),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

/** Stack tags are compared without case: stored lower-cased, each once. */
export function normalizeStack(stack: readonly string[]): string[] {
  return [...new Set(stack.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
}

export interface RankablePost {
  id: string
  authorId: string
  timezone: string | null
  createdAt: Date
}

/**
 * The board's order: the author's fit to the viewer (0 to 100, unknown counts as 0) first, the newer post second, the id last so the order is total.
 * With `tzOffsetMinutes`, only posts whose time zone is within the window of it are kept (a post without a zone is kept: it did not say). Pure.
 */
export function rankLfgPosts<P extends RankablePost>(posts: readonly P[], fit: ReadonlyMap<string, number>, options: { now: Date; tzOffsetMinutes?: number | null }): P[] {
  const window = LFG_CONFIG.tzWindowHours * 60
  const kept =
    options.tzOffsetMinutes === undefined || options.tzOffsetMinutes === null
      ? [...posts]
      : posts.filter((post) => {
          if (!post.timezone || !isValidTimeZone(post.timezone)) return true
          const diff = Math.abs(utcOffsetMinutes(options.now, post.timezone) - options.tzOffsetMinutes!)
          return Math.min(diff, 1440 - diff) <= window
        })
  return kept.sort((a, b) => (fit.get(b.authorId) ?? 0) - (fit.get(a.authorId) ?? 0) || b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const activeWhere = (now: Date): Prisma.LfgPostWhereInput => ({ closedAt: null, expiresAt: { gt: now } })

export interface LfgPostView {
  id: string
  hackathonId: string
  kind: LfgKind
  author: MatchPerson
  team: { id: string; name: string; slug: string; openSlots: number } | null
  roles: SquadRole[]
  stack: string[]
  timezone: string | null
  note: string
  expiresAt: string
  createdAt: string
  /** The author's fit to the viewer, 0 to 100, and why; null on the viewer's own post. */
  fit: { score: number; reasons: string[] } | null
  mine: boolean
}

type PostRow = Prisma.LfgPostGetPayload<{ include: { team: { select: { id: true; name: true; slug: true; slots: { where: { status: 'OPEN' }; select: { id: true } } } } } }>

const postInclude = { team: { select: { id: true, name: true, slug: true, slots: { where: { status: 'OPEN' as const }, select: { id: true } } } } } as const

function viewOf(post: PostRow, people: ReadonlyMap<string, MatchPerson>, viewerId: string, fit: { score: number; reasons: string[] } | undefined): LfgPostView | null {
  const author = people.get(post.authorId)
  if (!author) return null
  return {
    id: post.id,
    hackathonId: post.hackathonId,
    kind: post.kind,
    author,
    team: post.team ? { id: post.team.id, name: post.team.name, slug: post.team.slug, openSlots: post.team.slots.length } : null,
    roles: post.roles,
    stack: post.stack,
    timezone: post.timezone,
    note: post.note,
    expiresAt: post.expiresAt.toISOString(),
    createdAt: post.createdAt.toISOString(),
    fit: post.authorId === viewerId ? null : (fit ?? { score: 0, reasons: [] }),
    mine: post.authorId === viewerId,
  }
}

export async function lfgPostView(db: Db, postId: string, viewerId: string): Promise<LfgPostView | null> {
  const post = await db.lfgPost.findUnique({ where: { id: postId }, include: postInclude })
  if (!post) return null
  const people = await loadPersonSummaries(db, [post.authorId])
  const fit = post.authorId === viewerId ? undefined : (await recommendationsFor(db, viewerId, [post.authorId])).get(post.authorId)
  return viewOf(post, people, viewerId, fit ? { score: fit.score, reasons: fit.reasons } : undefined)
}

/** One page of the board for the viewer. `offset` is the decoded cursor. */
export async function listLfg(
  db: Db,
  input: { hackathonId: string; viewerId: string; role?: SquadRole; stack?: string; tz?: string; kind?: LfgKind; offset: number; limit: number; now?: Date }
): Promise<{ posts: LfgPostView[]; total: number }> {
  const now = input.now ?? new Date()
  const blocked = await blockedUserIds(db, input.viewerId)
  const where: Prisma.LfgPostWhereInput = {
    hackathonId: input.hackathonId,
    ...activeWhere(now),
    ...(blocked.length > 0 ? { authorId: { notIn: blocked } } : {}),
    ...(input.role ? { roles: { has: input.role } } : {}),
    ...(input.stack ? { stack: { has: input.stack.trim().toLowerCase() } } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
  }
  const rows = await db.lfgPost.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: LFG_CONFIG.candidates, include: postInclude })
  const authorIds = [...new Set(rows.map((row) => row.authorId))]
  const fits = await recommendationsFor(db, input.viewerId, authorIds.filter((id) => id !== input.viewerId), now)
  const scores = new Map([...fits].map(([id, rec]) => [id, rec.score]))
  const ranked = rankLfgPosts(rows, scores, { now, tzOffsetMinutes: input.tz ? utcOffsetMinutes(now, input.tz) : null })
  const page = ranked.slice(input.offset, input.offset + input.limit)
  const people = await loadPersonSummaries(db, page.map((row) => row.authorId))
  return {
    posts: page.flatMap((row) => {
      const fit = fits.get(row.authorId)
      const view = viewOf(row, people, input.viewerId, fit ? { score: fit.score, reasons: fit.reasons } : undefined)
      return view ? [view] : []
    }),
    total: ranked.length,
  }
}

export type LfgCreateFailure = 'ACTIVE_POST_EXISTS' | 'TEAM_NOT_MANAGED' | 'NOT_REGISTERED' | 'IN_A_SQUAD' | 'LOCKED' | 'BAD_EXPIRY'

/**
 * Creates the author's post on a hackathon's board. A PERSON post needs the author registered for the hackathon and in no squad yet; a TEAM post
 * needs a team of the hackathon that they own or run. One active post per author and hackathon, kept under a lock.
 */
export async function createLfgPost(
  db: Db,
  input: { hackathon: { id: string; endDate: Date; submissionDeadline: Date | null }; authorId: string; body: z.infer<typeof lfgCreateSchema>; now?: Date }
): Promise<{ ok: true; postId: string } | { ok: false; reason: LfgCreateFailure; existingId?: string }> {
  const now = input.now ?? new Date()
  const { hackathon, authorId, body } = input
  const lock = lockTimeOf(hackathon)
  if (now.getTime() >= lock.getTime()) return { ok: false, reason: 'LOCKED' }
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : lock
  if (expiresAt.getTime() <= now.getTime() || expiresAt.getTime() > lock.getTime()) return { ok: false, reason: 'BAD_EXPIRY' }

  if (body.kind === 'TEAM') {
    const membership = await db.teamMember.findUnique({ where: { userId_teamId: { userId: authorId, teamId: body.teamId! } }, select: { role: true, team: { select: { hackathonId: true } } } })
    if (!membership || membership.role === 'MEMBER' || membership.team.hackathonId !== hackathon.id) return { ok: false, reason: 'TEAM_NOT_MANAGED' }
  } else {
    const participant = await db.hackathonParticipant.findUnique({ where: { userId_hackathonId: { userId: authorId, hackathonId: hackathon.id } }, select: { id: true } })
    if (!participant) return { ok: false, reason: 'NOT_REGISTERED' }
    if (await otherSquadFor(db, authorId, hackathon.id, null)) return { ok: false, reason: 'IN_A_SQUAD' }
  }

  return db.$transaction(async (tx) => {
    // A partial unique index would do this, but Prisma cannot see one; the lock makes the count-then-insert safe instead.
    await advisoryLock(tx, `lfg:${hackathon.id}:${authorId}`)
    const existing = await tx.lfgPost.findFirst({ where: { hackathonId: hackathon.id, authorId, ...activeWhere(now) }, select: { id: true } })
    if (existing) return { ok: false as const, reason: 'ACTIVE_POST_EXISTS' as const, existingId: existing.id }
    const post = await tx.lfgPost.create({
      data: {
        hackathonId: hackathon.id,
        authorId,
        kind: body.kind,
        teamId: body.kind === 'TEAM' ? body.teamId! : null,
        roles: [...new Set(body.roles)],
        stack: normalizeStack(body.stack),
        timezone: body.timezone ?? null,
        note: body.note,
        expiresAt,
      },
    })
    return { ok: true as const, postId: post.id }
  })
}
