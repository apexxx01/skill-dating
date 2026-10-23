import type { Prisma } from '@prisma/client'
import { ARCHETYPES, BIO_CLOSERS, BIO_OPENERS, CITIES, NAME_POOLS, SKILLS, type ArchetypeSeed, type CitySeed } from './catalog'
import type { Rng } from './rng'
import { DAY_MS, DEMO_DOMAIN, ID_PREFIX, SEED_DOMAIN, personId, type Ctx, type Person, type PersonSkill } from './types'
import { WORKING_STYLE_QUIZ } from '../../src/lib/matching/quiz'
import { KNOWN_INTENTS } from '../../src/lib/matching/intents'
import { skeleton } from '../../src/lib/identity/confusables'
import legalVersions from '../../src/config/legal-versions.json'

// The people of the world: planned from the random generator alone (pure), then written to the database in bulk. They are legacy rows (no Clerk id), as the first seed made them: to sign
// in as one, run `npm run db:seed:clerk` for the demo accounts. Written directly, not through a route, because there is no sign-up to run; everything they DO afterwards goes through
// the domain functions (history.ts).

/** The core people go through the domain functions. Everyone past this many is a background person, written in bulk (background.ts). */
export const CORE_PEOPLE = 400

const asciiName = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')

function chooseUsername(first: string, last: string, rng: Rng, taken: Set<string>, index: number): string {
  const f = asciiName(first)
  const l = asciiName(last)
  const forms = [`${f}${l}`, `${f}_${l}`, `${f}-${l}`, `${f}${l.slice(0, 1)}${rng.int(1, 99)}`, `${f}.${l}`.replace('.', '_'), `${l}${f.slice(0, 2)}`]
  const base = forms[rng.int(0, 2)]
  for (const candidate of [base, ...forms]) {
    const name = candidate.slice(0, 28)
    if (name.length >= 3 && !taken.has(name)) {
      taken.add(name)
      return name
    }
  }
  const fallback = `${f}${l}`.slice(0, 22) + `_${index.toString(36)}`
  taken.add(fallback)
  return fallback
}

function pickSkills(archetype: ArchetypeSeed, rng: Rng): PersonSkill[] {
  const out: PersonSkill[] = []
  const used = new Set<string>()
  const add = (slug: string, level: number) => {
    if (used.has(slug) || !SKILLS.some((skill) => skill.slug === slug)) return
    used.add(slug)
    out.push({ slug, level, years: Math.round((level * 0.9 + rng.next() * 2) * 10) / 10 })
  }
  for (const slug of rng.sample(archetype.core, rng.int(2, Math.min(4, archetype.core.length)))) add(slug, rng.int(3, 5))
  for (const slug of rng.sample(archetype.extra, rng.int(1, Math.min(3, archetype.extra.length)))) add(slug, rng.int(1, 3))
  if (rng.chance(0.25)) add(rng.pick(SKILLS).slug, rng.int(1, 3))
  return out
}

function pickActivity(rng: Rng): { activity: number; streaky: boolean } {
  const roll = rng.next()
  if (roll < 0.14) return { activity: 0.8 + rng.next() * 0.2, streaky: true } // the ones who show up every day
  if (roll < 0.4) return { activity: 0.4 + rng.next() * 0.3, streaky: false }
  if (roll < 0.8) return { activity: 0.1 + rng.next() * 0.2, streaky: false }
  return { activity: rng.next() * 0.04, streaky: false } // signed up and drifted away
}

