import { createHash } from 'crypto'
import { CITIES, SKILLS } from './catalog'
import { ID_PREFIX, type Ctx } from './types'
import { ensureActiveSeason } from '../../src/lib/seasons'

// The things people point at: the skills catalogue, the verified colleges, the season. Idempotent (upserts on the slug).

export async function seedSkills(ctx: Ctx): Promise<void> {
  for (const skill of SKILLS) {
    const row = await ctx.db.skill.upsert({ where: { slug: skill.slug }, create: { ...skill }, update: {}, select: { id: true } }).catch(async () => {
      // A skill with the same name but another slug already exists (a database used before): use it.
      return ctx.db.skill.findFirstOrThrow({ where: { OR: [{ slug: skill.slug }, { name: skill.name }] }, select: { id: true } })
    })
    ctx.skillIds.set(skill.slug, row.id)
  }
}

export async function seedCampuses(ctx: Ctx): Promise<void> {
  for (const city of CITIES) {
    for (const campus of city.campuses) {
      const row = await ctx.db.campus.upsert({
        where: { slug: campus.slug },
        create: { slug: campus.slug, name: campus.name, emailDomains: campus.domains, city: city.city, cityKey: city.cityKey, countryCode: city.countryCode },
        update: {},
        select: { id: true },
      })
      ctx.campusIds.set(campus.slug, row.id)
    }
  }
}

/** The hash a campus membership keeps in place of the college address; the real one is keyed with the server's secret, this one with the seed's, and is just as unreadable. */
async function addressHash(address: string): Promise<string> {
  try {
    const { emailHashOf } = await import('../../src/lib/campus/campus')
    return emailHashOf(address)
  } catch {
    return createHash('sha256').update(`seed-campus:${address}`).digest('hex')
  }
}

/** The people with a campus have verified a college address (the address is never stored, only its hash): they are on its leaderboard and feed. */
export async function seedCampusMembers(ctx: Ctx): Promise<void> {
  const members = ctx.people.filter((person) => person.campusSlug && ctx.campusIds.has(person.campusSlug))
  const rows = []
  for (const person of members) {
    const campus = CITIES.flatMap((city) => city.campuses).find((c) => c.slug === person.campusSlug)!
    rows.push({ userId: person.id, campusId: ctx.campusIds.get(person.campusSlug!)!, emailHash: await addressHash(`${person.username}@${campus.domains[0]}`), verifiedAt: new Date(person.createdAt.getTime() + 3 * 24 * 3_600_000) })
  }
  await ctx.db.campusMembership.createMany({ data: rows, skipDuplicates: true })
  for (const person of members) {
    const campus = CITIES.flatMap((city) => city.campuses).find((c) => c.slug === person.campusSlug)!
    await ctx.db.profile.update({ where: { userId: person.id }, data: { campus: campus.name, campusKey: campus.slug } })
  }
}

export async function seedSeason(ctx: Ctx): Promise<void> {
  await ensureActiveSeason(ctx.db, ctx.now)
}

export { ID_PREFIX }
