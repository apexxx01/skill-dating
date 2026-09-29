import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { authorize } from '@/lib/api/handler'
import { calculateSkillCompatibility } from '@/lib/scoring'
import { blockRelation } from '@/lib/blocks'

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('User ID required', 400)
  }

  const targetUser = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      username: true,
      image: true,
      bio: true,
      headline: true,
      location: true,
      timezone: true,
      availability: true,
      builderRole: true,
      website: true,
      githubUsername: true,
      twitterUsername: true,
      linkedinUrl: true,
      xp: true,
      rank: true,
      reputationScore: true,
      role: true,
      verificationLevel: true,
      isEmailVerified: true,
      githubConnected: true,
      portfolioVerified: true,
      organizationVerified: true,
      createdAt: true,
      skills: {
        include: {
          skill: { select: { id: true, name: true, slug: true, category: true, color: true, icon: true } }
        }
      },
      skillEvidences: {
        take: 20,
        include: { skill: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: 'desc' }
      },
      ownedProjects: {
        take: 10,
        select: { id: true, name: true, slug: true, status: true, thumbnail: true, techStack: true },
        orderBy: { updatedAt: 'desc' }
      },
      achievements: {
        include: { achievement: true },
        orderBy: { earnedAt: 'desc' }
      },
      currentBuild: true,
      projects: {
        take: 10,
        select: {
          role: true,
          project: { select: { id: true, name: true, slug: true, status: true, thumbnail: true, techStack: true } }
        },
        orderBy: { joinedAt: 'desc' }
      },
      ownedTeams: {
        take: 10,
        select: {
          id: true,
          name: true,
          slug: true,
          isRecruiting: true,
          maxSize: true,
          project: { select: { id: true, name: true, slug: true, status: true } },
          _count: { select: { members: true, applications: true } }
        },
        orderBy: { createdAt: 'desc' }
      },
      teams: {
        take: 10,
        select: {
          role: true,
          team: {
            select: {
              id: true,
              name: true,
              slug: true,
              isRecruiting: true,
              maxSize: true,
              project: { select: { id: true, name: true, slug: true, status: true } },
              _count: { select: { members: true, applications: true } }
            }
          }
        },
        orderBy: { joinedAt: 'desc' }
      },
    }
  })

  if (!targetUser) {
    return createApiError('User not found', 404)
  }

  // Someone who has blocked the viewer looks, to the viewer, like an account
  // that does not exist. The blocker can still open the profile (to unblock).
  const relation = await blockRelation(prisma, user.id, id)
  if (relation === 'BLOCKED_BY_THEM') {
    return createApiError('User not found', 404)
  }

  let compatibility = null
  if (id !== user.id) {
    const mySkills = await prisma.userSkill.findMany({
      where: { userId: user.id },
      select: { skillId: true, level: true, skill: { select: { category: true } } }
    })
    const theirSkills = await prisma.userSkill.findMany({
      where: { userId: id },
      select: { skillId: true, level: true, skill: { select: { category: true } } }
    })
    compatibility = calculateSkillCompatibility(
      mySkills.map(s => ({ skillId: s.skillId, level: s.level, category: s.skill.category })),
      theirSkills.map(s => ({ skillId: s.skillId, level: s.level, category: s.skill.category }))
    ).score
  }

  return createApiResponse({ ...targetUser, compatibility, blockedByMe: relation === 'BLOCKED_BY_ME' })
}, { rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'users:get' } })