import type { Prisma, PrismaClient, SquadRole } from '@prisma/client'
import type { ErrorCode } from '@/lib/api/errors'
import { blockRelation } from '@/lib/blocks'
import { transactWithEvents } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { loadScoringProfiles } from '@/lib/matching/loader'
import { scoreCompatibility } from '@/lib/matching/score'
import { loadPersonSummaries } from '@/lib/matching/summary'
import { createNotification } from '@/lib/notifications'
import type { MatchPerson } from '@/types/api'
import { INVITATION_TTL_MS, PROPOSAL_TTL_MS } from './lifecycle'
import { capacityOf, createSlots, hackathonLimits, isLocked, otherSquadFor, squadHackathonSelect, type TeamForJoin } from './membership'
import { buildSquad, seedFrom } from './optimizer'
import { loadPairFacts, loadSquadPeople, pairKey, trustedIds, type SquadPerson } from './people'
import { loadPriorSignals } from './prior'
import { roleKey, roleLabel, squadSizeFor, templateFor, type RoleNeed, type RoleRef } from './roles'
import { squadStrength, type SquadStrength } from './strength'
import { createSquadTeam } from './teams'
import { tracksOf } from './tracks'

// "Find my squad": a complete squad of a sensible size around the requester, drawn from the hackathon's solo pool (registered, teamless, looking for
// a team, trusted, not blocked with anyone on the squad, never paired with someone they both said they would not build with again), optimised for
// squad strength (src/lib/squads/optimizer.ts), and then, in one call, the team and a slot invitation for everyone on it.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export const BUILDER_CONFIG = {
  /** The most solo-pool people considered (the most recently registered), so a huge hackathon stays fast. */
  poolLimit: 400,
  /** The best candidates by their fit to the requester that the optimiser works with. */
  shortlist: 40,
  maxEvaluations: 20_000,
}

export type BuilderFailure = { ok: false; code: ErrorCode; params?: Record<string, string | number> }

export interface ProposalMemberView {
  person: MatchPerson
  role: SquadRole
  roleLabel: string
  /** Why this person, from the pairwise score (src/lib/matching/score.ts), at most three lines. Empty for the requester and their team. */
  reasons: string[]
  /** Already on the requester's team (or the requester). */
  onTeam: boolean
}

export interface ProposalView {
  id: string
  hackathonId: string
  kind: 'BUILDER' | 'AUTO'
  status: string
  size: number
  seed: number
  expiresAt: string
  teamId: string | null
  strength: Pick<SquadStrength, 'score' | 'components' | 'gaps' | 'overlapHours'>
  members: ProposalMemberView[]
}

interface Context {
  hackathon: { id: string; name: string; slug: string; status: string; technologies: string[]; tracks: Prisma.JsonValue; minTeamSize: number; maxTeamSize: number; startDate: Date; endDate: Date; submissionDeadline: Date | null; source: 'NATIVE' | 'EXTERNAL'; verifiedAt: Date | null }
  team: { id: string; ownerId: string; targetTracks: string[]; members: { userId: string; squadRole: SquadRole | null; roleLabel: string | null }[]; slots: { role: SquadRole; customLabel: string | null; requiredSkills: string[]; status: string }[] } | null
}

async function loadContext(db: Db, hackathonId: string, requesterId: string, now: Date): Promise<Context | BuilderFailure> {
  const hackathon = await db.hackathon.findUnique({
    where: { id: hackathonId },
    select: { id: true, name: true, slug: true, status: true, technologies: true, tracks: true, minTeamSize: true, maxTeamSize: true, startDate: true, endDate: true, submissionDeadline: true, source: true, verifiedAt: true },
  })
  if (!hackathon) return { ok: false, code: 'HACKATHON_NOT_FOUND' }
  if (hackathon.status !== 'UPCOMING' && hackathon.status !== 'ACTIVE') return { ok: false, code: 'HACKATHON_TEAM_REGISTRATION_CLOSED' }
  if (isLocked(hackathon, now)) return { ok: false, code: 'TEAM_LOCKED' }
  const participant = await db.hackathonParticipant.findUnique({ where: { userId_hackathonId: { userId: requesterId, hackathonId } }, select: { teamId: true } })
  if (!participant) return { ok: false, code: 'HACKATHON_REGISTRATION_REQUIRED' }

  const teamId = participant.teamId ?? (await db.teamMember.findFirst({ where: { userId: requesterId, team: { hackathonId } }, select: { teamId: true } }))?.teamId ?? null
  const team = teamId
    ? await db.team.findUnique({
        where: { id: teamId },
        select: { id: true, ownerId: true, targetTracks: true, members: { select: { userId: true, squadRole: true, roleLabel: true }, orderBy: { joinedAt: 'asc' } }, slots: { select: { role: true, customLabel: true, requiredSkills: true, status: true } } },
      })
    : null
  return { hackathon, team }
}

