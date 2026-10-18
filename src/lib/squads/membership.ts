import type { Prisma, SquadRole, TeamSlot } from '@prisma/client'
import { recordActivity } from '@/lib/activity'
import { emit } from '@/lib/events'
import { derivedLookingFor, slotsFromLookingFor, type RoleNeed } from './roles'

// Joining and leaving a team, the one place that decides who may. Every path that adds a member (an accepted application or invitation, a squad
// proposal that formed, the squad builder's own team) runs checkJoin() and then addMember() in one transaction, so the race-safe capacity guard, the
// hackathon's size limits, the submission-deadline lock, the one-squad-per-hackathon rule and the slot that the join fills are the same everywhere.

type Tx = Prisma.TransactionClient

export interface TeamForJoin {
  id: string
  name: string
  slug: string
  ownerId: string
  maxSize: number
  projectId: string | null
  hackathonId: string | null
}

export interface SquadHackathon {
  id: string
  name: string
  slug: string
  maxTeamSize: number
  minTeamSize: number
  source: 'NATIVE' | 'EXTERNAL'
  verifiedAt: Date | null
}

export const squadHackathonSelect = { id: true, name: true, slug: true, maxTeamSize: true, minTeamSize: true, source: true, verifiedAt: true } as const

/**
 * Whether taking part in this hackathon earns XP. An EXTERNAL hackathon that no admin has verified yet is usable for squads straight away, but pays
 * nothing until it is verified: anybody trusted can submit a link, so an unverified one must not be a way to mint XP.
 */
export function hackathonPaysRewards(hackathon: Pick<SquadHackathon, 'source' | 'verifiedAt'>): boolean {
  return hackathon.source === 'NATIVE' || hackathon.verifiedAt !== null
}

export type JoinRefusal = 'team_full' | 'project_full' | 'team_locked' | 'already_in_squad' | 'slot_not_open'

export interface HackathonLimits {
  maxTeamSize: number
  minTeamSize: number
  endDate: Date
  submissionDeadline: Date | null
}

/** When a hackathon team stops changing: the submission deadline, else the end date. */
export function lockTimeOf(hackathon: Pick<HackathonLimits, 'endDate' | 'submissionDeadline'>): Date {
  return hackathon.submissionDeadline ?? hackathon.endDate
}

export function isLocked(hackathon: Pick<HackathonLimits, 'endDate' | 'submissionDeadline'> | null | undefined, now: Date): boolean {
  return Boolean(hackathon && now.getTime() >= lockTimeOf(hackathon).getTime())
}

/** The most members a team may have: its own maxSize, and its hackathon's maxTeamSize when it has one. */
export function capacityOf(team: Pick<TeamForJoin, 'maxSize'>, hackathon: Pick<HackathonLimits, 'maxTeamSize'> | null | undefined): number {
  return hackathon ? Math.min(team.maxSize, hackathon.maxTeamSize) : team.maxSize
}

export async function hackathonLimits(tx: Pick<Tx, 'hackathon'>, hackathonId: string | null): Promise<HackathonLimits | null> {
  if (!hackathonId) return null
  return tx.hackathon.findUnique({ where: { id: hackathonId }, select: { maxTeamSize: true, minTeamSize: true, endDate: true, submissionDeadline: true } })
}

/** Whether `userId` is already in a squad for this hackathon other than `teamId`: registered with another team, or a member of another of its teams. */
export async function otherSquadFor(tx: Tx, userId: string, hackathonId: string, teamId: string | null): Promise<string | null> {
  const participant = await tx.hackathonParticipant.findUnique({ where: { userId_hackathonId: { userId, hackathonId } }, select: { teamId: true } })
  if (participant?.teamId && participant.teamId !== teamId) return participant.teamId
  const member = await tx.teamMember.findFirst({ where: { userId, team: { hackathonId }, ...(teamId ? { teamId: { not: teamId } } : {}) }, select: { teamId: true } })
  return member?.teamId ?? null
}

/**
 * Locks the team (and its project, and the slot) and checks that `userId` may join it now. Call inside the transaction that then writes the member:
 * the team row stays locked until it commits, so two joins racing for the last place line up and the second sees the first's member.
 */
