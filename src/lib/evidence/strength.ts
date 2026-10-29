import type { ExternalPullFacts, RepoFacts } from './facts'
import { DEFAULT_STRENGTH_CONFIG, type Component, type StrengthConfig } from './strength-config'

// Evidence strength: how much one repository's history shows the person's own work, from 0 to 100, with an explanation a screen can show. Pure and
// deterministic: the same facts and config always give the same score. The model and the attack-and-counter table are in docs/PROOF.md.
//
//   every component   diminishing returns (a square root, or a logarithm) and a cap, so no single number can carry the score;
//   bursts            a day's commits beyond `burstPerDay` count as log2 of the rest, and authored work is also capped by the number of active days;
//   trivial changes   lockfiles, generated, vendored and minified files and whitespace-only edits weigh 0.05 of new code, and do not count as active days;
//   imports           a first commit holding most of the code, with little history after it, counts a quarter;
//   forks, templates  only commits after the fork point (or after the template's initial commit) count at all;
//   pull requests     merged by another maintainer weigh most; merged by the person themselves, least;
//   co-authors        a commit with N co-author trailers counts 1/(N+1);
//   stars             at most 2 points;
//   the floor         a small but genuine project (a few non-trivial commits over a few days) never reads lower than the beginner floor.
// Strength never changes XP. It feeds the passport, the weight of skill evidence and (from Stage 1L) matching.

export interface StrengthComponent {
  key: keyof StrengthConfig['components']
  points: number
  max: number
}

export interface StrengthResult {
  score: number
  components: StrengthComponent[]
  /** Sentences for a screen, the counts first. */
  reasons: string[]
  flags: { forkWithoutWork: boolean; template: boolean; import: boolean; burst: boolean; trivial: boolean; floor: boolean }
}

const DAY_MS = 24 * 60 * 60 * 1000
const round1 = (value: number) => Math.round(value * 10) / 10
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function capped(component: Component, value: number): number {
  return Math.min(component.cap, Math.max(0, component.scale * value))
}

/** A day's commits after burst dampening. */
export function dampenDay(commits: number, burstPerDay: number): number {
  return commits <= burstPerDay ? commits : burstPerDay + Math.log2(1 + commits - burstPerDay)
}

