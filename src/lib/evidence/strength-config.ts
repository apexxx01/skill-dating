import { z } from 'zod'

// Every weight and threshold of the evidence engine, in one place (docs/PROOF.md is the readable version). The defaults are here; the ones an operator may
// tune without a deploy are PlatformSettings (src/lib/settings.ts: evidence.strength, evidence.freshness, evidence.github-budget), audited like the rest.

/** One component of the strength score: `scale * f(count)` points, at most `cap`. f is a square root unless the component says otherwise. */
export interface Component {
  scale: number
  cap: number
}

export interface StrengthConfig {
  /** Commits a day that count in full; beyond it a day's commits count as the square root of the rest (burst dampening). */
  burstPerDay: number
  /** What a commit of each kind is worth relative to new code. */
  kindWeights: { code: number; modification: number; tests: number; docs: number; trivial: number }
  /** The kind mix assumed when no commit's files could be looked at. */
  unsampledKindWeight: number
  components: {
    /** Authored work: sqrt of the weighted, dampened commit count. */
    work: Component
    /** Active days: sqrt. */
    days: Component
    /** First to last authored commit: log2(1 + weeks). */
    span: Component
    /** Commits that touched tests: sqrt. */
    tests: Component
    /** Pull requests in the repository merged by someone else: sqrt. */
    mergedByOthers: Component
    /** Pull requests the person merged themselves: sqrt. Worth least. */
    selfMerged: Component
    /** Reviews of other people's pull requests: sqrt. */
    reviews: Component
    /** Releases published: sqrt. */
    releases: Component
    /** Stars: log10(1 + stars). A weak signal only. */
    stars: Component
  }
  /** A first commit holding at least this share of the added lines, with at most `maxCommits` commits in all, is an import. */
  importHeuristic: { share: number; maxCommits: number; factor: number }
  /** A small genuine project (at least `minCommits` non-trivial commits over at least `minDays` days) never scores below `score`. */
  beginnerFloor: { score: number; minCommits: number; minDays: number }
  /** An external pull request merged by another maintainer, as its own evidence: a fixed score. */
  externalPullScore: number
}

export const DEFAULT_STRENGTH_CONFIG: StrengthConfig = {
  burstPerDay: 4,
  kindWeights: { code: 1, modification: 0.8, tests: 1, docs: 0.3, trivial: 0.05 },
  unsampledKindWeight: 0.7,
  components: {
    work: { scale: 6, cap: 35 },
    days: { scale: 4, cap: 20 },
    span: { scale: 2, cap: 10 },
    tests: { scale: 1.5, cap: 5 },
    mergedByOthers: { scale: 5, cap: 15 },
    selfMerged: { scale: 1, cap: 3 },
    reviews: { scale: 2, cap: 8 },
    releases: { scale: 1.5, cap: 5 },
    stars: { scale: 1, cap: 2 },
  },
  importHeuristic: { share: 0.8, maxCommits: 5, factor: 0.25 },
  beginnerFloor: { score: 20, minCommits: 3, minDays: 2 },
  externalPullScore: 30,
}

/** The part of the strength model an operator may tune (PlatformSetting evidence.strength). Everything else is the defaults above. */
export const strengthSettingSchema = z
  .object({
    burstPerDay: z.number().int().min(1).max(50),
    kindWeights: z.object({ code: z.number().min(0).max(2), modification: z.number().min(0).max(2), tests: z.number().min(0).max(2), docs: z.number().min(0).max(2), trivial: z.number().min(0).max(1) }).strict(),
    importFactor: z.number().min(0).max(1),
    beginnerFloor: z.object({ score: z.number().int().min(0).max(50), minCommits: z.number().int().min(1).max(50), minDays: z.number().int().min(1).max(30) }).strict(),
  })
  .strict()

export type StrengthSetting = z.infer<typeof strengthSettingSchema>

export const DEFAULT_STRENGTH_SETTING: StrengthSetting = {
  burstPerDay: DEFAULT_STRENGTH_CONFIG.burstPerDay,
  kindWeights: DEFAULT_STRENGTH_CONFIG.kindWeights,
  importFactor: DEFAULT_STRENGTH_CONFIG.importHeuristic.factor,
  beginnerFloor: DEFAULT_STRENGTH_CONFIG.beginnerFloor,
}

export function strengthConfigFrom(setting: StrengthSetting): StrengthConfig {
  return {
    ...DEFAULT_STRENGTH_CONFIG,
    burstPerDay: setting.burstPerDay,
    kindWeights: setting.kindWeights,
    importHeuristic: { ...DEFAULT_STRENGTH_CONFIG.importHeuristic, factor: setting.importFactor },
    beginnerFloor: setting.beginnerFloor,
  }
}

/** Skill freshness (freshness.ts): the half-life of the decay and where the labels change. */
export const freshnessSettingSchema = z
  .object({
    halfLifeMonths: z.number().min(1).max(120),
    // A label is the first whose threshold the freshness (1 when just evidenced, 0.5 after one half-life) reaches.
    activeAtLeast: z.number().min(0).max(1),
    warmAtLeast: z.number().min(0).max(1),
  })
  .strict()
  .refine((value) => value.activeAtLeast > value.warmAtLeast, 'ACTIVE must need more than WARM')

export type FreshnessSetting = z.infer<typeof freshnessSettingSchema>

// 0.68 is about 10 months at an 18 month half-life; 0.3 about 31 months.
export const DEFAULT_FRESHNESS: FreshnessSetting = { halfLifeMonths: 18, activeAtLeast: 0.68, warmAtLeast: 0.3 }

/** How much one sync may ask of GitHub (sync.ts). Anonymous runs get their own, smaller, per-sync budget: GitHub allows 60 unauthenticated calls an hour per address. */
export const budgetSettingSchema = z
  .object({
    reposPerSync: z.number().int().min(1).max(50),
    recentRepos: z.number().int().min(0).max(30),
    callsPerSync: z.number().int().min(10).max(2000),
    anonymousCallsPerSync: z.number().int().min(5).max(60),
    callsPerDay: z.number().int().min(10).max(5000),
    commitPages: z.number().int().min(1).max(10),
    sampledCommits: z.number().int().min(0).max(50),
    pullDetails: z.number().int().min(0).max(30),
    externalPulls: z.number().int().min(0).max(20),
  })
  .strict()

export type BudgetSetting = z.infer<typeof budgetSettingSchema>

export const DEFAULT_BUDGET: BudgetSetting = {
  reposPerSync: 10,
  recentRepos: 6,
  callsPerSync: 200,
  anonymousCallsPerSync: 40,
  callsPerDay: 600,
  commitPages: 3,
  sampledCommits: 8,
  pullDetails: 8,
  externalPulls: 5,
}
