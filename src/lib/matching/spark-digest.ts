import { Prisma, type PrismaClient } from '@prisma/client'
import { blockedPeerIds } from '@/lib/blocks'
import { can, subjectFor } from '@/lib/entitlements'
import { log } from '@/lib/log'
import { createNotification } from '@/lib/notifications'
import { romanceCopy } from '@/lib/romance/config'
import { utcTimestamp } from '@/lib/sql'
import { localDateKey, localTimeKey } from '@/lib/time'

// Telling people they were sparked.
//
//  - A plan that shows WHO sparked you (the SEE_WHO_SPARKED entitlement; PRO and up, and everybody while plans are not enforced) gets a notification for each spark
//    with the sender in it, written when the spark is sent (sendSpark).
//  - A plan that does not gets one notification a local day, "N people sparked you": a COUNT only, no names, no openers, so the number is the only thing that can be
//    seen without paying. It is written by the hourly job `sparks/digest` from DIGEST_HOUR_LOCAL on, counts the sparks that arrived since the last one, and is skipped for
//    a day with none.
//  - Both can be switched off (NotificationPreference kinds SPARK and SPARK_DIGEST).
//  - The romance mode has its own, kept apart from the professional one in everything: its own sparks (connectionType DATING), its own marker (RomanceProfile.sparkDigestAt), its own
//    kinds (ROMANCE_SPARK, ROMANCE_SPARK_DIGEST) and wording that names the mode, "N people sparked you in <the mode>". A person in both gets two counts, never one that mixes them.
//  - A match is a different notification (MATCH, written when the pair is made) and an unmatch notifies nobody: see docs/MATCHING.md ("Why unmatching is silent").

type Db = PrismaClient

/** The local time from which the daily count is sent. */
export const DIGEST_HOUR_LOCAL = '09:00'
/** Sparks older than this are not counted by a digest that has never been sent (a person's first one). */
export const DIGEST_LOOKBACK_HOURS = 48

const HOUR_MS = 60 * 60 * 1000

export type DigestMode = 'professional' | 'romance'

export interface DigestRunOptions {
  now?: Date
  /** Whether plan limits apply (defaults to ENTITLEMENTS_ENFORCED). */
  enforced?: boolean
  /** Which sparks to count. Defaults to the professional ones; the job runs both. */
  mode?: DigestMode
}

export interface DigestRunResult {
  considered: number
  notified: number
  skipped: number
}

/** The wording of the daily count. Count only. */
export const digestMessage = (count: number, mode: DigestMode = 'professional') => (mode === 'romance' ? romanceCopy.sparkedYou(count) : `${count} ${count === 1 ? 'person' : 'people'} sparked you`)

const MODES = {
  professional: { kind: 'SPARK_DIGEST', title: 'New sparks', link: '/sparks', romance: false },
  romance: { kind: 'ROMANCE_SPARK_DIGEST', title: romanceCopy.modeName, link: '/romance', romance: true },
} as const

/** People with a pending spark from lately (of this mode), with the zone they are in and when they were last told. */
async function recentRecipients(db: Pick<Db, '$queryRaw'>, now: Date, mode: DigestMode) {
  const since = utcTimestamp(new Date(now.getTime() - DIGEST_LOOKBACK_HOURS * HOUR_MS))
  const sparks = MODES[mode].romance ? Prisma.sql`s."connectionType" = 'DATING'` : Prisma.sql`s."connectionType" <> 'DATING'`
  const marker = MODES[mode].romance
    ? Prisma.sql`LEFT JOIN "RomanceProfile" mp ON mp."userId" = u."id"`
    : Prisma.sql`LEFT JOIN "MatchingProfile" mp ON mp."userId" = u."id"`
  return db.$queryRaw<{ toId: string; timezone: string | null; sparkDigestAt: Date | null }[]>(Prisma.sql`
    SELECT DISTINCT s."toId", u."timezone", mp."sparkDigestAt"
    FROM "Spark" s
    JOIN "User" u ON u."id" = s."toId"
    ${marker}
    WHERE s."status" = 'PENDING' AND ${sparks} AND s."createdAt" >= ${since} AND u."deletedAt" IS NULL
  `)
}

export async function runSparkDigest(db: Db, options: DigestRunOptions = {}): Promise<DigestRunResult> {
  const now = options.now ?? new Date()
  const mode = options.mode ?? 'professional'
  const spec = MODES[mode]
  const recipients = await recentRecipients(db, now, mode)
  const result: DigestRunResult = { considered: recipients.length, notified: 0, skipped: 0 }

  for (const recipient of recipients) {
    try {
      // Time to send: past the hour in their own zone, and not yet today.
      const today = localDateKey(now, recipient.timezone)
      const lastDay = recipient.sparkDigestAt ? localDateKey(recipient.sparkDigestAt, recipient.timezone) : null
      if (localTimeKey(now, recipient.timezone) < DIGEST_HOUR_LOCAL || lastDay === today) {
        result.skipped += 1
        continue
      }
      // A plan that sees who gets each spark as it comes: nothing to batch.
      const subject = await subjectFor(db, recipient.toId, now)
      if (can(subject, 'SEE_WHO_SPARKED', { enforced: options.enforced })) {
        result.skipped += 1
        continue
      }
      // Count what arrived since they were last told (or the lookback, the first time), from people they have not blocked and who are still here.
      const hidden = await blockedPeerIds(db, recipient.toId)
      const since = recipient.sparkDigestAt ?? new Date(now.getTime() - DIGEST_LOOKBACK_HOURS * HOUR_MS)
      const count = await db.spark.count({
        where: {
          toId: recipient.toId,
          status: 'PENDING',
          connectionType: spec.romance ? 'DATING' : { not: 'DATING' },
          createdAt: { gt: since },
          from: { deletedAt: null, ...(hidden.length > 0 ? { id: { notIn: hidden } } : {}) },
        },
      })
      if (count === 0) {
        result.skipped += 1
        continue
      }
      const written = await createNotification(db, {
        userId: recipient.toId,
        kind: spec.kind,
        title: spec.title,
        message: digestMessage(count, mode),
        link: spec.link,
        metadata: { count, date: today },
      })
      // Told, or chose not to be: either way the day is done, so the count is not made again until tomorrow.
      if (spec.romance) await db.romanceProfile.updateMany({ where: { userId: recipient.toId }, data: { sparkDigestAt: now } })
      else await db.matchingProfile.updateMany({ where: { userId: recipient.toId }, data: { sparkDigestAt: now } })
      if (written) result.notified += 1
      else result.skipped += 1
    } catch (error) {
      result.skipped += 1
      log.error('could not send the spark digest to a user', { error, userId: recipient.toId, mode })
    }
  }
  log.info('spark digest run', { ...result, mode })
  return result
}

/** What the hourly job runs: the professional count and the romance one, each on its own. */
export async function runSparkDigestJob(): Promise<{ professional: DigestRunResult; romance: DigestRunResult }> {
  const { prisma } = await import('@/lib/prisma')
  return { professional: await runSparkDigest(prisma, { mode: 'professional' }), romance: await runSparkDigest(prisma, { mode: 'romance' }) }
}