/** Gives each member of a squad the role they would play: what they declared, else the template role strength found them for, else what they can play. */
export function assignProposalRoles(members: readonly SquadPerson[], needs: readonly RoleNeed[], strength: SquadStrength): Map<string, RoleRef> {
  const out = new Map<string, RoleRef>()
  const byKey = new Map(needs.map((need) => [roleKey(need), need]))
  for (const coverage of strength.roles) {
    if (!coverage.userId) continue
    const member = members.find((m) => m.userId === coverage.userId)
    out.set(coverage.userId, member?.role ?? byKey.get(coverage.key) ?? { role: 'FULLSTACK' })
  }
  // Whoever covers no template role gets one the template still lacks, else the first role they can play.
  const uncovered = strength.roles.filter((coverage) => !coverage.userId).map((coverage) => byKey.get(coverage.key)!)
  for (const member of members) {
    if (out.has(member.userId)) continue
    out.set(member.userId, member.role ?? uncovered.shift() ?? member.canPlay[0] ?? { role: 'FULLSTACK' })
  }
  return out
}

export interface ProposeInput {
  hackathonId: string
  requesterId: string
  size?: number
  seed?: number
  tracks?: string[]
  now?: Date
}

/** Proposes a squad around the requester and keeps the proposal (24 hours) for the invite step. */
export async function proposeSquad(db: Db, input: ProposeInput): Promise<{ ok: true; proposal: ProposalView } | BuilderFailure> {
  const now = input.now ?? new Date()
  const context = await loadContext(db, input.hackathonId, input.requesterId, now)
  if ('ok' in context) return context
  const { hackathon, team } = context

  const anchorIds = team ? team.members.map((member) => member.userId) : [input.requesterId]
  if (team && !anchorIds.includes(input.requesterId)) anchorIds.unshift(input.requesterId)
  const size = Math.max(squadSizeFor(hackathon, input.size), Math.min(anchorIds.length, hackathon.maxTeamSize))
  if (anchorIds.length >= size) return { ok: false, code: 'SQUAD_COMPLETE' }

  const allTracks = tracksOf(hackathon.tracks)
  const chosen = input.tracks ?? team?.targetTracks ?? []
  const unknown = chosen.filter((name) => !allTracks.some((track) => track.name.toLowerCase() === name.toLowerCase()))
  if (unknown.length > 0) return { ok: false, code: 'TRACK_NOT_FOUND', params: { tracks: unknown.join(', ') } }
  const tracks = allTracks.filter((track) => chosen.some((name) => name.toLowerCase() === track.name.toLowerCase()))
  const needs = templateFor({ technologies: hackathon.technologies, tracks, size })
  const slotSkills = (team?.slots ?? []).filter((slot) => slot.status === 'OPEN').flatMap((slot) => slot.requiredSkills)

  // --- The pool ------------------------------------------------------------------------------------------------
  const poolRows = await db.hackathonParticipant.findMany({
    where: { hackathonId: hackathon.id, teamId: null, lookingForTeam: true, userId: { notIn: anchorIds } },
    orderBy: [{ registeredAt: 'desc' }, { id: 'asc' }],
    take: BUILDER_CONFIG.poolLimit,
    select: { userId: true },
  })
  let poolIds = poolRows.map((row) => row.userId)
  const [trusted, inOtherTeams] = await Promise.all([
    trustedIds(db, poolIds, now),
    db.teamMember.findMany({ where: { userId: { in: poolIds }, team: { hackathonId: hackathon.id } }, select: { userId: true } }),
  ])
  const busy = new Set(inOtherTeams.map((row) => row.userId))
  poolIds = poolIds.filter((id) => trusted.has(id) && !busy.has(id))

  const roles = new Map<string, RoleRef | null>((team?.members ?? []).map((member) => [member.userId, member.squadRole ? { role: member.squadRole, customLabel: member.roleLabel } : null]))
  const pledgesExpected = now.getTime() < hackathon.startDate.getTime()
  const [people, pairs] = await Promise.all([loadSquadPeople(db, hackathon.id, [...anchorIds, ...poolIds], now, { roles, pledgesExpected }), loadPairFacts(db, [...anchorIds, ...poolIds])])
  const anchor = anchorIds.map((id) => people.get(id)).filter((p): p is SquadPerson => Boolean(p))
  const pool = poolIds.map((id) => people.get(id)).filter((p): p is SquadPerson => Boolean(p))

  // The pairwise fit of each candidate to the requester: the shortlist, and the reasons shown for them.
  const [viewer, ...candidates] = await loadScoringProfiles(db, [input.requesterId, ...pool.map((p) => p.id)], now, undefined, { includeWithoutMatchingProfile: true })
  const priors = await loadPriorSignals(db, input.requesterId, pool.map((p) => p.id))
  const fit = new Map<string, { score: number; reasons: string[] }>()
  if (viewer && viewer.userId === input.requesterId) {
    for (const candidate of candidates) {
      const result = scoreCompatibility({ viewer, candidate, connectionType: 'HACKATHON_TEAMMATE', now, prior: priors.get(candidate.userId) })
      if (!result.excluded) fit.set(candidate.userId, { score: result.score, reasons: result.reasons })
    }
  }

  const strengthOf = (members: readonly SquadPerson[]) => squadStrength({ members, needs: { roles: needs, requiredSkills: slotSkills, pledgesExpected, minSize: hackathon.minTeamSize }, history: pairs.history })
  const seed = input.seed ?? seedFrom(`${hackathon.id}:${input.requesterId}:${now.toISOString().slice(0, 10)}`)
  const built = buildSquad({
    anchor,
    pool: pool.filter((p) => fit.has(p.id) || !viewer),
    size,
    evaluate: (members) => strengthOf(members).score,
    forbidden: (a, b) => pairs.forbidden.has(pairKey(a, b)),
    seed,
    prescore: (candidate) => fit.get(candidate.id)?.score ?? 0,
    shortlist: BUILDER_CONFIG.shortlist,
    limits: { maxEvaluations: BUILDER_CONFIG.maxEvaluations },
  })
  if (built.members.length <= anchor.length) return { ok: false, code: 'SQUAD_POOL_EMPTY' }

  const strength = strengthOf(built.members)
  const assigned = assignProposalRoles(built.members, needs, strength)
  const proposal = await db.squadProposal.create({
    data: {
      hackathonId: hackathon.id,
      kind: 'BUILDER',
      status: 'OPEN',
      requesterId: input.requesterId,
      teamId: team?.id ?? null,
      seed,
      size,
      strength: strength.score,
      detail: { components: strength.components, gaps: strength.gaps, overlapHours: strength.overlapHours } as unknown as Prisma.InputJsonValue,
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
      members: {
        create: built.members.map((member, position) => {
          const role = assigned.get(member.userId)!
          const onTeam = anchorIds.includes(member.userId)
          return { userId: member.userId, role: role.role, roleLabel: role.role === 'OTHER' ? (role.customLabel ?? null) : null, reasons: onTeam ? [] : (fit.get(member.userId)?.reasons ?? []), position, response: onTeam ? 'ACCEPTED' : 'PENDING' }
        }),
      },
    },
  })
  await track(input.requesterId, 'squad_builder_used', { hackathonId: hackathon.id, size, proposed: built.members.length - anchor.length, strength: strength.score, evaluations: built.evaluations })
  return { ok: true, proposal: (await proposalView(db, proposal.id, now))! }
}

