import type { Prisma, PrismaClient } from '@prisma/client'

// "Who can message me" (a privacy setting, Profile.whoCanMessage): checked when somebody starts a direct conversation with a person. EVERYONE is the
// default; CONNECTIONS means people they are connected with, matched with, or share a crew or a project with; NOBODY closes new direct conversations
// (rooms they already share, and existing conversations, stay open).

type Db = PrismaClient | Prisma.TransactionClient

export async function areConnected(db: Db, a: string, b: string): Promise<boolean> {
  const [low, high] = a < b ? [a, b] : [b, a]
  const [connection, match, team, project] = await Promise.all([
    db.connection.findFirst({ where: { status: 'ACCEPTED', OR: [{ senderId: a, receiverId: b }, { senderId: b, receiverId: a }] }, select: { id: true } }),
    db.match.findFirst({ where: { userAId: low, userBId: high, endedAt: null }, select: { id: true } }),
    db.teamMember.findFirst({ where: { userId: a, team: { members: { some: { userId: b } } } }, select: { id: true } }),
    db.projectMember.findFirst({ where: { userId: a, project: { members: { some: { userId: b } } } }, select: { id: true } }),
  ])
  return Boolean(connection || match || team || project)
}

/** Whether `senderId` may start a direct conversation with `recipientId`, by the recipient's setting. */
export async function mayMessage(db: Db, senderId: string, recipientId: string): Promise<boolean> {
  const profile = await db.profile.findUnique({ where: { userId: recipientId }, select: { whoCanMessage: true } })
  const setting = profile?.whoCanMessage ?? 'EVERYONE'
  if (setting === 'EVERYONE') return true
  if (setting === 'NOBODY') return false
  return areConnected(db, senderId, recipientId)
}
