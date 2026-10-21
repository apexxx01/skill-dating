import { Prisma, type PrismaClient, type SquadRole } from '@prisma/client'
import { emit, transactWithEvents } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { createNotification } from '@/lib/notifications'
import { advisoryLock } from '@/lib/progress'
import { assignProposalRoles } from './builder'
import { PROPOSAL_TTL_MS } from './lifecycle'
import { addMember, checkJoin, createSlots, hackathonPaysRewards, isLocked, lockTimeOf, otherSquadFor, squadHackathonSelect, type SquadHackathon } from './membership'
import { partitionPool, storedSeedFrom } from './optimizer'
import { loadPairFacts, loadSquadPeople, pairKey, trustedIds, type SquadPerson } from './people'
import { squadSizeFor, templateFor } from './roles'
import { squadStrength } from './strength'
import { createSquadTeam } from './teams'

// The solo pool's automatic squads (docs/SQUADS.md, "Solo pool and auto-formation"). Two days before a hackathon's registration deadline, everyone
// registered, teamless, trusted and open to an automatic team is split into balanced squads (the optimiser's max-min partition: the weakest squad
// is made as strong as it can be). Each squad is PROPOSED to its members, who have a day to accept. A squad FORMS (its team is created, everyone
// who accepted is on it) when at least the hackathon's minTeamSize (and never fewer than two) accept; otherwise it FAILS. Once, if there is still
// time, the people who accepted a failed squad and those left over are pooled again (round 2).
//
// Idempotent and resumable: a round is one SquadFormationRun row (unique per hackathon and round), written in the same transaction as its
// proposals, so running the job twice (or two workers at once) makes one set; settling a proposal takes a lock on it and does nothing to one that
// is already settled.

type Db = PrismaClient

const HOUR_MS = 60 * 60 * 1000

export const POOL_CONFIG = {
  /** Round 1 runs this long before the registration deadline. */
  leadMs: 48 * HOUR_MS,
  /** Round 2 is only worth it with at least this long left before the deadline (a day to answer, and some slack). */
  roundTwoMinLeftMs: 25 * HOUR_MS,
  /** The most people one round considers. */
  poolLimit: 2000,
  maxEvaluations: 60_000,
  /** A squad needs at least this many members to form, whatever the hackathon's minimum. */
  minFormed: 2,
}

export type PoolHackathon = SquadHackathon & {
  status: string
  technologies: string[]
  tracks: Prisma.JsonValue
  startDate: Date
  endDate: Date
  registrationDeadline: Date | null
  submissionDeadline: Date | null
}

const poolHackathonSelect = { ...squadHackathonSelect, status: true, technologies: true, tracks: true, startDate: true, endDate: true, registrationDeadline: true, submissionDeadline: true } as const

/** When round 1 is due: two days before the registration deadline (or the start, when there is no deadline). */
export function roundOneAt(hackathon: Pick<PoolHackathon, 'registrationDeadline' | 'startDate'>): Date {
  return new Date((hackathon.registrationDeadline ?? hackathon.startDate).getTime() - POOL_CONFIG.leadMs)
}

const deadlineOf = (hackathon: Pick<PoolHackathon, 'registrationDeadline' | 'startDate'>) => hackathon.registrationDeadline ?? hackathon.startDate

export interface RoundOutcome {
  hackathonId: string
  round: number
  skipped?: 'ALREADY_RAN' | 'CLOSED' | 'POOL_TOO_SMALL' | 'NOT_DUE'
  runId?: string
  poolSize: number
  squads: number
  leftovers: number
}

/** The people round `round` pools: registered, teamless, open to an automatic team, trusted, and not waiting on (or in) a squad already. */
async function poolFor(db: Db, hackathon: PoolHackathon, round: number, now: Date): Promise<string[]> {
  const rows = await db.hackathonParticipant.findMany({
    where: { hackathonId: hackathon.id, teamId: null, openToAutoTeam: true, status: { not: 'WITHDRAWN' } },
    orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
    take: POOL_CONFIG.poolLimit,
    select: { userId: true },
  })
  let ids = rows.map((row) => row.userId)
  const [trusted, members, waiting, declined] = await Promise.all([
    trustedIds(db, ids, now),
    db.teamMember.findMany({ where: { userId: { in: ids }, team: { hackathonId: hackathon.id } }, select: { userId: true } }),
    db.squadProposalMember.findMany({ where: { userId: { in: ids }, proposal: { hackathonId: hackathon.id, kind: 'AUTO', status: 'PROPOSED' } }, select: { userId: true } }),
    // Round 2 re-pools the people who accepted a failed squad and the leftovers, not those who turned theirs down or never answered.
    round > 1
      ? db.squadProposalMember.findMany({ where: { userId: { in: ids }, response: { not: 'ACCEPTED' }, proposal: { hackathonId: hackathon.id, kind: 'AUTO', status: 'FAILED' } }, select: { userId: true } })
      : Promise.resolve([] as { userId: string }[]),
  ])
  const out = new Set([...members, ...waiting, ...declined].map((row) => row.userId))
  ids = ids.filter((id) => trusted.has(id) && !out.has(id))
  return ids
}

