import { randomUUID } from 'crypto'
import type { MatchType, Prisma } from '@prisma/client'
import { testPrisma } from './db'

// People for the matching tests, written straight into the database: they never sign in, so they cost no Clerk account, and a test can have
// dozens. They are established (a week old, verified email, recently active) unless a test says otherwise.

const DAY_MS = 24 * 60 * 60 * 1000

export interface FixtureUser {
  id: string
  username: string
}

export interface FixtureOptions {
  tag: string
  types?: MatchType[]
  /** false: no matching profile at all. */
  profile?: boolean
  paused?: boolean
  cityOnly?: boolean
  cityKey?: string | null
  lookingForSkills?: string[]
  /** [slug, level][] */
  skills?: [string, number][]
  hoursPerWeek?: number | null
  timezone?: string | null
  dropTimeLocal?: string
  ageDays?: number
  emailVerified?: boolean
  phone?: boolean
  github?: boolean
  birthDate?: string | null
  lastActiveDaysAgo?: number
  deleted?: boolean
  xp?: number
  intentTags?: Prisma.InputJsonValue
  workingStyle?: Prisma.InputJsonValue
  techStack?: string[]
  lastDropDate?: string | null
}

let counter = 0

export async function makePerson(options: FixtureOptions): Promise<FixtureUser> {
  const n = counter++
  const username = `${options.tag}${n}`.toLowerCase()
  const user = await testPrisma.user.create({
    data: {
      email: `${username}.${randomUUID().slice(0, 6)}@test.dev`,
      username,
      name: `Person ${n}`,
      isEmailVerified: options.emailVerified ?? true,
      isPhoneVerified: options.phone ?? false,
      githubConnected: options.github ?? false,
      createdAt: new Date(Date.now() - (options.ageDays ?? 30) * DAY_MS),
      lastActiveAt: new Date(Date.now() - (options.lastActiveDaysAgo ?? 0) * DAY_MS),
      timezone: options.timezone ?? null,
      xp: options.xp ?? 0,
      deletedAt: options.deleted ? new Date() : null,
      birthDate: options.birthDate ? new Date(`${options.birthDate}T00:00:00Z`) : null,
    },
  })
  if (options.profile !== false) {
    await testPrisma.matchingProfile.create({
      data: {
        userId: user.id,
        connectionTypes: options.types ?? ['COFOUNDER'],
        paused: options.paused ?? false,
        cityOnly: options.cityOnly ?? false,
        lookingForSkills: options.lookingForSkills ?? [],
        hoursPerWeek: options.hoursPerWeek ?? null,
        dropTimeLocal: options.dropTimeLocal ?? '00:00',
        intentTags: options.intentTags ?? [],
        workingStyle: options.workingStyle ?? {},
        lastDropDate: options.lastDropDate ?? null,
      },
    })
  }
  if (options.cityKey) await testPrisma.profile.create({ data: { userId: user.id, cityKey: options.cityKey, city: options.cityKey } })
  for (const [slug, level] of options.skills ?? []) {
    const skill = await testPrisma.skill.findUniqueOrThrow({ where: { slug } })
    await testPrisma.userSkill.create({ data: { userId: user.id, skillId: skill.id, level } })
  }
  if (options.techStack) await testPrisma.currentBuild.create({ data: { userId: user.id, title: 'Build', techStack: options.techStack } })
  return { id: user.id, username }
}

/** Skills the fixtures can use; returns their slugs. */
export async function makeSkills(tag: string, names: string[]): Promise<string[]> {
  const slugs: string[] = []
  for (const name of names) {
    const slug = `${tag}-${name}`
    await testPrisma.skill.upsert({ where: { slug }, create: { name: slug, slug, category: `Cat-${name}` }, update: {} })
    slugs.push(slug)
  }
  return slugs
}

export async function removePeople(tag: string) {
  await testPrisma.user.deleteMany({ where: { username: { startsWith: tag.toLowerCase() } } })
}

export const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS)

/** A date of birth that makes someone `years` old (plus `extraDays`) today. */
export function bornYearsAgo(years: number, extraDays = 0): string {
  const now = new Date()
  const date = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()))
  return new Date(date.getTime() - extraDays * DAY_MS).toISOString().slice(0, 10)
}

const OPENER_WORDS = [
  'compiler', 'parser', 'graph', 'database', 'offline', 'sync', 'payments', 'robotics', 'firmware', 'climate', 'mapping', 'finals',
  'prototype', 'weekend', 'design', 'review', 'architecture', 'embedded', 'replication', 'kubernetes', 'tracing', 'latency', 'billing',
  'rendering', 'shaders', 'physics', 'audio', 'streaming', 'search', 'ranking', 'tokenizer', 'checkout', 'inventory', 'logistics',
  'drone', 'sensor', 'dashboard', 'onboarding', 'analytics', 'migration', 'sandbox', 'plugin', 'protocol', 'encryption', 'identity',
  'pipeline', 'scheduler', 'allocator', 'garbage', 'collector', 'bytecode', 'interpreter', 'typechecker', 'linter', 'formatter', 'editor',
  'keyboard', 'terminal', 'browser', 'extension', 'mobile', 'wearable', 'satellite', 'telescope', 'genome', 'protein', 'battery', 'solar',
]
let openerCounter = 0

/** A different, believable opener every time: eight words that never repeat inside a run, so no two are taken for the same message. */
export function nextOpener(): string {
  const n = openerCounter++
  const w = (k: number) => OPENER_WORDS[(n * 8 + k) % OPENER_WORDS.length]
  return `Your ${w(0)} ${w(1)} work caught my eye, and I am stuck on ${w(2)} ${w(3)} in my own build. Could we try a ${w(4)} ${w(5)} ${w(6)} ${w(7)} together this month?`
}
