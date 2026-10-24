import type { HackathonPlatform, Prisma, SquadRole } from '@prisma/client'
import type { Ctx, HackathonRecord, Person } from './types'
import { DAY_MS, HOUR_MS } from './types'
import { atMoment } from './clock'
import type { Rng } from './rng'
import { HACKATHON_ORGANIZERS, HACKATHON_THEMES, HACKATHON_TRACKS, CITIES } from './catalog'
import { emit, transactWithEvents } from '../../src/lib/events'
import { recordActivity } from '../../src/lib/activity'
import { createSquadTeam } from '../../src/lib/squads/teams'
import { addMember, checkJoin, createSlots, hackathonPaysRewards, squadHackathonSelect } from '../../src/lib/squads/membership'
import { templateFor, type RoleNeed } from '../../src/lib/squads/roles'
import { createLfgPost } from '../../src/lib/squads/lfg'
import { writePeerReview } from '../../src/lib/squads/peer-review'
import { respondToProposal, runRound } from '../../src/lib/squads/pool'
import { createNotification } from '../../src/lib/notifications'

// Hackathons, squads and what happens around them, through the squad domain functions: registering, creating a squad (its team, conversation and hackathon registration), slots from the role
// template, joining by slot (checkJoin, addMember), submitting, results, peer reviews, the looking-for-group board and the solo pool's automatic squads. Written directly, as the routes do
// (docs/SEED.md): the hackathon rows themselves, the squad's project, pledges, ideas and the checklist, the results ranks.

type Phase = HackathonRecord['phase']

interface Plan {
  phase: Phase
  kind: 'NATIVE' | 'EXTERNAL'
  /** Days from today to the start (negative: it started). */
  startIn: number
  days: number
  platform?: HackathonPlatform
  mode: 'ONLINE' | 'IN_PERSON' | 'HYBRID'
  verified?: boolean
  cancelled?: boolean
  /** The registration closes this many hours from now (UPCOMING); used for the one that closes tomorrow. */
  closesInHours?: number
  max: number
  min: number
  /** How crowded: share of the core people. */
  share: number
}

const PLANS: Plan[] = [
  { phase: 'PAST', kind: 'NATIVE', startIn: -52, days: 3, mode: 'ONLINE', max: 5, min: 2, share: 0.16 },
  { phase: 'PAST', kind: 'NATIVE', startIn: -37, days: 2, mode: 'HYBRID', max: 4, min: 2, share: 0.13 },
  { phase: 'PAST', kind: 'NATIVE', startIn: -24, days: 3, mode: 'IN_PERSON', max: 5, min: 3, share: 0.1 },
  { phase: 'PAST', kind: 'EXTERNAL', startIn: -44, days: 2, mode: 'ONLINE', platform: 'DEVFOLIO', verified: true, max: 4, min: 2, share: 0.08 },
  { phase: 'PAST', kind: 'EXTERNAL', startIn: -29, days: 3, mode: 'ONLINE', platform: 'MLH', verified: true, max: 5, min: 2, share: 0.07 },
  { phase: 'PAST', kind: 'EXTERNAL', startIn: -17, days: 2, mode: 'IN_PERSON', platform: 'DEVPOST', verified: false, max: 4, min: 2, share: 0.05 },
  { phase: 'LIVE', kind: 'NATIVE', startIn: -1, days: 3, mode: 'ONLINE', max: 5, min: 2, share: 0.16 },
  { phase: 'LIVE', kind: 'NATIVE', startIn: -2, days: 4, mode: 'HYBRID', max: 4, min: 2, share: 0.11 },
  { phase: 'LIVE', kind: 'EXTERNAL', startIn: -1, days: 2, mode: 'ONLINE', platform: 'UNSTOP', verified: true, max: 4, min: 2, share: 0.07 },
  { phase: 'UPCOMING', kind: 'NATIVE', startIn: 2, days: 3, mode: 'ONLINE', max: 5, min: 2, closesInHours: 20, share: 0.22 },
  { phase: 'UPCOMING', kind: 'NATIVE', startIn: 9, days: 2, mode: 'IN_PERSON', max: 4, min: 2, share: 0.15 },
  { phase: 'UPCOMING', kind: 'NATIVE', startIn: 16, days: 3, mode: 'HYBRID', max: 5, min: 3, share: 0.12 },
  { phase: 'UPCOMING', kind: 'NATIVE', startIn: 31, days: 3, mode: 'ONLINE', max: 5, min: 2, share: 0.06 },
  { phase: 'UPCOMING', kind: 'EXTERNAL', startIn: 6, days: 2, mode: 'ONLINE', platform: 'LUMA', verified: true, max: 4, min: 2, share: 0.07 },
  { phase: 'UPCOMING', kind: 'EXTERNAL', startIn: 21, days: 2, mode: 'IN_PERSON', platform: 'DEVPOST', verified: false, max: 5, min: 2, share: 0.05 },
  { phase: 'UPCOMING', kind: 'NATIVE', startIn: 12, days: 2, mode: 'ONLINE', cancelled: true, max: 4, min: 2, share: 0 },
]

