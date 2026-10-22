import { Prisma, type PrismaClient } from '@prisma/client'
import { REWARD_ACTIONS, REWARD_RULES } from '@/lib/rewards-config'
import { utcTimestamp } from '@/lib/sql'

// What counts as a person doing something, in one place: the metrics (docs/METRICS.md) and the invite rule ("a first real action") read the same lists, so the numbers and the
// rules cannot drift apart. Two sources are used, both written by the application itself inside the code path of the action:
//   ProductEvent   the analytics events (src/lib/infra/analytics.ts), by name;
//   XPEvent        the XP log, for the rewards whose rule says they are an action of the person's own (REWARD_RULES[...].streak): not Props received, an endorsement, an accepted
//                  application or a win recorded by an organiser, which other people do for them.
// The romance mode's events and tables are not read, by design: the numbers never include it.

/** Events that mean the person used the product that day. */
export const ACTIVE_EVENTS = [
  'signup',
  'onboarding_completed',
  'project_created',
  'project_shipped',
  'drop_viewed',
  'spark_sent',
  'post_created',
  'props_given',
  'comment_created',
  'follow_created',
  'squad_builder_used',
  'squad_proposal_accepted',
  'solo_pool_joined',
  'squad_submitted',
] as const

/** Events that are a real thing done, not just looking: what "activated" and "a first real action" mean. */
export const MEANINGFUL_EVENTS = [
  'project_created',
  'project_shipped',
  'post_created',
  'spark_sent',
  'props_given',
  'comment_created',
  'squad_builder_used',
  'squad_proposal_accepted',
  'solo_pool_joined',
  'squad_submitted',
] as const

/** The XP types that are the person's own action. */
export const OWN_ACTION_XP_TYPES: readonly string[] = REWARD_ACTIONS.filter((action) => REWARD_RULES[action].streak)

/** The events that mean "shipped": a project shipped or a squad submitted. Posts and project updates are counted from their own tables (docs/METRICS.md). */
export const SHIPPING_EVENTS = ['project_shipped', 'squad_submitted'] as const

type Db = Pick<PrismaClient, '$queryRaw'>

/** Whether the person did a real thing in [since, until): any meaningful event, or an XP award for an action of their own. */
export async function didMeaningfulAction(db: Db, userId: string, since: Date, until: Date = new Date()): Promise<boolean> {
  const rows = await db.$queryRaw<{ found: number }[]>(Prisma.sql`
    SELECT 1 AS "found" WHERE EXISTS (
      SELECT 1 FROM "ProductEvent" WHERE "userId" = ${userId} AND "name" IN (${Prisma.join(MEANINGFUL_EVENTS)}) AND "createdAt" >= ${utcTimestamp(since)} AND "createdAt" < ${utcTimestamp(until)}
    ) OR EXISTS (
      SELECT 1 FROM "XPEvent" WHERE "userId" = ${userId} AND "type" IN (${Prisma.join(OWN_ACTION_XP_TYPES)}) AND "createdAt" >= ${utcTimestamp(since)} AND "createdAt" < ${utcTimestamp(until)}
    )
  `)
  return rows.length > 0
}
