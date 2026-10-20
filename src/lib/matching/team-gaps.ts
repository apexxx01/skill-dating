import type { PrismaClient } from '@prisma/client'
import type { TeamGapCandidate, TeamGapsResponse } from '@/types/api'
import { findCandidateIds, type Viewer } from './candidates'
import { DROP_CONFIG } from './config'
import { analyzeGaps } from './gaps'
import { loadPriorSignals } from '@/lib/squads/prior'
import { loadScoringProfiles } from './loader'
import { scoreCompatibility, type ScoringProfile, type ScoringSkill } from './score'
import { loadPersonSummaries } from './summary'
import type { MatchType } from './types'

// The gap finder: what a team is missing (gaps.ts) and the five people who could fill it, from the same pool and the same scorer as the daily
// drops. The team is scored as one viewer: it is looking for the skills it lacks and offers the skills its members have.

type Db = PrismaClient

export const GAP_CANDIDATES = 5

/** The kinds of teammate a team looks for: hackathon teams for hackathon teammates, others for collaborators or cofounders. Never dating. */
export function teamPoolTypes(hackathonId: string | null): MatchType[] {
  return hackathonId ? ['HACKATHON_TEAMMATE'] : ['COLLABORATOR', 'COFOUNDER']
}

/** The skills of several people as one list: each skill once, at the highest level any of them has. */
export function mergeSkills(lists: readonly (readonly ScoringSkill[])[]): ScoringSkill[] {
  const merged = new Map<string, ScoringSkill>()
  for (const list of lists) {
    for (const skill of list) {
      const have = merged.get(skill.slug)
      if (!have || skill.level > have.level) merged.set(skill.slug, { ...skill })
    }
  }
  return [...merged.values()]
}

export async function loadTeamGaps(db: Db, teamId: string, callerId: string, now: Date = new Date()): Promise<TeamGapsResponse | null> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      name: true,
      maxSize: true,
      ownerId: true,
      hackathonId: true,
      lookingFor: true,
      project: { select: { techStack: true, lookingFor: true } },
      members: { select: { userId: true, user: { select: { builderRole: true, skills: { select: { skill: { select: { slug: true } } } } } } } },
      applications: { select: { userId: true } },
    },
  })
  if (!team) return null

  const catalog = await db.skill.findMany({ where: { isActive: true }, select: { id: true, slug: true, name: true } })
  const members = team.members.map((member) => ({
    userId: member.userId,
    skills: member.user.skills.map((row) => row.skill.slug),
    builderRole: member.user.builderRole,
  }))
  const projectNeeds = team.project?.lookingFor ?? []
  const projectStack = team.project?.techStack ?? []
  const analysis = analyzeGaps({ teamNeeds: team.lookingFor, projectNeeds, projectStack, members, catalog })

  const response: TeamGapsResponse = {
    team: { id: team.id, name: team.name, maxSize: team.maxSize, memberCount: team.members.length, openSlots: Math.max(0, team.maxSize - team.members.length) },
    needs: { team: team.lookingFor, project: projectNeeds, stack: projectStack },
    missing: { skills: analysis.missingSkills, roles: analysis.missingRoles },
    covered: { skills: analysis.coveredSkills, roles: analysis.coveredRoles },
    unmatchedStack: analysis.unmatchedStack,
    candidates: [],
  }

  // --- Who could fill it ------------------------------------------------------------------------------------
  const [caller] = await loadScoringProfiles(db, [callerId], now, undefined, { includeWithoutMatchingProfile: true })
  if (!caller) return response
  const memberProfiles = await loadScoringProfiles(db, team.members.map((member) => member.userId), now, undefined, { includeWithoutMatchingProfile: true })
  const teamSkills = mergeSkills(memberProfiles.map((profile) => profile.skills))
  const wantedSlugs = analysis.missingSkills.map((skill) => skill.slug)
  const missingBySlug = new Map(analysis.missingSkills.map((skill) => [skill.slug, skill.name]))

  // The team as a viewer: it looks for the skills it lacks, offers the ones it has, and builds with its project's stack. The owner's own working style,
  // hours and time zone stand in for the team's.
  const teamViewer: ScoringProfile = { ...caller, lookingForSkills: wantedSlugs, skills: teamSkills, techStack: projectStack, intentTags: [], cityOnly: false }
  const viewer: Viewer = {
    userId: callerId,
    cityOnly: false,
    cityKey: caller.cityKey,
    lookingForSkillIds: catalog.filter((skill) => wantedSlugs.includes(skill.slug)).map((skill) => skill.id),
    skillSlugs: teamSkills.map((skill) => skill.slug),
  }
  const excludeIds = [...new Set([team.ownerId, ...team.members.map((member) => member.userId), ...team.applications.map((application) => application.userId)])]

  const best = new Map<string, TeamGapCandidate & { profile: ScoringProfile }>()
  for (const type of teamPoolTypes(team.hackathonId)) {
    const ids = await findCandidateIds(db, viewer, type, now, DROP_CONFIG, { teamSuggestion: true, excludeIds })
    for (let from = 0; from < ids.length; from += DROP_CONFIG.scoreBatch) {
      const batch = await loadScoringProfiles(db, ids.slice(from, from + DROP_CONFIG.scoreBatch), now)
      const priors = await loadPriorSignals(db, callerId, batch.map((candidate) => candidate.userId))
      for (const candidate of batch) {
        const result = scoreCompatibility({ viewer: teamViewer, candidate, connectionType: type, now, prior: priors.get(candidate.userId) })
        if (result.excluded || result.score < DROP_CONFIG.minScore) continue
        const have = best.get(candidate.userId)
        if (have && have.score >= result.score) continue
        best.set(candidate.userId, {
          person: undefined as never,
          connectionType: type,
          score: result.score,
          reasons: result.reasons,
          fills: candidate.skills.filter((skill) => missingBySlug.has(skill.slug)).map((skill) => missingBySlug.get(skill.slug)!).sort((a, b) => a.localeCompare(b)),
          profile: candidate,
        })
      }
    }
  }

  const top = [...best.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])).slice(0, GAP_CANDIDATES)
  const people = await loadPersonSummaries(db, top.map(([id]) => id))
  response.candidates = top.flatMap(([id, entry]) => {
    const person = people.get(id)
    return person ? [{ person, connectionType: entry.connectionType, score: entry.score, reasons: entry.reasons, fills: entry.fills }] : []
  })
  return response
}
