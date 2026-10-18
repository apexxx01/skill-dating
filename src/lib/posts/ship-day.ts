import type { PrismaClient } from '@prisma/client'
import { getCache, type Cache } from '@/lib/infra/cache'
import { log } from '@/lib/log'
import { isoWeekKeyOfDateKey } from '@/lib/time'
import { fridayOfDateKey, shipDayFor } from '@/lib/ship-day'
import { loadViewerScope, toPostViews, visibleWhere, type PostView } from './posts'

// Ship Day: Friday in each person's own time zone (src/lib/ship-day.ts). A post made on the author's Friday carries the Ship Day tag. GET /api/ship-day answers for the viewer's own Friday: whether
// it is today, when it ends, how many posts it has so far platform-wide (a cache counter, rebuilt from the table when it is missing), the viewer's own ships and the week's best posts.
// The Saturday job writes the recap of the week (ShipDayRecap): its best posts and how many came from each country, city and campus.

type Db = PrismaClient

const COUNTER_TTL_MS = 3 * 24 * 60 * 60 * 1000
const counterKey = (dateKey: string) => `shipday:count:${dateKey}`

/** Counts one more Ship Day post for the Friday. Never throws: the counter is a convenience, the table is the truth. */
export async function bumpShipDayCounter(dateKey: string, cache: Cache = getCache()): Promise<void> {
  try {
    await cache.incr(counterKey(dateKey), { ttlMs: COUNTER_TTL_MS })
  } catch (error) {
    log.warn('could not count a Ship Day post', { error })
  }
}

async function todayCount(db: Db, dateKey: string, cache: Cache): Promise<number> {
  try {
    const cached = await cache.get(counterKey(dateKey))
    if (cached !== null && cached !== undefined) return Number(cached)
  } catch {
    // fall through to the table
  }
  const count = await db.shipPost.count({ where: { shipDayKey: dateKey, deletedAt: null } })
  await cache.set(counterKey(dateKey), String(count), { ttlMs: COUNTER_TTL_MS }).catch(() => undefined)
  return count
}

export interface ShipDayResponse {
  isShipDay: boolean
  startsAt: string
  endsAt: string
  /** The viewer's Friday this week, "YYYY-MM-DD". */
  dateKey: string
  weekKey: string
  todayCount: number
  yourShips: PostView[]
  topPosts: PostView[]
  /** The recap of the most recent finished Ship Day, if the Saturday job has written one. */
  lastRecap: { weekKey: string; dateKey: string; totalPosts: number } | null
}

export async function loadShipDay(db: Db, viewerId: string, now: Date = new Date(), cache: Cache = getCache()): Promise<ShipDayResponse> {
  const viewer = await db.user.findUnique({ where: { id: viewerId }, select: { timezone: true } })
  const day = shipDayFor(now, viewer?.timezone ?? null)
  const started = day.startsAt.getTime() <= now.getTime()
  const scope = await loadViewerScope(db, viewerId)
  const [count, mine, top, lastRecap] = await Promise.all([
    started ? todayCount(db, day.dateKey, cache) : Promise.resolve(0),
    db.shipPost.findMany({ where: { shipDayKey: day.dateKey, deletedAt: null, OR: [{ authorId: viewerId }, { coAuthorIds: { has: viewerId } }] }, orderBy: { createdAt: 'desc' }, take: 20 }),
    started ? db.shipPost.findMany({ where: { AND: [visibleWhere(scope), { shipDayKey: day.dateKey }] }, orderBy: [{ propsScore: 'desc' }, { createdAt: 'desc' }], take: 10 }) : Promise.resolve([]),
    db.shipDayRecap.findFirst({ orderBy: { dateKey: 'desc' }, select: { weekKey: true, dateKey: true, totalPosts: true } }),
  ])
  return {
    isShipDay: day.isShipDay,
    startsAt: day.startsAt.toISOString(),
    endsAt: day.endsAt.toISOString(),
    dateKey: day.dateKey,
    weekKey: day.weekKey,
    todayCount: count,
    yourShips: await toPostViews(db, viewerId, mine),
    topPosts: await toPostViews(db, viewerId, top),
    lastRecap,
  }
}

// --- The Saturday recap -----------------------------------------------------------------------------------

export interface RecapResult {
  weekKey: string
  dateKey: string
  totalPosts: number
  created: boolean
}

/** The recap of the Ship Day of the ISO week that `now` is in (a Saturday: the Friday just ended everywhere). Writes it once; running it again changes nothing. */
export async function writeShipDayRecap(db: Db, now: Date = new Date()): Promise<RecapResult> {
  // The Friday of the week `now` falls in, in UTC: on a Saturday it is the day before.
  const today = now.toISOString().slice(0, 10)
  const dateKey = fridayOfDateKey(today)
  const weekKey = isoWeekKeyOfDateKey(dateKey)
  const existing = await db.shipDayRecap.findUnique({ where: { weekKey }, select: { totalPosts: true } })
  if (existing) return { weekKey, dateKey, totalPosts: existing.totalPosts, created: false }

  const totalPosts = await db.shipPost.count({ where: { shipDayKey: dateKey, deletedAt: null } })
  const top = await db.shipPost.findMany({ where: { shipDayKey: dateKey, deletedAt: null, visibility: 'PUBLIC' }, orderBy: [{ propsScore: 'desc' }, { createdAt: 'asc' }], take: 10, select: { id: true, authorId: true, propsScore: true, title: true } })
  const group = async (column: 'countryCode' | 'cityKey' | 'campusKey') => {
    const rows = await db.$queryRawUnsafe<{ key: string; n: bigint }[]>(
      `SELECT p."${column}" AS "key", COUNT(*) AS "n" FROM "ShipPost" s JOIN "Profile" p ON p."userId" = s."authorId" WHERE s."shipDayKey" = $1 AND s."deletedAt" IS NULL AND p."${column}" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50`,
      dateKey
    )
    return rows.map((row) => ({ key: row.key, count: Number(row.n) }))
  }
  const places = { countries: await group('countryCode'), cities: await group('cityKey'), campuses: await group('campusKey') }
  const made = await db.shipDayRecap.createMany({
    data: [{ weekKey, dateKey, totalPosts, topPosts: top.map((p) => ({ postId: p.id, authorId: p.authorId, propsScore: p.propsScore, title: p.title })), places }],
    skipDuplicates: true,
  })
  return { weekKey, dateKey, totalPosts, created: made.count > 0 }
}

export async function runShipDayRecapJob(): Promise<RecapResult> {
  const { prisma } = await import('@/lib/prisma')
  return writeShipDayRecap(prisma)
}