/** Plans `count` people. Pure: the same generator and arguments give the same people. */
export function planPeople(rng: Rng, count: number, now: Date, historyDays: number, firstIndex = 0): Person[] {
  const taken = new Set<string>()
  const people: Person[] = []
  const cityWeights = CITIES.map((city) => [city, city.weight] as const)
  const archetypeWeights = ARCHETYPES.map((archetype) => [archetype, archetype.weight] as const)
  const personRng = rng.fork('people')
  for (let i = 0; i < count; i++) {
    const index = firstIndex + i
    const r = personRng.fork(`p${index}`)
    const city: CitySeed = r.weighted(cityWeights)
    const archetype = r.weighted(archetypeWeights)
    const pool = NAME_POOLS[city.names]
    const first = r.pick(pool.first)
    const last = r.pick(pool.last)
    const isMinor = index < CORE_PEOPLE && r.chance(0.03)
    const age = isMinor ? r.int(16, 17) : r.chance(0.7) ? r.int(20, 32) : r.int(33, 52)
    // Accounts are at least 12 days old, so the oldest of them has been here the whole history and more; more people joined recently.
    const accountDays = Math.min(historyDays + 120, 12 + Math.floor(-Math.log(1 - r.next() * 0.995) * (historyDays * 0.8)))
    const createdAt = new Date(now.getTime() - accountDays * DAY_MS - r.int(0, 23) * 3_600_000)
    // Exactly `age` years old or up to a day short of the next birthday: a 16-year-old is never 15 and a 17-year-old never 18.
    const birthDate = new Date(Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), now.getUTCDate()) - r.int(0, 364) * DAY_MS)
    const username = chooseUsername(first, last, r, taken, index)
    const skills = pickSkills(archetype, r)
    const { activity, streaky } = pickActivity(r)
    const types: string[] = []
    if (r.chance(0.6)) types.push('HACKATHON_TEAMMATE')
    if (r.chance(0.55)) types.push('COLLABORATOR')
    if (r.chance(0.4)) types.push('COFOUNDER')
    if (skills.some((skill) => skill.level >= 5) && r.chance(0.2)) types.push('MENTOR')
    if (skills.every((skill) => skill.level <= 3) && r.chance(0.45)) types.push('MENTEE')
    if (types.length === 0) types.push('HACKATHON_TEAMMATE')
    const workingStyle: Record<string, string> = {}
    for (const question of WORKING_STYLE_QUIZ) if (r.chance(0.85)) workingStyle[question.id] = r.pick(question.options).id
    const hasCampus = !isMinor && city.campuses.length > 0 && r.chance(0.38)
    people.push({
      index,
      id: personId(index),
      tier: index < CORE_PEOPLE ? 'core' : 'background',
      email: `u${index}@${SEED_DOMAIN}`,
      username,
      name: `${first} ${last}`,
      city,
      archetype,
      skills,
      birthDate,
      isMinor,
      createdAt,
      activity,
      streaky,
      github: r.chance(0.72) ? `${username.replace(/[^a-z0-9]/g, '')}-${index.toString(36)}` : null,
      phone: r.chance(0.35),
      campusSlug: hasCampus ? r.pick(city.campuses).slug : null,
      headline: r.pick(archetype.headlines),
      bio: `${r.pick(BIO_OPENERS)} ${r.pick(BIO_CLOSERS)}`,
      plan: r.chance(0.08) ? 'PRO' : 'FREE',
      dropTime: `0${r.int(7, 9)}:${r.pick(['00', '15', '30', '45'])}`,
      connectionTypes: [...new Set(types)],
      intentTags: r.sample(KNOWN_INTENTS, r.int(1, 3)).map((intent) => ({ tag: intent.tag })),
      lookingForSkills: r.sample(archetype.seeks, r.int(1, archetype.seeks.length)),
      workingStyle,
      hoursPerWeek: r.pick([5, 8, 10, 12, 15, 20, 25, 30, 40]),
    })
  }
  return people
}

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Writes the people and everything that is part of being one: profile, matching profile, skills, consent to the terms. Bulk, in batches. */
export async function writePeople(ctx: Ctx, people: readonly Person[]): Promise<void> {
  const { db } = ctx
  for (const batch of chunks(people, 500)) {
    // No skipDuplicates here: a clash of username, e-mail or GitHub name must stop the run, not leave a person without a profile.
    await db.user.createMany({
      data: batch.map((p) => ({
        id: p.id,
        email: p.email,
        username: p.username,
        usernameSkeleton: skeleton(p.username),
        name: p.name,
        headline: p.headline,
        bio: p.bio,
        builderRole: p.archetype.role,
        location: p.isMinor ? null : `${p.city.city}, ${p.city.country}`,
        timezone: p.city.timezone,
        availability: p.hoursPerWeek >= 20 ? 'Full-time on side projects' : 'Evenings and weekends',
        isEmailVerified: true,
        emailVerified: p.createdAt,
        isPhoneVerified: p.phone,
        githubConnected: p.github !== null,
        githubUsername: p.github,
        verificationLevel: p.github ? 'GITHUB' : p.phone ? 'PHONE' : 'EMAIL',
        birthDate: p.birthDate,
        createdAt: p.createdAt,
        lastActiveAt: p.createdAt,
      })),
    })
    await db.profile.createMany({
      skipDuplicates: true,
      data: batch.map((p) => ({
        userId: p.id,
        headline: p.headline,
        bio: p.bio,
        builderRole: p.archetype.role,
        timezone: p.city.timezone,
        location: p.isMinor ? null : `${p.city.city}, ${p.city.country}`,
        countryCode: p.city.countryCode,
        city: p.isMinor ? null : p.city.city,
        cityKey: p.isMinor ? null : p.city.cityKey,
        githubUrl: p.github ? `https://github.com/${p.github}` : null,
        // Under 18 at any point: the cards are off until the person turns them on (docs/PRIVACY.md).
        showCardsOnWeb: !p.isMinor,
        createdAt: p.createdAt,
      })),
    })
    await db.matchingProfile.createMany({
      skipDuplicates: true,
      data: batch.map((p) => ({
        userId: p.id,
        connectionTypes: p.connectionTypes as Prisma.MatchingProfileCreateManyInput['connectionTypes'],
        intentTags: p.intentTags as Prisma.InputJsonValue,
        hoursPerWeek: p.hoursPerWeek,
        remoteOk: true,
        cityOnly: false,
        lookingForSkills: p.lookingForSkills,
        workingStyle: p.workingStyle as Prisma.InputJsonValue,
        dropTimeLocal: p.dropTime,
        createdAt: p.createdAt,
      })),
    })
    await db.userSkill.createMany({
      skipDuplicates: true,
      data: batch.flatMap((p) =>
        p.skills
          .filter((skill) => ctx.skillIds.has(skill.slug))
          .map((skill) => ({ userId: p.id, skillId: ctx.skillIds.get(skill.slug)!, level: skill.level, yearsExperience: skill.years, isVerified: skill.level >= 4 && p.github !== null, createdAt: p.createdAt }))
      ),
    })
    await db.consentRecord.createMany({
      skipDuplicates: true,
      data: batch.flatMap((p) =>
        (['TERMS', 'PRIVACY'] as const).map((type) => ({ id: `${ID_PREFIX}c_${p.index}_${type}`, userId: p.id, type, version: legalVersions[type], source: 'onboarding', grantedAt: p.createdAt }))
      ),
    })
  }
}

/** The people of the world as the simulation keeps them. */
export function register(ctx: Ctx, people: readonly Person[]): void {
  for (const person of people) {
    ctx.people.push(person)
    ctx.byId.set(person.id, person)
    ctx.state.set(person.id, { projects: [], evidence: [], posts: [], lastActiveDay: null })
  }
}

/** The demo domain, for accounts made by `seed:demo`; exported here so the two places that name the domains agree. */
export const demoEmail = (username: string) => `${username}@${DEMO_DOMAIN}`
