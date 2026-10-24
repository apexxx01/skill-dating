/**
 * npm run perf:drops [-- --sample 200]   (against PERF_DATABASE_URL, default the local skill_dating_perf database)
 *
 * Times the daily-drop generation for a sample of people of the 10,000-person database, the way a batch job does (generateDropsForUser, scoring and writing), and says how long
 * everybody takes: one at a time, and as the job runs it (batches of 250 per time zone, up to 8 at once). The drops are written for TOMORROW's local date, so today's are not touched.
 */
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { performance } from 'perf_hooks'
import { loadEnvLocal } from '../../tests/integration/env'
import { statsOf } from './lib'

async function main() {
  const url = process.env.PERF_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/skill_dating_perf?schema=public'
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('perf:drops runs against a database on this machine only')
  Object.assign(process.env, loadEnvLocal(path.resolve(__dirname, '../..')), { DATABASE_URL: url, NODE_ENV: 'test', PRISMA_QUERY_LOG: 'off' })
  const sampleArg = process.argv.indexOf('--sample')
  const sample = sampleArg >= 0 ? Number(process.argv[sampleArg + 1]) : 200
  const { generateDropsForUser } = await import('../../src/lib/matching/drops')
  const db = new PrismaClient({ datasources: { db: { url } } })
  try {
    const people = await db.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "MatchingProfile" WHERE NOT paused ORDER BY md5("userId") LIMIT ${sample}`
    const total = await db.matchingProfile.count({ where: { paused: false } })
    const tomorrow = new Date(Date.now() + 24 * 3_600_000)
    const times: number[] = []
    let created = 0
    for (const { userId } of people) {
      const started = performance.now()
      const result = await generateDropsForUser(db, userId, tomorrow, { enforced: false, force: true })
      times.push(performance.now() - started)
      created += result.created
    }
    const stats = statsOf(times)
    const mean = stats.mean
    console.log(`${people.length} people sampled of ${total} with a matching profile: p50 ${stats.p50} ms, p95 ${stats.p95} ms, p99 ${stats.p99} ms per person; ${created} drops written`)
    console.log(`everybody, one after another: ${((mean * total) / 60_000).toFixed(1)} minutes; as the job runs it (batches in parallel, 8 at once): about ${((mean * total) / 8 / 60_000).toFixed(1)} minutes`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
