// The numbers behind daily drops, in one place. Documented in docs/MATCHING.md.
export const DROP_CONFIG = {
  /** A candidate scoring below this is not worth a drop. */
  minScore: 30,
  /** How many candidates the database hands back per type of relationship, before they are scored. */
  candidatePoolPerType: 300,
  /** Only people seen in this many days are shown: the pool is bounded by activity, not by how many accounts ever signed up. */
  activeWithinDays: 60,
  /** The most people one person can be shown to in a UTC day (fairness: popular people are not shown to everyone). */
  exposureCapPerDay: 20,
  /** Nobody is shown to the same viewer again within this many days of being shown. */
  repeatCooldownDays: 7,
  /** Somebody who was passed is left out for this many days. */
  passCooldownDays: 30,
  /** People whose drops are generated per batch. */
  userBatch: 100,
  /** Candidates scored per batch. */
  scoreBatch: 300,
} as const

/** Second look: one per person per week, and what must have grown since the pass. */
export const SECOND_LOOK_CONFIG = {
  /** A drop passed longer ago than this is too old to resurface; one passed more recently than `minPassAgeDays` is too fresh. */
  minPassAgeDays: 14,
  maxPassAgeDays: 120,
} as const
