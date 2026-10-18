import type { Prisma, PrismaClient } from '@prisma/client'

// The account that "says" the system messages of a conversation (the icebreaker of a new match). A message needs a sender, so the platform has
// one: a tombstone-style account with no login and no Clerk id, marked deleted so every list that leaves out gone accounts (search, discovery,
// leaderboards, drops) leaves it out too. It is created the first time it is needed.

type Db = PrismaClient | Prisma.TransactionClient

export const SYSTEM_USER_EMAIL = 'system@skilldating.invalid'
export const SYSTEM_USER_NAME = 'Skill Dating'

export async function ensureSystemUser(db: Db): Promise<string> {
  const found = await db.user.findUnique({ where: { email: SYSTEM_USER_EMAIL }, select: { id: true } })
  if (found) return found.id
  // Two requests may race to create it; the unique email makes one of them a no-op and the read below finds the winner.
  await db.user.createMany({
    data: [{ email: SYSTEM_USER_EMAIL, username: 'skill_dating_system', name: SYSTEM_USER_NAME, deletedAt: new Date(), isEmailVerified: false }],
    skipDuplicates: true,
  })
  const created = await db.user.findUnique({ where: { email: SYSTEM_USER_EMAIL }, select: { id: true } })
  if (!created) throw new Error('could not create the system account')
  return created.id
}