/** Runs one round for one hackathon: partitions its pool and proposes the squads. Does nothing when the round already ran. */
export async function runRound(db: Db, hackathon: PoolHackathon, round: number, now: Date = new Date()): Promise<RoundOutcome> {
  const base = { hackathonId: hackathon.id, round, poolSize: 0, squads: 0, leftovers: 0 }
  if ((hackathon.status !== 'UPCOMING' && hackathon.status !== 'ACTIVE') || isLocked(hackathon, now)) return { ...base, skipped: 'CLOSED' }
  if (await db.squadFormationRun.findUnique({ where: { hackathonId_round: { hackathonId: hackathon.id, round } }, select: { id: true } })) return { ...base, skipped: 'ALREADY_RAN' }

  const ids = await poolFor(db, hackathon, round, now)
  const minSize = Math.max(POOL_CONFIG.minFormed, hackathon.minTeamSize)
  const target = squadSizeFor(hackathon)
  const pledgesExpected = now.getTime() < hackathon.startDate.getTime()
  const [people, pairs] = await Promise.all([loadSquadPeople(db, hackathon.id, ids, now, { pledgesExpected }), loadPairFacts(db, ids)])
  const pool = ids.map((id) => people.get(id)).filter((person): person is SquadPerson => Boolean(person))

  const needsFor = (size: number) => templateFor({ technologies: hackathon.technologies, tracks: [], size })
  const strengthOf = (members: readonly SquadPerson[]) =>
    squadStrength({ members, needs: { roles: needsFor(members.length), requiredSkills: [], pledgesExpected, minSize: hackathon.minTeamSize }, history: pairs.history })
  const seed = storedSeedFrom(`${hackathon.id}:auto:${round}`)
  const partition =
    pool.length >= minSize
      ? partitionPool({
          people: pool,
          minSize,
          maxSize: Math.max(minSize, hackathon.maxTeamSize),
          targetSize: Math.max(minSize, target),
          evaluate: (members) => strengthOf(members).score,
          forbidden: (a, b) => pairs.forbidden.has(pairKey(a, b)),
          seed,
          limits: { maxEvaluations: POOL_CONFIG.maxEvaluations },
        })
      : { squads: [] as SquadPerson[][], scores: [] as number[], leftovers: pool, evaluations: 0 }

  // The run and its proposals in one transaction: the unique (hackathon, round) makes a second run of the same round write nothing.
  const answerBy = new Date(Math.min(now.getTime() + PROPOSAL_TTL_MS, lockTimeOf(hackathon).getTime()))
  let runId: string
  try {
    runId = await db.$transaction(async (tx) => {
      const run = await tx.squadFormationRun.create({ data: { hackathonId: hackathon.id, round, poolSize: pool.length, squads: partition.squads.length, leftovers: partition.leftovers.length, ...(partition.squads.length === 0 ? { settledAt: now } : {}) } })
      for (const members of partition.squads) {
        const strength = strengthOf(members)
        const roles = assignProposalRoles(members, needsFor(members.length), strength)
        await tx.squadProposal.create({
          data: {
            hackathonId: hackathon.id,
            kind: 'AUTO',
            status: 'PROPOSED',
            runId: run.id,
            seed,
            size: members.length,
            strength: strength.score,
            detail: { components: strength.components, gaps: strength.gaps, overlapHours: strength.overlapHours } as unknown as Prisma.InputJsonValue,
            expiresAt: answerBy,
            members: {
              create: members.map((member, position) => {
                const role = roles.get(member.userId)!
                return { userId: member.userId, role: role.role, roleLabel: role.role === 'OTHER' ? (role.customLabel ?? null) : null, position }
              }),
            },
          },
        })
      }
      return run.id
    }, { timeout: 30_000 })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { ...base, skipped: 'ALREADY_RAN' }
    throw error
  }

  for (const members of partition.squads) {
    for (const member of members) {
      await createNotification(db, {
        userId: member.userId,
        kind: 'SQUAD_PROPOSAL',
        title: 'We found you a squad',
        message: `A squad of ${members.length} for ${hackathon.name} is waiting for your answer`,
        link: `/hackathons/${hackathon.slug}`,
        metadata: { hackathonId: hackathon.id, runId, round },
      })
    }
  }
  return { ...base, runId, poolSize: pool.length, squads: partition.squads.length, leftovers: partition.leftovers.length, ...(pool.length < minSize ? { skipped: 'POOL_TOO_SMALL' as const } : {}) }
}

