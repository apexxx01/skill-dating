import type { Prisma, PrismaClient, SquadRole } from '@prisma/client'
import { z } from 'zod'
import { blockRelation } from '@/lib/blocks'
import { emit, transactWithEvents } from '@/lib/events'
import { createPost, type CreatePostResult } from '@/lib/posts/posts'
import { isLocked, lockTimeOf } from './membership'
import { roleLabel } from './roles'
import { slugify } from './teams'
import { tracksOf } from './tracks'

// A hackathon team's private space (docs/SQUADS.md, "Team space"): the roles, the countdown to the submission deadline, a shared checklist, an idea
// board with votes and one chosen idea, the members' commitment pledges, "post our demo" (a DEMO post on the feed, co-authored by the squad) and,
// once the results are in or the hackathon is over, "keep building": the squad becomes a permanent crew with a project.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export const SPACE_LIMITS = { checklistItems: 100, ideas: 50 }

export const checklistCreateSchema = z.object({ title: z.string().trim().min(1).max(200), assigneeId: z.string().min(1).max(64).nullable().optional() }).strict()
export const checklistUpdateSchema = z
  .object({ title: z.string().trim().min(1).max(200), assigneeId: z.string().min(1).max(64).nullable(), done: z.boolean(), position: z.number().int().min(0).max(1000) })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field')

export const ideaCreateSchema = z.object({ title: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).optional() }).strict()

export const demoPostSchema = z
  .object({
    title: z.string().min(3).max(120),
    body: z.string().min(1).max(10_000),
    links: z.array(z.string().max(500)).max(5).default([]),
    mediaIds: z.array(z.string().min(1).max(64)).max(10).default([]),
    stackTags: z.array(z.string().max(30)).max(10).default([]),
  })
  .strict()

const personSelect = { id: true, name: true, username: true, image: true } as const

export interface TeamSpaceView {
  team: { id: string; name: string; slug: string; ownerId: string; projectId: string | null; targetTracks: string[]; keptBuildingAt: string | null }
  hackathon: {
    id: string
    name: string
    slug: string
    startDate: string
    endDate: string
    submissionDeadline: string | null
    /** When the team locks (the submission deadline, else the end), and the seconds left until then (0 once locked). */
    locksAt: string
    secondsLeft: number
    locked: boolean
    tracks: { name: string; description: string | null }[]
    unverified: boolean
  } | null
  roles: { userId: string; name: string | null; username: string | null; image: string | null; teamRole: string; squadRole: SquadRole | null; roleLabel: string | null; pledge: { attendance: string; hoursAvailable: number; availableFrom: string; availableUntil: string } | null }[]
  openSlots: { id: string; role: SquadRole; label: string; requiredSkills: string[] }[]
  checklist: { id: string; title: string; done: boolean; doneAt: string | null; position: number; assignee: { id: string; name: string | null; username: string | null; image: string | null } | null }[]
  ideas: { id: string; title: string; description: string | null; voteCount: number; votedByMe: boolean; chosen: boolean; author: { id: string; name: string | null; username: string | null; image: string | null } }[]
  /** Members who have not confirmed a pledge, while pledges are due (before the hackathon starts). */
  unconfirmedPledges: string[]
}