const ROLE_OF_ARCHETYPE: Record<string, SquadRole> = {
  fullstack: 'FULLSTACK',
  frontend: 'FRONTEND',
  backend: 'BACKEND',
  mobile: 'MOBILE',
  ml: 'ML_AI',
  data: 'DATA',
  infra: 'DEVOPS',
  designer: 'DESIGN_UI_UX',
  product: 'PRODUCT',
  growth: 'PITCH_BUSINESS',
  web3: 'BACKEND',
  hardware: 'HARDWARE',
  security: 'DEVOPS',
  games: 'FRONTEND',
}

const roleOf = (person: Person): SquadRole => ROLE_OF_ARCHETYPE[person.archetype.key] ?? 'OTHER'

const SQUAD_NAMES_A = ['Null', 'Hex', 'Delta', 'Ferris', 'Cobalt', 'Quokka', 'Zen', 'Atlas', 'Neon', 'Pixel', 'Rusty', 'Vector', 'Gamma', 'Orbit', 'Cinder', 'Marlin']
const SQUAD_NAMES_B = ['Pointers', 'Wranglers', 'Shippers', 'Collective', 'Unit', 'Garage', 'Crew', 'Syndicate', 'Labs', 'Brigade', 'Guild', 'Pioneers']

export async function seedHackathons(ctx: Ctx): Promise<void> {
  const core = ctx.people.filter((person) => person.tier === 'core')
  const taken = new Set<string>()
  for (const [index, plan] of PLANS.entries()) {
    const rng = ctx.rng.fork(`hackathon-${index}`)
    await oneHackathon(ctx, plan, index, rng, core, taken)
  }
  ctx.log(`  ${ctx.hackathons.length} hackathons`)
}

