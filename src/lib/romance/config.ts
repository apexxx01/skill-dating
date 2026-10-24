// The romance mode ("builder-first dating"): its name, its vocabulary and its numbers, in one place. The documentation is docs/ROMANCE.md.
//
// The product name is not final. EVERY label a person reads comes from ROMANCE_MODE_LABEL, and everything else (code, routes, tables of the
// new model, analytics events, docs) says "romance", so renaming the mode later is this one constant. The storage key of the old model stays
// `DATING` (the MatchType and ConnectionType enum value, and the `Match` rows made with it): it is never shown to anybody.

import { ROMANCE_PHOTO_LIMITS } from '@/lib/media'

export const ROMANCE_MODE_LABEL = 'Halves'

/** The answers a person can give about what they build and who they are. Stored as these strings; the labels are for the interface. */
export const AMBITION_LEVELS = [
  { value: 1, key: 'side-projects', label: 'Building on the side' },
  { value: 2, key: 'steady', label: 'Steady and serious' },
  { value: 3, key: 'driven', label: 'Driven' },
  { value: 4, key: 'all-in', label: 'All in' },
] as const

export const LIFE_DIRECTIONS = ['founder', 'craft', 'research', 'steady-career', 'nomad', 'open'] as const
export type LifeDirection = (typeof LIFE_DIRECTIONS)[number]

export const DIRECTION_LABELS: Record<LifeDirection, string> = {
  founder: 'Starting something of my own',
  craft: 'Getting really good at the craft',
  research: 'Pushing research forward',
  'steady-career': 'A steady career I am proud of',
  nomad: 'Moving around and building as I go',
  open: 'Still figuring it out',
}

export const WORKING_RHYTHMS = ['night-owl', 'early-bird', 'bursty', 'steady'] as const
export type WorkingRhythm = (typeof WORKING_RHYTHMS)[number]

export const RHYTHM_LABELS: Record<WorkingRhythm, string> = {
  'night-owl': 'Night owl',
  'early-bird': 'Early bird',
  bursty: 'In bursts',
  steady: 'Steady through the day',
}

/** How a rhythm is said in a sentence about two people ("You are both night-owl builders ..."). */
export const RHYTHM_PHRASE: Record<WorkingRhythm, string> = {
  'night-owl': 'night-owl',
  'early-bird': 'early-bird',
  bursty: 'bursty',
  steady: 'steady-paced',
}

/** The fixed list. SELF_DESCRIBED comes with the person's own words (`genderSelfDescribe`); it is also what "interested in" uses for them. */
export const GENDERS = ['WOMAN', 'MAN', 'NON_BINARY', 'SELF_DESCRIBED'] as const
export type Gender = (typeof GENDERS)[number]

export const GENDER_LABELS: Record<Gender, string> = { WOMAN: 'Woman', MAN: 'Man', NON_BINARY: 'Non-binary', SELF_DESCRIBED: 'In my own words' }

export const SCOPES = ['CITY', 'COUNTRY', 'ANYWHERE'] as const
export type Scope = (typeof SCOPES)[number]

export const SCOPE_LABELS: Record<Scope, string> = { CITY: 'My city', COUNTRY: 'My country', ANYWHERE: 'Anywhere' }

export const ROMANCE_CONFIG = {
  prompts: { minLength: 20, maxLength: 500 },
  obsessions: { max: 12, minLength: 2, maxLength: 40 },
  genderSelfDescribeMax: 40,
  /** The age range somebody accepts is never below this: the 18+ gate applies to the filters too. */
  minAge: 18,
  maxAge: 99,
  /** "Only people endorsed by at least N builders can spark me": N is 0 to this. */
  maxInboxEndorsements: 5,
  photos: ROMANCE_PHOTO_LIMITS,
  drop: {
    /** A person is given their drop for a local ISO week (Monday to Sunday) from this local time on the Monday, and until the week ends; someone who opts in midweek is given theirs at the next run. */
    weekdayLocal: 1,
    timeLocal: '08:00',
    /** A candidate scoring under this is not worth the one drop of the week. */
    minScore: 35,
    candidatePool: 200,
    activeWithinDays: 60,
    /** The most people one person can be shown to in a week (popular people are not shown to everyone). */
    exposureCapPerWeek: 25,
    /** Nobody is shown to the same viewer again within this many days. */
    repeatCooldownDays: 120,
    /** People per `romance/drops-batch` job (the weekly run is fanned out like the daily one: docs/MATCHING.md). */
    userBatch: 250,
    /** Candidates scored per query. */
    scoreBatch: 200,
  },
} as const

/** What the mode is called in a sentence a person reads. Only ever built from the label constant. */
export const romanceCopy = {
  modeName: ROMANCE_MODE_LABEL,
  sparkedYou: (count: number) => `${count} ${count === 1 ? 'person' : 'people'} sparked you in ${ROMANCE_MODE_LABEL}`,
  sparkedYouBy: (name: string) => `${name} sparked you in ${ROMANCE_MODE_LABEL}`,
  newDrop: `Your ${ROMANCE_MODE_LABEL} pick for the week is here`,
  matchTitle: `It is a ${ROMANCE_MODE_LABEL} match`,
  revealAsked: (name: string) => `${name} would like to share photos`,
  revealAccepted: (name: string) => `${name} agreed to share photos`,
  /** The one note to people who asked to be told when the mode opens (src/lib/romance/announce.ts). */
  opened: {
    title: `${ROMANCE_MODE_LABEL} is open for you`,
    message: 'You asked us to tell you. It is optional, private and for people who are 18 or older: you choose what to share, and nothing about it appears anywhere else in the app.',
  },
  duoAsked: (name: string) => `${name} invited you to a Duo`,
  duoAccepted: (name: string) => `${name} accepted your Duo`,
} as const

/** The vocabulary of the profile form, for the interface to draw it from one place. Labels describe the answers; the mode's own name is ROMANCE_MODE_LABEL. */
export const ROMANCE_OPTIONS = {
  ambition: AMBITION_LEVELS.map(({ value, label }) => ({ value, label })),
  direction: LIFE_DIRECTIONS.map((value) => ({ value, label: DIRECTION_LABELS[value] })),
  rhythm: WORKING_RHYTHMS.map((value) => ({ value, label: RHYTHM_LABELS[value] })),
  gender: GENDERS.map((value) => ({ value, label: GENDER_LABELS[value] })),
  scope: SCOPES.map((value) => ({ value, label: SCOPE_LABELS[value] })),
  limits: {
    promptMinLength: ROMANCE_CONFIG.prompts.minLength,
    promptMaxLength: ROMANCE_CONFIG.prompts.maxLength,
    maxObsessions: ROMANCE_CONFIG.obsessions.max,
    minAge: ROMANCE_CONFIG.minAge,
    maxAge: ROMANCE_CONFIG.maxAge,
    maxInboxEndorsements: ROMANCE_CONFIG.maxInboxEndorsements,
    maxPhotos: ROMANCE_CONFIG.photos.max,
  },
} as const
