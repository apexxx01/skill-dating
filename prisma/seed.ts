/**
 * npm run seed [-- --scale 400 --seed text --days 75 --reset --with-romance]   (also: npm run db:seed)
 *
 * Builds a deterministic, idempotent world of builders in twelve cities: see prisma/seed/cli.ts and docs/SEED.md. Refuses to run in production.
 */
import { main } from './seed/cli'
import { SeedRefusal } from './seed/guard'

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof SeedRefusal ? error.message : error)
  process.exit(1)
})
