// Measures daily-drop generation on a database seeded with synthetic people. Run it against a DISPOSABLE database whose name ends in
// "_bench" (it deletes and recreates every row whose id starts with "bench_"):
//
//   createdb skill_dating_bench
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/skill_dating_bench npx prisma migrate deploy
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/skill_dating_bench npm run bench:matching -- --users 10000 --sample 1000
//
//   --users N     how many people to seed (default 1000)
//   --sample M    how many of them to generate drops for, one at a time (default: all)
//   --keep        leave the seeded rows in place afterwards
//
// It prints seeding time, then for the sampled viewers: how long the candidate query takes, how long loading and scoring take, how long a
// whole person takes (mean, median, 95th percentile), and what the query plan of one candidate query looks like. Nothing secret is printed.

process.env.PRISMA_QUERY_LOG = 'off'

import { performance } from 'perf_hooks'

function arg(name: string, fallback?: number): number | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} needs a positive whole number`)
  return value
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
const round = (n: number) => Math.round(n * 10) / 10

async function main() {
  const users = arg('users', 1000)!
  const sample = Math.min(arg('sample', users)!, users)
  const url = process.env.DATABASE_URL ?? ''
  const database = decodeURIComponent(new URL(url || 'postgresql://x/none').pathname.replace(/^\//, ''))
  if (!/_bench$/.test(database)) throw new Error(`refusing to run: the database name must end in "_bench" (this one is "${database}")`)

  const { prisma } = await import('../src/lib/prisma')
  const { generateDropsForUser } = await import('../src/lib/matching/drops')
  const { findCandidateIds } = await import('../src/lib/matching/candidates')
  const { loadScoringProfiles } = await import('../src/lib/matching/loader')
  const { scoreCompatibility } = await import('../src/lib/matching/score')
  const { DROP_CONFIG } = await import('../src/lib/matching/config')

  try {
    // --- Seed -------------------------------------------------------------------------------------------------
    const seedStart = performance.now()
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" LIKE 'bench\\_%'`)
    await prisma.$executeRawUnsafe(`DELETE FROM "Skill" WHERE "id" LIKE 'bench\\_%'`)
    const utc = `(now() AT TIME ZONE 'UTC')`
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Skill" ("id","name","slug","category","updatedAt")
      SELECT 'bench_s'||k, 'Bench skill '||k, 'bench-skill-'||k, 'Category '||(k % 8), ${utc} FROM generate_series(0,39) k`)
    await prisma.$executeRawUnsafe(`
      INSERT INTO "User" ("id","email","username","name","isEmailVerified","isPhoneVerified","githubConnected","birthDate","timezone","xp","lastActiveAt","createdAt","updatedAt")
      SELECT 'bench_u'||i, 'bench'||i||'@bench.invalid', 'bench_'||i, 'Bench '||i, true, (i % 3 = 0), (i % 5 = 0),
             CASE WHEN i % 10 = 0 THEN DATE '1990-01-01' ELSE NULL END,
             (ARRAY['UTC','Asia/Kolkata','America/Los_Angeles','Europe/Berlin','America/New_York','Asia/Tokyo','Australia/Sydney','Africa/Lagos'])[1 + i % 8],
             (random() * 20000)::int, ${utc} - (random() * 20) * interval '1 day', ${utc} - interval '30 days', ${utc}
      FROM generate_series(1, ${users}) i`)
    await prisma.$executeRawUnsafe(`
      INSERT INTO "UserSkill" ("id","userId","skillId","level","updatedAt")
      SELECT 'bench_us'||i||'_'||j, 'bench_u'||i, 'bench_s'||((i * 7 + j * 13) % 40), 1 + ((i + j) % 5), ${utc}
      FROM generate_series(1, ${users}) i, generate_series(1, 5) j`)
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Profile" ("id","userId","cityKey","city","countryCode","updatedAt")
      SELECT 'bench_p'||i, 'bench_u'||i, 'city-'||(i % 30), 'City '||(i % 30), 'IN', ${utc} FROM generate_series(1, ${users}) i WHERE i % 5 < 3`)
    await prisma.$executeRawUnsafe(`
      INSERT INTO "MatchingProfile" ("id","userId","connectionTypes","intentTags","hoursPerWeek","cityOnly","lookingForSkills","workingStyle","dropTimeLocal","updatedAt")
      SELECT 'bench_m'||i, 'bench_u'||i,
        (CASE i % 6
           WHEN 0 THEN ARRAY['COFOUNDER']
           WHEN 1 THEN ARRAY['COFOUNDER','COLLABORATOR']
           WHEN 2 THEN ARRAY['HACKATHON_TEAMMATE']
           WHEN 3 THEN ARRAY['MENTOR']
           WHEN 4 THEN ARRAY['MENTEE','COFOUNDER']
           ELSE ARRAY['COLLABORATOR','MENTEE','MENTOR'] END
         || CASE WHEN i % 10 = 0 THEN ARRAY['DATING'] ELSE ARRAY[]::text[] END)::"MatchType"[],
        CASE i % 3 WHEN 0 THEN '[{"tag":"ship-mvp-90-days"}]'::jsonb WHEN 1 THEN '[{"tag":"win-a-hackathon"},{"tag":"open-source"}]'::jsonb ELSE '[]'::jsonb END,
        5 + (i % 8) * 5, (i % 20 = 0),
        ARRAY['bench-skill-'||((i * 3) % 40), 'bench-skill-'||((i * 3 + 11) % 40)],
        jsonb_build_object('pace', (ARRAY['steady','balanced','sprints'])[1 + i % 3], 'rhythm', (ARRAY['morning','daytime','evening','night'])[1 + i % 4]),
        '09:00', ${utc}
      FROM generate_series(1, ${users}) i`)
    await prisma.$executeRawUnsafe(`
      INSERT INTO "SkillEvidence" ("id","userId","skillId","type","title","verifiedAt","updatedAt")
      SELECT 'bench_e'||i, 'bench_u'||i, 'bench_s'||((i * 7 + 13) % 40), 'GITHUB_PROJECT', 'Project '||i, ${utc}, ${utc} FROM generate_series(1, ${users}) i WHERE i % 5 = 0`)
    await prisma.$executeRawUnsafe(`
      INSERT INTO "CurrentBuild" ("id","userId","title","techStack","updatedAt")
      SELECT 'bench_b'||i, 'bench_u'||i, 'Build '||i, (ARRAY['react','node','postgres','python','rust'])[1:1 + (i % 4)], ${utc} FROM generate_series(1, ${users}) i WHERE i % 2 = 0`)
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Block" ("id","blockerId","blockedId")
      SELECT 'bench_k'||i, 'bench_u'||i, 'bench_u'||(1 + (i * 17) % ${users}) FROM generate_series(1, ${users}) i WHERE i % 50 = 0 AND (1 + (i * 17) % ${users}) <> i`).catch(() => undefined)
    await prisma.$executeRawUnsafe('ANALYZE')
    const seedMs = performance.now() - seedStart
    console.log(`seeded ${users} people in ${round(seedMs / 1000)}s`)

    // --- Measure ----------------------------------------------------------------------------------------------
    const now = new Date()
    const step = Math.max(1, Math.floor(users / sample))
    const viewerIds = Array.from({ length: sample }, (_, k) => `bench_u${1 + ((k * step) % users)}`)

    const cache = new Map()
    const whole: number[] = []
    let drops = 0
    let considered = 0
    const wallStart = performance.now()
    for (const id of viewerIds) {
      const started = performance.now()
      const result = await generateDropsForUser(prisma, id, now, { enforced: true, cache, force: true })
      whole.push(performance.now() - started)
      drops += result.created
      considered += result.considered
    }
    const wallMs = performance.now() - wallStart

    // The parts, on a few viewers: the candidate query alone, then loading and scoring what it returned.
    const parts = { query: [] as number[], load: [] as number[], score: [] as number[], pool: [] as number[] }
    for (const id of viewerIds.slice(0, Math.min(100, viewerIds.length))) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id }, select: { matchingProfile: true, profile: { select: { cityKey: true } }, skills: { select: { skill: { select: { slug: true } } } } } })
      const mp = user.matchingProfile!
      const wanted = await prisma.skill.findMany({ where: { slug: { in: mp.lookingForSkills } }, select: { id: true } })
      const viewer = { userId: id, cityOnly: mp.cityOnly, cityKey: user.profile?.cityKey ?? null, lookingForSkillIds: wanted.map((s) => s.id), skillSlugs: user.skills.map((s) => s.skill.slug) }
      const type = mp.connectionTypes[0] === 'DATING' ? mp.connectionTypes[1] ?? 'COFOUNDER' : mp.connectionTypes[0]
      let t = performance.now()
      const ids = await findCandidateIds(prisma, viewer, type, now)
      parts.query.push(performance.now() - t)
      parts.pool.push(ids.length)
      t = performance.now()
      const profiles = await loadScoringProfiles(prisma, ids, now)
      parts.load.push(performance.now() - t)
      const [self] = await loadScoringProfiles(prisma, [id], now)
      t = performance.now()
      for (const candidate of profiles) scoreCompatibility({ viewer: self, candidate, connectionType: type, now })
      parts.score.push(performance.now() - t)
    }
    const stat = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return `mean ${round(values.reduce((a, b) => a + b, 0) / values.length)}  p50 ${round(percentile(sorted, 50))}  p95 ${round(percentile(sorted, 95))}`
    }

    console.log(`\npeople seeded:            ${users}`)
    console.log(`viewers generated:        ${sample} (cold profile cache shared across them, FREE plan: ${3} drops each)`)
    console.log(`drops created:            ${drops}   (mean ${round(drops / sample)} per viewer)`)
    console.log(`candidates scored:        ${considered}   (mean ${round(considered / sample)} per viewer, pool cap ${DROP_CONFIG.candidatePoolPerType} per type)`)
    console.log(`whole person, ms:         ${stat(whole)}`)
    console.log(`  candidate query, ms:    ${stat(parts.query)}   (pool size ${stat(parts.pool)})`)
    console.log(`  load one pool, ms:      ${stat(parts.load)}   (uncached)`)
    console.log(`  score one pool, ms:     ${stat(parts.score)}`)
    console.log(`wall time for the sample: ${round(wallMs / 1000)}s  => ${round((wallMs / sample) * 1)} ms per person`)
    console.log(`projected for everybody:  ${round(((wallMs / sample) * users) / 1000)}s  (${round(((wallMs / sample) * users) / 60000)} min) if run one after another`)

    if (!process.argv.includes('--keep')) {
      await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" LIKE 'bench\\_%'`)
      await prisma.$executeRawUnsafe(`DELETE FROM "Skill" WHERE "id" LIKE 'bench\\_%'`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
