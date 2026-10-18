import type { PrismaClient } from '@prisma/client'
import type { RomanceScoringProfile } from '@/lib/matching/score'
import { countCharacterEndorsers } from './endorsers'
import { LIFE_DIRECTIONS, WORKING_RHYTHMS, type LifeDirection, type WorkingRhythm } from './config'

// Turns rows into the RomanceScoringProfile that scoreRomance() reads: a batch of people at a time, in three queries however many there are. Only the part of a person
// the score is allowed to use is loaded (their answers, what they build with, how many builders vouch for them), nothing private (no gender, no age, no place).

type Db = Pick<PrismaClient, 'romanceProfile' | '$queryRaw'>

const MAX_PROJECTS_FOR_STACK = 5

export type RomanceProfileCache = Map<string, RomanceScoringProfile>

const asDirection = (value: string): LifeDirection => ((LIFE_DIRECTIONS as readonly string[]).includes(value) ? (value as LifeDirection) : 'open')
const asRhythm = (value: string): WorkingRhythm => ((WORKING_RHYTHMS as readonly string[]).includes(value) ? (value as WorkingRhythm) : 'steady')

export async function loadRomanceScoringProfiles(db: Db, userIds: readonly string[], now: Date, cache?: RomanceProfileCache): Promise<RomanceScoringProfile[]> {
  const wanted = [...new Set(userIds)]
  const missing = cache ? wanted.filter((id) => !cache.has(id)) : wanted
  const loaded = new Map<string, RomanceScoringProfile>()

  if (missing.length > 0) {
    const rows = await db.romanceProfile.findMany({
      where: { userId: { in: missing }, user: { deletedAt: null } },
      select: {
        userId: true,
        ambition: true,
        direction: true,
        rhythm: true,
        obsessions: true,
        user: {
          select: {
            currentBuild: { select: { techStack: true } },
            ownedProjects: { select: { techStack: true }, orderBy: { updatedAt: 'desc' }, take: MAX_PROJECTS_FOR_STACK },
          },
        },
      },
    })
    const endorsers = await countCharacterEndorsers(db, rows.map((row) => row.userId), now)
    for (const row of rows) {
      loaded.set(row.userId, {
        userId: row.userId,
        ambition: row.ambition,
        direction: asDirection(row.direction),
        rhythm: asRhythm(row.rhythm),
        obsessions: row.obsessions,
        techStack: [...(row.user.currentBuild?.techStack ?? []), ...row.user.ownedProjects.flatMap((project) => project.techStack)],
        endorsers: endorsers.get(row.userId) ?? 0,
      })
    }
    if (cache) for (const [id, profile] of loaded) cache.set(id, profile)
  }

  return wanted.flatMap((id) => {
    const profile = cache?.get(id) ?? loaded.get(id)
    return profile ? [profile] : []
  })
}
