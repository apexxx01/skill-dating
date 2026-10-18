import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError, checkOwnership } from '@/lib/api/handler'
import { teamRecommendationsFor } from '@/lib/matching/recommend'
import { blockedUserIds } from '@/lib/blocks'

/**
 * Recommend candidate builders for a recruiting team, ranked by
 * compatibility with the team (src/lib/matching/score.ts, the scorer the daily drops and the gap finder use), which is looking for its `lookingFor`
 * skills and offers what its members can do. Only the team
 * owner (or a platform admin) can see this — it surfaces the same
 * application-adjacent signal as the applications list, just proactively.
 */
export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'teamId' } })
  }

  const isOwner = await checkOwnership(prisma, user.id, 'team', id)
  if (!isOwner && user.role !== 'ADMIN') {
    return createApiError('FORBIDDEN')
  }

  const team = await prisma.team.findUnique({
    where: { id },
    include: { members: { select: { userId: true } }, project: { select: { techStack: true } } }
  })
  if (!team) {
    return createApiError('TEAM_NOT_FOUND')
  }

  if (team.lookingFor.length === 0) {
    return createApiResponse({ candidates: [], nextCursor: null, reason: 'Team has no lookingFor skills set' })
  }

  const wantedSkills = await prisma.skill.findMany({
    where: { name: { in: team.lookingFor } },
    select: { id: true, name: true, slug: true }
  })

  if (wantedSkills.length === 0) {
    return createApiResponse({ candidates: [], nextCursor: null, reason: 'No matching skills found for this team\'s lookingFor list' })
  }

  const memberIds = new Set(team.members.map(m => m.userId))
  const existingApplicants = await prisma.teamApplication.findMany({
    where: { teamId: id },
    select: { userId: true }
  })
  const excludedIds = new Set([
    ...memberIds,
    ...existingApplicants.map(a => a.userId),
    team.ownerId,
    ...(await blockedUserIds(prisma, user.id)),
  ])

  const candidateUsers = await prisma.user.findMany({
    where: {
      id: { notIn: [...excludedIds] },
      skills: { some: { skillId: { in: wantedSkills.map(s => s.id) } } }
    },
    take: 50,
    orderBy: { lastActiveAt: 'desc' },
    select: {
      id: true, name: true, username: true, image: true, headline: true,
      builderRole: true, xp: true, rank: true, location: true,
      skills: { select: { skillId: true } }
    }
  })

  const recommendations = await teamRecommendationsFor(
    prisma,
    { callerId: user.id, memberIds: [...memberIds], wantedSlugs: wantedSkills.map(s => s.slug), techStack: team.project?.techStack ?? [], hackathonId: team.hackathonId },
    candidateUsers.map(candidate => candidate.id)
  )
  const skillNameById = new Map(wantedSkills.map(s => [s.id, s.name]))

  const candidates = candidateUsers
    .map(candidate => {
      const recommendation = recommendations.get(candidate.id)
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
        compatibility: recommendation?.score ?? 0,
        reasons: recommendation?.reasons ?? [],
        matchedSkills: candidate.skills.map(s => skillNameById.get(s.skillId)).filter((n): n is string => Boolean(n)),
      }
    })
    .filter(c => c.compatibility > 0)
    .sort((a, b) => b.compatibility - a.compatibility || a.id.localeCompare(b.id))
    .slice(0, 10)

  // A short ranked recommendation list (top 10), never paged: nextCursor is always null.
  return createApiResponse({ candidates, nextCursor: null })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'teams:candidates' } })
