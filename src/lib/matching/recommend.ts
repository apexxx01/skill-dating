import type { PrismaClient } from '@prisma/client'
import { loadPriorSignals } from '@/lib/squads/prior'
import { loadScoringProfiles } from './loader'
import { scoreCompatibility, type ScoringProfile } from './score'
import { mergeSkills, teamPoolTypes } from './team-gaps'
import type { MatchType } from './types'

// Compatibility for the surfaces that suggest people without a drop: the dashboard's recommendations, /api/discover, a profile read and a
// team's candidate list. The same scorer as everywhere else (score.ts), for people who may not have a matching profile at all.

type Db = Pick<PrismaClient, 'user' | 'skillEvidence' | 'userCounter' | 'matchingProfile' | 'userReliability' | 'peerReview'>

export interface Recommendation {
  /** 0 to 100. */
  score: number
  /** Names of skills both have, the strongest first, at most three. */
  commonSkills: string[]
  /** At most three human-readable lines on why, strongest first. */
  reasons: string[]
}

/**
 * The type the score is worked out for on a surface that is not about one relationship: the first one the viewer chose that is not romance
 * (romance stays out of every other surface), and a plain collaboration for somebody who has chosen none.
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
  const priors = await loadPriorSignals(db, viewerId, candidates.map((candidate) => candidate.userId))
  for (const candidate of candidates) {
    if (candidate.userId === viewerId) continue
    const { score, reasons } = scoreCompatibility({ viewer, candidate, connectionType, now, prior: priors.get(candidate.userId) })
    out.set(candidate.userId, { score, commonSkills: commonSkillNames(viewer, candidate), reasons })
  }
  return out
}

export interface TeamViewerInput {
  /** The person asking (their hours, time zone and working style stand in for the team's). */
  callerId: string
  memberIds: readonly string[]
  /** Slugs of the skills the team is looking for. */
  wantedSlugs: readonly string[]
  /** The linked project's stack. */
  techStack: readonly string[]
  hackathonId: string | null
}

/** Scores candidates for a team: it is one viewer that looks for `wantedSlugs`, offers what its members can do and builds with its project's stack. */
export async function teamRecommendationsFor(db: Db, team: TeamViewerInput, candidateIds: readonly string[], now: Date = new Date()): Promise<Map<string, Recommendation>> {
  const out = new Map<string, Recommendation>()
  if (candidateIds.length === 0) return out
  const [caller] = await loadScoringProfiles(db, [team.callerId], now, undefined, { includeWithoutMatchingProfile: true })
  if (!caller) return out
  const members = await loadScoringProfiles(db, team.memberIds, now, undefined, { includeWithoutMatchingProfile: true })
  const teamViewer: ScoringProfile = { ...caller, lookingForSkills: team.wantedSlugs, skills: mergeSkills(members.map((member) => member.skills)), techStack: team.techStack, intentTags: [], cityOnly: false }
  const connectionType = teamPoolTypes(team.hackathonId)[0]
  const priors = await loadPriorSignals(db, team.callerId, candidateIds)
  for (const candidate of await loadScoringProfiles(db, candidateIds, now, undefined, { includeWithoutMatchingProfile: true })) {
    const { score, reasons } = scoreCompatibility({ viewer: teamViewer, candidate, connectionType, now, prior: priors.get(candidate.userId) })
    out.set(candidate.userId, { score, commonSkills: commonSkillNames(teamViewer, candidate), reasons })
  }
  return out
}
