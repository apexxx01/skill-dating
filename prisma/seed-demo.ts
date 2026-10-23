/**
 * npm run seed:demo -- --username aanya [--name "Aanya Kapoor"] [--city blr] [--streak 45]
 *
 * A polished demo account on top of the seeded world: see prisma/seed/demo.ts and docs/SEED.md. Refuses to run in production.
 */
import { demoMain } from './seed/demo'
import { SeedRefusal } from './seed/guard'

demoMain(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof SeedRefusal ? error.message : error)
  process.exit(1)
})
