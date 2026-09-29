import { Prisma, type PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

// UNREAD, defined once. A message is unread for user U when
//   - it is in a conversation U is a member of,
//   - it was not sent by U,
//   - it is not soft-deleted (deletedAt is null), and
//   - U has no MessageRead row for it.
// MessageRead is the only source of truth: ConversationMember.lastReadAt is
// still stamped whenever a conversation is opened or marked read, but it is
// informational and never used to count unread messages.

/** Unread counts for several conversations in one grouped query (no N+1). */
export async function unreadCountsByConversation(
  db: Db,
  userId: string,
  conversationIds: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (conversationIds.length === 0) return counts

  const rows = await db.$queryRaw<{ conversationId: string; count: bigint }[]>`
    SELECT m."conversationId", COUNT(*) AS count
    FROM "Message" m
    WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
      AND m."senderId" <> ${userId}
      AND m."deletedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "MessageRead" r
        WHERE r."messageId" = m.id AND r."userId" = ${userId}
      )
    GROUP BY m."conversationId"
  `
  for (const row of rows) counts.set(row.conversationId, Number(row.count))
  return counts
}

/** Total unread across every conversation the user belongs to. */
export async function totalUnread(db: Db, userId: string): Promise<number> {
  const rows = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count
    FROM "Message" m
    JOIN "ConversationMember" cm ON cm."conversationId" = m."conversationId" AND cm."userId" = ${userId}
    WHERE m."senderId" <> ${userId}
      AND m."deletedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "MessageRead" r
        WHERE r."messageId" = m.id AND r."userId" = ${userId}
      )
  `
  return Number(rows[0]?.count ?? 0)
}

/**
 * Mark unread messages in a conversation (optionally only those up to and
 * including a given message) as read for the user in one statement. Race-safe: the unique (messageId, userId) constraint plus
 * ON CONFLICT DO NOTHING means concurrent calls cannot double-insert.
 * Returns how many rows were newly marked.
 */
export async function markConversationRead(
  db: Db,
  userId: string,
  conversationId: string,
  upToMessageId?: string
): Promise<number> {
  // The boundary is resolved inside SQL rather than passed as a JS Date: a
  // Date parameter is sent as timestamptz and compared to the timestamp
  // column through the session time zone, which silently skews the cutoff on
  // any database whose time zone is not UTC.
  const upToClause = upToMessageId
    ? Prisma.sql`AND m."createdAt" <= (SELECT b."createdAt" FROM "Message" b WHERE b.id = ${upToMessageId})`
    : Prisma.empty
  return db.$executeRaw`
    INSERT INTO "MessageRead" ("id", "messageId", "userId", "readAt")
    SELECT gen_random_uuid()::text, m.id, ${userId}, now()
    FROM "Message" m
    WHERE m."conversationId" = ${conversationId}
      AND m."senderId" <> ${userId}
      AND m."deletedAt" IS NULL
      ${upToClause}
    ON CONFLICT ("messageId", "userId") DO NOTHING
  `
}

/** Record reads for specific messages (those a response actually returned). */
export async function markMessagesRead(db: Db, userId: string, messageIds: string[]): Promise<number> {
  if (messageIds.length === 0) return 0
  const result = await db.messageRead.createMany({
    data: messageIds.map((messageId) => ({ messageId, userId })),
    skipDuplicates: true,
  })
  return result.count
}

// Emoji validation: short, no control/format junk, and must actually contain a
// pictographic character (rejects arbitrary text such as "hello").
const MAX_EMOJI_CODEPOINTS = 8
const MAX_EMOJI_LENGTH = 16
export const MAX_DISTINCT_EMOJI_PER_USER_PER_MESSAGE = 10
export const MAX_DISTINCT_EMOJI_PER_MESSAGE = 30

// Built with the RegExp constructor because the project's TypeScript target
// predates the `u` flag literal syntax; the runtime (Node) fully supports it.
const FORBIDDEN_CHARS = new RegExp('[\\p{Cc}\\p{Cs}\\p{Co}\\p{Zl}\\p{Zp}\\s]', 'u')
const HAS_PICTOGRAPH = new RegExp('\\p{Extended_Pictographic}|\\p{Regional_Indicator}|[0-9#*]\\uFE0F?\\u20E3', 'u')
// Only pictographs and emoji plumbing (variation selector, ZWJ, skin tones,
// tags, regional indicators, keycap sequences). Digits are accepted only as
// part of a keycap, so no letters or bare digits can be smuggled in.
const ONLY_EMOJI = new RegExp(
  '^(?:[0-9#*]\\uFE0F?\\u20E3|\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|\\p{Regional_Indicator}|[\\u200D\\uFE0F\\u20E3]|[\\u{E0020}-\\u{E007F}])+$',
  'u'
)

export function isValidEmoji(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMOJI_LENGTH) return false
  if (Array.from(value).length > MAX_EMOJI_CODEPOINTS) return false
  if (FORBIDDEN_CHARS.test(value)) return false
  if (!HAS_PICTOGRAPH.test(value)) return false
  return ONLY_EMOJI.test(value)
}

export interface ReactionSummary {
  emoji: string
  count: number
  reactedByMe: boolean
}

export async function reactionSummary(db: Db, messageId: string, userId: string): Promise<ReactionSummary[]> {
  const grouped = await db.messageReaction.groupBy({
    by: ['emoji'],
    where: { messageId },
    _count: { _all: true },
    orderBy: { emoji: 'asc' },
  })
  const mine = await db.messageReaction.findMany({
    where: { messageId, userId },
    select: { emoji: true },
  })
  const mineSet = new Set(mine.map((r) => r.emoji))
  return grouped.map((g) => ({ emoji: g.emoji, count: g._count._all, reactedByMe: mineSet.has(g.emoji) }))
}