/** A stored proposal as the API shows it. */
export async function proposalView(db: Db, proposalId: string, now: Date = new Date()): Promise<ProposalView | null> {
  const proposal = await db.squadProposal.findUnique({ where: { id: proposalId }, include: { members: { orderBy: { position: 'asc' } } } })
  if (!proposal) return null
  const people = await loadPersonSummaries(db, proposal.members.map((member) => member.userId))
  const detail = proposal.detail as unknown as Pick<SquadStrength, 'components' | 'gaps' | 'overlapHours'>
  const expired = (proposal.status === 'OPEN' || proposal.status === 'PROPOSED') && proposal.expiresAt.getTime() <= now.getTime()
  return {
    id: proposal.id,
    hackathonId: proposal.hackathonId,
    kind: proposal.kind,
    status: expired && proposal.status === 'OPEN' ? 'EXPIRED' : proposal.status,
    size: proposal.size,
    seed: proposal.seed,
    expiresAt: proposal.expiresAt.toISOString(),
    teamId: proposal.teamId,
    strength: { score: proposal.strength, components: detail.components, gaps: detail.gaps, overlapHours: detail.overlapHours ?? null },
    members: proposal.members.flatMap((member) => {
      const person = people.get(member.userId)
      // A BUILDER proposal's requester and team members are stored as already ACCEPTED; the people it proposes answer through their invitations.
      return person ? [{ person, role: member.role, roleLabel: roleLabel({ role: member.role, customLabel: member.roleLabel }), reasons: member.reasons, onTeam: proposal.kind === 'BUILDER' && member.response === 'ACCEPTED' }] : []
    }),
  }
}