async function oneHackathon(ctx: Ctx, plan: Plan, index: number, rng: Rng, core: Person[], names: Set<string>): Promise<void> {
  const { db, now } = ctx
  const city = rng.pick(CITIES.filter((c) => plan.mode !== 'ONLINE' || rng.chance(0.3)))
  const theme = HACKATHON_THEMES[(index + rng.int(0, 3)) % HACKATHON_THEMES.length]
  let name = `${theme} ${plan.kind === 'NATIVE' ? 'Jam' : rng.pick(['Hackathon', 'Buildathon', 'Challenge'])} ${city.city}`
  if (names.has(name)) name = `${name} ${index}`
  names.add(name)
  const startDate = new Date(now.getTime() + plan.startIn * DAY_MS + rng.int(0, 5) * HOUR_MS)
  const endDate = new Date(startDate.getTime() + plan.days * DAY_MS)
  const registrationDeadline = plan.closesInHours !== undefined ? new Date(now.getTime() + plan.closesInHours * HOUR_MS) : new Date(startDate.getTime() - rng.int(1, 3) * DAY_MS)
  const submissionDeadline = new Date(endDate.getTime() - 6 * HOUR_MS)
  const status = plan.cancelled ? 'CANCELLED' : plan.phase === 'PAST' ? 'ENDED' : plan.phase === 'LIVE' ? 'ACTIVE' : 'UPCOMING'
  const slug = `seed-${index.toString().padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 90)
  const tracks = rng.sample(HACKATHON_TRACKS, 3).map((track) => ({ name: track, description: null }))
  const technologies = rng.sample(['React', 'TypeScript', 'Python', 'Rust', 'PostgreSQL', 'PyTorch', 'Solidity', 'Flutter', 'Go', 'Unity'], 4)
  const submitter = plan.kind === 'EXTERNAL' ? rng.pick(core.filter((person) => person.activity > 0.3)) : null
  const verifiedAt = plan.kind === 'NATIVE' || plan.verified ? new Date(startDate.getTime() - 15 * DAY_MS) : null

  const hackathon = await db.hackathon.create({
    data: {
      name,
      slug,
      description: `${theme}: a ${plan.days}-day build with a squad. Bring an idea or find one; ship a working demo by the deadline. Mentors, prizes and a very good group chat.`,
      shortDesc: `${plan.days} days, squads of up to ${plan.max}, ${theme.toLowerCase()}`,
      startDate,
      endDate,
      registrationDeadline,
      submissionDeadline,
      status,
      organizer: plan.kind === 'NATIVE' ? 'Skill Dating Community' : rng.pick(HACKATHON_ORGANIZERS),
      websiteUrl: plan.kind === 'EXTERNAL' ? `https://example.com/${slug}` : null,
      prizePool: rng.pick(['$5,000', '$10,000', '₹2,00,000', '€4,000', '$1,000 + credits']),
      technologies,
      maxTeamSize: plan.max,
      minTeamSize: plan.min,
      location: plan.mode === 'ONLINE' ? 'Online' : `${city.venues[0]}, ${city.city}`,
      tracks,
      source: plan.kind,
      externalUrl: plan.kind === 'EXTERNAL' ? `https://example.com/events/${slug}` : null,
      platform: plan.platform ?? null,
      mode: plan.mode,
      city: plan.mode === 'ONLINE' ? null : city.city,
      country: plan.mode === 'ONLINE' ? null : city.countryCode,
      resultsAt: plan.phase === 'PAST' ? new Date(endDate.getTime() + DAY_MS) : null,
      submittedById: submitter?.id ?? null,
      verifiedAt,
      createdAt: new Date(startDate.getTime() - 40 * DAY_MS),
    },
  })
  await db.conversation.create({ data: { type: 'HACKATHON', hackathonId: hackathon.id } })
  const record: HackathonRecord = { id: hackathon.id, slug, name, kind: plan.kind, phase: plan.phase, startDate, endDate, registrationDeadline, maxTeamSize: plan.max, city: plan.mode === 'ONLINE' ? null : city }
  ctx.hackathons.push(record)
  if (plan.cancelled) return

  // --- Who registers, and when ---------------------------------------------------------------------------------------------------
  const wanted = Math.max(8, Math.round(core.length * plan.share))
  const local = core.filter((person) => (plan.mode === 'ONLINE' ? true : person.city.key === city.key || rng.chance(0.08)))
  const pool = rng.shuffle(local).filter((person) => person.activity > 0.05).slice(0, wanted)
  const squadHackathon = await db.hackathon.findUniqueOrThrow({ where: { id: hackathon.id }, select: squadHackathonSelect })
  const pays = hackathonPaysRewards(squadHackathon)
  const registrationCloses = Math.min(registrationDeadline.getTime() - HOUR_MS, now.getTime() - HOUR_MS)
  const opens = Math.min(registrationCloses - 2 * DAY_MS, registrationDeadline.getTime() - 18 * DAY_MS)
  const registered: { person: Person; at: Date }[] = []
  for (const person of pool) {
    const earliest = Math.max(opens, person.createdAt.getTime() + 2 * DAY_MS)
    if (earliest >= registrationCloses) continue
    const at = new Date(earliest + Math.floor(rng.next() * (registrationCloses - earliest)))
    registered.push({ person, at })
  }
  registered.sort((a, b) => a.at.getTime() - b.at.getTime())
  for (const { person, at } of registered) {
    await atMoment(db, at, async () => {
      await transactWithEvents(db, async (tx) => {
        await tx.hackathonParticipant.create({
          data: { userId: person.id, hackathonId: hackathon.id, registeredAt: at, skills: person.skills.slice(0, 4).map((skill) => skill.slug), lookingFor: person.archetype.seeks.slice(0, 2), preferredRoles: [roleOf(person)] },
        })
        await recordActivity(tx, person.id, 'HACKATHON_JOINED', `Joined hackathon "${name}"`, { link: `/hackathons/${slug}` })
        if (pays) await emit(tx, 'HACKATHON_JOINED', { userId: person.id, hackathonId: hackathon.id, hackathonName: name })
      })
    })
  }
  if (registered.length < 4) return

  // --- Squads --------------------------------------------------------------------------------------------------------------------
  const free = new Set(registered.map((entry) => entry.person.id))
  const registeredAt = new Map(registered.map((entry) => [entry.person.id, entry.at]))
  const owners = registered.filter((entry) => rng.chance(plan.phase === 'UPCOMING' ? 0.2 : 0.3)).slice(0, Math.ceil(registered.length / 3.2))
  const teams: { id: string; ownerId: string; projectId: string | null; members: string[]; slots: number; filledSlots: number; name: string }[] = []
  const fillRate = plan.phase === 'UPCOMING' ? 0.55 : 0.92
  for (const { person: owner, at } of owners) {
    if (!free.has(owner.id)) continue
    const formedAt = new Date(Math.min(registrationCloses, Math.max(at.getTime() + 3 * HOUR_MS, owner.createdAt.getTime() + 3 * DAY_MS)))
    const size = rng.int(Math.max(2, plan.min), plan.max)
    const squadName = `${rng.pick(SQUAD_NAMES_A)} ${rng.pick(SQUAD_NAMES_B)}`
    const needs = templateFor({ size, tracks: tracks.map((t) => ({ name: t.name, description: null })), technologies })
    const ownerRole = roleOf(owner)
    const ownIndex = needs.findIndex((need) => need.role === ownerRole)
    const openNeeds: RoleNeed[] = needs.filter((_, i) => i !== (ownIndex >= 0 ? ownIndex : 0)).slice(0, size - 1)
    free.delete(owner.id)
    const made = await atMoment(db, formedAt, async () => {
      const { value } = await transactWithEvents(db, async (tx) => {
        const team = await createSquadTeam(tx, { hackathon: squadHackathon, ownerId: owner.id, name: squadName, ownerRole, maxSize: size, now: formedAt })
        await createSlots(tx, team.id, openNeeds)
        await tx.team.update({ where: { id: team.id }, data: { targetTracks: rng.sample(tracks, 1).map((track) => track.name), description: `We are building something for ${theme.toLowerCase()}. Looking for people who ship.` } })
        return team
      })
      return value
    })
    const slots = await db.teamSlot.findMany({ where: { teamId: made.id }, orderBy: { position: 'asc' } })
    const members = [owner.id]
    let filled = 0
    for (const slot of slots) {
      if (!rng.chance(fillRate)) continue
      const candidates = registered.map((entry) => entry.person).filter((person) => free.has(person.id) && roleOf(person) === slot.role)
      const fallback = registered.map((entry) => entry.person).filter((person) => free.has(person.id))
      const pick = candidates.length > 0 ? rng.pick(candidates) : rng.chance(0.4) && fallback.length > 0 ? rng.pick(fallback) : null
      if (!pick) continue
      const joinAt = new Date(Math.min(registrationCloses, Math.max(formedAt.getTime() + HOUR_MS, (registeredAt.get(pick.id) ?? formedAt).getTime() + HOUR_MS) + rng.int(0, 36) * HOUR_MS))
      const joined = await atMoment(db, joinAt, async () => {
        const { value } = await transactWithEvents(db, async (tx) => {
          const team = { id: made.id, name: made.name, slug: made.slug, ownerId: made.ownerId, maxSize: made.maxSize, projectId: made.projectId, hackathonId: made.hackathonId }
          const refusal = await checkJoin(tx, team, pick.id, { slotId: slot.id, now: joinAt })
          if (refusal) return false
          await addMember(tx, team, pick.id, { slotId: slot.id, now: joinAt })
          return true
        })
        return value
      })
      if (joined) {
        free.delete(pick.id)
        members.push(pick.id)
        filled += 1
      }
    }
    teams.push({ id: made.id, ownerId: owner.id, projectId: null, members, slots: slots.length, filledSlots: filled, name: squadName })
  }

  // --- The looking-for-group board and the solo pool (before the squads lock) -------------------------------------------------------
  const solo = registered.map((entry) => entry.person).filter((person) => free.has(person.id))
  for (const person of solo) {
    const wantsTeam = rng.chance(0.65)
    if (!wantsTeam) continue
    await db.hackathonParticipant.update({ where: { userId_hackathonId: { userId: person.id, hackathonId: hackathon.id } }, data: { lookingForTeam: true, openToAutoTeam: rng.chance(0.55) } })
  }
  if (plan.phase !== 'PAST') {
    for (const person of rng.sample(solo, Math.min(solo.length, 10))) {
      const at = new Date(Math.min(now.getTime() - HOUR_MS, (registeredAt.get(person.id) ?? now).getTime() + 2 * HOUR_MS))
      await atMoment(db, at, () =>
        createLfgPost(db, { hackathon: { id: hackathon.id, endDate, submissionDeadline }, authorId: person.id, now: at, body: { kind: 'PERSON', roles: [roleOf(person)], stack: person.skills.slice(0, 3).map((skill) => skill.slug), timezone: person.city.timezone, note: `Looking for a squad. I do ${person.archetype.role.toLowerCase()} work and I finish things.`, expiresAt: undefined, teamId: undefined } as never })
      )
    }
    for (const team of teams.filter((t) => t.filledSlots < t.slots).slice(0, 6)) {
      const owner = ctx.byId.get(team.ownerId)!
      const at = new Date(Math.min(now.getTime() - HOUR_MS, registrationCloses))
      await atMoment(db, at, () =>
        createLfgPost(db, { hackathon: { id: hackathon.id, endDate, submissionDeadline }, authorId: owner.id, now: at, body: { kind: 'TEAM', teamId: team.id, roles: [], stack: [], timezone: owner.city.timezone, note: `${team.name} has open seats and a clear plan. Come build with us.`, expiresAt: undefined } as never })
      )
    }
  }
  if (plan.phase === 'UPCOMING' && plan.closesInHours === undefined && plan.startIn > 8) {
    // The solo pool's automatic round, run as it would be two days before registration closes; then the people answer: most squads form, one falls through, one is left waiting.
    const roundAt = new Date(Math.min(now.getTime() - 6 * HOUR_MS, registrationDeadline.getTime() - 2 * DAY_MS))
    if (solo.length >= plan.min * 2) {
      const poolHackathon = await db.hackathon.findUniqueOrThrow({
        where: { id: hackathon.id },
        select: { ...squadHackathonSelect, status: true, technologies: true, tracks: true, startDate: true, endDate: true, registrationDeadline: true, submissionDeadline: true },
      })
      await atMoment(db, roundAt, async () => {
        const outcome = await runRound(db, poolHackathon, 1, roundAt)
        ctx.log(`  the solo pool of ${name}: ${outcome.squads} squads proposed from ${outcome.poolSize} people`)
        const proposals = await db.squadProposal.findMany({ where: { hackathonId: hackathon.id, kind: 'AUTO', status: 'PROPOSED' }, include: { members: true }, orderBy: { createdAt: 'asc' } })
        for (const [position, proposal] of proposals.entries()) {
          const mode = position === 0 && proposals.length > 2 ? 'FAIL' : position === proposals.length - 1 && proposals.length > 2 ? 'WAIT' : 'FORM'
          for (const [seat, member] of proposal.members.entries()) {
            if (mode === 'WAIT') continue
            const accept = mode === 'FORM' || seat !== 0
            await respondToProposal(db, { proposalId: proposal.id, userId: member.userId, accept, now: new Date(roundAt.getTime() + (seat + 1) * HOUR_MS) })
          }
        }
      })
    }
  }

  // --- A project for each squad that is building, pledges, ideas and a checklist --------------------------------------------------
  const squadsReady = teams.filter((team) => team.members.length >= plan.min)
  for (const team of squadsReady) {
    const owner = ctx.byId.get(team.ownerId)!
    const since = new Date(Math.min(now.getTime() - HOUR_MS, Math.max(registrationCloses, owner.createdAt.getTime()) + HOUR_MS))
    if (plan.phase !== 'UPCOMING' || rng.chance(0.4)) {
      const projectName = `${team.name.split(' ')[0]}${rng.pick(['Kit', 'Loop', 'Base', 'Lab', 'Flow'])}`
      const project = await db.project.create({
        data: { name: projectName, slug: `seed-${hackathon.id.slice(-6)}-${team.id.slice(-6)}`, description: `A ${theme.toLowerCase()} build by ${team.name}.`, status: plan.phase === 'UPCOMING' ? 'PLANNING' : 'BUILDING', ownerId: team.ownerId, hackathonId: hackathon.id, teamSize: team.members.length, maxTeamSize: plan.max, isPublic: true, createdAt: since },
      })
      await db.projectMember.createMany({ data: team.members.map((userId, i) => ({ userId, projectId: project.id, role: i === 0 ? 'OWNER' : 'MEMBER', joinedAt: since })), skipDuplicates: true })
      await db.team.update({ where: { id: team.id }, data: { projectId: project.id } })
      await db.hackathonTeam.update({ where: { teamId: team.id }, data: { projectId: project.id } })
      team.projectId = project.id
    }
    if (plan.phase !== 'PAST') {
      for (const userId of team.members) {
        if (!rng.chance(plan.phase === 'LIVE' ? 0.95 : 0.65)) continue
        const person = ctx.byId.get(userId)!
        const at = new Date(Math.min(now.getTime() - HOUR_MS, since.getTime() + rng.int(1, 40) * HOUR_MS))
        await atMoment(db, at, async () => {
          await db.commitmentPledge.create({
            data: { hackathonId: hackathon.id, teamId: team.id, userId, attendance: plan.mode === 'IN_PERSON' && person.city.key === city.key ? 'IN_PERSON' : 'REMOTE', hoursAvailable: rng.pick([12, 20, 24, 30, 36]), availableFrom: startDate, availableUntil: endDate, confirmedAt: at },
          })
        })
      }
    }
    if (rng.chance(0.6)) {
      const author = rng.pick(team.members)
      const idea = await db.teamIdea.create({ data: { teamId: team.id, authorId: author, title: rng.pick(['An agent that does the boring part', 'Offline-first notes for field teams', 'A dashboard that explains itself', 'Plain-language contract checker']), description: 'Scoped to what we can demo in two days.', voteCount: 0, createdAt: since } })
      const voters = team.members.filter(() => rng.chance(0.7))
      if (voters.length > 0) {
        await db.teamIdeaVote.createMany({ data: voters.map((userId) => ({ ideaId: idea.id, userId })), skipDuplicates: true })
        await db.teamIdea.update({ where: { id: idea.id }, data: { voteCount: voters.length, ...(voters.length >= 2 && rng.chance(0.5) ? { chosenAt: since } : {}) } })
      }
      const titles = ['Pick the stack', 'Wireframes', 'Auth and data model', 'Demo script', 'Landing page']
      await db.teamChecklistItem.createMany({
        data: titles.slice(0, 4).map((title, position) => ({ teamId: team.id, title, assigneeId: rng.pick(team.members), done: plan.phase !== 'UPCOMING' && rng.chance(0.6), doneAt: plan.phase !== 'UPCOMING' ? since : null, createdById: team.ownerId, position, createdAt: since })),
      })
    }
  }

  // --- Submissions, results and peer reviews ---------------------------------------------------------------------------------------
  if (plan.phase !== 'UPCOMING') {
    const submitChance = plan.phase === 'PAST' ? 0.8 : 0.4
    const submitted: typeof teams = []
    for (const team of squadsReady.filter((t) => t.projectId)) {
      if (!rng.chance(submitChance)) continue
      const at = new Date(Math.min(now.getTime() - HOUR_MS, Math.max(startDate.getTime() + 6 * HOUR_MS, startDate.getTime()) + rng.int(10, plan.days * 22) * HOUR_MS))
      if (at.getTime() >= submissionDeadline.getTime() && plan.phase === 'LIVE') continue
      await atMoment(db, at, async () => {
        const memberIds = team.members
        await transactWithEvents(db, async (tx) => {
          const updated = await tx.hackathonParticipant.updateMany({ where: { hackathonId: hackathon.id, teamId: team.id, status: { not: 'SUBMITTED' } }, data: { status: 'SUBMITTED' } })
          if (updated.count === 0 || !pays) return
          for (const userId of [...memberIds].sort()) {
            await emit(tx, 'SQUAD_SUBMITTED', { userId, teamId: team.id, hackathonId: hackathon.id, hackathonName: name })
            if (userId !== team.ownerId) await emit(tx, 'SQUAD_JOIN_CONFIRMED', { userId, ownerId: team.ownerId, teamId: team.id, hackathonId: hackathon.id, hackathonName: name })
          }
        })
      })
      submitted.push(team)
    }

    if (plan.phase === 'PAST') {
      const ranked = rng.shuffle(submitted)
      const resultsAt = new Date(endDate.getTime() + DAY_MS)
      await atMoment(db, resultsAt, async () => {
        for (const [position, team] of ranked.entries()) {
          await db.hackathonTeam.update({ where: { teamId: team.id }, data: { rank: position < 5 ? position + 1 : null, score: Math.max(40, 96 - position * 6 - rng.int(0, 4)) } })
          if (position === 0 && pays) {
            const hackathonTeam = await db.hackathonTeam.findUniqueOrThrow({ where: { teamId: team.id }, select: { id: true } })
            await transactWithEvents(db, async (tx) => {
              for (const userId of [...team.members].sort()) {
                await recordActivity(tx, userId, 'HACKATHON_WON', `Won "${name}"`, { link: `/hackathons/${slug}` })
                await emit(tx, 'HACKATHON_WON', { userId, hackathonId: hackathon.id, hackathonName: name, hackathonTeamId: hackathonTeam.id })
              }
            })
          }
        }
      })
      const reviewAt = new Date(Math.min(now.getTime() - HOUR_MS, endDate.getTime() + 2 * DAY_MS))
      await atMoment(db, reviewAt, async () => {
        for (const team of squadsReady) {
          for (const reviewer of team.members) {
            for (const reviewee of team.members) {
              if (reviewer === reviewee || !rng.chance(0.8)) continue
              await writePeerReview(db, {
                hackathon: { id: hackathon.id, endDate, resultsAt },
                reviewerId: reviewer,
                now: new Date(reviewAt.getTime() + rng.int(0, 600) * 60_000),
                body: { revieweeId: reviewee, showedUp: rng.weighted([['YES', 8], ['PARTLY', 2], ['NO', 0.4]] as const), wouldBuildAgain: rng.chance(0.85), note: rng.chance(0.3) ? 'Reliable, kind, and shipped their part early.' : undefined } as never,
              })
            }
          }
        }
      })
    }
  }

  // A squad that never got going: its owner left, the others withdrew (the withdrawn state), for the past and live ones.
  if (plan.phase !== 'UPCOMING') {
    const withdrawing = registered.filter((entry) => free.has(entry.person.id) && rng.chance(0.12)).slice(0, 4)
    for (const { person } of withdrawing) {
      await db.hackathonParticipant.update({ where: { userId_hackathonId: { userId: person.id, hackathonId: hackathon.id } }, data: { status: 'WITHDRAWN' } })
      free.delete(person.id)
    }
  }
  // The squads that formed in the last day are told, as they would be.
  if (plan.phase !== 'PAST') {
    for (const team of teams.slice(0, 5)) {
      await createNotification(db, { userId: team.ownerId, kind: 'SQUAD_UPDATE', title: 'Your squad is shaping up', message: `${team.name} has ${team.members.length} of ${team.slots + 1} seats filled for ${name}.`, link: `/teams/${team.id}`, metadata: { teamId: team.id } })
    }
  }
}

export type { Prisma }
