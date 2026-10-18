import type { PrismaClient, SquadRole } from '@prisma/client'
import { isValidTimeZone, utcOffsetMinutes } from '@/lib/time'
import { accountDistrust } from '@/lib/trust'
import { inferRoles, type RoleRef } from './roles'
import type { PairHistory, StrengthMember } from './strength'

// Loads what squad strength, the squad builder and the solo-pool optimiser read about people, from the database, a batch at a time (a handful of
// queries however many people): each person's facts for a hackathon, and what every pair of them has done together before.

type Db = PrismaClient

export interface SquadPerson extends StrengthMember {
  id: string
}

/** A stable key for an unordered pair. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/**
 * The squad facts of these people for a hackathon, keyed by id, skipping anybody deleted. `roles` gives the role a person plays when it is already
 * decided (their declared role on the team, the slot they fill, the role a proposal gave them).
 */
export async function loadSquadPeople(
  db: Db,
  hackathonId: string,
  userIds: readonly string[],
  now: Date,
  options: { roles?: ReadonlyMap<string, RoleRef | null>; pledgesExpected?: boolean } = {}
): Promise<Map<string, SquadPerson>> {
  const ids = [...new Set(userIds)]
  const out = new Map<string, SquadPerson>()
  if (ids.length === 0) return out

  const [users, participants, ships, shippedProjects, pledges, reliability] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: {
        id: true,
        timezone: true,
        builderRole: true,
        matchingProfile: { select: { hoursPerWeek: true } },
        skills: { select: { skill: { select: { slug: true, name: true } } } },
      },
    }),
    db.hackathonParticipant.findMany({ where: { hackathonId, userId: { in: ids } }, select: { userId: true, skills: true, preferredRoles: true } }),
    db.userCounter.findMany({ where: { userId: { in: ids }, key: 'ships', value: { gt: 0 } }, select: { userId: true } }),
    db.project.findMany({ where: { shippedAt: { not: null }, OR: [{ ownerId: { in: ids } }, { members: { some: { userId: { in: ids } } } }] }, select: { ownerId: true, members: { select: { userId: true } } } }),
    db.commitmentPledge.findMany({ where: { hackathonId, userId: { in: ids } }, select: { userId: true, hoursAvailable: true } }),
    db.userReliability.findMany({ where: { userId: { in: ids }, reviews: { gt: 0 } }, select: { userId: true, score: true } }),
  ])
  const participantBy = new Map(participants.map((row) => [row.userId, row]))
  const shipped = new Set(ships.map((row) => row.userId))
  for (const project of shippedProjects) {
    shipped.add(project.ownerId)
    for (const member of project.members) shipped.add(member.userId)
  }
  const pledgeBy = new Map(pledges.map((row) => [row.userId, row]))
  const reliabilityBy = new Map(reliability.map((row) => [row.userId, row.score]))

  for (const user of users) {
    const participant = participantBy.get(user.id)
    const skillNames = user.skills.flatMap((row) => [row.skill.name, row.skill.slug])
    const preferred: RoleRef[] = (participant?.preferredRoles ?? []).map((role: SquadRole) => ({ role }))
    const inferred = inferRoles([user.builderRole, ...user.skills.map((row) => row.skill.name), ...(participant?.skills ?? [])])
    const pledge = pledgeBy.get(user.id)
    out.set(user.id, {
      id: user.id,
      userId: user.id,
      role: options.roles?.get(user.id) ?? null,
      canPlay: [...preferred, ...inferred],
      skills: [...skillNames, ...(participant?.skills ?? [])],
      utcOffsetMinutes: isValidTimeZone(user.timezone) ? utcOffsetMinutes(now, user.timezone) : null,
      hoursPerWeek: user.matchingProfile?.hoursPerWeek ?? null,
      shipped: shipped.has(user.id),
      pledge: options.pledgesExpected ? (pledge ? { confirmed: true, hours: pledge.hoursAvailable } : { confirmed: false, hours: null }) : null,
      reliability: reliabilityBy.get(user.id) ?? null,
    })
  }
  return out
}

export interface PairFacts {
  history: PairHistory[]
  /** Pairs (pairKey) who must never be on one squad: blocked either way, or each said they would not build with the other again. */
  forbidden: Set<string>
}

/** What these people have done together before (would build again, hackathon teams shared), and which pairs of them must be kept apart. */
export async function loadPairFacts(db: Db, userIds: readonly string[]): Promise<PairFacts> {
  const ids = [...new Set(userIds)]
  if (ids.length < 2) return { history: [], forbidden: new Set() }

  const [blocks, reviews, memberships] = await Promise.all([
    db.block.findMany({ where: { blockerId: { in: ids }, blockedId: { in: ids } }, select: { blockerId: true, blockedId: true } }),
    db.peerReview.findMany({ where: { reviewerId: { in: ids }, revieweeId: { in: ids } }, select: { reviewerId: true, revieweeId: true, wouldBuildAgain: true }, orderBy: { createdAt: 'asc' } }),
    db.hackathonTeamMember.findMany({ where: { userId: { in: ids } }, select: { userId: true, hackathonTeamId: true } }),
  ])

  const forbidden = new Set<string>()
  for (const block of blocks) forbidden.add(pairKey(block.blockerId, block.blockedId))

  // What each person last said about each other person ("reviewer>reviewee" -> would build again): reviews come oldest first, so the latest wins.
  const said = new Map<string, boolean>()
  for (const review of reviews) said.set(`${review.reviewerId}>${review.revieweeId}`, review.wouldBuildAgain)
  const yes = new Set<string>()
  for (const [direction, again] of said) if (again) yes.add(pairKey(...(direction.split('>') as [string, string])))
  for (const [direction, again] of said) {
    const [a, b] = direction.split('>')
    // A mutual "no": both said, about the other, that they would not build together again.
    if (!again && said.get(`${b}>${a}`) === false) forbidden.add(pairKey(a, b))
  }

  const teamsOf = new Map<string, string[]>()
  for (const row of memberships) teamsOf.set(row.hackathonTeamId, [...(teamsOf.get(row.hackathonTeamId) ?? []), row.userId])
  const together = new Map<string, number>()
  for (const members of teamsOf.values()) {
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) together.set(pairKey(members[i], members[j]), (together.get(pairKey(members[i], members[j])) ?? 0) + 1)
  }

  const keys = new Set([...yes, ...together.keys()])
  const history: PairHistory[] = [...keys].map((key) => {
    const [a, b] = key.split('|')
    return { a, b, wouldBuildAgain: yes.has(key) && !forbidden.has(key), teamsTogether: together.get(key) ?? 0 }
  })
  return { history, forbidden }
}

/** Who of these accounts the trust gate trusts (a week old, verified email; src/lib/trust.ts) and are not deleted. */
export async function trustedIds(db: Db, userIds: readonly string[], now: Date): Promise<Set<string>> {
  const users = await db.user.findMany({ where: { id: { in: [...new Set(userIds)] }, deletedAt: null }, select: { id: true, createdAt: true, isEmailVerified: true } })
  return new Set(users.filter((user) => accountDistrust(user, now) === null).map((user) => user.id))
}
