import type { DuoStatus, Prisma, PrismaClient } from '@prisma/client'
import { track } from '@/lib/infra/analytics'
import { heatmapRange, loadHeatmap, MAX_HEATMAP_DAYS } from '@/lib/heatmap'
import { createNotification } from '@/lib/notifications'
import { advisoryLock } from '@/lib/progress'
import { pairOf } from '@/lib/matching/sparks'
import { romanceCopy } from './config'
import type { HeatmapDay } from '@/types/api'

// Duo: two people of a romance match who both agreed to share a page, a shared payload of their joint projects and a combined heatmap. One asks, the other accepts; either can
// dissolve it at any time (and ending the match dissolves it). Each person is in at most one active Duo at a time. The Duo page is for the two of them: it is not a public page and
// appears on no profile, passport, feed or leaderboard (docs/SAFETY.md). A partner who turned "show activity" off contributes nothing to the combined heatmap.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export type DuoResult = { kind: 'NOT_FOUND' } | { kind: 'BUSY' } | { kind: 'OK'; status: DuoStatus; id: string }

async function busy(tx: Tx, userId: string, exceptPair: [string, string]): Promise<boolean> {
  const other = await tx.duo.findFirst({
    where: { status: 'ACTIVE', OR: [{ userAId: userId }, { userBId: userId }], NOT: { userAId: exceptPair[0], userBId: exceptPair[1] } },
    select: { id: true },
  })
  return other !== null
}

/** Asks to form a Duo with the other person of an open romance match, or accepts when they have already asked. Safe to repeat. */
export async function requestDuo(db: Db, userId: string, matchId: string, now: Date = new Date()): Promise<DuoResult> {
  const out = await db.$transaction(async (tx) => {
    const match = await tx.match.findUnique({ where: { id: matchId } })
    if (!match || match.connectionType !== 'DATING' || match.endedAt || (match.userAId !== userId && match.userBId !== userId)) return { kind: 'NOT_FOUND' as const }
    const [a, b] = pairOf(match.userAId, match.userBId)
    const otherId = a === userId ? b : a
    await advisoryLock(tx, `duo:${a}:${b}`)
    const row = await tx.duo.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } } })

    if (row?.status === 'ACTIVE' || (row?.status === 'PENDING' && row.requestedById === userId)) return { kind: 'OK' as const, status: row.status, id: row.id, formed: false }
    if ((await busy(tx, userId, [a, b])) || (await busy(tx, otherId, [a, b]))) return { kind: 'BUSY' as const }

    const people = await tx.user.findMany({ where: { id: { in: [a, b] } }, select: { id: true, name: true, username: true } })
    const nameOf = (id: string) => people.find((p) => p.id === id)?.name || people.find((p) => p.id === id)?.username || 'Someone'

    if (row?.status === 'PENDING') {
      const updated = await tx.duo.update({ where: { id: row.id }, data: { status: 'ACTIVE', acceptedAt: now } })
      await createNotification(tx, { userId: otherId, kind: 'ROMANCE_DUO', title: romanceCopy.modeName, message: romanceCopy.duoAccepted(nameOf(userId)), link: '/romance/duo', metadata: { duoId: updated.id } })
      return { kind: 'OK' as const, status: updated.status, id: updated.id, formed: true }
    }
    const data = { requestedById: userId, status: 'PENDING' as const, acceptedAt: null, dissolvedAt: null, dissolvedById: null }
    const saved = row ? await tx.duo.update({ where: { id: row.id }, data }) : await tx.duo.create({ data: { userAId: a, userBId: b, ...data } })
    await createNotification(tx, { userId: otherId, kind: 'ROMANCE_DUO', title: romanceCopy.modeName, message: romanceCopy.duoAsked(nameOf(userId)), link: '/romance/duo', metadata: { duoId: saved.id } })
    return { kind: 'OK' as const, status: saved.status, id: saved.id, formed: false }
  })
  if (out.kind === 'OK' && out.formed) await track(userId, 'romance_duo_formed', { duoId: out.id })
  return out.kind === 'OK' ? { kind: 'OK', status: out.status, id: out.id } : out
}

/** Dissolves the caller's Duo, or declines/cancels a pending one. Safe to repeat. */
export async function dissolveDuo(db: Db, userId: string, now: Date = new Date()): Promise<{ dissolved: boolean }> {
  const changed = await db.duo.updateMany({
    where: { status: { in: ['PENDING', 'ACTIVE'] }, OR: [{ userAId: userId }, { userBId: userId }] },
    data: { status: 'DISSOLVED', dissolvedAt: now, dissolvedById: userId },
  })
  return { dissolved: changed.count > 0 }
}

export interface DuoPartner {
  id: string
  name: string | null
  username: string
  headline: string | null
}

export interface DuoPage {
  id: string
  status: DuoStatus
  /** Whether the caller is the one who asked. */
  requestedByMe: boolean
  partner: DuoPartner
  /** Only for an ACTIVE Duo. */
  shared: {
    projects: { id: string; name: string; slug: string; status: string; shortDesc: string | null }[]
    heatmap: { timezone: string; from: string; to: string; items: HeatmapDay[]; partnerActivityHidden: boolean }
  } | null
}

/** Merges per-day totals: the same local date adds up. */
export function mergeHeatmaps(...lists: readonly (readonly HeatmapDay[])[]): HeatmapDay[] {
  const byDate = new Map<string, HeatmapDay>()
  for (const list of lists) {
    for (const day of list) {
      const have = byDate.get(day.date)
      byDate.set(day.date, have ? { date: day.date, xp: have.xp + day.xp, actions: have.actions + day.actions } : { ...day })
    }
  }
  return [...byDate.values()].sort((x, y) => (x.date < y.date ? -1 : 1))
}

/** The caller's Duo (pending or active), or null. The shared payload is built only for an active one. */
export async function loadDuo(db: Db, userId: string, now: Date = new Date()): Promise<DuoPage | null> {
  const duo = await db.duo.findFirst({ where: { status: { in: ['PENDING', 'ACTIVE'] }, OR: [{ userAId: userId }, { userBId: userId }] }, orderBy: { updatedAt: 'desc' } })
  if (!duo) return null
  const partnerId = duo.userAId === userId ? duo.userBId : duo.userAId
  const [partner, me] = await Promise.all([
    db.user.findUnique({ where: { id: partnerId }, select: { id: true, name: true, username: true, headline: true, deletedAt: true, profile: { select: { showActivity: true } } } }),
    db.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
  ])
  if (!partner || partner.deletedAt) return null
  const page: DuoPage = { id: duo.id, status: duo.status, requestedByMe: duo.requestedById === userId, partner: { id: partner.id, name: partner.name, username: partner.username, headline: partner.headline }, shared: null }
  if (duo.status !== 'ACTIVE') return page

  const projects = await db.project.findMany({
    where: { AND: [{ members: { some: { userId } } }, { members: { some: { userId: partnerId } } }] },
    select: { id: true, name: true, slug: true, status: true, shortDesc: true },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  })
  // Both heatmaps are grouped by the caller's own days, so the squares line up.
  const range = heatmapRange(MAX_HEATMAP_DAYS, me?.timezone, now)
  const partnerHidden = partner.profile?.showActivity === false
  const mine = await loadHeatmap(db, userId, range)
  const theirs = partnerHidden ? [] : await loadHeatmap(db, partnerId, range)
  page.shared = {
    projects,
    heatmap: { timezone: range.timezone, from: range.from, to: range.to, items: mergeHeatmaps(mine, theirs), partnerActivityHidden: partnerHidden },
  }
  return page
}
