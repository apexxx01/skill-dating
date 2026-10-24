import type { Ctx } from './types'
import { DAY_MS } from './types'
import { runSnapshot } from '../../src/lib/kpi/snapshot'
import { recomputeRarity } from '../../src/lib/achievement-rarity'
import { addDays, formatDay } from '../../src/lib/kpi/days'

// The last steps: what the nightly jobs would have done by now, so the admin pages have numbers and the notification sweep has nothing old to send.

export async function finish(ctx: Ctx): Promise<void> {
  const { db, now } = ctx
  // Everyone's last visit is the last thing they did (XP, a post or a message), or the day they signed up.
  await db.$executeRaw`
    UPDATE "User" u SET "lastActiveAt" = GREATEST(u."createdAt", COALESCE((SELECT max(x."createdAt") FROM "XPEvent" x WHERE x."userId" = u."id"), u."createdAt"), COALESCE((SELECT max(p."createdAt") FROM "ShipPost" p WHERE p."authorId" = u."id"), u."createdAt"))
    WHERE u."id" LIKE 'sd\_%'
  `
  // Nothing the seed wrote is mailed or pushed: it is history, already swept.
  const swept = await db.$executeRaw`UPDATE "Notification" n SET "sweptAt" = n."createdAt" FROM "User" u WHERE u."id" = n."userId" AND u."id" LIKE 'sd\_%' AND n."sweptAt" IS NULL`
  ctx.log(`  ${swept} notifications marked as already swept`)

  await recomputeRarity(db)

  // What autovacuum does a minute after a bulk load: the planner's statistics. Without them the first queries are planned for tables it believes are empty.
  await db.$executeRawUnsafe('ANALYZE')

  // The numbers: a snapshot for each of the last 30 days that are over (the activity days are filled from the first), as the nightly job would have written them.
  const yesterday = formatDay(new Date(now.getTime() - DAY_MS))
  const days = Math.min(30, ctx.args.days - 1)
  for (let back = days; back >= 0; back--) {
    const day = addDays(yesterday, -back)
    await runSnapshot(db, { day, now, ...(back === days ? { backfillDays: ctx.args.days } : {}) })
  }
  ctx.log(`  metrics for ${days + 1} days`)
}
