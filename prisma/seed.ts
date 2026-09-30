/**
 * Demo/dev seed script.
 *
 * Run with: npm run db:seed
 * (invokes `tsx prisma/seed.ts` against whatever DATABASE_URL is active)
 *
 * Safe to re-run: every record is upserted on a stable natural key
 * (email for users, slug for projects/teams/hackathons/achievements/skills),
 * so running it twice does not duplicate data or throw on unique
 * constraints.
 *
 * Demo login credentials (email / plaintext password used before hashing):
 *   demo1@demo.skilldating.test / DemoPass123!   (Aanya Kapoor - fully populated account:
 *     owns a shipped project, owns a recruiting team, member of a hackathon)
 *   demo2@demo.skilldating.test / DemoPass123!   (Leo Fontaine - owns the full team + an
 *     idea-stage project, applied to another team)
 * All 12 seeded users share the password DemoPass123! for convenience during
 * a demo walkthrough.
 *
 * Also seeded: skill evidence and peer endorsements, project updates and
 * milestones, profile activity, granted achievements, connections (accepted
 * and pending), and read state plus reactions on the demo conversations.
 * Each is matched on its natural identity (see the comments on each block).
 */

import { PrismaClient, ProjectStatus, HackathonStatus, HackathonParticipantStatus, TeamApplicationStatus } from '@prisma/client'
import { hash } from 'bcryptjs'
import { ACHIEVEMENT_DEFINITIONS, type AchievementDefinition } from '../src/lib/achievement-definitions'
import { grantAchievement } from '../src/lib/achievements'

const prisma = new PrismaClient()

const DEMO_DOMAIN = 'demo.skilldating.test'
const DEMO_PASSWORD = 'DemoPass123!'

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const SKILLS = [
  { name: 'React', slug: 'react', category: 'Frontend' },
  { name: 'TypeScript', slug: 'typescript', category: 'Language' },
  { name: 'Node.js', slug: 'nodejs', category: 'Backend' },
  { name: 'Python', slug: 'python', category: 'Language' },
  { name: 'PostgreSQL', slug: 'postgresql', category: 'Database' },
  { name: 'UI/UX Design', slug: 'ui-ux-design', category: 'Design' },
  { name: 'Product Management', slug: 'product-management', category: 'Product' },
  { name: 'Machine Learning', slug: 'machine-learning', category: 'AI' },
  { name: 'Go', slug: 'go', category: 'Language' },
  { name: 'DevOps', slug: 'devops', category: 'Infrastructure' },
  { name: 'Mobile (React Native)', slug: 'react-native', category: 'Mobile' },
  { name: 'Growth Marketing', slug: 'growth-marketing', category: 'Marketing' },
  { name: 'Solidity', slug: 'solidity', category: 'Blockchain' },
  { name: 'Rust', slug: 'rust', category: 'Language' },
  { name: 'Figma', slug: 'figma', category: 'Design' },
] as const

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

interface SeedUser {
  email: string
  username: string
  name: string
  headline: string
  bio: string
  builderRole: string
  location: string
  xp: number
  skills: { slug: string; level: number }[]
}

