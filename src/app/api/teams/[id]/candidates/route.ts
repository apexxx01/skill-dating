import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError, checkOwnership } from '@/lib/api/handler'
import { calculateSkillCompatibility, type SkillRef } from '@/lib/scoring'

/**
 * Recommend candidate builders for a recruiting team, ranked by
 * compatibility with the team's `lookingFor` skill list. Only the team
 * owner (or a platform admin) can see this — it surfaces the same
 * application-adjacent signal as the applications list, just proactively.
 */
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('Team ID required', 400)
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('Forbidden', 403)
  }

  const team = await prisma.team.findUnique({
    where: { id },
    include: { members: { select: { userId: true } } }
  })
  if (!team) {
    return createApiError('Team not found', 404)
  }

  if (team.lookingFor.length === 0) {
    return createApiResponse({ candidates: [], reason: 'Team has no lookingFor skills set' })
  }

  const wantedSkills = await prisma.skill.findMany({
    where: { name: { in: team.lookingFor } },
    select: { id: true, name: true, category: true }
  })

  if (wantedSkills.length === 0) {
    return createApiResponse({ candidates: [], reason: 'No matching skills found for this team\'s lookingFor list' })
  }

  // The team's "profile" for scoring purposes: wanting a skill is treated
  // like having it at max level, so a candidate who has it scores the
  // shared-skill component fully.
  const wantedProfile: SkillRef[] = wantedSkills.map(s => ({ skillId: s.id, level: 5, category: s.category }))

  const memberIds = new Set(team.members.map(m => m.userId))
  const existingApplicants = await prisma.teamApplication.findMany({
    where: { teamId: id },
    select: { userId: true }
  })
  const excludedIds = new Set([...memberIds, ...existingApplicants.map(a => a.userId), team.ownerId])

  const candidateUsers = await prisma.user.findMany({
    where: {
      id: { notIn: [...excludedIds] },
      skills: { some: { skillId: { in: wantedSkills.map(s => s.id) } } }
    },
    take: 30,
    select: {
      id: true, name: true, username: true, image: true, headline: true,
      builderRole: true, xp: true, rank: true, location: true,
      skills: {
        select: { skillId: true, level: true, skill: { select: { name: true, category: true } } }
      }
    }
  })

  const skillNameById = new Map(wantedSkills.map(s => [s.id, s.name]))

  const candidates = candidateUsers
    .map(candidate => {
      const candidateSkills: SkillRef[] = candidate.skills.map(s => ({
        skillId: s.skillId, level: s.level, category: s.skill.category
      }))
      const { score, commonSkillIds } = calculateSkillCompatibility(wantedProfile, candidateSkills)
      return {
        id: candidate.id,
        name: candidate.name,
        username: candidate.username,
        image: candidate.image,
        headline: candidate.headline,
        builderRole: candidate.builderRole,
        xp: candidate.xp,
        rank: candidate.rank,
        location: candidate.location,
        compatibility: score,
        matchedSkills: commonSkillIds.map(sid => skillNameById.get(sid)).filter((n): n is string => Boolean(n)),
      }
    })
    .filter(c => c.compatibility > 0)
    .sort((a, b) => b.compatibility - a.compatibility)
    .slice(0, 10)

  return createApiResponse({ candidates })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:candidates' } })
