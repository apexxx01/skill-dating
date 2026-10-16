import type { PrismaClient } from '@prisma/client'
import { levelFor } from '@/lib/levels'
import { isValidTimeZone, utcOffsetMinutes } from '@/lib/time'
import { readIntentTags } from './profile'
import { readWorkingStyle } from './quiz'
import type { ScoringProfile, ScoringSkill } from './score'
import type { MatchType } from './types'

// Turns the rows of the database into the ScoringProfile that the pure scorer reads: a batch of people at a time, in a handful of
// queries however many there are (never one per person).

type Db = Pick<PrismaClient, 'user' | 'skillEvidence' | 'userCounter'>

const MAX_PROJECTS_FOR_STACK = 5

/** Profiles already loaded in this run, so a person who is a candidate for many viewers is loaded once. */
export type ProfileCache = Map<string, ScoringProfile>

/** A stored "YYYY-MM-DD" (the local day of the last XP) as a moment. */
function dayToDate(day: string | null): Date | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * The scoring profiles of these people, in the order of `userIds`, skipping anybody who has no matching profile or is gone.
 * Anything already in `cache` is not loaded again, and what is loaded is added to it.
 */
export async function loadScoringProfiles(
  db: Db,
  userIds: readonly string[],
  now: Date,
  cache?: ProfileCache,
  options: { includeWithoutMatchingProfile?: boolean } = {}
): Promise<ScoringProfile[]> {
  const wanted = [...new Set(userIds)]
  const missing = cache ? wanted.filter((id) => !cache.has(id)) : wanted
  const loaded = new Map<string, ScoringProfile>()

  if (missing.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: missing }, deletedAt: null, ...(options.includeWithoutMatchingProfile ? {} : { matchingProfile: { isNot: null } }) },
      select: {
        id: true,
        timezone: true,
        lastActiveAt: true,
        currentStreak: true,
        lastStreakDay: true,
        xp: true,
        profile: { select: { cityKey: true, city: true } },
        matchingProfile: true,
        skills: { select: { skillId: true, level: true, skill: { select: { slug: true, name: true } } } },
        currentBuild: { select: { techStack: true } },
        ownedProjects: { select: { techStack: true }, orderBy: { updatedAt: 'desc' }, take: MAX_PROJECTS_FOR_STACK },
      },
    })
    const ids = users.map((user) => user.id)

    const [evidence, counters] = await Promise.all([
      db.skillEvidence.groupBy({ by: ['userId', 'skillId'], where: { userId: { in: ids }, verifiedAt: { not: null } }, _count: { _all: true } }),
      db.userCounter.findMany({ where: { userId: { in: ids }, key: { in: ['ships', 'endorsements_received'] } }, select: { userId: true, key: true, value: true } }),
    ])
    const evidenceBy = new Map<string, Map<string, number>>()
    for (const row of evidence) {
      const perSkill = evidenceBy.get(row.userId) ?? new Map<string, number>()
      perSkill.set(row.skillId, row._count._all)
      evidenceBy.set(row.userId, perSkill)
    }
    const counterBy = new Map<string, Record<string, number>>()
    for (const row of counters) counterBy.set(row.userId, { ...(counterBy.get(row.userId) ?? {}), [row.key]: row.value })

    for (const user of users) {
      // Somebody without a matching profile (only when asked for) has no stated wishes: everything that comes from the profile is empty.
      const stored = user.matchingProfile
      const perSkill = evidenceBy.get(user.id) ?? new Map<string, number>()
      const skills: ScoringSkill[] = user.skills.map((row) => ({ slug: row.skill.slug, name: row.skill.name, level: row.level, evidence: perSkill.get(row.skillId) ?? 0 }))
      const counts = counterBy.get(user.id) ?? {}
      const lastXpAt = dayToDate(user.lastStreakDay)
      loaded.set(user.id, {
        userId: user.id,
        connectionTypes: stored ? ([...stored.connectionTypes] as MatchType[]) : [],
        intentTags: readIntentTags(stored?.intentTags),
        hoursPerWeek: stored?.hoursPerWeek ?? null,
        availableFrom: stored?.availableFrom ?? null,
        remoteOk: stored?.remoteOk ?? true,
        cityOnly: stored?.cityOnly ?? false,
        lookingForSkills: stored?.lookingForSkills ?? [],
        workingStyle: readWorkingStyle(stored?.workingStyle),
        skills,
        techStack: [...(user.currentBuild?.techStack ?? []), ...user.ownedProjects.flatMap((project) => project.techStack)],
        utcOffsetMinutes: isValidTimeZone(user.timezone) ? utcOffsetMinutes(now, user.timezone) : null,
        cityKey: user.profile?.cityKey ?? null,
        city: user.profile?.city ?? null,
        proof: {
          verifiedEvidence: [...perSkill.values()].reduce((sum, count) => sum + count, 0),
          tier: levelFor(user.xp).tier,
          shipped: counts.ships ?? 0,
          endorsements: counts.endorsements_received ?? 0,
        },
        activity: { streak: user.currentStreak, lastActiveAt: user.lastActiveAt, lastXpAt },
      })
    }
    if (cache) for (const [id, profile] of loaded) cache.set(id, profile)
  }

  return wanted.flatMap((id) => {
    const profile = cache?.get(id) ?? loaded.get(id)
    return profile ? [profile] : []
  })
}
