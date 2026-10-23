import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { LAYOUT_VERSION } from './layout'
import { achievementCard, passportCard, postCard, squadCard } from './data'

// The address of a share card, with a version in it. A card is cached for a day by browsers and link-preview services (render.ts), so an edit would not show until the copy
// expired; but a link with a different `?v=` is a different thing to every cache, so the page asks for the address here and gets a new one whenever the person, post, squad or
// achievement changed. The version is a short hash of the `updatedAt` stamps of the rows the card is drawn from (and of the layout's version, so a redesign changes every one),
// not of the card: one cheap query, no drawing. Counts that move without touching those rows (Props on a post) follow the day-long cache like before.
//
// A card that may not be shown has no address (null), which is exactly as much as asking for the card itself would tell: it answers the same 404.

export type CardRef =
  | { kind: 'passport'; id: string }
  | { kind: 'post'; id: string }
  | { kind: 'squad'; id: string }
  | { kind: 'achievement'; id: string; user: string }

export type CardLinkDb = Pick<PrismaClient, 'user' | 'profile' | 'shipPost' | 'team' | 'achievement' | 'userAchievement' | 'project' | 'userRisk' | 'userRestriction' | 'userSkill' | 'hackathonTeam' | 'teamMember' | 'xPEvent' | 'hackathon'>

/** The version for some stamps: 12 hex characters of a hash of the layout's version and every part, in order. Pure. */
export function versionOf(parts: ReadonlyArray<Date | string | number | null | undefined>): string {
  // An array encoded as JSON, so no value can be mistaken for two (or two for one) by what it contains.
  const text = JSON.stringify([LAYOUT_VERSION, ...parts.map((part) => (part instanceof Date ? `d:${part.toISOString()}` : part === null || part === undefined ? null : typeof part === 'number' ? part : `s:${part}`))])
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** The path of a card (the same one the card routes serve), with its version. */
export function cardPath(ref: CardRef, version: string): string {
  const v = `v=${version}`
  switch (ref.kind) {
    case 'passport':
      return `/api/og/passport/${encodeURIComponent(ref.id)}?${v}`
    case 'post':
      return `/api/og/post/${encodeURIComponent(ref.id)}?${v}`
    case 'squad':
      return `/api/og/squad/${encodeURIComponent(ref.id)}?${v}`
    case 'achievement':
      return `/api/og/achievement/${encodeURIComponent(ref.id)}?user=${encodeURIComponent(ref.user)}&${v}`
  }
}

const stampsOfUsers = async (db: CardLinkDb, where: { username: { equals: string; mode: 'insensitive' } } | { id: { in: string[] } }): Promise<Array<Date | null>> => {
  const rows = await db.user.findMany({ where, select: { id: true, updatedAt: true, profile: { select: { updatedAt: true } } }, orderBy: { id: 'asc' } })
  return rows.flatMap((row) => [row.updatedAt, row.profile?.updatedAt ?? null])
}

/** The path (with its version) of a card that may be shown, or null. The gate is the card's own: this asks the card functions, so the two can never disagree. */
export async function cardLink(db: CardLinkDb, ref: CardRef, now: Date = new Date()): Promise<string | null> {
  switch (ref.kind) {
    case 'passport': {
      if (!(await passportCard(db, ref.id, now))) return null
      const user = await db.user.findFirst({ where: { username: { equals: ref.id, mode: 'insensitive' } }, select: { id: true } })
      if (!user) return null
      const [people, skills, earned] = await Promise.all([
        stampsOfUsers(db, { username: { equals: ref.id, mode: 'insensitive' } }),
        db.userSkill.aggregate({ where: { userId: user.id }, _max: { updatedAt: true }, _count: true }),
        db.userAchievement.aggregate({ where: { userId: user.id }, _max: { earnedAt: true }, _count: true }),
      ])
      return cardPath(ref, versionOf([...people, skills._max.updatedAt, skills._count, earned._max.earnedAt, earned._count]))
    }
    case 'post': {
      if (!(await postCard(db, ref.id, now))) return null
      const post = await db.shipPost.findUnique({ where: { id: ref.id }, select: { authorId: true, editedAt: true, revision: true } })
      if (!post) return null
      return cardPath(ref, versionOf([post.editedAt, post.revision, ...(await stampsOfUsers(db, { id: { in: [post.authorId] } }))]))
    }
    case 'squad': {
      if (!(await squadCard(db, ref.id, now))) return null
      const squad = await db.hackathonTeam.findUnique({
        where: { teamId: ref.id },
        select: { updatedAt: true, hackathon: { select: { updatedAt: true } }, team: { select: { updatedAt: true, project: { select: { updatedAt: true } }, members: { select: { userId: true } } } } },
      })
      if (!squad) return null
      const people = await stampsOfUsers(db, { id: { in: squad.team.members.map((member) => member.userId) } })
      return cardPath(ref, versionOf([squad.updatedAt, squad.hackathon.updatedAt, squad.team.updatedAt, squad.team.project?.updatedAt, squad.team.members.length, ...people]))
    }
    case 'achievement': {
      if (!(await achievementCard(db, ref.id, ref.user, now))) return null
      const earned = await db.userAchievement.findFirst({
        where: { achievement: { slug: ref.id }, user: { username: { equals: ref.user, mode: 'insensitive' } } },
        select: { earnedAt: true, achievement: { select: { updatedAt: true } } },
      })
      if (!earned) return null
      return cardPath(ref, versionOf([earned.earnedAt, earned.achievement.updatedAt, ...(await stampsOfUsers(db, { username: { equals: ref.user, mode: 'insensitive' } }))]))
    }
  }
}
