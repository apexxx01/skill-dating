import type { Person, Ctx, PersonState } from './types'
import { DAY_MS } from './types'
import { atMoment } from './clock'
import type { Rng } from './rng'
import { PROJECT_NAME_PREFIXES, PROJECT_NAME_SUFFIXES, PROJECT_PITCHES, UPDATE_BODIES, UPDATE_TITLES, POST_BODIES, POST_TITLES, COMMENT_BODIES, SKILLS } from './catalog'
import { localDateKey, localDateStart, addDaysToDateKey } from '../../src/lib/time'
import { createPost } from '../../src/lib/posts/posts'
import { giveProps } from '../../src/lib/posts/props'
import { createComment } from '../../src/lib/posts/comments'
import { emit, transactWithEvents } from '../../src/lib/events'
import { recordActivity } from '../../src/lib/activity'
import { endorseEvidence } from '../../src/lib/skill-evidence'
import { createNotification } from '../../src/lib/notifications'

// The history: the days before today, played by the same code that runs live. Each day, the people who show up do one to three things (start a project, post an update, finish a milestone,
// ship, add evidence, endorse, give Props, comment, follow, connect), each through its domain function inside `atMoment`, which sets the clock to that person's afternoon of that day. So
// XP, levels, tiers, streaks, daily caps, achievements, quests, Ship Day tags, notifications and the product events are what a real run would have written, not numbers made up
// to look right. Written directly, as the routes do (and documented in docs/SEED.md): the project, its milestones and its coordination channel, evidence rows, follows and connections.

const MILESTONE_TITLES = ['Private beta', 'Public launch', 'First 100 users', 'Docs and examples', 'Payments', 'Mobile app', 'Performance pass', 'Accessibility pass', 'Open source the core']
const EVIDENCE_TYPES = ['GITHUB_PROJECT', 'PORTFOLIO', 'CONTRIBUTION', 'CERTIFICATION'] as const

const slugify = (text: string) => text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '')

export interface Sim {
  recentPosts: { id: string; authorId: string }[]
  followed: Set<string>
  connected: Set<string>
  counts: Record<string, number>
  failures: Record<string, number>
}

type Action = 'project' | 'update' | 'milestone' | 'ship' | 'evidence' | 'endorse' | 'props' | 'comment' | 'follow' | 'connect' | 'demo'

function weekday(dayKey: string): number {
  return new Date(`${dayKey}T12:00:00Z`).getUTCDay()
}

export interface HistoryResult {
  actions: Record<string, number>
  failures: Record<string, number>
  days: number
}

function chooseActions(person: Person, state: PersonState, sim: Sim, rng: Rng, hasOthers: boolean): Action[] {
  const open = state.projects.filter((project) => !project.shipped && project.status !== 'ARCHIVED')
  const out: Action[] = []
  const wanted = person.streaky ? rng.int(1, 3) : rng.chance(0.28) ? rng.int(2, 3) : 1
  for (let i = 0; i < wanted; i++) {
    const choices: (readonly [Action, number])[] = []
    if (open.length === 0 && state.projects.length < 4) choices.push(['project', 120])
    else if (state.projects.length < 4 && rng.chance(0.08)) choices.push(['project', 30])
    if (open.length > 0) {
      choices.push(['update', person.streaky ? 70 : 38])
      if (open.some((project) => project.milestones.length > 0)) choices.push(['milestone', 20])
      if (open.some((project) => project.updates >= 2)) choices.push(['ship', 11])
      choices.push(['demo', 6])
    }
    if (state.evidence.length < 5) choices.push(['evidence', 13])
    if (hasOthers) choices.push(['endorse', 14], ['props', person.streaky ? 24 : 32], ['comment', 14], ['follow', 9], ['connect', 5])
    if (choices.length === 0) choices.push(['evidence', 1])
    out.push(rng.weighted(choices))
  }
  return out
}