/**
 * The scheduled run (hourly): round 1 for every hackathon now inside its last 48 hours before the registration deadline, and round 2 for those whose
 * round 1 is settled and that still have time. With a `hackathonId` (an admin running it on demand) it runs that hackathon's next round, or the round
 * asked for, whatever the clock says.
 */
export async function autoForm(db: Db, input: { hackathonId?: string; round?: number; now?: Date } = {}): Promise<RoundOutcome[]> {
  const now = input.now ?? new Date()
  if (input.hackathonId) {
    const hackathon = await db.hackathon.findUnique({ where: { id: input.hackathonId }, select: poolHackathonSelect })
    if (!hackathon) return []
    const ran = await db.squadFormationRun.findMany({ where: { hackathonId: hackathon.id }, select: { round: true } })
    const round = input.round ?? (ran.some((run) => run.round === 1) ? 2 : 1)
    return [await runRound(db, hackathon, round, now)]
  }

  const due = await db.hackathon.findMany({
    where: {
      status: { in: ['UPCOMING', 'ACTIVE'] },
      OR: [
        { registrationDeadline: { gt: now, lte: new Date(now.getTime() + POOL_CONFIG.leadMs) } },
        { registrationDeadline: null, startDate: { gt: now, lte: new Date(now.getTime() + POOL_CONFIG.leadMs) } },
      ],
    },
    select: { ...poolHackathonSelect, formationRuns: { select: { round: true, settledAt: true } } },
    orderBy: { id: 'asc' },
    take: 200,
  })
  const outcomes: RoundOutcome[] = []
  for (const { formationRuns, ...hackathon } of due) {
    const first = formationRuns.find((run) => run.round === 1)
    if (!first) outcomes.push(await runRound(db, hackathon, 1, now))
    else if (first.settledAt && !formationRuns.some((run) => run.round === 2) && deadlineOf(hackathon).getTime() - now.getTime() >= POOL_CONFIG.roundTwoMinLeftMs) {
      outcomes.push(await runRound(db, hackathon, 2, now))
    }
  }
  return outcomes
}

// --- Answering and settling -----------------------------------------------------------------------------------

export type RespondFailure = 'NOT_FOUND' | 'CLOSED' | 'EXPIRED'

/** A member's answer to an AUTO proposal. Settles the proposal when it was the last answer. */
export async function respondToProposal(db: Db, input: { proposalId: string; userId: string; accept: boolean; now?: Date }): Promise<{ ok: true; status: string; teamId: string | null } | { ok: false; reason: RespondFailure }> {
  const now = input.now ?? new Date()
  const proposal = await db.squadProposal.findUnique({ where: { id: input.proposalId }, select: { id: true, kind: true, status: true, expiresAt: true, hackathonId: true, members: { select: { userId: true } } } })
  if (!proposal || proposal.kind !== 'AUTO' || !proposal.members.some((member) => member.userId === input.userId)) return { ok: false, reason: 'NOT_FOUND' }
  if (proposal.status !== 'PROPOSED') return { ok: false, reason: 'CLOSED' }
  if (proposal.expiresAt.getTime() <= now.getTime()) {
    await settleProposal(db, proposal.id, now)
    return { ok: false, reason: 'EXPIRED' }
  }
  const updated = await db.squadProposalMember.updateMany({
    where: { proposalId: proposal.id, userId: input.userId, proposal: { status: 'PROPOSED' } },
    data: { response: input.accept ? 'ACCEPTED' : 'DECLINED', respondedAt: now },
  })
  if (updated.count === 0) return { ok: false, reason: 'CLOSED' }
  if (input.accept) await track(input.userId, 'squad_proposal_accepted', { hackathonId: proposal.hackathonId, kind: 'AUTO' })
  const settled = await settleProposal(db, proposal.id, now)
  return { ok: true, status: settled.status, teamId: settled.teamId }
}