export async function loadTeamSpace(db: Db, teamId: string, viewerId: string, now: Date = new Date()): Promise<TeamSpaceView | null> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      name: true,
      slug: true,
      ownerId: true,
      projectId: true,
      targetTracks: true,
      keptBuildingAt: true,
      hackathonTeams: { select: { hackathon: { select: { id: true, name: true, slug: true, startDate: true, endDate: true, submissionDeadline: true, tracks: true, source: true, verifiedAt: true } } }, take: 1 },
      hackathon: { select: { id: true, name: true, slug: true, startDate: true, endDate: true, submissionDeadline: true, tracks: true, source: true, verifiedAt: true } },
      members: { select: { userId: true, role: true, squadRole: true, roleLabel: true, user: { select: personSelect } }, orderBy: { joinedAt: 'asc' } },
      slots: { where: { status: 'OPEN' }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true, role: true, customLabel: true, requiredSkills: true } },
      TeamChecklistItem: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: { assignee: { select: personSelect } } },
      TeamIdea: { orderBy: [{ voteCount: 'desc' }, { createdAt: 'asc' }], include: { author: { select: personSelect }, votes: { where: { userId: viewerId }, select: { id: true } } } },
    },
  })
  if (!team) return null
  // A team that kept building is no longer tied to its hackathon (Team.hackathonId is cleared), but its registration still says which one it was.
  const hackathon = team.hackathon ?? team.hackathonTeams[0]?.hackathon ?? null
  const pledges = hackathon ? await db.commitmentPledge.findMany({ where: { hackathonId: hackathon.id, userId: { in: team.members.map((m) => m.userId) } } }) : []
  const pledgeBy = new Map(pledges.map((pledge) => [pledge.userId, pledge]))
  const pledgesDue = Boolean(hackathon && now.getTime() < hackathon.startDate.getTime())
  const locksAt = hackathon ? lockTimeOf(hackathon) : null
  const locked = Boolean(hackathon && !team.keptBuildingAt && isLocked(hackathon, now))

  return {
    team: { id: team.id, name: team.name, slug: team.slug, ownerId: team.ownerId, projectId: team.projectId, targetTracks: team.targetTracks, keptBuildingAt: team.keptBuildingAt?.toISOString() ?? null },
    hackathon:
      hackathon && locksAt
        ? {
            id: hackathon.id,
            name: hackathon.name,
            slug: hackathon.slug,
            startDate: hackathon.startDate.toISOString(),
            endDate: hackathon.endDate.toISOString(),
            submissionDeadline: hackathon.submissionDeadline?.toISOString() ?? null,
            locksAt: locksAt.toISOString(),
            secondsLeft: Math.max(0, Math.floor((locksAt.getTime() - now.getTime()) / 1000)),
            locked,
            tracks: tracksOf(hackathon.tracks),
            unverified: hackathon.source === 'EXTERNAL' && !hackathon.verifiedAt,
          }
        : null,
    roles: team.members.map((member) => {
      const pledge = pledgeBy.get(member.userId)
      return {
        userId: member.userId,
        name: member.user.name,
        username: member.user.username,
        image: member.user.image,
        teamRole: member.role,
        squadRole: member.squadRole,
        roleLabel: member.squadRole ? roleLabel({ role: member.squadRole, customLabel: member.roleLabel }) : null,
        pledge: pledge
          ? { attendance: pledge.attendance, hoursAvailable: pledge.hoursAvailable, availableFrom: pledge.availableFrom.toISOString().slice(0, 10), availableUntil: pledge.availableUntil.toISOString().slice(0, 10) }
          : null,
      }
    }),
    openSlots: team.slots.map((slot) => ({ id: slot.id, role: slot.role, label: roleLabel({ role: slot.role, customLabel: slot.customLabel }), requiredSkills: slot.requiredSkills })),
    checklist: team.TeamChecklistItem.map((item) => ({ id: item.id, title: item.title, done: item.done, doneAt: item.doneAt?.toISOString() ?? null, position: item.position, assignee: item.assignee })),
    ideas: team.TeamIdea.map((idea) => ({ id: idea.id, title: idea.title, description: idea.description, voteCount: idea.voteCount, votedByMe: idea.votes.length > 0, chosen: idea.chosenAt !== null, author: idea.author })),
    unconfirmedPledges: pledgesDue ? team.members.filter((member) => !pledgeBy.has(member.userId)).map((member) => member.userId) : [],
  }
}

// --- Ideas ---------------------------------------------------------------------------------------------------------

/** One vote per member per idea; the count is kept on the idea. Returns the new count, or null when the idea is not this team's. */
export async function voteIdea(db: Db, input: { teamId: string; ideaId: string; userId: string; vote: boolean }): Promise<number | null> {
  return db.$transaction(async (tx) => {
    const [idea] = await tx.$queryRaw<{ teamId: string }[]>`SELECT "teamId" FROM "TeamIdea" WHERE id = ${input.ideaId} FOR UPDATE`
    if (!idea || idea.teamId !== input.teamId) return null
    if (input.vote) await tx.teamIdeaVote.createMany({ data: [{ ideaId: input.ideaId, userId: input.userId }], skipDuplicates: true })
    else await tx.teamIdeaVote.deleteMany({ where: { ideaId: input.ideaId, userId: input.userId } })
    const voteCount = await tx.teamIdeaVote.count({ where: { ideaId: input.ideaId } })
    await tx.teamIdea.update({ where: { id: input.ideaId }, data: { voteCount } })
    return voteCount
  })
}