/** Plays `days` days of history for the core people. */
export async function runHistory(ctx: Ctx): Promise<HistoryResult> {
  const { db, rng, args } = ctx
  const core = ctx.people.filter((person) => person.tier === 'core')
  const sim: Sim = { recentPosts: [], followed: new Set(), connected: new Set(), counts: {}, failures: {} }
  const todayKey = localDateKey(ctx.now, 'UTC')
  const firstKey = addDaysToDateKey(todayKey, -args.days)

  // Who keeps a streak, and from when: a run of days that ends yesterday and is as long as the person's patience.
  const streakFrom = new Map<string, string>()
  for (const person of core) {
    if (person.streaky) streakFrom.set(person.id, addDaysToDateKey(todayKey, -rng.fork(`streak-${person.id}`).int(4, Math.min(args.days - 1, 70))))
  }

  const byGroup = (dayKey: string) => {
    const groups = new Map<string, Person[]>()
    for (const person of core) {
      const created = localDateKey(person.createdAt, person.city.timezone)
      if (created > dayKey) continue
      const age = (Date.parse(`${dayKey}T00:00:00Z`) - Date.parse(`${created}T00:00:00Z`)) / DAY_MS
      if (age < 1 && !person.streaky) continue
      const dayRng = rng.fork(`day-${dayKey}-${person.id}`)
      const weekend = [0, 6].includes(weekday(dayKey))
      const base = person.activity * (weekend ? 1.25 : 1) * (age < 4 ? 1.8 : 1)
      const from = streakFrom.get(person.id)
      const onStreak = from !== undefined && dayKey >= from
      if (!(onStreak ? dayRng.chance(0.985) : dayRng.chance(Math.min(0.9, base)))) continue
      const list = groups.get(person.city.timezone) ?? []
      list.push(person)
      groups.set(person.city.timezone, list)
    }
    return groups
  }

  for (let offset = 0; offset < args.days; offset++) {
    const dayKey = addDaysToDateKey(firstKey, offset)
    const groups = byGroup(dayKey)
    for (const [timezone, people] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const person of people) {
        const personRng = rng.fork(`do-${dayKey}-${person.id}`)
        const hour = personRng.int(8, 22)
        const at = new Date(localDateStart(dayKey, timezone).getTime() + hour * 3_600_000 + personRng.int(0, 59) * 60_000)
        if (at.getTime() > ctx.now.getTime() - 3_600_000) continue
        await atMoment(db, at, async () => {
          const state = ctx.state.get(person.id)!
          const actions = chooseActions(person, state, sim, personRng, ctx.people.length > 20)
          for (const action of actions) {
            try {
              const done = await perform(ctx, sim, person, state, action, personRng)
              if (done) sim.counts[action] = (sim.counts[action] ?? 0) + 1
            } catch (error) {
              sim.failures[action] = (sim.failures[action] ?? 0) + 1
              if (sim.failures[action] <= 2) ctx.log(`  ! ${action} failed for ${person.username}: ${error instanceof Error ? error.message.split('\n').pop() : error}`)
            }
          }
          state.lastActiveDay = dayKey
          await db.user.update({ where: { id: person.id }, data: { lastActiveAt: new Date() } })
        })
      }
    }
    if ((offset + 1) % 10 === 0) ctx.log(`  day ${offset + 1} of ${args.days}: ${Object.values(sim.counts).reduce((a, b) => a + b, 0)} actions`)
  }
  return { actions: sim.counts, failures: sim.failures, days: args.days }
}

async function perform(ctx: Ctx, sim: Sim, person: Person, state: PersonState, action: Action, rng: Rng): Promise<boolean> {
  switch (action) {
    case 'project':
      return createProject(ctx, person, state, rng)
    case 'update':
      return postUpdate(ctx, sim, person, state, rng, 'UPDATE')
    case 'demo':
      return postUpdate(ctx, sim, person, state, rng, 'DEMO')
    case 'milestone':
      return completeMilestone(ctx, person, state, rng)
    case 'ship':
      return shipProject(ctx, sim, person, state, rng)
    case 'evidence':
      return addEvidence(ctx, person, state, rng)
    case 'endorse':
      return endorseSomeone(ctx, person, rng)
    case 'props':
      return giveSomeProps(ctx, sim, person, rng)
    case 'comment':
      return commentOnPost(ctx, sim, person, rng)
    case 'follow':
      return followSomeone(ctx, sim, person, rng)
    case 'connect':
      return connectWithSomeone(ctx, sim, person, rng)
  }
}