export async function checkJoin(tx: Tx, team: TeamForJoin, userId: string, options: { slotId?: string | null; now?: Date } = {}): Promise<JoinRefusal | null> {
  const now = options.now ?? new Date()
  await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${team.id} FOR UPDATE`
  const hackathon = await hackathonLimits(tx, team.hackathonId)
  if (isLocked(hackathon, now)) return 'team_locked'

  const alreadyMember = await tx.teamMember.findUnique({ where: { userId_teamId: { userId, teamId: team.id } }, select: { id: true } })
  if (!alreadyMember) {
    const memberCount = await tx.teamMember.count({ where: { teamId: team.id } })
    if (memberCount >= capacityOf(team, hackathon)) return 'team_full'
  }
  if (team.hackathonId && (await otherSquadFor(tx, userId, team.hackathonId, team.id))) return 'already_in_squad'

  // A team's own cap is independent of the maxTeamSize its linked project declares; same lock-then-count on the project row.
  if (team.projectId) {
    const alreadyProjectMember = await tx.projectMember.findUnique({ where: { userId_projectId: { userId, projectId: team.projectId } }, select: { id: true } })
    if (!alreadyProjectMember) {
      const [lockedProject] = await tx.$queryRaw<{ maxTeamSize: number }[]>`SELECT "maxTeamSize" FROM "Project" WHERE id = ${team.projectId} FOR UPDATE`
      const projectMemberCount = await tx.projectMember.count({ where: { projectId: team.projectId } })
      if (lockedProject && projectMemberCount >= lockedProject.maxTeamSize) return 'project_full'
    }
  }

  if (options.slotId) {
    const [slot] = await tx.$queryRaw<{ status: string; teamId: string }[]>`SELECT "status"::text AS status, "teamId" FROM "TeamSlot" WHERE id = ${options.slotId} FOR UPDATE`
    if (!slot || slot.teamId !== team.id || slot.status !== 'OPEN') return 'slot_not_open'
  }
  return null
}

export interface AddMemberResult {
  /** The slot this join filled, if any. */
  slot: TeamSlot | null
  /** Whether the member was also entered with the team's hackathon registration. */
  joinedHackathonTeam: boolean
}

/**
 * Writes a member who passed checkJoin(): the team membership with the role they play, the project and conversation memberships, the slot, and (for a
 * hackathon team that is registered) their own registration's team. Idempotent for a member who is already there.
 */
export async function addMember(
  tx: Tx,
  team: TeamForJoin,
  userId: string,
  options: { slotId?: string | null; squadRole?: SquadRole | null; roleLabel?: string | null; teamRole?: 'OWNER' | 'ADMIN' | 'MEMBER'; now?: Date; activityTitle?: string } = {}
): Promise<AddMemberResult> {
  const now = options.now ?? new Date()
  const slot = options.slotId ? await tx.teamSlot.findUnique({ where: { id: options.slotId } }) : null
  const squadRole = options.squadRole ?? slot?.role ?? null
  const roleLabel = squadRole === 'OTHER' ? (options.roleLabel ?? slot?.customLabel ?? null) : null

  await tx.teamMember.upsert({
    where: { userId_teamId: { userId, teamId: team.id } },
    create: { userId, teamId: team.id, role: options.teamRole ?? 'MEMBER', squadRole, roleLabel },
    update: squadRole ? { squadRole, roleLabel } : {},
  })
  if (team.projectId) {
    await tx.projectMember.upsert({
      where: { userId_projectId: { userId, projectId: team.projectId } },
      create: { userId, projectId: team.projectId, role: 'MEMBER' },
      update: {},
    })
  }
  const conversation = await tx.conversation.findUnique({ where: { teamId: team.id }, select: { id: true } })
  if (conversation) {
    await tx.conversationMember.upsert({
      where: { userId_conversationId: { userId, conversationId: conversation.id } },
      create: { userId, conversationId: conversation.id, role: 'MEMBER' },
      update: {},
    })
  }

  let filled: TeamSlot | null = null
  if (slot && slot.status === 'OPEN') {
    filled = await tx.teamSlot.update({ where: { id: slot.id }, data: { status: 'FILLED', filledById: userId, filledAt: now } })
    await syncLookingFor(tx, team.id)
  }

  let joinedHackathonTeam = false
  if (team.hackathonId) {
    const hackathon = await tx.hackathon.findUnique({ where: { id: team.hackathonId }, select: squadHackathonSelect })
    if (hackathon) joinedHackathonTeam = await registerWithTeam(tx, team, userId, team.ownerId === userId ? 'OWNER' : 'MEMBER', hackathon, now)
  }
  await recordActivity(tx, userId, 'TEAM_JOINED', options.activityTitle ?? `Joined team "${team.name}"`, { link: `/teams/${team.slug}` })
  return { slot: filled, joinedHackathonTeam }
}

/**
 * Enters a registered, teamless participant with their team's hackathon registration (the HackathonTeam), when the team has one: their registration
 * points at the team and they join the hackathon's own conversation. Someone who is not registered for the hackathon is left as they are (they
 * register themselves). Returns whether they were entered.
 */
export async function joinHackathonTeam(tx: Tx, team: Pick<TeamForJoin, 'id' | 'hackathonId'>, userId: string, role: 'OWNER' | 'MEMBER', now: Date): Promise<boolean> {
  if (!team.hackathonId) return false
  const hackathonTeam = await tx.hackathonTeam.findUnique({ where: { teamId: team.id }, select: { id: true } })
  if (!hackathonTeam) return false
  const participant = await tx.hackathonParticipant.findUnique({ where: { userId_hackathonId: { userId, hackathonId: team.hackathonId } }, select: { teamId: true } })
  if (!participant || (participant.teamId && participant.teamId !== team.id)) return false

  await tx.hackathonParticipant.update({
    where: { userId_hackathonId: { userId, hackathonId: team.hackathonId } },
    data: { teamId: team.id, status: 'TEAM_FORMED', ...(participant.teamId ? {} : { teamJoinedAt: now }) },
  })
  await tx.hackathonTeamMember.upsert({
    where: { hackathonTeamId_userId: { hackathonTeamId: hackathonTeam.id, userId } },
    create: { hackathonTeamId: hackathonTeam.id, userId, role },
    update: {},
  })
  const hackathonConversation = await tx.conversation.findUnique({ where: { hackathonId: team.hackathonId }, select: { id: true } })
  if (hackathonConversation) {
    await tx.conversationMember.upsert({
      where: { userId_conversationId: { userId, conversationId: hackathonConversation.id } },
      create: { userId, conversationId: hackathonConversation.id, role: 'MEMBER' },
      update: {},
    })
  }
  return true
}

/**
 * Enters a member with the team's hackathon registration and, when that registered them, announces TEAM_FORMED (the once-per-hackathon award the
 * manual POST /api/hackathons/{id}/teams also pays). Call on a transaction opened with transactWithEvents.
 */
export async function registerWithTeam(tx: Tx, team: Pick<TeamForJoin, 'id' | 'hackathonId'>, userId: string, role: 'OWNER' | 'MEMBER', hackathon: SquadHackathon, now: Date): Promise<boolean> {
  const joined = await joinHackathonTeam(tx, team, userId, role, now)
  if (joined && hackathonPaysRewards(hackathon)) await emit(tx, 'TEAM_FORMED', { userId, teamId: team.id, hackathonId: hackathon.id, hackathonName: hackathon.name })
  return joined
}

/**
 * Takes a member off a team: their membership, the slot they filled (reopened), and their hackathon registration's link to the team. Returns the
 * reopened slot, for the refill suggestion. The caller has checked who may do it.
 */
export async function removeMember(tx: Tx, team: Pick<TeamForJoin, 'id' | 'hackathonId'>, userId: string): Promise<TeamSlot | null> {
  await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${team.id} FOR UPDATE`
  await tx.teamMember.delete({ where: { userId_teamId: { userId, teamId: team.id } } })

  const filled = await tx.teamSlot.findFirst({ where: { teamId: team.id, filledById: userId, status: 'FILLED' }, orderBy: { filledAt: 'desc' } })
  const reopened = filled ? await tx.teamSlot.update({ where: { id: filled.id }, data: { status: 'OPEN', filledById: null, filledAt: null } }) : null
  if (reopened) await syncLookingFor(tx, team.id)

  if (team.hackathonId) {
    await tx.hackathonParticipant.updateMany({ where: { userId, hackathonId: team.hackathonId, teamId: team.id }, data: { teamId: null, status: 'REGISTERED', teamJoinedAt: null } })
    const hackathonTeam = await tx.hackathonTeam.findUnique({ where: { teamId: team.id }, select: { id: true } })
    if (hackathonTeam) await tx.hackathonTeamMember.deleteMany({ where: { hackathonTeamId: hackathonTeam.id, userId } })
  }
  return reopened
}