// --- Invite --------------------------------------------------------------------------------------------------------

export interface InviteOutcome {
  teamId: string
  created: boolean
  invitations: { userId: string; invitationId: string; slotId: string }[]
  skipped: { userId: string; reason: 'IN_ANOTHER_SQUAD' | 'BLOCKED' | 'ALREADY_INVITED' | 'NO_ROOM' }[]
}

/**
 * Turns an open BUILDER proposal into a team (the requester's, or a new one) with an open slot for, and a 48-hour slot invitation to, each proposed
 * person who is still free. One transaction; the proposal can be used once.
 */
export async function inviteProposal(db: Db, input: { proposalId: string; requesterId: string; teamName?: string; now?: Date }): Promise<{ ok: true; outcome: InviteOutcome } | BuilderFailure> {
  const now = input.now ?? new Date()
  const proposal = await db.squadProposal.findUnique({ where: { id: input.proposalId }, include: { members: { orderBy: { position: 'asc' } }, hackathon: { select: { ...squadHackathonSelect, endDate: true, submissionDeadline: true } } } })
  if (!proposal || proposal.kind !== 'BUILDER' || proposal.requesterId !== input.requesterId) return { ok: false, code: 'SQUAD_PROPOSAL_NOT_FOUND' }
  if (proposal.status !== 'OPEN') return { ok: false, code: 'SQUAD_PROPOSAL_USED' }
  if (proposal.expiresAt.getTime() <= now.getTime()) return { ok: false, code: 'SQUAD_PROPOSAL_EXPIRED' }
  if (isLocked(proposal.hackathon, now)) return { ok: false, code: 'TEAM_LOCKED' }

  const requester = await db.user.findUnique({ where: { id: input.requesterId }, select: { name: true, username: true } })
  const result = await transactWithEvents(db, async (tx): Promise<{ ok: true; outcome: InviteOutcome; teamName: string; teamSlug: string } | BuilderFailure> => {
    // Used once, even by two requests at the same moment.
    const claimed = await tx.squadProposal.updateMany({ where: { id: proposal.id, status: 'OPEN' }, data: { status: 'INVITED', decidedAt: now } })
    if (claimed.count === 0) return { ok: false, code: 'SQUAD_PROPOSAL_USED' }

    const own = proposal.members.find((member) => member.userId === input.requesterId)
    let team: TeamForJoin & { name: string; slug: string }
    let created = false
    const existingId = proposal.teamId ?? (await otherSquadFor(tx, input.requesterId, proposal.hackathonId, null))
    if (existingId) {
      const existing = await tx.team.findUnique({ where: { id: existingId }, select: { id: true, name: true, slug: true, ownerId: true, maxSize: true, projectId: true, hackathonId: true } })
      if (!existing) return { ok: false, code: 'TEAM_NOT_FOUND' }
      const membership = await tx.teamMember.findUnique({ where: { userId_teamId: { userId: input.requesterId, teamId: existing.id } }, select: { role: true } })
      if (!membership || membership.role === 'MEMBER') return { ok: false, code: 'FORBIDDEN' }
      team = existing
    } else {
      const name = input.teamName?.trim() || `${requester?.name || requester?.username || 'New'}'s squad`
      team = await createSquadTeam(tx, { hackathon: proposal.hackathon, ownerId: input.requesterId, name, ownerRole: own?.role ?? null, ownerRoleLabel: own?.roleLabel ?? null, now })
      created = true
    }

    await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${team.id} FOR UPDATE`
    const members = await tx.teamMember.count({ where: { teamId: team.id } })
    let room = capacityOf(team, await hackathonLimits(tx, team.hackathonId)) - members - (await tx.teamApplication.count({ where: { teamId: team.id, status: 'PENDING', invitedById: { not: null } } }))

    const outcome: InviteOutcome = { teamId: team.id, created, invitations: [], skipped: [] }
    for (const member of proposal.members) {
      if (member.userId === input.requesterId || (await tx.teamMember.findUnique({ where: { userId_teamId: { userId: member.userId, teamId: team.id } }, select: { id: true } }))) continue
      if (await otherSquadFor(tx, member.userId, proposal.hackathonId, team.id)) {
        outcome.skipped.push({ userId: member.userId, reason: 'IN_ANOTHER_SQUAD' })
        continue
      }
      if (await blockRelation(tx, input.requesterId, member.userId)) {
        outcome.skipped.push({ userId: member.userId, reason: 'BLOCKED' })
        continue
      }
      const existing = await tx.teamApplication.findUnique({ where: { userId_teamId: { userId: member.userId, teamId: team.id } } })
      if (existing?.status === 'PENDING') {
        outcome.skipped.push({ userId: member.userId, reason: 'ALREADY_INVITED' })
        continue
      }
      if (room <= 0) {
        outcome.skipped.push({ userId: member.userId, reason: 'NO_ROOM' })
        continue
      }
      // The open slot of this role if the team has one free of other invitations, else a new one.
      const ref: RoleRef = { role: member.role, customLabel: member.roleLabel }
      const openSlots = await tx.teamSlot.findMany({ where: { teamId: team.id, status: 'OPEN' }, include: { applications: { where: { status: 'PENDING' }, select: { id: true } } }, orderBy: { position: 'asc' } })
      let slot = openSlots.find((candidate) => roleKey(candidate) === roleKey(ref) && candidate.applications.length === 0)
      if (!slot) {
        await createSlots(tx, team.id, [{ ...ref, requiredSkills: [] }])
        slot = { ...(await tx.teamSlot.findFirstOrThrow({ where: { teamId: team.id }, orderBy: { position: 'desc' } })), applications: [] }
      }
      const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS)
      const data = { status: 'PENDING' as const, invitedById: input.requesterId, slotId: slot.id, expiresAt, proposalId: proposal.id, message: null }
      const invitation = existing ? await tx.teamApplication.update({ where: { id: existing.id }, data }) : await tx.teamApplication.create({ data: { ...data, userId: member.userId, teamId: team.id } })
      outcome.invitations.push({ userId: member.userId, invitationId: invitation.id, slotId: slot.id })
      room -= 1
    }
    await tx.squadProposal.update({ where: { id: proposal.id }, data: { teamId: team.id } })
    return { ok: true, outcome, teamName: team.name, teamSlug: team.slug }
  })
  if (!result.value.ok) return result.value
  const { outcome, teamName, teamSlug } = result.value

  for (const invitation of outcome.invitations) {
    await createNotification(db, {
      userId: invitation.userId,
      kind: 'SQUAD_INVITE',
      title: 'You were picked for a squad',
      message: `${requester?.name || requester?.username} wants you on ${teamName} for ${proposal.hackathon.name}`,
      link: `/teams/${teamSlug}`,
      metadata: { teamId: outcome.teamId, invitationId: invitation.invitationId, slotId: invitation.slotId, proposalId: proposal.id, hackathonId: proposal.hackathonId },
    })
  }
  return { ok: true, outcome }
}

/** For the proposal's own owner: the proposal, or null when it is not theirs. */
export async function proposalFor(db: Db, proposalId: string, userId: string, now: Date = new Date()): Promise<ProposalView | null> {
  const proposal = await db.squadProposal.findUnique({ where: { id: proposalId }, select: { requesterId: true, members: { select: { userId: true } } } })
  if (!proposal || (proposal.requesterId !== userId && !proposal.members.some((member) => member.userId === userId))) return null
  return proposalView(db, proposalId, now)
}

/** Unused BUILDER proposals older than a day are only clutter: marked EXPIRED. Run by the hourly squad sweep. */
export async function expireBuilderProposals(db: Db | Tx, now: Date = new Date()): Promise<number> {
  const { count } = await db.squadProposal.updateMany({ where: { kind: 'BUILDER', status: 'OPEN', expiresAt: { lte: now } }, data: { status: 'EXPIRED', decidedAt: now } })
  return count
}
