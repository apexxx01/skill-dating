import type { PrismaClient } from '@prisma/client'
import type { ArchetypeSeed, CitySeed } from './catalog'
import type { SeedArgs } from './args'
import type { Rng } from './rng'

export const SEED_DOMAIN = 'seed.skilldating.test'
export const DEMO_DOMAIN = 'demo.skilldating.test'
/** Everything the seed makes has an id with this prefix, so it can be found and removed without touching anybody else's rows. */
export const ID_PREFIX = 'sd_'
export const DAY_MS = 24 * 60 * 60 * 1000
export const HOUR_MS = 60 * 60 * 1000

export const personId = (index: number) => `${ID_PREFIX}u${index}`

export type Tier = 'core' | 'background'

export interface PersonSkill {
  slug: string
  level: number
  years: number
}

export interface Person {
  index: number
  id: string
  tier: Tier
  email: string
  username: string
  name: string
  city: CitySeed
  archetype: ArchetypeSeed
  skills: PersonSkill[]
  birthDate: Date
  isMinor: boolean
  createdAt: Date
  /** 0 to 1: how often they show up. 0 is somebody who signed up and left. */
  activity: number
  /** Keeps a streak going. */
  streaky: boolean
  github: string | null
  phone: boolean
  campusSlug: string | null
  headline: string
  bio: string
  plan: 'FREE' | 'PRO'
  dropTime: string
  connectionTypes: string[]
  intentTags: { tag: string }[]
  lookingForSkills: string[]
  workingStyle: Record<string, string>
  hoursPerWeek: number
}

/** What the simulation remembers about one person while it runs. */
export interface PersonState {
  projects: { id: string; name: string; status: string; milestones: string[]; shipped: boolean; updates: number }[]
  evidence: { id: string; skillId: string; slug: string }[]
  posts: string[]
  lastActiveDay: string | null
}

export interface Ctx {
  db: PrismaClient
  rng: Rng
  args: SeedArgs
  /** The real moment the run started: "today". */
  now: Date
  /** The first day of the history. */
  start: Date
  log: (message: string) => void
  people: Person[]
  byId: Map<string, Person>
  state: Map<string, PersonState>
  skillIds: Map<string, string>
  campusIds: Map<string, string>
  /** Hackathons made by the world, for the phases that follow. */
  hackathons: HackathonRecord[]
}

export interface HackathonRecord {
  id: string
  slug: string
  name: string
  kind: 'NATIVE' | 'EXTERNAL'
  phase: 'PAST' | 'LIVE' | 'UPCOMING'
  startDate: Date
  endDate: Date
  registrationDeadline: Date
  maxTeamSize: number
  city: CitySeed | null
}