// --- Slots and lookingFor --------------------------------------------------------------------------------------

/** Rewrites Team.lookingFor from the team's open slots (the old field, kept for old clients and the code that reads it). */
export async function syncLookingFor(tx: Pick<Tx, 'teamSlot' | 'team'>, teamId: string): Promise<string[]> {
  const slots = await tx.teamSlot.findMany({ where: { teamId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { role: true, customLabel: true, requiredSkills: true, status: true } })
  const lookingFor = derivedLookingFor(slots)
  await tx.team.update({ where: { id: teamId }, data: { lookingFor } })
  return lookingFor
}

/** Creates open slots for these needs after the team's existing ones, and re-derives lookingFor. */
export async function createSlots(tx: Pick<Tx, 'teamSlot' | 'team'>, teamId: string, needs: readonly RoleNeed[]): Promise<void> {
  if (needs.length === 0) return
  const last = await tx.teamSlot.findFirst({ where: { teamId }, orderBy: { position: 'desc' }, select: { position: true } })
  const start = (last?.position ?? -1) + 1
  await tx.teamSlot.createMany({
    data: needs.map((need, index) => ({ teamId, role: need.role, customLabel: need.role === 'OTHER' ? (need.customLabel ?? null) : null, requiredSkills: need.requiredSkills, position: start + index })),
  })
  await syncLookingFor(tx, teamId)
}

/** An old client wrote lookingFor: its open slots are replaced by one per entry (filled slots are kept), and lookingFor is re-derived from them. */
export async function replaceOpenSlotsFromLookingFor(tx: Pick<Tx, 'teamSlot' | 'team'>, teamId: string, entries: readonly string[]): Promise<void> {
  await tx.teamSlot.deleteMany({ where: { teamId, status: 'OPEN' } })
  await createSlots(tx, teamId, slotsFromLookingFor(entries))
  await syncLookingFor(tx, teamId)
}
