import { CORE_PEOPLE, planPeople, register, writePeople } from './people'
import { seedCampuses, seedCampusMembers, seedSeason, seedSkills } from './reference'
import { runHistory } from './history'
import { seedHackathons } from './hackathons'
import { seedMatching } from './matching'
import { archiveQuietProjects, seedCrews, seedCurrentBuilds, seedInvites, seedReminders, seedReports, seedShipDayRecaps } from './extras'
import { finish } from './finish'
import { seedBackground } from './background'
import { seedRomance } from './romance'
import type { Ctx } from './types'

// The order the world is built in. Each phase is its own module and logs what it made.

export async function buildWorld(ctx: Ctx): Promise<void> {
  const started = Date.now()
  const step = async (label: string, fn: () => Promise<unknown>) => {
    const at = Date.now()
    ctx.log(`${label}...`)
    await fn()
    ctx.log(`  done in ${((Date.now() - at) / 1000).toFixed(1)}s`)
  }

  await step('Reference data (skills, colleges, the season)', async () => {
    await seedSkills(ctx)
    await seedCampuses(ctx)
    await seedSeason(ctx)
  })

  await step(`People (${Math.min(ctx.args.scale, CORE_PEOPLE)} builders)`, async () => {
    const core = planPeople(ctx.rng, Math.min(ctx.args.scale, CORE_PEOPLE), ctx.now, ctx.args.days)
    register(ctx, core)
    await writePeople(ctx, core)
    await seedCampusMembers(ctx)
  })

  await step(`History (${ctx.args.days} days, through the domain functions)`, async () => {
    const result = await runHistory(ctx)
    ctx.log(`  actions: ${JSON.stringify(result.actions)}`)
    if (Object.keys(result.failures).length > 0) ctx.log(`  failed (see above): ${JSON.stringify(result.failures)}`)
  })

  await step('Hackathons, squads, pledges, results and reviews', () => seedHackathons(ctx))
  await step('Drops, sparks, matches and conversations', async () => {
    const result = await seedMatching(ctx)
    ctx.log(`  ${JSON.stringify(result)}`)
  })

  await step('Invites, reports, crews, current builds and the Ship Day recaps', async () => {
    ctx.log(`  invites ${JSON.stringify(await seedInvites(ctx))}`)
    ctx.log(`  ${await seedReports(ctx)} reports filed`)
    ctx.log(`  ${await seedCrews(ctx)} crews`)
    ctx.log(`  ${await seedCurrentBuilds(ctx)} current builds`)
    ctx.log(`  ${await seedShipDayRecaps(ctx)} Ship Day recaps`)
    ctx.log(`  ${await archiveQuietProjects(ctx)} quiet projects archived`)
    ctx.log(`  reminders ${JSON.stringify(await seedReminders(ctx))}`)
  })

  if (ctx.args.scale > CORE_PEOPLE) await step(`Background people (${ctx.args.scale - CORE_PEOPLE}, written in bulk)`, () => seedBackground(ctx))

  if (ctx.args.withRomance) await step('The romance mode (synthetic people, --with-romance)', () => seedRomance(ctx))

  await step('Finishing (last activity, rarity, the metrics of the last month)', () => finish(ctx))

  ctx.log(`World built in ${((Date.now() - started) / 1000).toFixed(0)}s`)
}
