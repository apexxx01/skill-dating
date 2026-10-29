import type { GhCommit, GhRepo, GitHubApi } from '@/lib/infra/github'
import { classifyCommit, dayHistogram, emptyKinds, FACTS_VERSION, meaningfulAdditions, type ExternalPullFacts, type RepoFacts } from './facts'
import { mainLanguages } from './skill-map'
import type { BudgetSetting } from './strength-config'

// Reading one repository's history for one person, into the minimal facts (facts.ts). Everything about the person is matched by their GitHub numeric id:
// GitHub is asked for the commits of the login the id has TODAY (so a rename changes nothing), and only commits whose author is that id are kept, so
// another account's commits under a similar name, or an email somebody else typed into a commit, never count. Every call spends from the run's budget.

export interface Person {
  githubId: string
  /** The login the id has now (from GitHub, by id). */
  login: string
}

/** A template's initial commit is made with the repository; commits within this long of its creation are the template's, not the person's. */
const TEMPLATE_GRACE_MS = 10 * 60 * 1000
/** A repository must be this old when an outside pull request into it is merged for that merge to count towards Upstream. */
export const ESTABLISHED_REPO_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export interface CollectedRepo {
  facts: RepoFacts
  /** The newest authored commit: what the receipt pins. */
  headSha: string | null
}

/** Evenly spread picks, always including the first and the last. */
export function spreadPick<T>(items: readonly T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return []
  if (items.length <= count) return [...items]
  if (count === 1) return [items[items.length - 1]]
  const step = (items.length - 1) / (count - 1)
  return [...new Set(Array.from({ length: count }, (_, i) => Math.round(i * step)))].map((index) => items[index])
}

const round2 = (value: number) => Math.round(value * 100) / 100

export async function collectRepoFacts(api: GitHubApi, repo: GhRepo, person: Person, budget: BudgetSetting): Promise<CollectedRepo> {
  const languages = mainLanguages(await api.languages(repo.fullName))
  const listed: GhCommit[] = await api.commitsBy(repo.fullName, person.login, budget.commitPages)
  // Ours by id, merge commits left out; oldest first.
  const mine = listed.filter((commit) => commit.authorId === person.githubId && commit.parents <= 1).sort((a, b) => a.authoredAt.localeCompare(b.authoredAt))

  const created = new Date(repo.createdAt).getTime()
  const afterOrigin = repo.fork
    ? mine.filter((commit) => new Date(commit.authoredAt).getTime() > created).length
    : repo.fromTemplate
      ? mine.filter((commit) => new Date(commit.authoredAt).getTime() > created + TEMPLATE_GRACE_MS).length
      : mine.length

  // What kind of work: the files of a few commits, spread over the history, the first one always among them (for the import check).
  const kinds = emptyKinds()
  let sampled = 0
  let firstAdditions = 0
  let sampledAdditions = 0
  for (const [index, commit] of spreadPick(mine, budget.sampledCommits).entries()) {
    const detail = await api.commit(repo.fullName, commit.sha)
    if (!detail) continue
    kinds[classifyCommit(detail.files)] += 1
    sampled += 1
    const added = meaningfulAdditions(detail.files)
    sampledAdditions += added
    if (index === 0 && commit === mine[0]) firstAdditions = added
  }

  const contributors = await api.contributors(repo.fullName)
  const authoredByList = contributors.find((entry) => entry.id === person.githubId)?.contributions ?? 0
  const total = contributors.reduce((sum, entry) => sum + entry.contributions, 0)

  // Pull requests the person wrote that were merged; who merged them is only on each pull request, so a few are read, and the rest are counted as merged
  // by the person themselves (the case that weighs least) rather than guessed generously.
  const merged = (await api.pulls(repo.fullName, 1)).filter((pull) => pull.authorId === person.githubId && pull.mergedAt)
  let mergedByOthers = 0
  let selfMerged = 0
  for (const [index, pull] of merged.entries()) {
    if (index >= budget.pullDetails) {
      selfMerged += 1
      continue
    }
    const detail = await api.pull(repo.fullName, pull.number)
    if (detail?.mergedById && detail.mergedById !== person.githubId) mergedByOthers += 1
    else selfMerged += 1
  }

  const reviews = await api.reviewCount(repo.fullName, person.login)
  const releases = (await api.releases(repo.fullName)).filter((release) => release.authorId === person.githubId && release.publishedAt).length

  const facts: RepoFacts = {
    v: FACTS_VERSION,
    kind: 'repo',
    repo: { id: repo.id, fullName: repo.fullName, createdAt: repo.createdAt, fork: repo.fork, template: repo.fromTemplate, stars: repo.stars, languages, topics: [...repo.topics].sort() },
    author: { githubId: person.githubId },
    commits: {
      authored: mine.length,
      credit: round2(mine.reduce((sum, commit) => sum + 1 / (1 + Math.max(0, commit.coAuthors)), 0)),
      coauthored: mine.filter((commit) => commit.coAuthors > 0).length,
      afterOrigin,
      kinds,
      sampled,
      firstCommitShare: sampledAdditions > 0 ? round2(firstAdditions / sampledAdditions) : 0,
      days: dayHistogram(mine.map((commit) => commit.authoredAt)),
      first: mine[0]?.authoredAt ?? null,
      last: mine[mine.length - 1]?.authoredAt ?? null,
    },
    pulls: { mergedByOthers, selfMerged },
    reviews,
    releases,
    contributors: { authored: Math.max(authoredByList, mine.length), total: Math.max(total, mine.length) },
  }
  return { facts, headSha: mine[mine.length - 1]?.sha ?? null }
}

export interface UpstreamPull {
  facts: ExternalPullFacts
  repoHtmlUrl: string
  /** Counts towards the Upstream achievement: the repository was established when the pull request was merged (a trust gate for a counterparty who is not on the platform). */
  established: boolean
}

/** Pull requests the person wrote that another maintainer merged into a public repository the person does not own. */
export async function collectUpstreamPulls(api: GitHubApi, person: Person, budget: BudgetSetting): Promise<UpstreamPull[]> {
  if (budget.externalPulls === 0) return []
  const out: UpstreamPull[] = []
  for (const ref of await api.mergedPullsElsewhere(person.login, budget.externalPulls)) {
    const repo = await api.repoByName(ref.repoFullName)
    if (!repo || repo.private || repo.owner.id === person.githubId) continue
    const pull = await api.pull(repo.fullName, ref.number)
    if (!pull || pull.authorId !== person.githubId || !pull.mergedAt || !pull.mergedById || pull.mergedById === person.githubId) continue
    out.push({
      facts: { v: FACTS_VERSION, kind: 'external-pull', repo: { id: repo.id, fullName: repo.fullName, ownerId: repo.owner.id, createdAt: repo.createdAt }, author: { githubId: person.githubId }, pull: { number: pull.number, mergedAt: pull.mergedAt, mergedByOther: true } },
      repoHtmlUrl: repo.htmlUrl,
      established: new Date(pull.mergedAt).getTime() - new Date(repo.createdAt).getTime() >= ESTABLISHED_REPO_DAYS * DAY_MS,
    })
  }
  return out
}