// --- The actions ----------------------------------------------------------------------------------------------------------

export function projectNameFor(person: Person, rng: Rng, taken: Set<string>): string {
  for (let tries = 0; tries < 20; tries++) {
    const name = `${rng.pick(PROJECT_NAME_PREFIXES)}${rng.pick(PROJECT_NAME_SUFFIXES)}`
    if (!taken.has(name)) return name
  }
  return `${rng.pick(PROJECT_NAME_PREFIXES)}${person.index}`
}

export async function createProject(ctx: Ctx, person: Person, state: PersonState, rng: Rng): Promise<boolean> {
  const name = projectNameFor(person, rng, new Set(state.projects.map((project) => project.name)))
  const domain = rng.pick(person.archetype.domains)
  const description = rng.pick(PROJECT_PITCHES).replace('{domain}', domain)
  const slug = `${slugify(name)}-${person.index.toString(36)}-${state.projects.length}`
  const stack = person.skills.slice(0, 4).map((skill) => SKILLS.find((s) => s.slug === skill.slug)?.name ?? skill.slug)
  const now = new Date()
  const { value: project } = await transactWithEvents(ctx.db, async (tx) => {
    const created = await tx.project.create({
      data: { name, slug, description, shortDesc: description.slice(0, 90), status: 'IDEA', ownerId: person.id, teamSize: 1, maxTeamSize: rng.int(2, 5), techStack: stack, lookingFor: person.archetype.seeks.slice(0, 2), isPublic: true, startedAt: now, createdAt: now },
    })
    await tx.projectMember.create({ data: { userId: person.id, projectId: created.id, role: 'OWNER', joinedAt: now } })
    await tx.conversation.create({ data: { type: 'PROJECT', projectId: created.id, members: { create: { userId: person.id, role: 'OWNER' } } } })
    const titles = rng.sample(MILESTONE_TITLES, rng.int(2, 4))
    for (const [order, title] of titles.entries()) {
      await tx.milestone.create({ data: { projectId: created.id, title, description: `${title} for ${name}.`, order, dueDate: new Date(now.getTime() + (order + 1) * rng.int(10, 25) * DAY_MS), createdAt: now } })
    }
    await recordActivity(tx, person.id, 'PROJECT_CREATED', `Created project "${created.name}"`, { projectId: created.id, link: `/projects/${created.slug}` })
    await emit(tx, 'PROJECT_CREATED', { userId: person.id, projectId: created.id, projectName: created.name })
    return created
  })
  const milestones = await ctx.db.milestone.findMany({ where: { projectId: project.id }, select: { id: true }, orderBy: { order: 'asc' } })
  state.projects.push({ id: project.id, name, status: 'IDEA', milestones: milestones.map((m) => m.id), shipped: false, updates: 0 })
  return true
}

const STATUS_BY_UPDATES = ['IDEA', 'PLANNING', 'BUILDING', 'BUILDING', 'TESTING'] as const

export async function postUpdate(ctx: Ctx, sim: Sim, person: Person, state: PersonState, rng: Rng, kind: 'UPDATE' | 'DEMO'): Promise<boolean> {
  const open = state.projects.filter((project) => !project.shipped && project.status !== 'ARCHIVED')
  if (open.length === 0) return false
  const project = rng.pick(open)
  const title = rng.pick(UPDATE_TITLES)
  const body = `${rng.pick(UPDATE_BODIES)}\n\n${rng.pick(POST_BODIES)}`
  const result = await createPost(ctx.db, { id: person.id, timezone: person.city.timezone }, { kind: kind === 'DEMO' ? 'DEMO' : rng.chance(0.3) ? 'DEVLOG' : 'UPDATE', title, body, projectId: project.id, links: [], mediaIds: [], stackTags: person.skills.slice(0, 2).map((skill) => skill.slug), coAuthorIds: [], visibility: 'PUBLIC' })
  if (!result.ok) throw new Error(`createPost: ${result.code}`)
  project.updates += 1
  const status = STATUS_BY_UPDATES[Math.min(project.updates, STATUS_BY_UPDATES.length - 1)]
  if (status !== project.status) {
    project.status = status
    await ctx.db.project.update({ where: { id: project.id }, data: { status } })
  }
  state.posts.push(result.post.id)
  sim.recentPosts.push({ id: result.post.id, authorId: person.id })
  if (sim.recentPosts.length > 300) sim.recentPosts.shift()
  return true
}

