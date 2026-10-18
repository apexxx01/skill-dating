import type { PrismaClient } from '@prisma/client'
import { levelFor } from '@/lib/levels'
import type { MatchPerson } from '@/types/api'

// The short card of a person that matching shows: drops, sparks and matches all use it. Public profile fields only - never an email, a date
// of birth, or anything a person keeps private.

type Db = Pick<PrismaClient, 'user' | 'skillEvidence' | 'userCounter'>

const TOP_SKILLS = 5

export async function loadPersonSummaries(db: Db, userIds: readonly string[]): Promise<Map<string, MatchPerson>> {
  const ids = [...new Set(userIds)]
  const people = new Map<string, MatchPerson>()
  if (ids.length === 0) return people

  const [users, evidence, ships] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: {
        id: true,
        name: true,
        username: true,
        image: true,
        headline: true,
        builderRole: true,
        location: true,
        xp: true,
        skills: { select: { level: true, skill: { select: { slug: true, name: true } } }, orderBy: { level: 'desc' }, take: TOP_SKILLS },
      },
    }),
    db.skillEvidence.groupBy({ by: ['userId'], where: { userId: { in: ids }, verifiedAt: { not: null } }, _count: { _all: true } }),
    db.userCounter.findMany({ where: { userId: { in: ids }, key: 'ships' }, select: { userId: true, value: true } }),
  ])
  const verified = new Map(evidence.map((row) => [row.userId, row._count._all]))
  const shipped = new Map(ships.map((row) => [row.userId, row.value]))
  for (const user of users) {
    const level = levelFor(user.xp)
    people.set(user.id, {
      id: user.id,
      name: user.name,
      username: user.username,
      image: user.image,
      headline: user.headline,
      builderRole: user.builderRole,
      location: user.location,
      level: level.level,
      tier: level.tier,
      skills: user.skills.map((row) => ({ slug: row.skill.slug, name: row.skill.name, level: row.level })),
      proof: { verifiedEvidence: verified.get(user.id) ?? 0, shipped: shipped.get(user.id) ?? 0 },
    })
  }
  return people
}

/** What a person has shown so far, to compare with later (the second look). */
export async function proofSnapshot(db: Db, userId: string): Promise<{ tier: string; verifiedEvidence: number } | null> {
  const person = (await loadPersonSummaries(db, [userId])).get(userId)
  return person ? { tier: person.tier, verifiedEvidence: person.proof.verifiedEvidence } : null
}
