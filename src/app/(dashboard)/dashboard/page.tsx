import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { DashboardClient } from "./_components/DashboardClient";
import { Metadata } from "next";
import { calculateSkillCompatibility } from "@/lib/scoring";

export const metadata: Metadata = {
  title: "Dashboard - Skill Dating",
  description: "Your builder command center - track progress, discover opportunities, and collaborate",
};

async function getDashboardData(userId: string) {
  // Fetched once up front: reused below instead of re-querying the same
  // user's skills/xp three separate times inside the Promise.all batch.
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
  });

  const userSkills = currentUser?.skills ?? [];
  const userSkillCategories = [...new Set(userSkills.map(s => s.skill.category).filter(Boolean))] as string[];
  const userSkillNames = userSkills.map(s => s.skill.name).slice(0, 10);

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
    // Current build
    prisma.currentBuild.findUnique({
      where: { userId },
      include: {
        hackathon: {
          select: { id: true, name: true, slug: true, startDate: true, endDate: true, status: true }
        }
      }
    }),

    // User's projects (active)
    prisma.project.findMany({
      where: {
        OR: [
          { ownerId: userId },
          { members: { some: { userId } } }
        ],
        status: { in: ['IDEA', 'PLANNING', 'BUILDING', 'TESTING'] }
      },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      include: {
        owner: { select: { id: true, name: true, username: true, image: true } },
        hackathon: { select: { id: true, name: true, slug: true } },
        _count: { select: { members: true, milestones: true } }
      }
    }),

    // User's teams
    prisma.team.findMany({
      where: {
        members: { some: { userId } }
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        project: { select: { id: true, name: true, slug: true, status: true } },
        hackathon: { select: { id: true, name: true, slug: true } },
        members: {
          include: { user: { select: { id: true, name: true, username: true, image: true, builderRole: true } } }
        },
        _count: { select: { members: true } }
      }
    }),

    // Hackathon participations
    prisma.hackathonParticipant.findMany({
      where: { userId },
      include: {
        hackathon: {
          include: {
            _count: { select: { participants: true, teams: true } }
          }
        }
      },
      orderBy: { registeredAt: 'desc' },
      take: 5
    }),

    // User quests with quest details
    prisma.userQuest.findMany({
      where: { userId },
      include: {
        quest: true
      },
      orderBy: { createdAt: 'desc' },
      take: 5
    }),

    // Recent activities
    prisma.activity.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        project: { select: { id: true, name: true, slug: true } }
      }
    }),

    // Recent XP events
    prisma.xPEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10
    }),

    // Recommended builders (users with complementary skills)
    prisma.user.findMany({
      where: {
        id: { not: userId },
        skills: {
          some: {
            skill: { category: { in: userSkillCategories } }
          }
        }
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
          include: { skill: { select: { id: true, name: true, slug: true, category: true, color: true } } }
        },
        _count: { select: { projects: true, hackathons: true, achievements: true } }
      }
    }),

    // Teams recruiting for user's skills
    prisma.team.findMany({
      where: {
        isRecruiting: true,
        lookingFor: { hasSome: userSkillNames },
        NOT: { members: { some: { userId } } }
      },
      take: 6,
      include: {
        owner: { select: { id: true, name: true, username: true, image: true } },
        project: { select: { id: true, name: true, slug: true, status: true } },
        hackathon: { select: { id: true, name: true, slug: true, startDate: true, endDate: true } },
        members: {
          include: { user: { select: { id: true, name: true, username: true, image: true, builderRole: true } } }
        },
        _count: { select: { members: true, applications: true } }
      }
    }),

    // Upcoming hackathons
    prisma.hackathon.findMany({
      where: {
        isPublic: true,
        status: { in: ['UPCOMING', 'ACTIVE'] },
        startDate: { gte: new Date() }
      },
      orderBy: { startDate: 'asc' },
      take: 6,
      include: {
        _count: { select: { participants: true, teams: true } }
      }
    }),
  ]);

  // Calculate compatibility scores for recommended builders using the same
  // scoring function every other surface uses (see src/lib/scoring.ts).
  const userSkillRefs = userSkills.map(s => ({ skillId: s.skillId, level: s.level, category: s.skill.category }));
  const skillNameById = new Map(userSkills.map(s => [s.skillId, s.skill.name]));

  const buildersWithCompatibility = recommendedBuilders.map(builder => {
    const builderSkillRefs = builder.skills.map(s => ({ skillId: s.skillId, level: s.level, category: s.skill.category }));
    for (const s of builder.skills) skillNameById.set(s.skillId, s.skill.name);

    const { score, commonSkillIds } = calculateSkillCompatibility(userSkillRefs, builderSkillRefs);

    return {
      ...builder,
      compatibility: score,
      commonSkills: commonSkillIds.slice(0, 3).map(id => skillNameById.get(id)).filter(Boolean),
    };
  }).sort((a, b) => b.compatibility - a.compatibility);

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
  };
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=/dashboard");
  }

  const data = await getDashboardData(session.user.id);

  return <DashboardClient initialData={data} user={session.user} />;
}