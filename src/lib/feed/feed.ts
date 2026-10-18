import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { getCache, type Cache } from '@/lib/infra/cache'
import { levelFor } from '@/lib/levels'
import { professionalMatchIds } from '@/lib/matching/matches'
import { loadViewerScope, toPostViews, visibleWhere, type PostView, type ViewerScope } from '@/lib/posts/posts'
import { closestNetwork, pageAt, rankPosts, type Network, type Rankable } from './ranking'

// GET /api/feed. Ranking v1 (ranking.ts, documented in docs/FEED.md with a worked example): recency decay with a 24 hour half-life, times 1 + ln(1 + propsScore), times a boost for the
// network (follow 1.5, crew 1.8, match 2.2), times a small boost for the author's tier; at most two posts per author per page; blocked and hidden authors never in it.
//
// Fan-out on read, over a cached candidate window: a request builds (or reads) a window of the viewer's most recent visible posts for a tab, ranks it in memory and cuts a page; nothing is
// written when someone posts. The window is cached per viewer and tab for a minute. The cursor carries the instant the first page was ranked at and the page number, so later pages rank the same
// window the same way (a Prop that lands in between can move a post a little). The migration path to fan-out on write is in docs/FEED.md.

type Db = PrismaClient

export const FEED_TABS = ['for-you', 'following', 'city', 'campus'] as const
export type FeedTab = (typeof FEED_TABS)[number]

export const FEED_CONFIG = {
  windowSize: 300,
  windowDays: 7,
  windowCacheMs: 60_000,
  pageSize: 20,
  /** A cursor is good for this long: after it the feed has moved on and the client starts again. */
  cursorMaxAgeMs: 60 * 60_000,
} as const

export const feedQuerySchema = z.object({
  tab: z.enum(FEED_TABS).default('for-you'),
  limit: z.coerce.number().int().min(1).max(50).default(FEED_CONFIG.pageSize),
  cursor: z.string().min(1).max(200).optional(),
})

interface Cursor {
  asOf: number
  page: number
}

export function encodeFeedCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ v: 1, a: cursor.asOf, p: cursor.page }), 'utf8').toString('base64url')
}

export function decodeFeedCursor(raw: string, now: Date): Cursor | null {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { v?: number; a?: number; p?: number }
    if (value.v !== 1 || !Number.isInteger(value.a) || !Number.isInteger(value.p) || (value.p as number) < 0 || (value.p as number) > 1000) return null
    const age = now.getTime() - (value.a as number)
    if (age < -60_000 || age > FEED_CONFIG.cursorMaxAgeMs) return null
    return { asOf: value.a as number, page: value.p as number }
  } catch {
    return null
  }
}

interface WindowEntry {
  id: string
  authorId: string
  createdAt: number
  propsScore: number
  authorXp: number
}

async function networkOf(db: Db, scope: ViewerScope): Promise<(authorId: string) => Network> {
  const [matches, teamMates, projectMates] = await Promise.all([
    professionalMatchIds(db, scope.userId),
    scope.teamIds.size > 0 ? db.teamMember.findMany({ where: { teamId: { in: [...scope.teamIds] }, userId: { not: scope.userId } }, select: { userId: true }, take: 1000 }) : Promise.resolve([]),
    scope.projectIds.size > 0 ? db.projectMember.findMany({ where: { projectId: { in: [...scope.projectIds] }, userId: { not: scope.userId } }, select: { userId: true }, take: 1000 }) : Promise.resolve([]),
  ])
  const matched = new Set(matches)
  const crew = new Set([...teamMates.map((row) => row.userId), ...projectMates.map((row) => row.userId)])
  return (authorId) => closestNetwork({ follows: scope.following.has(authorId), crew: crew.has(authorId), match: matched.has(authorId) })
}

async function buildWindow(db: Db, scope: ViewerScope, tab: FeedTab, asOf: Date): Promise<WindowEntry[]> {
  const where: Record<string, unknown>[] = [visibleWhere(scope) as Record<string, unknown>, { createdAt: { gte: new Date(asOf.getTime() - FEED_CONFIG.windowDays * 86_400_000), lte: asOf } }]
  if (tab === 'following') {
    where.push({ authorId: { in: [...scope.following] } })
  } else if (tab === 'city' || tab === 'campus') {
    const place = await db.profile.findUnique({ where: { userId: scope.userId }, select: { cityKey: true, campusKey: true } })
    const key = tab === 'city' ? place?.cityKey : place?.campusKey
    if (!key) return []
    where.push({ author: { profile: tab === 'city' ? { cityKey: key } : { campusKey: key } } })
  }
  const rows = await db.shipPost.findMany({
    where: { AND: where } as never,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: FEED_CONFIG.windowSize,
    select: { id: true, authorId: true, createdAt: true, propsScore: true, author: { select: { xp: true } } },
  })
  return rows.map((row) => ({ id: row.id, authorId: row.authorId, createdAt: row.createdAt.getTime(), propsScore: row.propsScore, authorXp: row.author.xp }))
}

export interface FeedResponse {
  tab: FeedTab
  posts: PostView[]
  nextCursor: string | null
}

export async function loadFeed(db: Db, viewerId: string, query: { tab: FeedTab; cursor?: string; limit: number }, options: { now?: Date; cache?: Cache } = {}): Promise<FeedResponse | 'INVALID_CURSOR'> {
  const now = options.now ?? new Date()
  const cache = options.cache ?? getCache()
  const cursor = query.cursor ? decodeFeedCursor(query.cursor, now) : { asOf: now.getTime(), page: 0 }
  if (!cursor) return 'INVALID_CURSOR'

  const scope = await loadViewerScope(db, viewerId)
  // The window is built at a minute boundary at or before the ranking instant, so every request of that minute shares it.
  const bucket = Math.floor(cursor.asOf / FEED_CONFIG.windowCacheMs)
  const key = `feed:win:${viewerId}:${query.tab}:${bucket}`
  let window: WindowEntry[]
  const cached = await cache.get(key).catch(() => null)
  if (cached) window = JSON.parse(cached) as WindowEntry[]
  else {
    window = await buildWindow(db, scope, query.tab, new Date(cursor.asOf))
    await cache.set(key, JSON.stringify(window), { ttlMs: FEED_CONFIG.windowCacheMs * 2 }).catch(() => undefined)
  }

  const networkFor = await networkOf(db, scope)
  const asOf = new Date(cursor.asOf)
  const rankables: (Rankable & { id: string })[] = window
    .filter((entry) => entry.createdAt <= cursor.asOf && !scope.hidden.has(entry.authorId))
    .map((entry) => ({ id: entry.id, authorId: entry.authorId, createdAt: new Date(entry.createdAt), propsScore: entry.propsScore, authorTier: levelFor(entry.authorXp).tier, network: networkFor(entry.authorId) }))
  const ranked = rankPosts(rankables, asOf)
  const page = pageAt(ranked, cursor.page, query.limit)

  const ids = page.items.map((item) => item.id)
  const rows = ids.length > 0 ? await db.shipPost.findMany({ where: { id: { in: ids }, deletedAt: null } }) : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  const ordered = ids.flatMap((id) => byId.get(id) ?? [])
  const posts = await toPostViews(db, viewerId, ordered)
  return { tab: query.tab, posts, nextCursor: page.hasMore ? encodeFeedCursor({ asOf: cursor.asOf, page: cursor.page + 1 }) : null }
}