export async function completeMilestone(ctx: Ctx, person: Person, state: PersonState, rng: Rng): Promise<boolean> {
  const candidates = state.projects.filter((project) => !project.shipped && project.milestones.length > 0)
  if (candidates.length === 0) return false
  const project = rng.pick(candidates)
  const milestoneId = project.milestones.shift()!
  const row = await ctx.db.project.findUniqueOrThrow({ where: { id: project.id }, select: { slug: true, name: true } })
  await transactWithEvents(ctx.db, async (tx) => {
    const flipped = await tx.milestone.updateMany({ where: { id: milestoneId, projectId: project.id, completedAt: null }, data: { completedAt: new Date() } })
    if (flipped.count !== 1) return
    const milestone = await tx.milestone.findUniqueOrThrow({ where: { id: milestoneId }, select: { title: true } })
    await recordActivity(tx, person.id, 'MILESTONE_COMPLETED', `Completed milestone "${milestone.title}" on "${row.name}"`, { link: `/projects/${row.slug}`, projectId: project.id, metadata: { milestoneId } })
    await emit(tx, 'MILESTONE_COMPLETED', { userId: person.id, projectId: project.id, milestoneId })
    await tx.projectUpdate.create({ data: { projectId: project.id, authorId: person.id, type: 'MILESTONE', title: `Milestone completed: ${milestone.title}`.slice(0, 200), content: `${person.name} completed the milestone "${milestone.title}".` } })
  })
  return true
}

export async function shipProject(ctx: Ctx, sim: Sim, person: Person, state: PersonState, rng: Rng): Promise<boolean> {
  const ready = state.projects.filter((project) => !project.shipped && project.updates >= 2)
  if (ready.length === 0) return false
  const project = rng.pick(ready)
  const name = project.name
  const result = await createPost(ctx.db, { id: person.id, timezone: person.city.timezone }, { kind: 'SHIP', title: rng.pick(POST_TITLES.SHIP).replace('{name}', name), body: `${rng.pick(POST_BODIES)}\n\nTry it, break it, tell us what is missing.`, projectId: project.id, links: ['https://example.com/' + slugify(name)], mediaIds: [], stackTags: person.skills.slice(0, 3).map((skill) => skill.slug), coAuthorIds: [], visibility: 'PUBLIC' })
  if (!result.ok) throw new Error(`createPost(SHIP): ${result.code}`)
  project.shipped = true
  project.status = 'SHIPPED'
  await ctx.db.project.update({ where: { id: project.id }, data: { demoUrl: `https://example.com/${slugify(name)}`, githubUrl: person.github ? `https://github.com/${person.github}/${slugify(name)}` : null } })
  sim.recentPosts.push({ id: result.post.id, authorId: person.id })
  state.posts.push(result.post.id)
  return true
}