const USERS: SeedUser[] = [
  {
    email: `demo1@${DEMO_DOMAIN}`,
    username: 'aanya_builds',
    name: 'Aanya Kapoor',
    headline: 'Full-stack builder shipping weekend projects into real products',
    bio: 'I started coding in college hackathons and never stopped. These days I split time between a full-time backend role and half a dozen side projects, most of which die in week two — but the ones that survive tend to survive hard.',
    builderRole: 'Full-Stack Engineer',
    location: 'Bengaluru, India',
    xp: 2450,
    skills: [{ slug: 'react', level: 4 }, { slug: 'nodejs', level: 5 }, { slug: 'postgresql', level: 4 }, { slug: 'typescript', level: 4 }],
  },
  {
    email: `demo2@${DEMO_DOMAIN}`,
    username: 'leo_ships',
    name: 'Leo Fontaine',
    headline: 'Product-minded engineer, obsessed with shipping fast and ugly',
    bio: 'Ex-agency dev who got tired of building other people\'s ideas. Now I build my own, badly, in public. Looking for a designer who can make my Tailwind crimes look intentional.',
    builderRole: 'Product Engineer',
    location: 'Lyon, France',
    xp: 1890,
    skills: [{ slug: 'react', level: 3 }, { slug: 'nodejs', level: 3 }, { slug: 'growth-marketing', level: 3 }],
  },
  {
    email: `demo3@${DEMO_DOMAIN}`,
    username: 'mika.codes',
    name: 'Mika Sato',
    headline: 'ML engineer turning research papers into things that actually run',
    bio: 'PhD dropout (proudly). I read papers so you don\'t have to, then try to turn the interesting ones into demos before the excitement wears off.',
    builderRole: 'ML Engineer',
    location: 'Osaka, Japan',
    xp: 3120,
    skills: [{ slug: 'python', level: 5 }, { slug: 'machine-learning', level: 5 }, { slug: 'postgresql', level: 2 }],
  },
  {
    email: `demo4@${DEMO_DOMAIN}`,
    username: 'priya.designs',
    name: 'Priya Nair',
    headline: 'Product designer who codes just enough to be dangerous',
    bio: 'I believe most software fails on the first screen, not the tenth feature. I join early-stage teams to fix that before it becomes load-bearing debt.',
    builderRole: 'Product Designer',
    location: 'Toronto, Canada',
    xp: 1420,
    skills: [{ slug: 'ui-ux-design', level: 5 }, { slug: 'figma', level: 5 }, { slug: 'react', level: 2 }],
  },
  {
    email: `demo5@${DEMO_DOMAIN}`,
    username: 'dtorres_dev',
    name: 'Diego Torres',
    headline: 'Backend engineer, infra nerd, occasional Rust evangelist',
    bio: 'Ten years of keeping systems up at 3am has made me paranoid in a useful way. Currently rewriting things in Rust that did not need to be rewritten in Rust.',
    builderRole: 'Backend / Infra Engineer',
    location: 'Mexico City, Mexico',
    xp: 4010,
    skills: [{ slug: 'go', level: 4 }, { slug: 'rust', level: 3 }, { slug: 'devops', level: 5 }, { slug: 'postgresql', level: 4 }],
  },
  {
    email: `demo6@${DEMO_DOMAIN}`,
    username: 'sam.builds.things',
    name: 'Samira Haddad',
    headline: 'Solo founder, three failed startups, learning something new each time',
    bio: 'Building in public because accountability beats motivation. Currently heads-down on a project I am not ready to talk about yet but will absolutely not shut up about once it works.',
    builderRole: 'Founder / Generalist',
    location: 'Beirut, Lebanon',
    xp: 980,
    skills: [{ slug: 'product-management', level: 4 }, { slug: 'react', level: 3 }, { slug: 'growth-marketing', level: 4 }],
  },
  {
    email: `demo7@${DEMO_DOMAIN}`,
    username: 'kwame_k',
    name: 'Kwame Asante',
    headline: 'Mobile engineer, cross-platform by day, native by obsession',
    bio: 'I have shipped more App Store rejections than most people have shipped apps. Getting better at reading the guidelines before submitting, slowly.',
    builderRole: 'Mobile Engineer',
    location: 'Accra, Ghana',
    xp: 2210,
    skills: [{ slug: 'react-native', level: 4 }, { slug: 'typescript', level: 4 }, { slug: 'figma', level: 2 }],
  },
  {
    email: `demo8@${DEMO_DOMAIN}`,
    username: 'ingrid.eth',
    name: 'Ingrid Lindqvist',
    headline: 'Smart contract engineer, allergic to unaudited code',
    bio: 'Came from traditional fintech backend, moved to chain work because the failure modes are more interesting and much more expensive to get wrong.',
    builderRole: 'Blockchain Engineer',
    location: 'Stockholm, Sweden',
    xp: 3340,
    skills: [{ slug: 'solidity', level: 5 }, { slug: 'typescript', level: 3 }, { slug: 'rust', level: 2 }],
  },
  {
    email: `demo9@${DEMO_DOMAIN}`,
    username: 'noah.writes.code',
    name: 'Noah Bergström',
    headline: 'Junior dev, hackathon regular, here to learn faster than a bootcamp allows',
    bio: 'Six months into my first real job, spending weekends on this platform because tutorials stopped teaching me anything new a while ago.',
    builderRole: 'Junior Engineer',
    location: 'Malmo, Sweden',
    xp: 340,
    skills: [{ slug: 'react', level: 2 }, { slug: 'typescript', level: 2 }],
  },
  {
    email: `demo10@${DEMO_DOMAIN}`,
    username: 'fatima.pm',
    name: 'Fatima Al-Sayed',
    headline: 'Product manager who insists on writing the first draft of the spec herself',
    bio: 'Ten years in enterprise product, now chasing the chaos of early-stage teams where the roadmap changes every standup and I would not have it any other way.',
    builderRole: 'Product Manager',
    location: 'Dubai, UAE',
    xp: 1670,
    skills: [{ slug: 'product-management', level: 5 }, { slug: 'ui-ux-design', level: 2 }],
  },
  {
    email: `demo11@${DEMO_DOMAIN}`,
    username: 'yuki_ml',
    name: 'Yuki Tanaka',
    headline: 'Data scientist crossing over into ML engineering',
    bio: 'Spent years building dashboards nobody looked at. Now I build models that at least fail loudly and visibly, which is progress.',
    builderRole: 'Data Scientist',
    location: 'Tokyo, Japan',
    xp: 2780,
    skills: [{ slug: 'python', level: 4 }, { slug: 'machine-learning', level: 4 }, { slug: 'postgresql', level: 3 }],
  },
  {
    email: `demo12@${DEMO_DOMAIN}`,
    username: 'ben.grows',
    name: 'Ben O\'Sullivan',
    headline: 'Growth marketer who learned SQL to stop waiting on engineering',
    bio: 'Marketing background, self-taught enough backend to pull my own funnels out of the database. Looking for technical co-founders who don\'t treat marketing as an afterthought.',
    builderRole: 'Growth Marketer',
    location: 'Dublin, Ireland',
    xp: 1120,
    skills: [{ slug: 'growth-marketing', level: 5 }, { slug: 'python', level: 2 }, { slug: 'postgresql', level: 2 }],
  },
]

