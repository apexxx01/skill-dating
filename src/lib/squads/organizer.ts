import type { PrismaClient } from '@prisma/client'

// Organizer-ready data about a hackathon's squads (B2B later; admins only for now): a CSV of the teams, their members and roles and what they
// submitted, and the headline numbers (how many registrants ended up in a team, and how long that took).

type Db = PrismaClient

/** One CSV cell: quoted when it must be, and never read as a formula by a spreadsheet (a leading = + - @ is escaped with a quote). Pure. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const csvRow = (cells: readonly (string | number | boolean | null | undefined)[]) => cells.map(csvCell).join(',')

export const TEAMS_CSV_HEADER = ['team_id', 'team_name', 'rank', 'score', 'submitted', 'project_name', 'project_url', 'repo_url', 'member_id', 'member_username', 'member_name', 'team_role', 'squad_role', 'role_label', 'joined_at'] as const

export async function teamsCsv(db: Db, hackathonId: string): Promise<string> {
  const teams = await db.hackathonTeam.findMany({
    where: { hackathonId },
    orderBy: [{ rank: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    select: {
      teamId: true,
      name: true,
      rank: true,
      score: true,
      projectId: true,
      members: { select: { userId: true, role: true, joinedAt: true, user: { select: { username: true, name: true } } }, orderBy: { joinedAt: 'asc' } },
      team: { select: { project: { select: { name: true, demoUrl: true, websiteUrl: true, githubUrl: true } }, members: { select: { userId: true, squadRole: true, roleLabel: true } } } },
    },
  })
  const submitted = new Set(
    (await db.hackathonParticipant.findMany({ where: { hackathonId, status: 'SUBMITTED' }, select: { teamId: true } })).map((row) => row.teamId).filter((id): id is string => Boolean(id))
  )
  const lines = [TEAMS_CSV_HEADER.join(',')]
  for (const team of teams) {
    const project = team.team.project
    const roles = new Map(team.team.members.map((member) => [member.userId, member]))
    for (const member of team.members) {
      const role = roles.get(member.userId)
      lines.push(
        csvRow([
          team.teamId,
          team.name,
          team.rank,
          team.score,
          submitted.has(team.teamId),
          project?.name,
          project?.demoUrl || project?.websiteUrl,
          project?.githubUrl,
          member.userId,
          member.user.username,
          member.user.name,
          member.role,
          role?.squadRole,
          role?.roleLabel,
          member.joinedAt.toISOString(),
        ])
      )
    }
  }
  return lines.join('\r\n') + '\r\n'
}

export interface HackathonSquadMetrics {
  hackathonId: string
  registered: number
  inTeam: number
  /** Share of registrants (not withdrawn) who ended in a team, 0 to 100, one decimal. */
  percentInTeam: number
  /** Median time from registering to joining a squad, in minutes, over those who joined one; null when nobody has. */
  medianMinutesToTeam: number | null
  squads: number
  autoSquadsFormed: number
  builderProposalsInvited: number
  soloPool: number
}

export async function squadMetrics(db: Db, hackathonId: string): Promise<HackathonSquadMetrics> {
  const [registered, inTeam, squads, autoSquadsFormed, builderProposalsInvited, soloPool, median] = await Promise.all([
    db.hackathonParticipant.count({ where: { hackathonId, status: { not: 'WITHDRAWN' } } }),
    db.hackathonParticipant.count({ where: { hackathonId, status: { not: 'WITHDRAWN' }, teamId: { not: null } } }),
    db.hackathonTeam.count({ where: { hackathonId } }),
    db.squadProposal.count({ where: { hackathonId, kind: 'AUTO', status: 'FORMED' } }),
    db.squadProposal.count({ where: { hackathonId, kind: 'BUILDER', status: 'INVITED' } }),
    db.hackathonParticipant.count({ where: { hackathonId, lookingForTeam: true } }),
    db.$queryRaw<{ minutes: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("teamJoinedAt" - "registeredAt")) / 60.0) AS minutes
      FROM "HackathonParticipant"
      WHERE "hackathonId" = ${hackathonId} AND "teamJoinedAt" IS NOT NULL AND "status" <> 'WITHDRAWN'
    `,
  ])
  const minutes = median[0]?.minutes
  return {
    hackathonId,
    registered,
    inTeam,
    percentInTeam: registered === 0 ? 0 : Math.round((inTeam / registered) * 1000) / 10,
    medianMinutesToTeam: minutes === null || minutes === undefined ? null : Math.max(0, Math.round(Number(minutes))),
    squads,
    autoSquadsFormed,
    builderProposalsInvited,
    soloPool,
  }
}
