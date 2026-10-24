/**
 * npm run perf:digests [-- --kind daily|weekly]   (against PERF_DATABASE_URL, default the local skill_dating_perf database)
 *
 * Times the digest job for everybody who is eligible, the way the job runs it: it runs every hour, takes batches of 500 and goes through them one person after another, mail to the
 * in-memory twin (nothing is sent). A person is due once their local morning has come, so one pass finds only the people in the zones whose morning it is; this runs five passes
 * through a day (01, 06, 12, 18 and 23 UTC) and adds them up, which reaches every zone of the seed. Prints each batch, each pass, the total and the throughput. Digests are marked sent
 * in the database, so run it on a fresh seed or with --reset-state.
 */
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { performance } from 'perf_hooks'
import { loadEnvLocal } from '../../tests/integration/env'

async function main() {
  const url = process.env.PERF_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/skill_dating_perf?schema=public'
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('perf:digests runs against a database on this machine only')
  Object.assign(process.env, loadEnvLocal(path.resolve(__dirname, '../..')), { DATABASE_URL: url })
  Object.assign(process.env, { NODE_ENV: 'test', PRISMA_QUERY_LOG: 'off' })
  const kind = process.argv.includes('weekly') || process.argv.includes('--kind=weekly') ? 'DIGEST_WEEKLY' : 'DIGEST_DAILY'
  const { runDigests } = await import('../../src/lib/notify/digest')
  const { MemoryEmail } = await import('../../src/lib/infra/email.memory')
  const { MemoryPush } = await import('../../src/lib/infra/push.memory')
  const db = new PrismaClient({ datasources: { db: { url } } })
  try {
    if (process.argv.includes('--reset-state')) await db.notificationSettings.updateMany({ data: { lastDailyDigestAt: null, lastWeeklyDigestAt: null } })
    const email = new MemoryEmail()
    const started = performance.now()
    const total = { considered: 0, sent: 0, nothingToSend: 0, notDue: 0, notEligible: 0, failed: 0 }
    const day = new Date().toISOString().slice(0, 10)
    for (const hour of [1, 6, 12, 18, 23]) {
      const now = new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`)
      const deps = { email, push: new MemoryPush(), baseUrl: 'https://app.test', now }
      const passStart = performance.now()
      let after: string | undefined
      let batches = 0
      let sentInPass = 0
      for (;;) {
        const result = await runDigests(db, kind, { now, after, deps })
        batches += 1
        sentInPass += result.sent
        for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += result[key]
        if (result.next) {
          after = result.next
          continue
        }
        break
      }
      console.log(`pass at ${String(hour).padStart(2, '0')}:00 UTC: ${batches} batches, ${sentInPass} sent, ${((performance.now() - passStart) / 1000).toFixed(1)} s`)
    }
    const seconds = (performance.now() - started) / 1000
    console.log(`\n${kind}: ${JSON.stringify(total)}\nfive passes: ${seconds.toFixed(1)} s; ${email.outbox.length} messages to the in-memory twin, ${(email.outbox.length / Math.max(seconds, 1)).toFixed(0)} a second`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
