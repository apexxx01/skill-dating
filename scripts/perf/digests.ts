/**
 * npm run perf:digests [-- --kind daily|weekly]   (against PERF_DATABASE_URL, default the local skill_dating_perf database)
 *
 * Times the digest job for everybody who is eligible, the way the job runs it: batches of 500, one person after another, mail to the in-memory twin (nothing is sent). Prints how long a
 * batch took, how long all of it took, and the throughput. Digests are marked sent in the database, so a second run finds nobody due: run it on a fresh seed or with --reset-state.
 */
import { PrismaClient } from '@prisma/client'
import { performance } from 'perf_hooks'

async function main() {
  const url = process.env.PERF_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/skill_dating_perf?schema=public'
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('perf:digests runs against a database on this machine only')
  process.env.DATABASE_URL = url
  Object.assign(process.env, { NODE_ENV: 'test', PRISMA_QUERY_LOG: 'off' })
  const kind = process.argv.includes('weekly') || process.argv.includes('--kind=weekly') ? 'DIGEST_WEEKLY' : 'DIGEST_DAILY'
  const { runDigests } = await import('../../src/lib/notify/digest')
  const { MemoryEmail } = await import('../../src/lib/infra/email.memory')
  const { MemoryPush } = await import('../../src/lib/infra/push.memory')
  const db = new PrismaClient({ datasources: { db: { url } } })
  try {
    if (process.argv.includes('--reset-state')) await db.notificationSettings.updateMany({ data: { lastDailyDigestAt: null, lastWeeklyDigestAt: null } })
    // Everybody is a candidate at the hour they chose; run at the moment each person's morning has come in the busiest zone, so many are due.
    const now = new Date()
    const email = new MemoryEmail()
    const deps = { email, push: new MemoryPush(), baseUrl: 'https://app.test', now }
    const started = performance.now()
    let after: string | undefined
    let batches = 0
    const total = { considered: 0, sent: 0, nothingToSend: 0, notDue: 0, notEligible: 0, failed: 0 }
    for (;;) {
      const batchStart = performance.now()
      const result = await runDigests(db, kind, { now, after, deps })
      batches += 1
      for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += result[key]
      console.log(`batch ${batches}: ${result.considered} considered, ${result.sent} sent in ${((performance.now() - batchStart) / 1000).toFixed(1)} s`)
      if (!result.next) break
      after = result.next
    }
    const seconds = (performance.now() - started) / 1000
    console.log(`\n${kind}: ${JSON.stringify(total)}\nall of it: ${seconds.toFixed(1)} s, ${(total.considered / seconds).toFixed(0)} people a second, ${email.outbox.length} messages to the in-memory twin`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
