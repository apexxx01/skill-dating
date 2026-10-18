import type { Db } from '@/lib/events'
import { emit } from '@/lib/events'
import type { Prisma } from '@prisma/client'

// "The first match that later formed a team together". When somebody joins a team, every open match between them and a member of that team
// is announced (MATCH_TEAM_FORMED), once per match. The achievement counts it for each person whose counterparty is trusted; nothing is paid.

type Tx = Prisma.TransactionClient

/** The open matches between `userId` and the other members of `teamId`. */
export async function matchesWithTeammates(tx: Tx, userId: string, teamId: string) {
  const members = await tx.teamMember.findMany({ where: { teamId, userId: { not: userId } }, select: { userId: true } })
  if (members.length === 0) return []
  const ids = members.map((member) => member.userId)
  return tx.match.findMany({
    where: { endedAt: null, connectionType: { not: 'DATING' }, OR: [{ userAId: userId, userBId: { in: ids } }, { userBId: userId, userAId: { in: ids } }] },
    select: { id: true, userAId: true, userBId: true },
  })
}

/** Announces the matches that now share a team. Runs inside the transaction that added `userId` to the team. */
export async function announceMatchTeams(db: Db, userId: string, teamId: string): Promise<number> {
  const tx = db as Tx
  const matches = await matchesWithTeammates(tx, userId, teamId)
  for (const match of matches) {
    await emit(tx, 'MATCH_TEAM_FORMED', { userId, otherUserId: match.userAId === userId ? match.userBId : match.userAId, matchId: match.id, teamId })
  }
  return matches.length
}
