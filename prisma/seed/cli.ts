import { PrismaClient } from '@prisma/client'
import { parseArgs, DEFAULTS, type SeedArgs } from './args'
import { assertSafeToSeed, loadEnvFiles } from './guard'
import { installClock } from './clock'
import { rngFor } from './rng'
import { ID_PREFIX, type Ctx } from './types'

// npm run seed [-- --scale 400 --seed text --days 75 --reset --with-romance]
//
// Builds the same world every time for the same arguments (a seeded random generator, deterministic ids and emails), and does nothing on a second run: a marker (the flag `seed.world`) records
// what was built. --reset deletes the seeded world (every row of it has an id starting `sd_`, an address at seed.skilldating.test, or a hackathon slug starting `seed-`) and builds it again.
// It refuses to run in production or against a database that is not on this machine. docs/SEED.md says what it makes and what is written directly.

export const WORLD_FLAG = 'seed.world'

const USAGE = `Usage: npm run seed -- [options]

  --scale <n>        people in the world (default ${DEFAULTS.scale}; 50 to 50000). Up to 400 are built through the domain functions; the rest are background people written in bulk
  --days <n>         days of history (default ${DEFAULTS.days})
  --seed <text>      the seed of the random generator (default "${DEFAULTS.seed}")
  --reset            delete the seeded world first and build it again
  --with-romance     also make the synthetic people of the romance mode (adults, 25+)
  --help
`

interface WorldMarker {
  seed: string
  scale: number
  days: number
  withRomance: boolean
  builtAt: string
}

export async function readMarker(db: PrismaClient): Promise<WorldMarker | null> {
  const flag = await db.featureFlag.findUnique({ where: { key: WORLD_FLAG } })
  if (!flag?.description) return null
  try {
    return JSON.parse(flag.description) as WorldMarker
  } catch {
    return null
  }
}

async function writeMarker(db: PrismaClient, marker: WorldMarker): Promise<void> {
  await db.featureFlag.upsert({
    where: { key: WORLD_FLAG },
    create: { key: WORLD_FLAG, description: JSON.stringify(marker), enabled: false, rolloutPercent: 0 },
    update: { description: JSON.stringify(marker) },
  })
}

/** Deletes the seeded world. Cascades remove everything that hangs off a person. */
export async function resetWorld(db: PrismaClient, log: (message: string) => void): Promise<void> {
  log('Removing the seeded world...')
  const removed = await db.user.deleteMany({ where: { OR: [{ id: { startsWith: ID_PREFIX } }, { email: { endsWith: '@seed.skilldating.test' } }] } })
  const hackathons = await db.hackathon.deleteMany({ where: { slug: { startsWith: 'seed-' } } })
  await db.featureFlag.deleteMany({ where: { key: WORLD_FLAG } })
  // The synthetic romance people were on the launch flag's allowlist; they are gone, so are they from it.
  const launch = await db.featureFlag.findUnique({ where: { key: 'romance.enabled' } })
  if (launch && launch.allowUserIds.some((id) => id.startsWith(ID_PREFIX))) await db.featureFlag.update({ where: { key: 'romance.enabled' }, data: { allowUserIds: launch.allowUserIds.filter((id) => !id.startsWith(ID_PREFIX)) } })
  log(`  removed ${removed.count} people and ${hackathons.count} hackathons (and what hung off them)`)
}

export async function main(argv: readonly string[]): Promise<void> {
  loadEnvFiles()
  const args = parseArgs(argv)
  if (args.help) {
    console.log(USAGE)
    return
  }
  const target = assertSafeToSeed()
  process.env.PRISMA_QUERY_LOG = 'off'
  // The job queue runs jobs on its own outside tests; here nothing may run while the clock is set to the past, so the seed runs as a test process does: jobs wait in memory and are dropped.
  Object.assign(process.env, { NODE_ENV: 'test' })
  const log = (message: string) => console.log(message)
  log(`Seeding ${target.host}/${target.database}: ${args.scale} people, ${args.days} days, seed "${args.seed}"`)

  const db = new PrismaClient()
  try {
    const marker = await readMarker(db)
    const wanted = { seed: args.seed, scale: args.scale, days: args.days, withRomance: args.withRomance }
    if (marker && !args.reset) {
      const same = marker.seed === wanted.seed && marker.scale === wanted.scale && marker.days === wanted.days && marker.withRomance === wanted.withRomance
      log(same ? `The world is already built (${marker.builtAt}). Nothing to do. Use --reset to build it again.` : `A world with other settings is already built (seed "${marker.seed}", ${marker.scale} people, ${marker.days} days). Use --reset to replace it.`)
      return
    }
    if (args.reset || (await db.user.count({ where: { id: { startsWith: ID_PREFIX } } })) > 0) await resetWorld(db, log)

    installClock()
    const ctx = await buildContext(db, args, log)
    const { buildWorld } = await import('./world')
    await buildWorld(ctx)
    await writeMarker(db, { ...wanted, builtAt: new Date().toISOString() })
  } finally {
    await db.$disconnect()
  }
}

export async function buildContext(db: PrismaClient, args: SeedArgs, log: (message: string) => void): Promise<Ctx> {
  const rng = rngFor(args.seed)
  const now = new Date()
  const ctx: Ctx = {
    db,
    rng,
    args,
    now,
    start: new Date(now.getTime() - args.days * 24 * 3_600_000),
    log,
    people: [],
    byId: new Map(),
    state: new Map(),
    skillIds: new Map(),
    campusIds: new Map(),
    hackathons: [],
  }
  return ctx
}