/**
 * Settles an AUTO proposal once everyone has answered or its day is up: the squad forms when enough accepted (and are still free), else it fails.
 * Before that it is left as it is. Safe to call any number of times, concurrently too.
 */
export async function settleProposal(db: Db, proposalId: string, now: Date = new Date()): Promise<{ status: string; teamId: string | null }> {
  const result = await transactWithEvents(db, async (tx) => {
    await advisoryLock(tx, `squad-proposal:${proposalId}`)
    const proposal = await tx.squadProposal.findUnique({
      where: { id: proposalId },
      include: { members: { orderBy: { position: 'asc' } }, hackathon: { select: poolHackathonSelect } },
    })
    if (!proposal || proposal.kind !== 'AUTO') return { status: 'NOT_FOUND', teamId: null, formed: [] as string[], failedFor: [] as string[], hackathon: null }
    if (proposal.status !== 'PROPOSED') return { status: proposal.status, teamId: proposal.teamId, formed: [], failedFor: [], hackathon: null }
    const pending = proposal.members.some((member) => member.response === 'PENDING')
    if (pending && proposal.expiresAt.getTime() > now.getTime()) return { status: proposal.status, teamId: null, formed: [], failedFor: [], hackathon: null }

    const { hackathon } = proposal
    const minSize = Math.max(POOL_CONFIG.minFormed, hackathon.minTeamSize)
    const accepted: typeof proposal.members = []
    for (const member of proposal.members) {
      if (member.response === 'ACCEPTED' && !(await otherSquadFor(tx, member.userId, hackathon.id, null))) accepted.push(member)
    }
    const close = async (status: 'FORMED' | 'FAILED', teamId: string | null) => {
      await tx.squadProposal.update({ where: { id: proposal.id }, data: { status, decidedAt: now, teamId } })
      if (proposal.runId && (await tx.squadProposal.count({ where: { runId: proposal.runId, status: 'PROPOSED' } })) === 0) {
        await tx.squadFormationRun.update({ where: { id: proposal.runId }, data: { settledAt: now } })
      }
    }
    if (accepted.length < minSize || isLocked(hackathon, now)) {
      await close('FAILED', null)
      return { status: 'FAILED', teamId: null, formed: [], failedFor: accepted.map((member) => member.userId), hackathon }
    }

    const [owner, ...rest] = accepted
    const team = await createSquadTeam(tx, { hackathon, ownerId: owner.userId, name: `${hackathon.name} squad ${proposal.id.slice(-4)}`, ownerRole: owner.role, ownerRoleLabel: owner.roleLabel, maxSize: hackathon.maxTeamSize, now })
    const formed = [owner.userId]
    for (const member of rest) {
      await createSlots(tx, team.id, [{ role: member.role, customLabel: member.roleLabel, requiredSkills: [] }])
      const slot = await tx.teamSlot.findFirstOrThrow({ where: { teamId: team.id }, orderBy: { position: 'desc' } })
      if (await checkJoin(tx, team, member.userId, { slotId: slot.id, now })) {
        await tx.teamSlot.delete({ where: { id: slot.id } })
        continue
      }
      await addMember(tx, team, member.userId, { slotId: slot.id, squadRole: member.role, roleLabel: member.roleLabel, now, activityTitle: `Joined squad "${team.name}"` })
      formed.push(member.userId)
    }
    await close('FORMED', team.id)
    if (hackathonPaysRewards(hackathon)) {
      for (const userId of formed) await emit(tx, 'AUTO_SQUAD_FORMED', { userId, teamId: team.id, hackathonId: hackathon.id, proposalId: proposal.id })
    }
    return { status: 'FORMED', teamId: team.id, formed, failedFor: [], hackathon, teamSlug: team.slug }
  })

  const value = result.value as { status: string; teamId: string | null; formed: string[]; failedFor: string[]; hackathon: PoolHackathon | null; teamSlug?: string }
  if (value.hackathon) {
    for (const userId of value.formed) {
      await track(userId, 'auto_squad_formed', { hackathonId: value.hackathon.id, size: value.formed.length })
      await createNotification(db, {
        userId,
        kind: 'SQUAD_UPDATE',
        title: 'Your squad formed',
        message: `Your squad for ${value.hackathon.name} is ready: say hello in the team space`,
        link: `/teams/${value.teamSlug}`,
        metadata: { hackathonId: value.hackathon.id, teamId: value.teamId, proposalId },
      })
    }
    for (const userId of value.failedFor) {
      await createNotification(db, {
        userId,
        kind: 'SQUAD_UPDATE',
        title: 'Not enough people said yes',
        message: `Your proposed squad for ${value.hackathon.name} did not form; you stay in the solo pool`,
        link: `/hackathons/${value.hackathon.slug}`,
        metadata: { hackathonId: value.hackathon.id, proposalId },
      })
    }
  }
  return { status: value.status, teamId: value.teamId }
}