/** Marks one idea as the squad's choice (and no other). Null when the idea is not this team's. */
export async function chooseIdea(db: Db, input: { teamId: string; ideaId: string; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date()
  return db.$transaction(async (tx) => {
    const idea = await tx.teamIdea.findUnique({ where: { id: input.ideaId }, select: { teamId: true } })
    if (!idea || idea.teamId !== input.teamId) return false
    await tx.teamIdea.updateMany({ where: { teamId: input.teamId, chosenAt: { not: null }, id: { not: input.ideaId } }, data: { chosenAt: null } })
    await tx.teamIdea.update({ where: { id: input.ideaId }, data: { chosenAt: now } })
    return true
  })
}

// --- Post our demo --------------------------------------------------------------------------------------------------

/** The most co-authors a post can name (src/lib/posts/posts.ts). */
export const MAX_CO_AUTHORS = 5

/** A DEMO post on the feed for the team (and its project), co-authored by the other members (the first five who have not blocked the author). */
export async function postDemo(db: Db, input: { teamId: string; author: { id: string; timezone: string | null }; body: z.infer<typeof demoPostSchema> }): Promise<CreatePostResult> {
  const team = await db.team.findUniqueOrThrow({ where: { id: input.teamId }, select: { projectId: true, members: { select: { userId: true }, orderBy: { joinedAt: 'asc' } } } })
  const coAuthorIds: string[] = []
  for (const member of team.members) {
    if (member.userId === input.author.id || coAuthorIds.length >= MAX_CO_AUTHORS) continue
    if (!(await blockRelation(db, input.author.id, member.userId))) coAuthorIds.push(member.userId)
  }
  return createPost(db, input.author, {
    kind: 'DEMO',
    title: input.body.title,
    body: input.body.body,
    teamId: input.teamId,
    ...(team.projectId ? { projectId: team.projectId } : {}),
    links: input.body.links,
    mediaIds: input.body.mediaIds,
    stackTags: input.body.stackTags,
    coAuthorIds,
    visibility: 'PUBLIC',
  })
}

// --- Keep building --------------------------------------------------------------------------------------------------

export type KeepBuildingFailure = 'NOT_A_HACKATHON_TEAM' | 'TOO_EARLY' | 'ALREADY'

/**
 * After the results (or the end date): the squad becomes a permanent crew. Members and their roles stay; the team is no longer tied to the hackathon
 * (Team.hackathonId is cleared, so its size limits and lock stop applying, and its HackathonTeam keeps the history); its project is kept, or one is
 * created from the chosen idea (else the team's name) with every member on it.
 */
export async function keepBuilding(db: Db, input: { teamId: string; userId: string; projectName?: string; now?: Date }) {
  const now = input.now ?? new Date()
  const team = await db.team.findUniqueOrThrow({
    where: { id: input.teamId },
    select: {
      id: true,
      name: true,
      ownerId: true,
      projectId: true,
      keptBuildingAt: true,
      members: { select: { userId: true } },
      hackathonTeams: { select: { id: true, hackathon: { select: { id: true, name: true, endDate: true, resultsAt: true } } }, take: 1 },
      TeamIdea: { where: { chosenAt: { not: null } }, select: { title: true, description: true }, take: 1 },
    },
  })
  const registration = team.hackathonTeams[0]
  if (!registration) return { ok: false as const, reason: 'NOT_A_HACKATHON_TEAM' as KeepBuildingFailure }
  if (team.keptBuildingAt) return { ok: false as const, reason: 'ALREADY' as KeepBuildingFailure }
  const { hackathon } = registration
  const over = Boolean(hackathon.resultsAt) || now.getTime() >= hackathon.endDate.getTime()
  if (!over) return { ok: false as const, reason: 'TOO_EARLY' as KeepBuildingFailure }

  const idea = team.TeamIdea[0]
  const { value, scope } = await transactWithEvents(db, async (tx: Tx) => {
    // Once, even for two owners clicking at the same moment.
    const claimed = await tx.team.updateMany({ where: { id: team.id, keptBuildingAt: null }, data: { keptBuildingAt: now, hackathonId: null, isRecruiting: false } })
    if (claimed.count === 0) return { created: false, projectId: null as string | null, already: true }
    let projectId = team.projectId
    let created = false
    if (!projectId) {
      const name = (input.projectName ?? idea?.title ?? team.name).slice(0, 100)
      const base = slugify(name).slice(0, 60)
      const slug = (await tx.project.findUnique({ where: { slug: base }, select: { id: true } })) ? `${base}-${team.id.slice(-6)}` : base
      const project = await tx.project.create({
        data: { name, slug, description: idea?.description ?? `Started at ${hackathon.name}`, ownerId: team.ownerId, teamSize: team.members.length, status: 'BUILDING' },
      })
      await tx.projectMember.createMany({ data: team.members.map((member) => ({ userId: member.userId, projectId: project.id, role: member.userId === team.ownerId ? 'OWNER' : 'MEMBER' })), skipDuplicates: true })
      await tx.team.update({ where: { id: team.id }, data: { projectId: project.id } })
      await tx.hackathonTeam.update({ where: { id: registration.id }, data: { projectId: project.id } })
      await emit(tx, 'PROJECT_CREATED', { userId: team.ownerId, projectId: project.id, projectName: project.name })
      projectId = project.id
      created = true
    }
    return { created, projectId, already: false }
  })
  if (value.already) return { ok: false as const, reason: 'ALREADY' as KeepBuildingFailure }
  return { ok: true as const, teamId: team.id, projectId: value.projectId!, projectCreated: value.created, rewards: await scope.rewardsFor(db, input.userId) }
}
