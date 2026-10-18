import type { Prisma } from '@prisma/client'
import { testPrisma } from './db'
import { makePerson, type FixtureOptions, type FixtureUser } from './matching-fixtures'
import { bornYearsAgo } from './matching-fixtures'

// People for the romance tests, written straight into the database like the matching fixtures: an established, verified adult with a romance profile
// unless a test says otherwise. They never sign in, so they cost no Clerk account.

export interface RomanceFixtureOptions extends Omit<FixtureOptions, 'profile'> {
  /** false: no romance profile at all. */
  romance?: boolean
  gender?: 'WOMAN' | 'MAN' | 'NON_BINARY' | 'SELF_DESCRIBED'
  interestedIn?: ('WOMAN' | 'MAN' | 'NON_BINARY' | 'SELF_DESCRIBED')[]
  age?: number
  ageMin?: number
  ageMax?: number
  scope?: 'CITY' | 'COUNTRY' | 'ANYWHERE'
  countryCode?: string | null
  minEndorsements?: number
  paused?: boolean
  ambition?: number
  direction?: string
  rhythm?: string
  obsessions?: string[]
}

export async function makeRomancePerson(options: RomanceFixtureOptions & { tag: string }): Promise<FixtureUser> {
  const age = options.age ?? 30
  const person = await makePerson({
    ...options,
    profile: false,
    birthDate: options.birthDate === undefined ? bornYearsAgo(age, 100) : options.birthDate,
    phone: options.phone ?? true,
  })
  if (options.cityKey || options.countryCode) {
    // makePerson made a Profile when it was given a city; give it the country too.
    await testPrisma.profile.upsert({
      where: { userId: person.id },
      create: { userId: person.id, cityKey: options.cityKey ?? null, city: options.cityKey ?? null, countryCode: options.countryCode ?? null },
      update: { countryCode: options.countryCode ?? null },
    })
  }
  if (options.romance !== false) {
    await testPrisma.romanceProfile.create({
      data: {
        userId: person.id,
        promptObsessed: `Obsessed with ${options.obsessions?.[0] ?? 'compilers'} and the people who make them.`,
        promptBuild: 'A small tool that I would use every day, built with someone patient.',
        promptWeekend: 'Ship something small together on Saturday, eat well on Sunday.',
        ambition: options.ambition ?? 3,
        direction: options.direction ?? 'founder',
        rhythm: options.rhythm ?? 'night-owl',
        obsessions: options.obsessions ?? ['compilers'],
        gender: options.gender ?? 'WOMAN',
        interestedIn: options.interestedIn ?? ['MAN'],
        ageMin: options.ageMin ?? 18,
        ageMax: options.ageMax ?? 99,
        scope: options.scope ?? 'ANYWHERE',
        minEndorsements: options.minEndorsements ?? 0,
        paused: options.paused ?? false,
      },
    })
  }
  return person
}

/** Gives a person `count` trusted endorsers (accounts a month old with a verified email), the way the inbox gate and the character score count them. */
export async function giveEndorsers(tag: string, userId: string, count: number): Promise<void> {
  const skill = await testPrisma.skill.upsert({ where: { slug: `${tag}-endorsed` }, create: { name: `${tag}-endorsed`, slug: `${tag}-endorsed`, category: 'Test' }, update: {} })
  for (let i = 0; i < count; i++) {
    const endorser = await makePerson({ tag: `${tag}endorser`, profile: false })
    const data: Prisma.SkillEvidenceUncheckedCreateInput = {
      userId,
      skillId: skill.id,
      type: 'PEER_ENDORSEMENT',
      title: 'Peer endorsement',
      metadata: { endorsedEvidenceId: `${tag}-evidence-${i}`, endorserId: endorser.id },
    }
    await testPrisma.skillEvidence.create({ data })
  }
}
