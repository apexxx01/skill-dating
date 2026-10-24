import { applyFieldVisibility, visibilityOf } from '@/lib/privacy/settings'
import { areConnected } from '@/lib/privacy/messaging'
import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { authorize } from '@/lib/api/handler'
import { recommendationsFor } from '@/lib/matching/recommend'
import { blockRelation } from '@/lib/blocks'
import { liveRank } from '@/lib/leaderboard'

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').pop()

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'userId' } })
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
    return createApiError('USER_NOT_FOUND')
  }

  // Someone who has blocked the viewer looks, to the viewer, like an account
  // that does not exist. The blocker can still open the profile (to unblock).
  const relation = await blockRelation(prisma, user.id, id)
  if (relation === 'BLOCKED_BY_THEM') {
    return createApiError('USER_NOT_FOUND')
  }

  let compatibility: number | null = null
  let compatibilityReasons: string[] = []
  if (id !== user.id) {
    const recommendation = (await recommendationsFor(prisma, user.id, [id])).get(id)
    compatibility = recommendation?.score ?? 0
    compatibilityReasons = recommendation?.reasons ?? []
  }

  // `rank` is computed from the XP event log: the stored column is never
  // updated and would always read 0. The account's own email is returned to
  // that account only; nobody else's is ever exposed.
  const standing = await liveRank(prisma, id)
  const own = id === user.id ? await prisma.user.findUnique({ where: { id }, select: { email: true } }) : null
  // The passport's "Reliable teammate" badge (docs/SQUADS.md): only the badge, never the reliability number behind it.
  const reliability = await prisma.userReliability.findUnique({ where: { userId: id }, select: { badge: true } })

  // Passport field visibility (a privacy setting): fields the person keeps to connections or to themselves are null for others.
  const privacy = id === user.id ? null : await prisma.profile.findUnique({ where: { userId: id }, select: { fieldVisibility: true } })
  const visibility = visibilityOf(privacy?.fieldVisibility)
  const needsConnection = id !== user.id && Object.values(visibility).includes('CONNECTIONS')
  const visible = applyFieldVisibility(targetUser, visibility, { isOwner: id === user.id, connected: needsConnection ? await areConnected(prisma, user.id, id) : false })

  return createApiResponse({
    ...visible,
    rank: standing.rank ?? 0,
    ...(own ? { email: own.email } : {}),
    compatibility,
    compatibilityReasons,
    blockedByMe: relation === 'BLOCKED_BY_ME',
    reliableTeammate: reliability?.badge ?? false,
  })
}, { cache: { maxAge: 30 }, rateLimit: { windowMs: 60000, maxRequests: 120, keyPrefix: 'users:get' } })