/** Settles every AUTO proposal whose day is up. Run by the hourly squad sweep. */
export async function settleExpiredProposals(db: Db, now: Date = new Date()): Promise<number> {
  const due = await db.squadProposal.findMany({ where: { kind: 'AUTO', status: 'PROPOSED', expiresAt: { lte: now } }, select: { id: true }, orderBy: { expiresAt: 'asc' }, take: 500 })
  for (const proposal of due) await settleProposal(db, proposal.id, now)
  return due.length
}

/** Invitations nobody answered within their 48 hours are marked EXPIRED (the accept route refuses them anyway). */
export async function expireInvitations(db: Db, now: Date = new Date()): Promise<number> {
  const { count } = await db.teamApplication.updateMany({ where: { status: 'PENDING', invitedById: { not: null }, expiresAt: { lte: now } }, data: { status: 'EXPIRED' } })
  return count
}

// --- The caller's own proposals -------------------------------------------------------------------------------

export interface MyProposalRow {
  id: string
  hackathonId: string
  hackathonName: string
  kind: 'BUILDER' | 'AUTO'
  status: string
  expiresAt: string
  teamId: string | null
  size: number
  strength: number
  myRole: SquadRole
  myResponse: string
  createdAt: string
}

/** Proposals the caller is on (AUTO) or asked for (BUILDER), newest first, a page at a time (cursor: the last id). */
export async function myProposals(db: Db, userId: string, input: { cursor?: string; limit: number }): Promise<{ proposals: MyProposalRow[]; nextCursor: string | null }> {
  const rows = await db.squadProposalMember.findMany({
    where: { userId },
    orderBy: [{ proposal: { createdAt: 'desc' } }, { id: 'desc' }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: { id: true, role: true, response: true, proposal: { select: { id: true, hackathonId: true, kind: true, status: true, expiresAt: true, teamId: true, size: true, strength: true, createdAt: true, hackathon: { select: { name: true } } } } },
  })
  const page = rows.slice(0, input.limit)
  return {
    proposals: page.map((row) => ({
      id: row.proposal.id,
      hackathonId: row.proposal.hackathonId,
      hackathonName: row.proposal.hackathon.name,
      kind: row.proposal.kind,
      status: row.proposal.status,
      expiresAt: row.proposal.expiresAt.toISOString(),
      teamId: row.proposal.teamId,
      size: row.proposal.size,
      strength: row.proposal.strength,
      myRole: row.role,
      myResponse: row.response,
      createdAt: row.proposal.createdAt.toISOString(),
    })),
    nextCursor: rows.length > input.limit ? page[page.length - 1].id : null,
  }
}

// --- Jobs ------------------------------------------------------------------------------------------------------

/** `squads/auto-form`: the scheduled run, or one hackathon's round on demand. */
export async function runAutoFormJob(data: { hackathonId?: string; round?: number }) {
  const { prisma } = await import('@/lib/prisma')
  // The `squad_autoform` kill switch (src/lib/ops/kill-switches.ts) stops automatic squads without touching anything else.
  const { isKilled } = await import('@/lib/ops/kill-switches')
  if (await isKilled(prisma, 'squad_autoform')) return { rounds: 0, outcomes: [], paused: true }
  const outcomes = await autoForm(prisma, data)
  return { rounds: outcomes.length, outcomes }
}

/**
 * `squads/sweep` (hourly): settles the automatic squads whose day is up, expires unused builder proposals and unanswered invitations, and sends the
 * reminders and peer-review prompts that are due. Each part is safe to repeat.
 */
export async function runSquadSweepJob() {
  const { prisma } = await import('@/lib/prisma')
  const { expireBuilderProposals } = await import('./builder')
  const { sendSquadReminders } = await import('./reminders')
  const { sendPeerReviewPrompts } = await import('./peer-review')
  const now = new Date()
  const settled = await settleExpiredProposals(prisma, now)
  const builderExpired = await expireBuilderProposals(prisma, now)
  const invitationsExpired = await expireInvitations(prisma, now)
  const reminders = await sendSquadReminders(prisma, now)
  const reviewPrompts = await sendPeerReviewPrompts(prisma, now)
  return { settled, builderExpired, invitationsExpired, reminders, reviewPrompts }
}
