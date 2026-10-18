import type { Prisma, SquadRole } from '@prisma/client'
import { randomUUID } from 'crypto'
import { registerWithTeam, type SquadHackathon, type TeamForJoin } from './membership'

// Creating a squad's team for a hackathon, the way the squad builder and the solo-pool auto-formation do it: the team, its owner, its own
// conversation, its hackathon registration (the HackathonTeam, so the team space exists from the start) and the owner's registration pointing at it,
// in the caller's transaction (one opened with transactWithEvents, for the TEAM_FORMED award).

type Tx = Prisma.TransactionClient

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '') || 'squad'
}

async function uniqueTeamSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name).slice(0, 60)
  if (!(await tx.team.findUnique({ where: { slug: base }, select: { id: true } }))) return base
  return `${base}-${randomUUID().slice(0, 8)}`
}

export interface CreateSquadTeamInput {
  hackathon: SquadHackathon
  ownerId: string
  name: string
  ownerRole?: SquadRole | null
  ownerRoleLabel?: string | null
  /** At most the hackathon's maxTeamSize. */
  maxSize?: number
  now: Date
}

export async function createSquadTeam(tx: Tx, input: CreateSquadTeamInput): Promise<TeamForJoin> {
  const { hackathon } = input
  const team = await tx.team.create({
    data: {
      name: input.name.slice(0, 100),
      slug: await uniqueTeamSlug(tx, input.name),
      ownerId: input.ownerId,
      hackathonId: hackathon.id,
      maxSize: Math.max(2, Math.min(input.maxSize ?? hackathon.maxTeamSize, hackathon.maxTeamSize)),
      isRecruiting: true,
    },
    select: { id: true, name: true, slug: true, ownerId: true, maxSize: true, projectId: true, hackathonId: true },
  })
  await tx.teamMember.create({ data: { userId: input.ownerId, teamId: team.id, role: 'OWNER', squadRole: input.ownerRole ?? null, roleLabel: input.ownerRole === 'OTHER' ? (input.ownerRoleLabel ?? null) : null } })
  await tx.conversation.create({ data: { type: 'TEAM', teamId: team.id, members: { create: { userId: input.ownerId, role: 'OWNER' } } } })
  await tx.hackathonTeam.create({ data: { hackathonId: hackathon.id, teamId: team.id, name: team.name } })
  await registerWithTeam(tx, team, input.ownerId, 'OWNER', hackathon, input.now)
  return team
}

export { hackathonPaysRewards, squadHackathonSelect, type SquadHackathon } from './membership'
