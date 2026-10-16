// Run once after every deploy (and safe to run on every one): `npm run postdeploy`. See docs/DEPLOY.md.
//
//   npm run postdeploy               do it
//   npm run postdeploy -- --dry-run  check the environment and the database, say what it would do, change nothing
//   npm run postdeploy -- --production  hold the environment to the production rules even if it does not say it is production
//
// It reads the environment it is run in (DATABASE_URL, the Upstash settings, ...); it prints what it did and never a secret.
// Exit code 0: everything done (or skipped, with a warning). Anything else: something failed or the environment is not fit
// for production, and the message says what.

import { jobs, runJob } from '../src/lib/infra/jobs'
import { checkEnvironment, PostdeployError, runPostdeploy } from '../src/lib/postdeploy'

async function main() {
  const flags = process.argv.slice(2)
  const dryRun = flags.includes('--dry-run')
  const production = flags.includes('--production')
  const unknown = flags.filter((argument) => argument !== '--dry-run' && argument !== '--production')
  if (unknown.length > 0) throw new PostdeployError(`unknown argument: ${unknown.join(' ')} (the options are --dry-run and --production)`)

  // Before any service is created: production without Upstash must stop here, with its own message.
  checkEnvironment(process.env, undefined, { forceProduction: production })

  const { getCache } = await import('../src/lib/infra/cache')
  const { prisma } = await import('../src/lib/prisma')
  try {
    const reports = await runPostdeploy(
      { env: process.env, cache: getCache(), prisma, runJob: (name, data) => runJob(jobs, name, data), say: (line) => console.log(line) },
      { dryRun, production }
    )
    console.log(`\n${dryRun ? 'Dry run' : 'Post-deploy'} finished: ${reports.map((report) => `${report.step} ${report.status}`).join(', ')}.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n\nPOST-DEPLOY FAILED. Do not treat this deploy as complete.`)
  process.exit(1)
})
