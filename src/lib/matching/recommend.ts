import type { PrismaClient } from '@prisma/client'
import { loadScoringProfiles } from './loader'
import { scoreCompatibility, type ScoringProfile } from './score'
import type { MatchType } from './types'

// Compatibility for the surfaces that suggest people without a drop: the dashboard's recommendations. The same scorer as everywhere
// else (score.ts), for people who may not have a matching profile at all.

type Db = Pick<PrismaClient, 'user' | 'skillEvidence' | 'userCounter' | 'matchingProfile'>

export interface Recommendation {
  /** 0 to 100. */
  score: number
  /** Names of skills both have, the strongest first, at most three. */
  commonSkills: string[]
}

/**
 * The type the score is worked out for on a surface that is not about one relationship: the first one the viewer chose that is not DATING
 * (dating stays out of every other surface), and a plain collaboration for somebody who has chosen none.
 */
export function recommendationType(types: readonly MatchType[]): MatchType {
  return types.find((type) => type !== 'DATING') ?? 'COLLABORATOR'
}

function commonSkillNames(viewer: ScoringProfile, candidate: ScoringProfile): string[] {
  const theirs = new Map(candidate.skills.map((skill) => [skill.slug, skill]))
  return viewer.skills
    .flatMap((skill) => {
      const other = theirs.get(skill.slug)
      return other ? [{ name: skill.name, closeness: Math.min(skill.level, other.level) }] : []
    })
    .sort((a, b) => b.closeness - a.closeness || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((skill) => skill.name)
}

/** The score of each candidate for the viewer. A candidate who is not found (deleted, say) is missing from the answer. */
export async function recommendationsFor(db: Db, viewerId: string, candidateIds: readonly string[], now: Date = new Date()): Promise<Map<string, Recommendation>> {
  const out = new Map<string, Recommendation>()
  if (candidateIds.length === 0) return out
  const [viewer, ...candidates] = await loadScoringProfiles(db, [viewerId, ...candidateIds], now, undefined, { includeWithoutMatchingProfile: true })
  if (!viewer || viewer.userId !== viewerId) return out
  const connectionType = recommendationType(viewer.connectionTypes)
  for (const candidate of candidates) {
    if (candidate.userId === viewerId) continue
    const { score } = scoreCompatibility({ viewer, candidate, connectionType, now })
    out.set(candidate.userId, { score, commonSkills: commonSkillNames(viewer, candidate) })
  }
  return out
}