export function repoStrength(facts: RepoFacts, config: StrengthConfig = DEFAULT_STRENGTH_CONFIG): StrengthResult {
  const c = config.components
  const commits = facts.commits
  const authored = Math.max(0, commits.authored)

  // Forks and templates: only what came after the origin.
  const originBound = facts.repo.fork || facts.repo.template
  const originFactor = authored === 0 ? 0 : originBound ? Math.min(1, Math.max(0, commits.afterOrigin) / authored) : 1
  const coauthorFactor = authored === 0 ? 0 : Math.min(1, Math.max(0, commits.credit) / authored)

  // What kind of work, from the commits whose files were looked at.
  const sampled = Math.max(0, commits.sampled)
  const w = config.kindWeights
  const kindFactor =
    sampled === 0
      ? config.unsampledKindWeight
      : (commits.kinds.code * w.code + commits.kinds.modification * w.modification + commits.kinds.tests * w.tests + commits.kinds.docs * w.docs + commits.kinds.trivial * w.trivial) / sampled
  const realShare = sampled === 0 ? 1 : 1 - commits.kinds.trivial / sampled

  // Burst dampening over the days on record, scaled to every authored commit when the record holds fewer.
  const recorded = commits.days.reduce((sum, [, n]) => sum + n, 0)
  const dampenedRecorded = commits.days.reduce((sum, [, n]) => sum + dampenDay(n, config.burstPerDay), 0)
  const dampened = recorded === 0 ? 0 : dampenedRecorded * (authored / recorded)
  const burst = recorded > 0 && dampenedRecorded < 0.8 * recorded

  const activeDays = commits.days.length * originFactor * realShare
  const weighted = dampened * originFactor * coauthorFactor * kindFactor

  const isImport = authored > 0 && authored <= config.importHeuristic.maxCommits && commits.firstCommitShare >= config.importHeuristic.share
  let work = Math.min(capped(c.work, Math.sqrt(weighted)), c.work.scale * activeDays)
  if (isImport) work *= config.importHeuristic.factor

  const spanWeeks = commits.first && commits.last ? Math.max(0, new Date(commits.last).getTime() - new Date(commits.first).getTime()) / (7 * DAY_MS) : 0
  const testCommits = sampled === 0 ? 0 : (commits.kinds.tests / sampled) * authored * originFactor

  const components: StrengthComponent[] = [
    { key: 'work', points: work, max: c.work.cap },
    { key: 'days', points: capped(c.days, Math.sqrt(activeDays)), max: c.days.cap },
    { key: 'span', points: originFactor * realShare > 0 ? capped(c.span, Math.log2(1 + spanWeeks)) : 0, max: c.span.cap },
    { key: 'tests', points: capped(c.tests, Math.sqrt(testCommits)), max: c.tests.cap },
    { key: 'mergedByOthers', points: capped(c.mergedByOthers, Math.sqrt(facts.pulls.mergedByOthers)), max: c.mergedByOthers.cap },
    { key: 'selfMerged', points: capped(c.selfMerged, Math.sqrt(facts.pulls.selfMerged)), max: c.selfMerged.cap },
    { key: 'reviews', points: capped(c.reviews, Math.sqrt(facts.reviews)), max: c.reviews.cap },
    { key: 'releases', points: capped(c.releases, Math.sqrt(facts.releases)), max: c.releases.cap },
    { key: 'stars', points: capped(c.stars, Math.log10(1 + Math.max(0, facts.repo.stars))), max: c.stars.cap },
  ].map((component) => ({ ...component, points: round1(component.points) })) as StrengthComponent[]

  let score = Math.min(100, Math.round(components.reduce((sum, component) => sum + component.points, 0)))

  const nonTrivialCommits = authored * originFactor * realShare
  const floor = config.beginnerFloor
  const genuine = !isImport && nonTrivialCommits >= floor.minCommits && commits.days.length * originFactor * realShare >= floor.minDays
  const floored = genuine && score < floor.score
  if (floored) score = floor.score

  const forkWithoutWork = facts.repo.fork && Math.max(0, commits.afterOrigin) === 0
  const trivial = sampled > 0 && realShare < 0.25

  const reasons: string[] = []
  const counted = [`${plural(authored, 'authored commit')} over ${plural(commits.days.length, 'active day')}`]
  if (facts.pulls.mergedByOthers > 0) counted.push(`${plural(facts.pulls.mergedByOthers, 'PR')} merged by other maintainers`)
  if (facts.reviews > 0) counted.push(plural(facts.reviews, 'review'))
  if (facts.releases > 0) counted.push(plural(facts.releases, 'release'))
  reasons.push(`Counts: ${counted.join(', ')}`)
  if (forkWithoutWork) reasons.push('A fork with no commits of yours after it was forked: authored work here counts for nothing')
  else if (facts.repo.fork) reasons.push(`A fork: only the ${plural(commits.afterOrigin, 'commit')} after the fork point count`)
  if (facts.repo.template) reasons.push(commits.afterOrigin === 0 ? 'Made from a template with nothing added after it: authored work here counts for nothing' : "Made from a template: the template's initial commit does not count")
  if (burst) reasons.push(`Dampened: commits bunched into a few days count far less than the same work spread out (${recorded} on record count as about ${Math.round(dampenedRecorded)})`)
  if (isImport) reasons.push('Most of the code arrived in one first commit with little history after it: counted as an import')
  if (trivial) reasons.push('Mostly lockfile, generated, vendored or whitespace changes: they count for very little')
  if (commits.coauthored > 0) reasons.push(`${plural(commits.coauthored, 'commit')} shared with co-authors count in part`)
  if (facts.pulls.selfMerged > 0) reasons.push(`${plural(facts.pulls.selfMerged, 'PR')} you merged yourself count for little`)
  if (facts.repo.stars > 0) reasons.push(`Stars are a weak signal: at most ${c.stars.cap} points`)
  if (floored) reasons.push('A small, genuine project: counted at the beginner floor')

  return { score, components, reasons, flags: { forkWithoutWork, template: facts.repo.template, import: isImport, burst, trivial, floor: floored } }
}

/** A pull request merged by another maintainer into a repository the person does not own: one fixed, explained score. */
export function externalPullStrength(facts: ExternalPullFacts, config: StrengthConfig = DEFAULT_STRENGTH_CONFIG): StrengthResult {
  return {
    score: config.externalPullScore,
    components: [{ key: 'mergedByOthers', points: config.externalPullScore, max: config.externalPullScore }],
    reasons: [`Counts: PR #${facts.pull.number} to ${facts.repo.fullName}, merged by another maintainer`],
    flags: { forkWithoutWork: false, template: false, import: false, burst: false, trivial: false, floor: false },
  }
}

export interface WeightInputs {
  strength: number
  support: 'SUPPORTED' | 'UNSUPPORTED' | null
  sourceWeight: number
  moderated: boolean
  integrityWeight?: number
}

/** How much a piece of engine evidence counts (0 to 1): its strength, times the source still being there, times integrity. Unsupported or moderated: 0. */
export function evidenceWeight(input: WeightInputs): number {
  if (input.support === 'UNSUPPORTED' || input.moderated) return 0
  return round1((Math.max(0, Math.min(100, input.strength)) / 100) * Math.max(0, Math.min(1, input.sourceWeight)) * Math.max(0, Math.min(1, input.integrityWeight ?? 1)) * 100) / 100
}

/** What a recheck does to the weight of evidence whose source changed or went away: lowered, never to zero, never deleted. */
export const SOURCE_WEIGHT = { VALID: 1, SOURCE_CHANGED: 0.6, SOURCE_GONE: 0.3, REVOKED: 0 } as const
