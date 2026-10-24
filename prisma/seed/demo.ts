import { PrismaClient } from '@prisma/client'
import type { Ctx, Person } from './types'
import { DAY_MS, DEMO_DOMAIN, HOUR_MS, ID_PREFIX } from './types'
import { assertSafeToSeed, loadEnvFiles, SeedRefusal } from './guard'
import { installClock, atMoment, STAMPED } from './clock'
import { rngFor, type Rng } from './rng'
import { ARCHETYPES, CITIES, SKILLS, UPDATE_BODIES, UPDATE_TITLES, POST_BODIES, COMMENT_BODIES } from './catalog'
import { buildContext, main as buildWorldMain, readMarker } from './cli'
import { register, writePeople } from './people'
import { seedSkills, seedCampuses, seedCampusMembers } from './reference'
import { addEvidence, completeMilestone, createProject, postUpdate, shipProject, type Sim } from './history'
import { localDateKey, localDateStart, addDaysToDateKey } from '../../src/lib/time'
import { emit, transactWithEvents } from '../../src/lib/events'
import { recordActivity } from '../../src/lib/activity'
import { giveProps } from '../../src/lib/posts/props'
import { createComment } from '../../src/lib/posts/comments'
import { endorseEvidence } from '../../src/lib/skill-evidence'
import { createPost } from '../../src/lib/posts/posts'
import { generateDropsForUser } from '../../src/lib/matching/drops'
import { sendSpark } from '../../src/lib/matching/sparks'
import { createSquadTeam } from '../../src/lib/squads/teams'
import { addMember, checkJoin, createSlots, squadHackathonSelect } from '../../src/lib/squads/membership'
import { templateFor } from '../../src/lib/squads/roles'
import { createLfgPost } from '../../src/lib/squads/lfg'
import { sendSquadReminders } from '../../src/lib/squads/reminders'
import { recomputeRarity } from '../../src/lib/achievement-rarity'
import { ensurePersonalCode } from '../../src/lib/invites/invites'
import { skeleton } from '../../src/lib/identity/confusables'

// npm run seed:demo -- --username aanya [--name "Aanya Kapoor"] [--city blr] [--streak 45]
//
// A polished account to show someone: a passport with proof (a verified GitHub, evidence that peers endorsed, three shipped projects and one in progress, a Ship Feed that people gave
// Props to), a streak of 45 days that is still alive today, a high level and rare achievements, a squad of four with one seat open a day before a hackathon's registration closes, five
// matches with conversations (some unread), drops waiting today, and a share card that is drawn for it. Built through the same domain functions as the world (docs/SEED.md). It needs the
// world: if there is none it builds a small one first. Run again to rebuild the account from scratch (the streak is then alive today). It refuses to run in production.
// To sign in as it: npm run db:seed:clerk (password DemoPass123!).

const titleCase = (text: string) => text.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

interface DemoArgs {
  username: string
  name: string
  city: string
  streak: number
}

function parseDemoArgs(argv: readonly string[]): DemoArgs {
  let username: string | null = null
  let name: string | null = null
  let city = 'blr'
  let streak = 45
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=')
    const value = () => (inline !== undefined ? inline : argv[++i])
    if (flag === '--username') username = value() ?? null
    else if (flag === '--name') name = value() ?? null
    else if (flag === '--city') city = value() ?? city
    else if (flag === '--streak') streak = Number(value())
    else if (flag === '--help' || flag === '-h') throw new SeedRefusal('Usage: npm run seed:demo -- --username <name> [--name "Full Name"] [--city blr|del|bom|hyd|pnq|sfo|nyc|lon|ber|los|sin|gru] [--streak 45]')
    else throw new SeedRefusal(`unknown argument ${argv[i]} (see --help)`)
  }
  if (!username || !/^[a-z0-9][a-z0-9_-]{1,29}$/.test(username)) throw new SeedRefusal('--username is required: 2 to 30 characters, lower-case letters, digits, "_" or "-"')
  if (!CITIES.some((c) => c.key === city)) throw new SeedRefusal(`--city must be one of ${CITIES.map((c) => c.key).join(', ')}`)
  if (!Number.isInteger(streak) || streak < 7 || streak > 120) throw new SeedRefusal('--streak must be a whole number from 7 to 120')
  return { username, name: name ?? titleCase(username), city, streak }
}

