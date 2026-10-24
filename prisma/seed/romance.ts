import type { Ctx, Person } from './types'
import { DAY_MS, ID_PREFIX, SEED_DOMAIN } from './types'
import { atMoment } from './clock'
import { CITIES } from './catalog'
import { runRomanceDropGeneration } from '../../src/lib/romance/drops'
import { ROMANCE_LAUNCH_FLAG } from '../../src/lib/romance/launch-keys'
import { invalidateFlags } from '../../src/lib/flags'
import { skeleton } from '../../src/lib/identity/confusables'
import legalVersions from '../../src/config/legal-versions.json'

// --with-romance: forty people for the romance mode, and ONLY then. The mode ships closed, so the world has none unless this flag asks. They are plainly synthetic (named "Synthetic",
// with a bio that says so, an address at seed.skilldating.test), adults aged 25 and over, with no photos. The mode itself stays closed for everyone else: the synthetic people are put on the
// ALLOWLIST of the launch flag (romance.enabled), which opens it for them and nobody else, in this database only. Each gets this week's drop through the real weekly-drop function.

export const ROMANCE_PEOPLE = 40
const FIRST = ['Synthetic Ada', 'Synthetic Ben', 'Synthetic Chidi', 'Synthetic Dev', 'Synthetic Elif', 'Synthetic Farah', 'Synthetic Gus', 'Synthetic Hana']
const OBSESSIONS = ['compilers', 'climate tech', 'rust', 'typography', 'open source', 'bouldering', 'espresso', 'robotics', 'accessibility', 'local-first software']
const GENDERS = ['WOMAN', 'MAN', 'NON_BINARY'] as const

export async function seedRomance(ctx: Ctx): Promise<void> {
  const { db, rng, now } = ctx
  const ids: string[] = []
  for (let n = 0; n < ROMANCE_PEOPLE; n++) {
    const r = rng.fork(`romance-${n}`)
    const city = CITIES[n % CITIES.length]
    const id = `${ID_PREFIX}r${n}`
    const age = r.int(25, 38)
    const gender = r.pick(GENDERS)
    const interestedIn = gender === 'NON_BINARY' ? [...GENDERS] : [r.pick(GENDERS.filter((g) => g !== gender))]
    const username = `synthetic-halves-${n}`
    const createdAt = new Date(now.getTime() - r.int(40, 160) * DAY_MS)
    await db.user.create({
      data: {
        id,
        email: `romance-${n}@${SEED_DOMAIN}`,
        username,
        usernameSkeleton: skeleton(username),
        name: `${FIRST[n % FIRST.length]} ${n + 1}`,
        headline: 'A synthetic account for the romance-mode demo',
        bio: 'Synthetic account created by the seed. Not a real person.',
        builderRole: 'Full-Stack Engineer',
        timezone: city.timezone,
        isEmailVerified: true,
        emailVerified: createdAt,
        isPhoneVerified: true,
        verificationLevel: 'PHONE',
        birthDate: new Date(Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), now.getUTCDate()) - r.int(0, 364) * DAY_MS),
        createdAt,
        lastActiveAt: now,
      },
    })
    await db.profile.create({ data: { userId: id, headline: 'A synthetic account for the romance-mode demo', countryCode: city.countryCode, city: city.city, cityKey: city.cityKey, timezone: city.timezone, showCardsOnWeb: false } })
    await db.consentRecord.createMany({ data: (['TERMS', 'PRIVACY', 'ROMANCE_MODE'] as const).map((type) => ({ id: `${ID_PREFIX}rc_${n}_${type}`, userId: id, type, version: legalVersions[type], source: type === 'ROMANCE_MODE' ? 'romance-optin' : 'onboarding', grantedAt: createdAt })) })
    await db.romanceProfile.create({
      data: {
        userId: id,
        promptObsessed: `Right now I am obsessed with ${r.pick(OBSESSIONS)} and the people who care about it as much as I do.`,
        promptBuild: 'A small tool I would use every day, built with someone patient and a little stubborn.',
        promptWeekend: 'Ship something tiny on Saturday, cook something good on Sunday, call it a plan.',
        ambition: r.int(1, 4),
        direction: r.pick(['founder', 'craft', 'research', 'steady-career', 'nomad', 'open']),
        rhythm: r.pick(['night-owl', 'early-bird', 'bursty', 'steady']),
        obsessions: r.sample(OBSESSIONS, 3),
        gender,
        interestedIn,
        ageMin: Math.max(25, age - 6),
        ageMax: age + 9,
        scope: r.pick(['CITY', 'COUNTRY', 'ANYWHERE'] as const),
        createdAt,
      },
    })
    ids.push(id)
  }
  // The launch flag stays OFF; these people alone are on its allowlist, so the mode is open for them and closed for everyone else.
  const flag = await db.featureFlag.findUnique({ where: { key: ROMANCE_LAUNCH_FLAG } })
  if (flag) await db.featureFlag.update({ where: { key: ROMANCE_LAUNCH_FLAG }, data: { allowUserIds: [...new Set([...flag.allowUserIds, ...ids])] } })
  await invalidateFlags().catch(() => undefined)

  const at = new Date(now.getTime() - 6 * 3_600_000)
  const result = await atMoment(db, at, () => runRomanceDropGeneration(db, { userIds: ids, force: true, now: at }), [{ table: 'Notification', column: 'createdAt' }, { table: 'RomanceDrop', column: 'createdAt' }, { table: 'ProductEvent', column: 'createdAt' }])
  await db.$executeRaw`UPDATE "Notification" SET "sweptAt" = "createdAt" WHERE "userId" LIKE 'sd\_r%' AND "sweptAt" IS NULL`
  ctx.log(`  ${ids.length} synthetic romance people on the allowlist of ${ROMANCE_LAUNCH_FLAG}; ${result.drops} weekly drops`)
}

export type { Person }