export async function addEvidence(ctx: Ctx, person: Person, state: PersonState, rng: Rng): Promise<boolean> {
  const skill = rng.pick(person.skills.filter((s) => ctx.skillIds.has(s.slug)))
  if (!skill) return false
  const skillId = ctx.skillIds.get(skill.slug)!
  const name = SKILLS.find((s) => s.slug === skill.slug)?.name ?? skill.slug
  const type = rng.pick(EVIDENCE_TYPES)
  const title = `${name}: ${rng.pick(['production app', 'open source contribution', 'hackathon build', 'course project', 'client work', 'side project'])}`
  const verified = type === 'GITHUB_PROJECT' || rng.chance(0.4)
  const evidence = await transactWithEvents(ctx.db, async (tx) => {
    const created = await tx.skillEvidence.create({
      data: { userId: person.id, skillId, type, title, description: `Evidence of ${name} work.`, url: `https://example.com/${person.username}/${slugify(title)}`, verifiedAt: verified ? new Date() : null, integrityWeight: 1 },
    })
    await recordActivity(tx, person.id, 'SKILL_EVIDENCE_ADDED', `Added evidence "${title}"`, { metadata: { evidenceId: created.id, skillId } })
    await emit(tx, 'EVIDENCE_ADDED', { userId: person.id, evidenceId: created.id, skillId })
    return created
  })
  state.evidence.push({ id: evidence.value.id, skillId, slug: skill.slug })
  return true
}

async function endorseSomeone(ctx: Ctx, person: Person, rng: Rng): Promise<boolean> {
  const others = ctx.people.filter((other) => other.tier === 'core' && other.id !== person.id && ctx.state.get(other.id)!.evidence.length > 0)
  if (others.length === 0) return false
  // Colleagues first: people in the same city or with the same trade endorse each other more often.
  const near = others.filter((other) => other.city.key === person.city.key || other.archetype.key === person.archetype.key)
  const target = rng.pick(near.length > 3 && rng.chance(0.7) ? near : others)
  const evidence = rng.pick(ctx.state.get(target.id)!.evidence)
  const result = await endorseEvidence(ctx.db, { endorserId: person.id, endorserName: person.name, evidenceId: evidence.id })
  return result.outcome === 'created'
}

async function giveSomeProps(ctx: Ctx, sim: Sim, person: Person, rng: Rng): Promise<boolean> {
  const pool = sim.recentPosts.filter((post) => post.authorId !== person.id)
  if (pool.length === 0) return false
  const count = rng.int(1, 3)
  let given = 0
  for (const post of rng.sample(pool, count)) {
    const result = await giveProps(ctx.db, person.id, post.id)
    if (result.ok && result.created) given += 1
  }
  return given > 0
}

async function commentOnPost(ctx: Ctx, sim: Sim, person: Person, rng: Rng): Promise<boolean> {
  const pool = sim.recentPosts.filter((post) => post.authorId !== person.id)
  if (pool.length === 0) return false
  const post = rng.pick(pool)
  const result = await createComment(ctx.db, person.id, post.id, { body: rng.pick(COMMENT_BODIES) })
  return result.ok
}

async function followSomeone(ctx: Ctx, sim: Sim, person: Person, rng: Rng): Promise<boolean> {
  const target = rng.pick(ctx.people.filter((other) => other.tier === 'core' && other.id !== person.id))
  const key = `${person.id}>${target.id}`
  if (sim.followed.has(key)) return false
  sim.followed.add(key)
  await ctx.db.follow.create({ data: { followerId: person.id, followeeId: target.id } })
  await createNotification(ctx.db, { userId: target.id, kind: 'FOLLOW', title: 'New follower', message: `${person.name} started following you`, link: `/u/${person.username}`, metadata: { followerId: person.id } })
  return true
}

async function connectWithSomeone(ctx: Ctx, sim: Sim, person: Person, rng: Rng): Promise<boolean> {
  const target = rng.pick(ctx.people.filter((other) => other.tier === 'core' && other.id !== person.id))
  const key = [person.id, target.id].sort().join('|')
  if (sim.connected.has(key)) return false
  sim.connected.add(key)
  const type = rng.pick(['TEAMMATE', 'COLLABORATOR', 'NETWORK', 'FRIEND'] as const)
  const connection = await ctx.db.connection.create({ data: { senderId: target.id, receiverId: person.id, type, status: 'ACCEPTED', message: 'Great to connect.' } })
  await transactWithEvents(ctx.db, async (tx) => {
    await emit(tx, 'CONNECTION_ACCEPTED', { userId: person.id, otherUserId: target.id, connectionId: connection.id })
  })
  return true
}