async function main() {
  console.log('Seeding database...')

  // -------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------
  const skillBySlug = new Map<string, { id: string }>()
  for (const s of SKILLS) {
    // Skill has two unique columns (name and slug). A row created through the
    // API can share a name with a seed skill under a different slug, so match
    // on either and leave the existing row's name/slug untouched.
    const existing = await prisma.skill.findFirst({
      where: { OR: [{ slug: s.slug }, { name: s.name }] },
      orderBy: { createdAt: 'asc' },
    })
    const skill = existing
      ? await prisma.skill.update({ where: { id: existing.id }, data: { category: s.category } })
      : await prisma.skill.create({ data: { name: s.name, slug: s.slug, category: s.category } })
    skillBySlug.set(s.slug, skill)
  }

  // -------------------------------------------------------------------
  // Achievements (single source of truth: ACHIEVEMENT_DEFINITIONS)
  // -------------------------------------------------------------------
  for (const [slug, def] of Object.entries(ACHIEVEMENT_DEFINITIONS) as [string, AchievementDefinition][]) {
    await prisma.achievement.upsert({
      where: { slug },
      update: {
        name: def.name,
        description: def.description,
        icon: def.icon,
        category: def.category,
        xpReward: def.xpReward,
        criteria: def.criteria as object,
        isSecret: def.isSecret ?? false,
        order: def.order,
      },
      create: {
        slug,
        name: def.name,
        description: def.description,
        icon: def.icon,
        category: def.category,
        xpReward: def.xpReward,
        criteria: def.criteria as object,
        isSecret: def.isSecret ?? false,
        order: def.order,
      },
    })
  }

  // -------------------------------------------------------------------
  // Users (+ skills, + a couple of real XPEvent rows for leaderboard flavor)
  // -------------------------------------------------------------------
  const passwordHash = await hash(DEMO_PASSWORD, 12)
  const userByUsername = new Map<string, { id: string; name: string | null }>()

  for (const u of USERS) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {
        name: u.name,
        username: u.username,
        headline: u.headline,
        bio: u.bio,
        builderRole: u.builderRole,
        location: u.location,
        xp: u.xp,
        passwordHash,
        isEmailVerified: true,
        verificationLevel: 'EMAIL',
        emailVerified: new Date(),
      },
      create: {
        email: u.email,
        username: u.username,
        name: u.name,
        headline: u.headline,
        bio: u.bio,
        builderRole: u.builderRole,
        location: u.location,
        xp: u.xp,
        passwordHash,
        isEmailVerified: true,
        verificationLevel: 'EMAIL',
        emailVerified: new Date(),
      },
    })
    userByUsername.set(u.username, user)

    for (const s of u.skills) {
      const skill = skillBySlug.get(s.slug)!
      await prisma.userSkill.upsert({
        where: { userId_skillId: { userId: user.id, skillId: skill.id } },
        update: { level: s.level },
        create: { userId: user.id, skillId: skill.id, level: s.level },
      })
    }

    // A couple of XPEvent rows so the leaderboard/activity feed has real
    // history behind the raw xp total, without trying to make the sum
    // exactly reconcile (demo data, not an XP-integrity test).
    const existingEvents = await prisma.xPEvent.count({ where: { userId: user.id } })
    if (existingEvents === 0 && u.xp > 0) {
      await prisma.xPEvent.create({
        data: {
          userId: user.id,
          type: 'PROJECT_SHIP',
          amount: Math.min(200, Math.round(u.xp * 0.1)),
          description: 'Seed history: early project milestone',
        },
      })
    }
  }

  const aanya = userByUsername.get('aanya_builds')!
  const leo = userByUsername.get('leo_ships')!
  const mika = userByUsername.get('mika.codes')!
  const priya = userByUsername.get('priya.designs')!
  const diego = userByUsername.get('dtorres_dev')!
  const samira = userByUsername.get('sam.builds.things')!
  const kwame = userByUsername.get('kwame_k')!
  const ingrid = userByUsername.get('ingrid.eth')!
  const noah = userByUsername.get('noah.writes.code')!
  const fatima = userByUsername.get('fatima.pm')!
  const yuki = userByUsername.get('yuki_ml')!
  const ben = userByUsername.get('ben.grows')!

  // -------------------------------------------------------------------
  // Projects (+ owner ProjectMember + PROJECT Conversation, mirroring
  // POST /api/projects)
  // -------------------------------------------------------------------
  interface SeedProject {
    slug: string
    name: string
    description: string
    shortDesc: string
    status: ProjectStatus
    ownerId: string
    memberIds: string[]
    techStack: string[]
    lookingFor: string[]
    maxTeamSize: number
  }

  const PROJECTS: SeedProject[] = [
    {
      slug: 'pairup',
      name: 'PairUp',
      description: 'A matchmaking tool for finding accountability partners for side projects. Swipe-style matching on goals and availability, then a shared weekly check-in.',
      shortDesc: 'Tinder for accountability partners',
      status: ProjectStatus.SHIPPED,
      ownerId: aanya.id,
      memberIds: [leo.id],
      techStack: ['React', 'Node.js', 'PostgreSQL'],
      lookingFor: [],
      maxTeamSize: 4,
    },
    {
      slug: 'focusloop',
      name: 'FocusLoop',
      description: 'A local-first focus timer that syncs across devices without needing an account, built as a weekend experiment with CRDTs.',
      shortDesc: 'Local-first focus timer with CRDT sync',
      status: ProjectStatus.BUILDING,
      ownerId: leo.id,
      memberIds: [],
      techStack: ['TypeScript', 'React'],
      lookingFor: ['UI/UX Design'],
      maxTeamSize: 3,
    },
    {
      slug: 'papertrail-ml',
      name: 'PaperTrail',
      description: 'Turns arXiv papers into runnable demo notebooks automatically by extracting the core algorithm and generating a minimal implementation.',
      shortDesc: 'Auto-generates runnable demos from ML papers',
      status: ProjectStatus.TESTING,
      ownerId: mika.id,
      memberIds: [yuki.id],
      techStack: ['Python', 'Machine Learning'],
      lookingFor: ['Machine Learning'],
      maxTeamSize: 4,
    },
    {
      slug: 'sketchsprint',
      name: 'SketchSprint',
      description: 'A collaborative design-critique tool for hackathon teams to get fast feedback on UI mockups before writing any code.',
      shortDesc: 'Fast design-critique tool for hackathon teams',
      status: ProjectStatus.IDEA,
      ownerId: priya.id,
      memberIds: [],
      techStack: ['Figma', 'React'],
      lookingFor: ['Frontend Engineer'],
      maxTeamSize: 3,
    },
    {
      slug: 'chainwatch',
      name: 'ChainWatch',
      description: 'A monitoring dashboard for smart contract events with alerting, built after one too many silent exploits went unnoticed for hours.',
      shortDesc: 'Real-time smart contract monitoring and alerting',
      status: ProjectStatus.ARCHIVED,
      ownerId: ingrid.id,
      memberIds: [diego.id],
      techStack: ['Solidity', 'Go'],
      lookingFor: [],
      maxTeamSize: 3,
    },
  ]

  const projectBySlug = new Map<string, { id: string; name: string; ownerId: string }>()

  for (const p of PROJECTS) {
    const existing = await prisma.project.findUnique({ where: { slug: p.slug } })

    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.project.upsert({
        where: { slug: p.slug },
        update: {
          name: p.name,
          description: p.description,
          shortDesc: p.shortDesc,
          status: p.status,
          techStack: p.techStack,
          lookingFor: p.lookingFor,
          maxTeamSize: p.maxTeamSize,
          teamSize: 1 + p.memberIds.length,
        },
        create: {
          slug: p.slug,
          name: p.name,
          description: p.description,
          shortDesc: p.shortDesc,
          status: p.status,
          ownerId: p.ownerId,
          techStack: p.techStack,
          lookingFor: p.lookingFor,
          maxTeamSize: p.maxTeamSize,
          teamSize: 1 + p.memberIds.length,
        },
      })

      if (!existing) {
        await tx.projectMember.create({
          data: { userId: p.ownerId, projectId: created.id, role: 'OWNER' },
        })
        for (const memberId of p.memberIds) {
          await tx.projectMember.upsert({
            where: { userId_projectId: { userId: memberId, projectId: created.id } },
            update: {},
            create: { userId: memberId, projectId: created.id, role: 'MEMBER' },
          })
        }

        await tx.conversation.create({
          data: {
            type: 'PROJECT',
            projectId: created.id,
            members: {
              create: [
                { userId: p.ownerId, role: 'OWNER' },
                ...p.memberIds.map((id) => ({ userId: id, role: 'MEMBER' })),
              ],
            },
          },
        })
      } else {
        for (const memberId of p.memberIds) {
          await tx.projectMember.upsert({
            where: { userId_projectId: { userId: memberId, projectId: created.id } },
            update: {},
            create: { userId: memberId, projectId: created.id, role: 'MEMBER' },
          })
        }
      }

      return created
    })

    projectBySlug.set(p.slug, { id: project.id, name: project.name, ownerId: project.ownerId })
  }

  // -------------------------------------------------------------------
  // Teams (+ owner TeamMember + TEAM Conversation, mirroring
  // POST /api/teams) - one recruiting with open slots, one full
  // -------------------------------------------------------------------
  interface SeedTeam {
    slug: string
    name: string
    description: string
    ownerId: string
    memberIds: string[]
    maxSize: number
    isRecruiting: boolean
    lookingFor: string[]
  }

  const TEAMS: SeedTeam[] = [
    {
      slug: 'pairup-crew',
      name: 'PairUp Crew',
      description: 'The team behind PairUp, still looking for a growth person to help us find our first real users.',
      ownerId: aanya.id,
      memberIds: [leo.id],
      maxSize: 4,
      isRecruiting: true,
      lookingFor: ['Growth Marketing', 'UI/UX Design'],
    },
    {
      slug: 'papertrail-squad',
      name: 'PaperTrail Squad',
      description: 'Full team shipping PaperTrail for the upcoming AI hackathon. Not currently taking new members.',
      ownerId: mika.id,
      memberIds: [yuki.id, diego.id],
      maxSize: 3,
      isRecruiting: false,
      lookingFor: [],
    },
    {
      slug: 'chainwatch-core',
      name: 'ChainWatch Core',
      description: 'Small contract-security-focused team, open to one more backend engineer.',
      ownerId: ingrid.id,
      memberIds: [],
      maxSize: 3,
      isRecruiting: true,
      lookingFor: ['Go', 'Rust'],
    },
  ]

  const teamBySlug = new Map<string, { id: string; name: string; ownerId: string; maxSize: number }>()

  for (const t of TEAMS) {
    const existing = await prisma.team.findUnique({ where: { slug: t.slug } })

    const team = await prisma.$transaction(async (tx) => {
      const created = await tx.team.upsert({
        where: { slug: t.slug },
        update: {
          name: t.name,
          description: t.description,
          maxSize: t.maxSize,
          isRecruiting: t.isRecruiting,
          lookingFor: t.lookingFor,
        },
        create: {
          slug: t.slug,
          name: t.name,
          description: t.description,
          ownerId: t.ownerId,
          maxSize: t.maxSize,
          isRecruiting: t.isRecruiting,
          lookingFor: t.lookingFor,
        },
      })

      if (!existing) {
        await tx.teamMember.create({
          data: { userId: t.ownerId, teamId: created.id, role: 'OWNER' },
        })
        for (const memberId of t.memberIds) {
          await tx.teamMember.upsert({
            where: { userId_teamId: { userId: memberId, teamId: created.id } },
            update: {},
            create: { userId: memberId, teamId: created.id, role: 'MEMBER' },
          })
        }

        await tx.conversation.create({
          data: {
            type: 'TEAM',
            teamId: created.id,
            members: {
              create: [
                { userId: t.ownerId, role: 'OWNER' },
                ...t.memberIds.map((id) => ({ userId: id, role: 'MEMBER' })),
              ],
            },
          },
        })
      } else {
        for (const memberId of t.memberIds) {
          await tx.teamMember.upsert({
            where: { userId_teamId: { userId: memberId, teamId: created.id } },
            update: {},
            create: { userId: memberId, teamId: created.id, role: 'MEMBER' },
          })
        }
      }

      return created
    })

    teamBySlug.set(t.slug, { id: team.id, name: team.name, ownerId: team.ownerId, maxSize: team.maxSize })
  }

  // -------------------------------------------------------------------
  // Team applications (varied statuses)
  // -------------------------------------------------------------------
  const pairupTeam = teamBySlug.get('pairup-crew')!
  const chainwatchTeam = teamBySlug.get('chainwatch-core')!

  const APPLICATIONS: { userId: string; teamId: string; message: string; status: TeamApplicationStatus }[] = [
    {
      userId: samira.id,
      teamId: pairupTeam.id,
      message: 'I have run growth for two early-stage products before, would love to help PairUp find its first cohort of users.',
      status: TeamApplicationStatus.PENDING,
    },
    {
      userId: noah.id,
      teamId: pairupTeam.id,
      message: 'Junior dev looking to learn - happy to start with small frontend tickets if there is room.',
      status: TeamApplicationStatus.REJECTED,
    },
    {
      userId: diego.id,
      teamId: chainwatchTeam.id,
      message: 'Ten years of backend/infra work, comfortable with Go and just picked up Rust. Would like to help harden the alerting pipeline.',
      status: TeamApplicationStatus.ACCEPTED,
    },
    {
      userId: kwame.id,
      teamId: chainwatchTeam.id,
      message: 'Mostly a mobile engineer but curious about on-chain monitoring, open to pairing with someone on the backend side.',
      status: TeamApplicationStatus.PENDING,
    },
  ]

  for (const app of APPLICATIONS) {
    await prisma.teamApplication.upsert({
      where: { userId_teamId: { userId: app.userId, teamId: app.teamId } },
      update: { message: app.message, status: app.status },
      create: { userId: app.userId, teamId: app.teamId, message: app.message, status: app.status },
    })
  }

  // -------------------------------------------------------------------
  // Hackathons (+ HACKATHON Conversation, mirroring POST /api/hackathons)
  // one UPCOMING, one ACTIVE, each with a few HackathonParticipant rows
  // -------------------------------------------------------------------
  interface SeedHackathon {
    slug: string
    name: string
    description: string
    shortDesc: string
    status: HackathonStatus
    startDate: Date
    endDate: Date
    organizerId: string
    participants: { userId: string; status: HackathonParticipantStatus }[]
  }

  const now = new Date()
  const inTwoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
  const inThreeWeeks = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000)
  const startedYesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const endsInFiveDays = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000)

  const HACKATHONS: SeedHackathon[] = [
    {
      slug: 'ai-builders-weekend',
      name: 'AI Builders Weekend',
      description: 'A weekend hackathon for anyone building with LLMs, agents, or applied ML - bring an idea, leave with a working demo.',
      shortDesc: 'Weekend hackathon for applied AI builders',
      status: HackathonStatus.UPCOMING,
      startDate: inTwoWeeks,
      endDate: inThreeWeeks,
      organizerId: fatima.id,
      participants: [
        { userId: mika.id, status: HackathonParticipantStatus.REGISTERED },
        { userId: yuki.id, status: HackathonParticipantStatus.REGISTERED },
        { userId: noah.id, status: HackathonParticipantStatus.REGISTERED },
      ],
    },
    {
      slug: 'shipfast-hack',
      name: 'ShipFast Hack',
      description: 'A five-day build sprint for solo builders and small teams shipping a real, usable product by the end of the week.',
      shortDesc: 'Five-day build sprint, ship something real',
      status: HackathonStatus.ACTIVE,
      startDate: startedYesterday,
      endDate: endsInFiveDays,
      organizerId: aanya.id,
      participants: [
        { userId: aanya.id, status: HackathonParticipantStatus.TEAM_FORMED },
        { userId: leo.id, status: HackathonParticipantStatus.TEAM_FORMED },
        { userId: samira.id, status: HackathonParticipantStatus.REGISTERED },
        { userId: ben.id, status: HackathonParticipantStatus.REGISTERED },
      ],
    },
  ]

  const hackathonBySlug = new Map<string, { id: string; name: string }>()

  for (const h of HACKATHONS) {
    const existing = await prisma.hackathon.findUnique({ where: { slug: h.slug } })

    const hackathon = await prisma.$transaction(async (tx) => {
      const created = await tx.hackathon.upsert({
        where: { slug: h.slug },
        update: {
          name: h.name,
          description: h.description,
          shortDesc: h.shortDesc,
          status: h.status,
          startDate: h.startDate,
          endDate: h.endDate,
        },
        create: {
          slug: h.slug,
          name: h.name,
          description: h.description,
          shortDesc: h.shortDesc,
          status: h.status,
          startDate: h.startDate,
          endDate: h.endDate,
        },
      })

      if (!existing) {
        await tx.conversation.create({
          data: {
            type: 'HACKATHON',
            hackathonId: created.id,
            members: { create: { userId: h.organizerId, role: 'OWNER' } },
          },
        })
      }

      for (const p of h.participants) {
        await tx.hackathonParticipant.upsert({
          where: { userId_hackathonId: { userId: p.userId, hackathonId: created.id } },
          update: { status: p.status },
          create: { userId: p.userId, hackathonId: created.id, status: p.status },
        })
      }

      return created
    })

    hackathonBySlug.set(h.slug, { id: hackathon.id, name: hackathon.name })
  }

  // -------------------------------------------------------------------
  // Messages - a handful of plausible builder chat lines in a couple of
  // the seeded conversations
  // -------------------------------------------------------------------
  const pairupProject = projectBySlug.get('pairup')!
  const pairupProjectConvo = await prisma.conversation.findUnique({ where: { projectId: pairupProject.id } })

  const pairupCrewConvo = await prisma.conversation.findUnique({ where: { teamId: pairupTeam.id } })

  async function seedMessagesOnce(conversationId: string, lines: { senderId: string; content: string }[]) {
    const count = await prisma.message.count({ where: { conversationId } })
    if (count > 0) return
    for (const line of lines) {
      await prisma.message.create({
        data: { conversationId, senderId: line.senderId, content: line.content },
      })
    }
  }

  if (pairupProjectConvo) {
    await seedMessagesOnce(pairupProjectConvo.id, [
      { senderId: aanya.id, content: 'Pushed the onboarding flow rework, can someone sanity check the empty state before I ship it?' },
      { senderId: leo.id, content: 'Looking now. The copy on the empty state feels a little flat, want me to take a pass?' },
      { senderId: aanya.id, content: 'Please, copy is not my strength. Also - are we still targeting Friday for the check-in reminder feature?' },
      { senderId: leo.id, content: 'Friday works if the notification service cooperates. Last I checked it was still flaking on retries.' },
    ])
  }

  if (pairupCrewConvo) {
    await seedMessagesOnce(pairupCrewConvo.id, [
      { senderId: aanya.id, content: 'Welcome to the team channel, Leo. Figured we should keep hackathon chatter separate from the project one.' },
      { senderId: leo.id, content: 'Good call. Also just saw we got another application in - the growth marketing one looks promising.' },
      { senderId: aanya.id, content: 'Yeah I saw Samira\'s application, her background looks solid. Want to jump on a call with her this week?' },
    ])
  }

  // -------------------------------------------------------------------
  // Skill evidence and peer endorsements
  //
  // Evidence rows are matched on (user, skill, type, title); an endorsement is
  // matched on the evidence it endorses plus the endorser, the same identity
  // the endorse endpoint uses, so re-running adds nothing.
  // -------------------------------------------------------------------
  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000)

  const EVIDENCE: { key: string; user: { id: string }; skill: string; type: string; title: string; url?: string; description: string }[] = [
    { key: 'aanya-react', user: aanya, skill: 'react', type: 'PORTFOLIO', title: 'PairUp web app', url: 'https://pairup.example.com', description: 'Production React front end for PairUp, including the swipe-style matching flow.' },
    { key: 'aanya-node', user: aanya, skill: 'nodejs', type: 'GITHUB_PROJECT', title: 'pairup-api', url: 'https://github.com/aanya-builds/pairup-api', description: 'Matching and check-in API behind PairUp.' },
    { key: 'leo-ts', user: leo, skill: 'typescript', type: 'CONTRIBUTION', title: 'Sync engine for FocusLoop', url: 'https://github.com/leo-ships/focusloop', description: 'CRDT-based local-first sync written in TypeScript.' },
    { key: 'mika-ml', user: mika, skill: 'machine-learning', type: 'GITHUB_PROJECT', title: 'papertrail-core', url: 'https://github.com/mika-codes/papertrail-core', description: 'Extracts the core algorithm from arXiv papers and generates a minimal implementation.' },
    { key: 'priya-figma', user: priya, skill: 'figma', type: 'PORTFOLIO', title: 'Design system for a hackathon toolkit', url: 'https://priya.example.com/design-system', description: 'Component library and critique templates used by three hackathon teams.' },
    { key: 'diego-go', user: diego, skill: 'go', type: 'CONTRIBUTION', title: 'Alert routing service', url: 'https://github.com/dtorres-dev/alert-router', description: 'Rate-aware alert fan-out written in Go.' },
    { key: 'ingrid-sol', user: ingrid, skill: 'solidity', type: 'CERTIFICATION', title: 'Smart contract security course', url: 'https://certs.example.com/ingrid-solidity', description: 'Completed a practical audit-focused Solidity course.' },
  ]

  const evidenceByKey = new Map<string, { id: string; userId: string; skillId: string; title: string }>()
  for (const e of EVIDENCE) {
    const skill = skillBySlug.get(e.skill)!
    const existing = await prisma.skillEvidence.findFirst({
      where: { userId: e.user.id, skillId: skill.id, type: e.type, title: e.title },
    })
    const row =
      existing ??
      (await prisma.skillEvidence.create({
        data: { userId: e.user.id, skillId: skill.id, type: e.type, title: e.title, url: e.url, description: e.description, createdAt: daysAgo(12) },
      }))
    evidenceByKey.set(e.key, { id: row.id, userId: row.userId, skillId: row.skillId, title: row.title })
  }

  const ENDORSEMENTS: { evidence: string; by: { id: string } }[] = [
    { evidence: 'aanya-react', by: leo },
    { evidence: 'aanya-react', by: priya },
    { evidence: 'aanya-node', by: leo },
    { evidence: 'mika-ml', by: yuki },
    { evidence: 'diego-go', by: aanya },
    { evidence: 'priya-figma', by: aanya },
  ]
  for (const en of ENDORSEMENTS) {
    const evidence = evidenceByKey.get(en.evidence)!
    const existing = await prisma.skillEvidence.findFirst({
      where: {
        type: 'PEER_ENDORSEMENT',
        AND: [
          { metadata: { path: ['endorsedEvidenceId'], equals: evidence.id } },
          { metadata: { path: ['endorserId'], equals: en.by.id } },
        ],
      },
    })
    if (existing) continue
    await prisma.skillEvidence.create({
      data: {
        userId: evidence.userId,
        skillId: evidence.skillId,
        type: 'PEER_ENDORSEMENT',
        title: `Peer endorsement: ${evidence.title}`.slice(0, 200),
        metadata: { endorsedEvidenceId: evidence.id, endorserId: en.by.id },
      },
    })
  }

  // -------------------------------------------------------------------
  // Project updates and milestones (matched on project + title)
  // -------------------------------------------------------------------
  const projectId = (slug: string) => projectBySlug.get(slug)!.id
  const ownerOf = (slug: string) => projectBySlug.get(slug)!.ownerId

  const UPDATES: { project: string; authorId: string; title: string; content: string; type: string; days: number }[] = [
    { project: 'pairup', authorId: aanya.id, title: 'Onboarding flow rework is live', content: 'The new onboarding cut time-to-first-match from four steps to two. Early testers finish it without help.', type: 'UPDATE', days: 9 },
    { project: 'pairup', authorId: leo.id, title: 'Weekly check-in reminders shipped', content: 'Reminders now go out the morning of a check-in and retry when the notification service is slow.', type: 'UPDATE', days: 3 },
    { project: 'pairup', authorId: aanya.id, title: 'PairUp is looking for a growth marketer', content: 'We have the product in shape and need someone to help find the first cohort of users.', type: 'ANNOUNCEMENT', days: 2 },
    { project: 'focusloop', authorId: leo.id, title: 'CRDT sync works across two devices', content: 'Timers started on one device now show up on the other with no account and no server round trip.', type: 'UPDATE', days: 5 },
    { project: 'papertrail-ml', authorId: mika.id, title: 'Notebook generation passes the first 20 papers', content: 'Twenty of the first thirty papers produce a notebook that runs end to end. Fixing the rest is the next milestone.', type: 'UPDATE', days: 6 },
    { project: 'papertrail-ml', authorId: yuki.id, title: 'Added a benchmark harness', content: 'A small harness now compares generated implementations against the reference numbers in each paper.', type: 'UPDATE', days: 1 },
  ]
  for (const u of UPDATES) {
    const pid = projectId(u.project)
    const exists = await prisma.projectUpdate.findFirst({ where: { projectId: pid, title: u.title } })
    if (exists) continue
    await prisma.projectUpdate.create({
      data: { projectId: pid, authorId: u.authorId, title: u.title, content: u.content, type: u.type, createdAt: daysAgo(u.days) },
    })
  }

  const MILESTONES: { project: string; title: string; description: string; order: number; doneDaysAgo?: number; dueInDays?: number }[] = [
    { project: 'pairup', title: 'Private beta', description: 'Ten pairs completing a full week of check-ins.', order: 0, doneDaysAgo: 30 },
    { project: 'pairup', title: 'Public launch', description: 'Open sign-up and a landing page.', order: 1, doneDaysAgo: 14 },
    { project: 'pairup', title: 'First 500 users', description: 'Reach 500 registered builders.', order: 2, dueInDays: 30 },
    { project: 'focusloop', title: 'Two-device sync', description: 'A timer started on one device appears on another.', order: 0, doneDaysAgo: 5 },
    { project: 'focusloop', title: 'Design pass', description: 'Replace the placeholder UI.', order: 1, dueInDays: 14 },
    { project: 'focusloop', title: 'Public beta', description: 'Publish to a small group of testers.', order: 2, dueInDays: 45 },
    { project: 'papertrail-ml', title: 'Notebook generator', description: 'Generate a runnable notebook from a paper.', order: 0, doneDaysAgo: 20 },
    { project: 'papertrail-ml', title: 'Benchmark harness', description: 'Compare generated code against published results.', order: 1, doneDaysAgo: 1 },
    { project: 'papertrail-ml', title: 'Handle multi-algorithm papers', description: 'Support papers that introduce more than one method.', order: 2, dueInDays: 21 },
  ]
  for (const m of MILESTONES) {
    const pid = projectId(m.project)
    const exists = await prisma.milestone.findFirst({ where: { projectId: pid, title: m.title } })
    if (exists) continue
    await prisma.milestone.create({
      data: {
        projectId: pid,
        title: m.title,
        description: m.description,
        order: m.order,
        completedAt: m.doneDaysAgo !== undefined ? daysAgo(m.doneDaysAgo) : null,
        dueDate: m.dueInDays !== undefined ? new Date(Date.now() + m.dueInDays * 24 * 60 * 60 * 1000) : null,
      },
    })
  }

  // Activity for the profile feed: a project-scoped entry (public, so visible
  // to everyone) and one that has no project. Matched on user + type + title.
  const ACTIVITIES: { userId: string; type: string; title: string; project?: string; days: number }[] = [
    { userId: aanya.id, type: 'PROJECT_UPDATE_POSTED', title: 'Posted an update on "PairUp"', project: 'pairup', days: 9 },
    { userId: aanya.id, type: 'MILESTONE_COMPLETED', title: 'Completed milestone "Public launch" on "PairUp"', project: 'pairup', days: 14 },
    { userId: leo.id, type: 'PROJECT_UPDATE_POSTED', title: 'Posted an update on "FocusLoop"', project: 'focusloop', days: 5 },
    { userId: mika.id, type: 'MILESTONE_COMPLETED', title: 'Completed milestone "Benchmark harness" on "PaperTrail"', project: 'papertrail-ml', days: 1 },
    { userId: diego.id, type: 'TEAM_JOINED', title: 'Joined the ChainWatch core team', days: 7 },
  ]
  for (const a of ACTIVITIES) {
    const exists = await prisma.activity.findFirst({ where: { userId: a.userId, type: a.type, title: a.title } })
    if (exists) continue
    await prisma.activity.create({
      data: { userId: a.userId, type: a.type, title: a.title, projectId: a.project ? projectId(a.project) : undefined, createdAt: daysAgo(a.days) },
    })
  }

  // Achievements through the real grant path: idempotent, and it records the
  // XP event and activity entry the same way a live grant would.
  const GRANTS: { userId: string; slug: 'first-evidence' | 'endorsed' | 'first-update' | 'first-milestone' }[] = [
    { userId: aanya.id, slug: 'first-evidence' },
    { userId: aanya.id, slug: 'endorsed' },
    { userId: aanya.id, slug: 'first-update' },
    { userId: aanya.id, slug: 'first-milestone' },
    { userId: leo.id, slug: 'first-update' },
    { userId: mika.id, slug: 'first-evidence' },
    { userId: mika.id, slug: 'first-milestone' },
  ]
  for (const g of GRANTS) await grantAchievement(prisma, g.userId, g.slug)

  // -------------------------------------------------------------------
  // Connections (matched on sender + receiver, the unique pair)
  // -------------------------------------------------------------------
  const CONNECTIONS: { sender: { id: string }; receiver: { id: string }; type: 'TEAMMATE' | 'COLLABORATOR' | 'NETWORK'; status: string; message?: string }[] = [
    { sender: aanya, receiver: leo, type: 'TEAMMATE', status: 'ACCEPTED', message: 'Great building PairUp together.' },
    { sender: mika, receiver: yuki, type: 'COLLABORATOR', status: 'ACCEPTED' },
    { sender: samira, receiver: aanya, type: 'NETWORK', status: 'PENDING', message: 'Loved PairUp, would like to help with growth.' },
    { sender: priya, receiver: leo, type: 'COLLABORATOR', status: 'PENDING', message: 'Happy to help with the FocusLoop design pass.' },
  ]
  for (const c of CONNECTIONS) {
    const reverse = await prisma.connection.findUnique({
      where: { senderId_receiverId: { senderId: c.receiver.id, receiverId: c.sender.id } },
    })
    if (reverse) continue
    await prisma.connection.upsert({
      where: { senderId_receiverId: { senderId: c.sender.id, receiverId: c.receiver.id } },
      update: { type: c.type, status: c.status },
      create: { senderId: c.sender.id, receiverId: c.receiver.id, type: c.type, status: c.status, message: c.message },
    })
  }

  // -------------------------------------------------------------------
  // Read state and reactions on the seeded conversations
  //
  // Read rows are unique on (message, reader), so upserting them is safe to
  // repeat. The team channel is left partly unread for Aanya so the unread
  // badge has something to show on a fresh demo.
  //
  // Blocks are deliberately not seeded: a block hides the pair from each
  // other everywhere, which would make demo accounts disappear from one
  // another's lists during a walkthrough. Create one from the UI to see it.
  // -------------------------------------------------------------------
  async function markRead(conversationId: string, readerId: string) {
    const others = await prisma.message.findMany({ where: { conversationId, senderId: { not: readerId }, deletedAt: null }, select: { id: true } })
    for (const m of others) {
      await prisma.messageRead.upsert({
        where: { messageId_userId: { messageId: m.id, userId: readerId } },
        update: {},
        create: { messageId: m.id, userId: readerId },
      })
    }
  }

  if (pairupProjectConvo) {
    await markRead(pairupProjectConvo.id, aanya.id)
    await markRead(pairupProjectConvo.id, leo.id)

    const first = await prisma.message.findFirst({ where: { conversationId: pairupProjectConvo.id, senderId: aanya.id }, orderBy: { createdAt: 'asc' } })
    const reply = await prisma.message.findFirst({ where: { conversationId: pairupProjectConvo.id, senderId: leo.id }, orderBy: { createdAt: 'asc' } })
    const REACTIONS = [
      { message: first, user: leo, emoji: '👍' },
      { message: first, user: aanya, emoji: '🚀' },
      { message: reply, user: aanya, emoji: '🙏' },
    ]
    for (const r of REACTIONS) {
      if (!r.message) continue
      await prisma.messageReaction.upsert({
        where: { messageId_userId_emoji: { messageId: r.message.id, userId: r.user.id, emoji: r.emoji } },
        update: {},
        create: { messageId: r.message.id, userId: r.user.id, emoji: r.emoji },
      })
    }
  }
  if (pairupCrewConvo) {
    // Leo has read Aanya's messages; Aanya has read none of Leo's.
    await markRead(pairupCrewConvo.id, leo.id)
  }

  // -------------------------------------------------------------------
  // Done
  // -------------------------------------------------------------------
  console.log('Seed complete.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
