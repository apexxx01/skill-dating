import type { PrismaClient } from '@prisma/client'
import { capacityOf } from './membership'
import { loadPairFacts, loadSquadPeople } from './people'
import { roleLabel, templateFor, type RoleRef } from './roles'
import { squadStrength, type SquadStrength } from './strength'
import { canonicalTracks, tracksOf } from './tracks'

// The strength of an existing team (GET /api/teams/{id}/strength and the team space): its members as they are, measured against the role template
// for its hackathon's technologies and the tracks it goes for (sized to the team's capacity), plus the skills its open slots ask for. Pledges count
// before the hackathon starts.

type Db = PrismaClient

export interface TeamStrengthView extends Pick<SquadStrength, 'score' | 'components' | 'gaps' | 'overlapHours'> {
  teamId: string
  hackathonId: string | null
  /** Each role of the template, and who covers it (null: nobody). */
  roles: { key: string; label: string; userId: string | null }[]
  memberCount: number
  capacity: number
  pledgesExpected: boolean
}

export async function loadTeamStrength(db: Db, teamId: string, now: Date = new Date()): Promise<TeamStrengthView | null> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      maxSize: true,
      hackathonId: true,
      targetTracks: true,
      members: { select: { userId: true, squadRole: true, roleLabel: true }, orderBy: { joinedAt: 'asc' } },
      slots: { where: { status: 'OPEN' }, select: { requiredSkills: true } },
      hackathon: { select: { id: true, technologies: true, tracks: true, minTeamSize: true, maxTeamSize: true, startDate: true } },
    },
  })
  if (!team) return null
  const hackathon = team.hackathon
  const capacity = capacityOf(team, hackathon)
  const allTracks = tracksOf(hackathon?.tracks)
  const chosen = canonicalTracks(allTracks, team.targetTracks)
  const tracks = allTracks.filter((track) => chosen.includes(track.name))
  const needs = templateFor({ technologies: hackathon?.technologies ?? [], tracks, size: Math.max(team.members.length, capacity) })
  const pledgesExpected = Boolean(hackathon && now.getTime() < hackathon.startDate.getTime())

  const roles = new Map<string, RoleRef | null>(team.members.map((member) => [member.userId, member.squadRole ? { role: member.squadRole, customLabel: member.roleLabel } : null]))
  const ids = team.members.map((member) => member.userId)
  const [people, pairs] = await Promise.all([loadSquadPeople(db, hackathon?.id ?? '', ids, now, { roles, pledgesExpected }), loadPairFacts(db, ids)])
  const members = ids.map((id) => people.get(id)).filter((person): person is NonNullable<typeof person> => Boolean(person))

  const strength = squadStrength({
    members,
    needs: { roles: needs, requiredSkills: team.slots.flatMap((slot) => slot.requiredSkills), pledgesExpected, minSize: hackathon?.minTeamSize ?? 1 },
    history: pairs.history,
  })
  return {
    teamId: team.id,
    hackathonId: hackathon?.id ?? null,
    score: strength.score,
    components: strength.components,
    gaps: strength.gaps,
    overlapHours: strength.overlapHours,
    roles: strength.roles.map((role, index) => ({ key: role.key, label: role.label || roleLabel(needs[index]), userId: role.userId })),
    memberCount: team.members.length,
    capacity,
    pledgesExpected,
  }
}