export async function demoMain(argv: readonly string[]): Promise<void> {
  loadEnvFiles()
  const args = parseDemoArgs(argv)
  const target = assertSafeToSeed()
  const log = (message: string) => console.log(message)
  log(`Making the demo account "${args.username}" in ${target.host}/${target.database}`)
  const probe = new PrismaClient()
  try {
    if (!(await readMarker(probe))) {
      log('There is no seeded world yet: building a small one first (150 people, 45 days)...')
      await probe.$disconnect()
      await buildWorldMain(['--scale', '150', '--days', '45'])
    }
  } finally {
    await probe.$disconnect().catch(() => undefined)
  }

  process.env.PRISMA_QUERY_LOG = 'off'
  Object.assign(process.env, { NODE_ENV: 'test' })
  installClock()
  const db = new PrismaClient()
  try {
    const marker = (await readMarker(db))!
    const ctx = await buildContext(db, { scale: marker.scale, seed: marker.seed, days: marker.days, reset: false, withRomance: false, username: args.username, help: false }, log)
    await buildDemo(ctx, args)
  } finally {
    await db.$disconnect()
  }
}

async function buildDemo(ctx: Ctx, args: DemoArgs): Promise<void> {
  const { db, now } = ctx
  const rng = rngFor(`demo:${args.username}`)
  const city = CITIES.find((c) => c.key === args.city)!
  const id = `${ID_PREFIX}demo_${args.username}`
  await db.user.deleteMany({ where: { OR: [{ id }, { username: args.username }, { email: `${args.username}@${DEMO_DOMAIN}` }] } })

  // The world's reference data and the people who give the demo its audience (the first 400 builders of the world, by their stable ids).
  await seedSkills(ctx)
  await seedCampuses(ctx)
  const world = await db.user.findMany({ where: { id: { startsWith: `${ID_PREFIX}u` }, deletedAt: null, createdAt: { lt: new Date(now.getTime() - 15 * DAY_MS) } }, select: { id: true, name: true, username: true, timezone: true }, orderBy: { xp: 'desc' }, take: 120 })
  if (world.length < 30) throw new SeedRefusal('The seeded world is too small to give a demo account an audience. Run: npm run seed -- --reset')

  const archetype = ARCHETYPES.find((a) => a.key === 'fullstack')!
  const campus = city.campuses[0]
  const person: Person = {
    index: 900_000,
    id,
    tier: 'core',
    email: `${args.username}@${DEMO_DOMAIN}`,
    username: args.username,
    name: args.name,
    city,
    archetype,
    skills: [
      { slug: 'typescript', level: 5, years: 6 }, { slug: 'react', level: 5, years: 6 }, { slug: 'nodejs', level: 5, years: 5 }, { slug: 'postgresql', level: 4, years: 5 },
      { slug: 'nextjs', level: 4, years: 3 }, { slug: 'llm-apps', level: 4, years: 2 }, { slug: 'ui-ux-design', level: 3, years: 3 }, { slug: 'go', level: 3, years: 2 },
    ],
    birthDate: new Date(Date.UTC(1996, 4, 17)),
    isMinor: false,
    createdAt: new Date(now.getTime() - (args.streak + 28) * DAY_MS),
    activity: 1,
    streaky: true,
    github: `${args.username.replace(/[^a-z0-9]/g, '')}-dev`,
    phone: true,
    campusSlug: campus ? campus.slug : null,
    headline: 'Full-stack builder who ships something every week and writes it down',
    bio: `I build developer tools and small products that people use daily. ${city.city}-based, hackathon regular, open to the right co-founder. Three things shipped, one in progress, and a streak I am not going to break.`,
    plan: 'PRO',
    dropTime: '08:30',
    connectionTypes: ['COFOUNDER', 'HACKATHON_TEAMMATE', 'COLLABORATOR', 'MENTOR'],
    intentTags: [{ tag: 'win-a-hackathon' }, { tag: 'find-cofounder' }, { tag: 'open-source' }],
    lookingForSkills: ['ui-ux-design', 'machine-learning', 'growth-marketing'],
    workingStyle: { pace: 'balanced', communication: 'mixed', planning: 'light', decisions: 'owners' },
    hoursPerWeek: 20,
  }
  register(ctx, [person])
  await writePeople(ctx, [person])
  await db.user.update({ where: { id }, data: { name: args.name, image: null } })
  if (campus) await seedCampusMembers(ctx)

  const state = ctx.state.get(id)!
  const sim: Sim = { recentPosts: [], followed: new Set(), connected: new Set(), counts: {}, failures: {} }
  const todayKey = localDateKey(now, city.timezone)
  const momentOf = (dayKey: string, hour: number, minute = 0) => new Date(localDateStart(dayKey, city.timezone).getTime() + hour * HOUR_MS + minute * 60_000)
  const audience = rng.shuffle(world)
  const by = (n: number) => audience.slice(0, n)

  // --- The streak: something of their own, every day, ending today ---------------------------------------------------------------
  ctx.log(`  ${args.streak} days of building...`)
  const posts: { id: string; at: Date; kind: string }[] = []
  const firstKey = addDaysToDateKey(todayKey, -(args.streak - 1))
  let projectIndex = 0
  for (let offset = 0; offset < args.streak; offset++) {
    const dayKey = addDaysToDateKey(firstKey, offset)
    const dayRng = rng.fork(`day-${offset}`)
    // Today's turn is whenever "now" lets it be: the streak must be alive today.
    const at = new Date(Math.min(momentOf(dayKey, dayRng.int(17, 21), dayRng.int(0, 59)).getTime(), now.getTime() - 10 * 60_000))
    if (at.getTime() < localDateStart(dayKey, city.timezone).getTime()) continue
    await atMoment(db, at, async () => {
      // The story: three projects shipped (about a third, two thirds and nine tenths of the way), a fourth that is being built.
      const shipPoints = [0.32, 0.62, 0.9].map((fraction) => Math.floor(args.streak * fraction))
      if (offset === 0 || (state.projects.every((p) => p.shipped) && offset > 1 && projectIndex < 4)) {
        await createProject(ctx, person, state, dayRng)
        projectIndex += 1
        return
      }
      if (shipPoints.includes(offset) && state.projects.some((p) => !p.shipped)) {
        const project = state.projects.find((p) => !p.shipped)!
        while (project.updates < 2) await postUpdate(ctx, sim, person, state, dayRng, 'UPDATE')
        const ok = await shipProject(ctx, sim, person, state, dayRng)
        if (ok) posts.push({ id: state.posts[state.posts.length - 1], at, kind: 'SHIP' })
        return
      }
      const open = state.projects.find((p) => !p.shipped)
      if (!open) return
      const roll = dayRng.next()
      if (roll < 0.34 && open.milestones.length > 0) await completeMilestone(ctx, person, state, dayRng)
      else if (roll < 0.46 && state.evidence.length < 8) await addEvidence(ctx, person, state, dayRng)
      else if (roll < 0.6) {
        await postUpdate(ctx, sim, person, state, dayRng, 'UPDATE')
        posts.push({ id: state.posts[state.posts.length - 1], at, kind: 'UPDATE' })
      } else {
        // A project log entry: a short note, the daily work, no feed post.
        await transactWithEvents(db, async (tx) => {
          const update = await tx.projectUpdate.create({ data: { projectId: open.id, authorId: id, title: dayRng.pick(UPDATE_TITLES), content: dayRng.pick(UPDATE_BODIES), type: 'UPDATE', createdAt: new Date() } })
          await recordActivity(tx, id, 'PROJECT_UPDATE_POSTED', `Posted an update on "${open.name}"`, { projectId: open.id })
          await emit(tx, 'PROJECT_UPDATE_POSTED', { userId: id, projectId: open.id, updateId: update.id })
        })
        open.updates += 1
      }
    })
    await db.user.update({ where: { id }, data: { lastActiveAt: at } })
  }
  // Evidence enough to be convincing, whatever the days drew.
  for (let k = state.evidence.length; k < 6; k++) {
    await atMoment(db, momentOf(addDaysToDateKey(todayKey, -(args.streak - 3 - k)), 12), () => addEvidence(ctx, person, state, rng.fork(`evidence-${k}`)))
  }
  // The current project is a hackathon build, and the passport says what is being worked on now.
  const current = state.projects.find((p) => !p.shipped)
  if (current) {
    await db.currentBuild.upsert({ where: { userId: id }, create: { userId: id, title: current.name, description: 'The project the squad is building for this weekend.', status: 'BUILDING', progress: 62, techStack: ['TypeScript', 'Next.js', 'PostgreSQL'], rolesNeeded: ['Designer (UI/UX)'] }, update: {} })
  }

  // --- The audience: Props, comments, endorsements, followers -----------------------------------------------------------------------
  ctx.log('  an audience (Props, comments, endorsements, followers)...')
  const myPosts = await db.shipPost.findMany({ where: { authorId: id }, orderBy: { createdAt: 'asc' } })
  for (const post of myPosts) {
    const r = rng.fork(`react-${post.id}`)
    const crowd = by(post.kind === 'SHIP' ? 36 : 14)
    for (const [i, fan] of crowd.entries()) {
      const at = new Date(Math.min(now.getTime() - 10 * 60_000, post.createdAt.getTime() + (i + 1) * r.int(7, 90) * 60_000))
      await atMoment(db, at, async () => {
        await giveProps(db, fan.id, post.id, at)
        if (i < (post.kind === 'SHIP' ? 5 : 1)) await createComment(db, fan.id, post.id, { body: r.pick(COMMENT_BODIES) }, at)
      })
    }
  }
  const evidence = await db.skillEvidence.findMany({ where: { userId: id, type: { not: 'PEER_ENDORSEMENT' } } })
  for (const [i, row] of evidence.entries()) {
    for (const [j, endorser] of audience.slice(40 + i * 3, 43 + i * 3).entries()) {
      const at = new Date(Math.min(now.getTime() - 20 * 60_000, row.createdAt.getTime() + (j + 1) * 5 * HOUR_MS))
      await atMoment(db, at, () => endorseEvidence(db, { endorserId: endorser.id, endorserName: endorser.name ?? endorser.username, evidenceId: row.id }))
    }
  }
  await db.follow.createMany({ data: by(70).map((fan, i) => ({ followerId: fan.id, followeeId: id, createdAt: new Date(now.getTime() - (i + 1) * 9 * HOUR_MS) })), skipDuplicates: true })
  await db.follow.createMany({ data: audience.slice(0, 28).map((o) => ({ followerId: id, followeeId: o.id })), skipDuplicates: true })
  for (const [i, friend] of audience.slice(10, 20).entries()) {
    const at = new Date(now.getTime() - (i + 2) * DAY_MS)
    const connection = await db.connection.create({ data: { senderId: friend.id, receiverId: id, type: i % 3 === 0 ? 'TEAMMATE' : 'COLLABORATOR', status: 'ACCEPTED', message: 'Loved your last ship.', createdAt: at } })
    await atMoment(db, at, () => transactWithEvents(db, (tx) => emit(tx, 'CONNECTION_ACCEPTED', { userId: id, otherUserId: friend.id, connectionId: connection.id })))
  }

  // --- The squad, a day before registration closes ----------------------------------------------------------------------------------
  ctx.log('  the squad...')
  const hackathon = await db.hackathon.findFirst({ where: { slug: { startsWith: 'seed-' }, status: 'UPCOMING', registrationDeadline: { gt: now } }, orderBy: { registrationDeadline: 'asc' } })
  if (hackathon) {
    const squadHackathon = await db.hackathon.findUniqueOrThrow({ where: { id: hackathon.id }, select: squadHackathonSelect })
    const registeredAt = new Date(now.getTime() - 4 * DAY_MS)
    await atMoment(db, registeredAt, () =>
      transactWithEvents(db, async (tx) => {
        await tx.hackathonParticipant.create({ data: { userId: id, hackathonId: hackathon.id, registeredAt, skills: ['typescript', 'react', 'nodejs'], preferredRoles: ['FULLSTACK'] } })
        await recordActivity(tx, id, 'HACKATHON_JOINED', `Joined hackathon "${hackathon.name}"`, { link: `/hackathons/${hackathon.slug}` })
        await emit(tx, 'HACKATHON_JOINED', { userId: id, hackathonId: hackathon.id, hackathonName: hackathon.name })
      })
    )
    const formedAt = new Date(now.getTime() - 3 * DAY_MS)
    const team = await atMoment(db, formedAt, async () => {
      const { value } = await transactWithEvents(db, async (tx) => {
        const created = await createSquadTeam(tx, { hackathon: squadHackathon, ownerId: id, name: 'Late Night Shippers', ownerRole: 'FULLSTACK', maxSize: Math.min(4, hackathon.maxTeamSize), now: formedAt })
        const needs = templateFor({ size: Math.min(4, hackathon.maxTeamSize), tracks: [], technologies: hackathon.technologies }).filter((need) => need.role !== 'FULLSTACK')
        await createSlots(tx, created.id, needs.slice(0, 3))
        await tx.team.update({ where: { id: created.id }, data: { description: 'We ship on Fridays and sleep on Mondays. One seat open: we need a designer who likes fast, honest feedback.' } })
        return created
      })
      return value
    })
    const slots = await db.teamSlot.findMany({ where: { teamId: team.id }, orderBy: { position: 'asc' } })
    const mates = await db.hackathonParticipant.findMany({ where: { hackathonId: hackathon.id, teamId: null, userId: { not: id }, status: 'REGISTERED' }, select: { userId: true }, take: 40 })
    const members = [id]
    const filling = slots.slice(0, Math.max(0, slots.length - 1))
    for (const [i, slot] of filling.entries()) {
      const mate = mates[i]
      if (!mate) break
      const joinAt = new Date(formedAt.getTime() + (i + 1) * 7 * HOUR_MS)
      const ok = await atMoment(db, joinAt, async () => {
        const { value } = await transactWithEvents(db, async (tx) => {
          const t = { id: team.id, name: team.name, slug: team.slug, ownerId: team.ownerId, maxSize: team.maxSize, projectId: team.projectId, hackathonId: team.hackathonId }
          if (await checkJoin(tx, t, mate.userId, { slotId: slot.id, now: joinAt })) return false
          await addMember(tx, t, mate.userId, { slotId: slot.id, now: joinAt })
          return true
        })
        return value
      })
      if (ok) members.push(mate.userId)
    }
    if (current) {
      await db.team.update({ where: { id: team.id }, data: { projectId: current.id } })
      await db.hackathonTeam.update({ where: { teamId: team.id }, data: { projectId: current.id } })
      await db.projectMember.createMany({ data: members.slice(1).map((userId) => ({ userId, projectId: current.id, role: 'MEMBER' })), skipDuplicates: true })
    }
    for (const userId of members) {
      await db.commitmentPledge.create({ data: { hackathonId: hackathon.id, teamId: team.id, userId, attendance: 'REMOTE', hoursAvailable: 24, availableFrom: hackathon.startDate, availableUntil: hackathon.endDate, confirmedAt: new Date(formedAt.getTime() + 20 * HOUR_MS) } })
    }
    const idea = await db.teamIdea.create({ data: { teamId: team.id, authorId: id, title: 'An agent that triages your pull requests', description: 'Reads the diff, runs the tests, writes the review you would have written.', voteCount: members.length, chosenAt: new Date(now.getTime() - 2 * DAY_MS) } })
    await db.teamIdeaVote.createMany({ data: members.map((userId) => ({ ideaId: idea.id, userId })), skipDuplicates: true })
    await db.teamChecklistItem.createMany({ data: ['Pick the stack', 'Auth and data model', 'Wireframes', 'Demo script', 'Landing page'].map((title, position) => ({ teamId: team.id, title, assigneeId: members[position % members.length], done: position < 2, doneAt: position < 2 ? new Date(now.getTime() - 20 * HOUR_MS) : null, createdById: id, position })) })
    await atMoment(db, new Date(now.getTime() - 2 * HOUR_MS), () =>
      createLfgPost(db, { hackathon: { id: hackathon.id, endDate: hackathon.endDate, submissionDeadline: hackathon.submissionDeadline }, authorId: id, now: new Date(now.getTime() - 2 * HOUR_MS), body: { kind: 'TEAM', teamId: team.id, roles: ['DESIGN_UI_UX'], stack: ['figma', 'react'], timezone: city.timezone, note: 'Late Night Shippers has one seat left: a designer. Clear plan, good people, we ship.' } as never })
    )
    await sendSquadReminders(db, now)
    ctx.log(`  squad of ${members.length} for ${hackathon.name}, registration closes ${hackathon.registrationDeadline?.toISOString()}`)
  }

  // --- Matches, drops, sparks ---------------------------------------------------------------------------------------------------------
  ctx.log('  matches and drops...')
  const suitors = (await db.user.findMany({ where: { id: { in: by(120).slice(30).map((o) => o.id) }, matchingProfile: { connectionTypes: { has: 'COLLABORATOR' }, paused: false } }, select: { id: true, name: true, username: true, timezone: true } })).slice(0, 5)
  const opener = (name: string, extra: string) => `${name.split(' ')[0]}, ${extra} Would you want to build something small together this month?`
  for (const [i, other] of suitors.entries()) {
    const at = new Date(now.getTime() - (i + 2) * DAY_MS)
    await atMoment(db, at, async () => {
      await sendSpark(db, other.id, { toId: id, connectionType: 'COLLABORATOR', opener: opener(args.name, `I read your devlog on ${state.projects[0]?.name ?? 'the project'} and the retry logic caught my eye (${i + 1}).`) }, { now: at, enforced: false })
    })
    const back = new Date(at.getTime() + 5 * HOUR_MS)
    await atMoment(db, back, async () => {
      const topics = ['your approach to retries and idempotency', 'how you structure a monorepo for a small team', 'the way you write release notes people actually read', 'your take on keeping a codebase boring on purpose', 'the benchmarks you published for the sync engine']
      const first = other.name?.split(' ')[0] ?? 'Hey'
      const sent = await sendSpark(db, id, { toId: other.id, connectionType: 'COLLABORATOR', opener: `${first}, I have been following ${topics[i % topics.length]} and I would love to pair on a small weekend build with you (${first} idea ${i + 1}).` }, { now: back, enforced: false })
      if (!sent.ok) ctx.log(`  ! spark to ${other.username} refused: ${sent.code}`)
    })
  }
  const matches = await db.match.findMany({ where: { OR: [{ userAId: id }, { userBId: id }], connectionType: { not: 'DATING' } }, select: { id: true, conversationId: true, userAId: true, userBId: true, createdAt: true } })
  for (const [i, match] of matches.entries()) {
    const other = match.userAId === id ? match.userBId : match.userAId
    const lines = [`Great to match, ${args.name.split(' ')[0]}! What are you building this month?`, 'I am a few weeks from shipping the next one. Looking for someone to review the architecture.', 'Happy to. Send me the doc when it is ready?']
    for (const [k, line] of lines.entries()) {
      const message = await db.message.create({ data: { conversationId: match.conversationId!, senderId: k === 1 ? id : other, content: line, createdAt: new Date(match.createdAt.getTime() + (k + 1) * 40 * 60_000) } })
      // The last message of the first two threads is waiting to be read.
      if (!(k === 2 && i < 2) && k !== 1) await db.messageRead.create({ data: { messageId: message.id, userId: id, readAt: new Date(message.createdAt.getTime() + 600_000) } }).catch(() => undefined)
    }
  }
  const pending = (await db.user.findMany({ where: { id: { in: by(120).slice(70).map((o) => o.id) }, matchingProfile: { connectionTypes: { has: 'HACKATHON_TEAMMATE' }, paused: false } }, select: { id: true, name: true, username: true, timezone: true } })).slice(0, 3)
  for (const [i, other] of pending.entries()) {
    const at = new Date(now.getTime() - (i + 1) * 3 * HOUR_MS)
    await atMoment(db, at, () => sendSpark(db, other.id, { toId: id, connectionType: 'HACKATHON_TEAMMATE', opener: `${args.name.split(' ')[0]}, I saw your squad needs a designer and I am a product designer who ships (${i + 1}). Can we talk before the deadline?` }, { now: at, enforced: false }))
  }
  await atMoment(db, momentOf(todayKey, 8, 35), () => generateDropsForUser(db, id, momentOf(todayKey, 8, 35), { enforced: false, force: true }), [...STAMPED, { table: 'Drop', column: 'createdAt' }, { table: 'Spark', column: 'createdAt' }, { table: 'Match', column: 'createdAt' }])

  // --- Finishing ------------------------------------------------------------------------------------------------------------------------
  const code = await ensurePersonalCode(db, id)
  await db.$executeRaw`UPDATE "Notification" SET "sweptAt" = "createdAt" WHERE "userId" = ${id} AND "sweptAt" IS NULL`
  await db.user.update({ where: { id }, data: { lastActiveAt: now } })
  await db.subscription.upsert({ where: { userId: id }, create: { userId: id, plan: 'PRO', status: 'ACTIVE' }, update: {} })
  await recomputeRarity(db)

  const me = await db.user.findUniqueOrThrow({ where: { id }, select: { xp: true, currentStreak: true, longestStreak: true } })
  const achievements = await db.userAchievement.count({ where: { userId: id } })
  ctx.log('')
  ctx.log(`Demo account ready: ${args.name} (@${args.username})`)
  ctx.log(`  XP ${me.xp}, streak ${me.currentStreak} (longest ${me.longestStreak}), ${achievements} achievements, invite code ${code.code}`)
  ctx.log(`  passport:    /u/${args.username}      share card: /api/og/passport/${args.username}`)
  ctx.log(`  sign in:     npm run db:seed:clerk   (e-mail ${args.username}@demo.skilldating.example.com, password DemoPass123!)`)
}

export type { Rng }
