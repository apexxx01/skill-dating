import type { PrismaClient } from '@prisma/client'
import { calculateSkillCompatibility } from '@/lib/scoring'
import { blockedUserIds } from '@/lib/blocks'

const userSummary = { id: true, name: true, username: true, image: true } as const
const memberSummary = { id: true, name: true, username: true, image: true, builderRole: true } as const

/**
 * Everything the dashboard shows, in one call: the viewer's own work (build,
 * projects, teams, hackathons, quests, activity, XP) and recommendations
 * (builders, recruiting teams, upcoming hackathons). Recommendations leave out
 * anyone blocked with, or by, the viewer, exactly like discover does.
 */
export async function getDashboardData(prisma: PrismaClient, userId: string) {
  const hidden = await blockedUserIds(prisma, userId)

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      xp: true,
      skills: {
        include: { skill: { select: { id: true, name: true, slug: true, category: true } } },
        orderBy: { level: 'desc' },
        take: 20,
      },
    },
  })

  const userSkills = currentUser?.skills ?? []
  const userSkillCategories = [...new Set(userSkills.map((s) => s.skill.category).filter(Boolean))] as string[]
  const userSkillNames = userSkills.map((s) => s.skill.name).slice(0, 10)

  const [
    currentBuild,
    userProjects,
    userTeams,
    hackathonParticipations,
    userQuests,
    recentActivities,
    xpEvents,
    recommendedBuilders,
    recruitingTeams,
    upcomingHackathons,
  ] = await Promise.all([
    prisma.currentBuild.findUnique({
      where: { userId },
      include: { hackathon: { select: { id: true, name: true, slug: true, startDate: true, endDate: true, status: true } } },
    }),

    prisma.project.findMany({
      where: {
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        status: { in: ['IDEA', 'PLANNING', 'BUILDING', 'TESTING'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      include: {
        owner: { select: userSummary },
        hackathon: { select: { id: true, name: true, slug: true } },
        _count: { select: { members: true, milestones: true } },
      },
    }),

    prisma.team.findMany({
      where: { members: { some: { userId } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        project: { select: { id: true, name: true, slug: true, status: true } },
        hackathon: { select: { id: true, name: true, slug: true } },
        members: { include: { user: { select: memberSummary } } },
        _count: { select: { members: true } },
      },
    }),

    prisma.hackathonParticipant.findMany({
      where: { userId },
      include: { hackathon: { include: { _count: { select: { participants: true, teams: true } } } } },
      orderBy: { registeredAt: 'desc' },
      take: 5,
    }),

    prisma.userQuest.findMany({ where: { userId }, include: { quest: true }, orderBy: { createdAt: 'desc' }, take: 5 }),

    prisma.activity.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { project: { select: { id: true, name: true, slug: true } } },
    }),

    prisma.xPEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10 }),

    prisma.user.findMany({
      where: {
        id: { not: userId, ...(hidden.length ? { notIn: hidden } : {}) },
        skills: { some: { skill: { category: { in: userSkillCategories } } } },
      },
      take: 8,
      select: {
        id: true,
        name: true,
        username: true,
        image: true,
        headline: true,
        builderRole: true,
        xp: true,
        rank: true,
        location: true,
        skills: {
          take: 6,
          include: { skill: { select: { id: true, name: true, slug: true, category: true, color: true } } },
        },
        _count: { select: { projects: true, hackathons: true, achievements: true } },
      },
    }),

    prisma.team.findMany({
      where: {
        isRecruiting: true,
        lookingFor: { hasSome: userSkillNames },
        NOT: { members: { some: { userId } } },
        ...(hidden.length ? { ownerId: { notIn: hidden } } : {}),
      },
      take: 6,
      include: {
        owner: { select: userSummary },
        project: { select: { id: true, name: true, slug: true, status: true } },
        hackathon: { select: { id: true, name: true, slug: true, startDate: true, endDate: true } },
        members: { include: { user: { select: memberSummary } } },
        _count: { select: { members: true, applications: true } },
      },
    }),

    prisma.hackathon.findMany({
      where: { isPublic: true, status: { in: ['UPCOMING', 'ACTIVE'] }, startDate: { gte: new Date() } },
      orderBy: { startDate: 'asc' },
      take: 6,
      include: { _count: { select: { participants: true, teams: true } } },
    }),
  ])

  // Same scoring function every other surface uses (src/lib/scoring.ts).
  const userSkillRefs = userSkills.map((s) => ({ skillId: s.skillId, level: s.level, category: s.skill.category }))
  const skillNameById = new Map(userSkills.map((s) => [s.skillId, s.skill.name]))

  const buildersWithCompatibility = recommendedBuilders
    .map((builder) => {
      const builderSkillRefs = builder.skills.map((s) => ({ skillId: s.skillId, level: s.level, category: s.skill.category }))
      for (const s of builder.skills) skillNameById.set(s.skillId, s.skill.name)
      const { score, commonSkillIds } = calculateSkillCompatibility(userSkillRefs, builderSkillRefs)
      return {
        ...builder,
        compatibility: score,
        commonSkills: commonSkillIds.slice(0, 3).map((id) => skillNameById.get(id)).filter(Boolean),
      }
    })
    .sort((a, b) => b.compatibility - a.compatibility)

  return {
    currentBuild,
    userProjects,
    userTeams,
    hackathonParticipations,
    userQuests,
    recentActivities,
    xpEvents,
    userSkills,
    recommendedBuilders: buildersWithCompatibility,
    recruitingTeams,
    upcomingHackathons,
  }
}
