import fs from 'node:fs'
import type { GhCommitDetail, GhContributor, GhPull, GhRelease, GhRepo, GhUser, GitHubApi, GitHubAuthMode, GitHubBudget } from './github'

// The in-memory GitHub: answers every GitHubApi call from fixtures, spending the run's budget exactly as HttpGitHub would (one call per page it would
// request), so budgets, renames, forks and every heuristic of the engine can be tested with no network. github.contract.ts holds it and HttpGitHub to the
// same behaviour. The integration server loads its fixtures from GITHUB_FIXTURES_FILE.

export interface FixtureCommit extends Omit<GhCommitDetail, 'coAuthors' | 'parents'> {
  coAuthors?: number
  parents?: number
}

export interface GitHubFixtures {
  users: GhUser[]
  /** `gone`: deleted on GitHub (every lookup misses). */
  repos: (GhRepo & { languages?: Record<string, number>; gone?: boolean })[]
  /** By repository id. */
  commits?: Record<string, FixtureCommit[]>
  pulls?: Record<string, GhPull[]>
  releases?: Record<string, GhRelease[]>
  /** Who reviewed whose pull requests, by repository id. */
  reviews?: Record<string, { reviewerId: string; authorId: string }[]>
  /** By repository id; worked out from the commits when absent. */
  contributors?: Record<string, GhContributor[]>
}

const PER_PAGE = 100
const pagesFor = (count: number, pages: number) => Math.min(pages, Math.floor(count / PER_PAGE) + 1)
const newestFirst = <T>(items: T[], date: (item: T) => string | null) => [...items].sort((a, b) => (date(b) ?? '').localeCompare(date(a) ?? ''))

export class MemoryGitHub implements GitHubApi {
  readonly kind = 'memory' as const
  readonly authMode: GitHubAuthMode

  constructor(
    private readonly fixtures: GitHubFixtures,
    private readonly options: { budget: GitHubBudget; authMode?: GitHubAuthMode }
  ) {
    this.authMode = options.authMode ?? 'anonymous'
  }

  private spend(times = 1) {
    for (let i = 0; i < times; i++) this.options.budget.spend()
  }

  private live() {
    return this.fixtures.repos.filter((repo) => !repo.gone)
  }

  private byName(fullName: string) {
    return this.live().find((repo) => repo.fullName.toLowerCase() === fullName.toLowerCase()) ?? null
  }

  private userByLogin(login: string) {
    return this.fixtures.users.find((user) => user.login.toLowerCase() === login.toLowerCase()) ?? null
  }

  private commitsOf(repoId: string) {
    return (this.fixtures.commits?.[repoId] ?? []).map((commit) => ({ ...commit, coAuthors: commit.coAuthors ?? 0, parents: commit.parents ?? 1 }))
  }

  private strip(repo: GhRepo & { languages?: unknown; gone?: unknown }): GhRepo {
    const { languages: _languages, gone: _gone, ...rest } = repo
    return { ...rest, owner: { ...rest.owner }, topics: [...rest.topics] }
  }

  async userById(id: string) {
    this.spend()
    const user = this.fixtures.users.find((candidate) => candidate.id === id)
    return user ? { ...user } : null
  }

  async ownedRepos(login: string, limit: number) {
    this.spend()
    const user = this.userByLogin(login)
    if (!user) return []
    return newestFirst(this.live().filter((repo) => repo.owner.id === user.id && !repo.private), (repo) => repo.pushedAt)
      .slice(0, Math.min(PER_PAGE, limit))
      // GitHub's lists do not say whether a repository was made from a template; only the repository itself does.
      .map((repo) => ({ ...this.strip(repo), fromTemplate: false }))
  }

  async repoById(id: string) {
    this.spend()
    const repo = this.live().find((candidate) => candidate.id === id)
    return repo ? this.strip(repo) : null
  }

  async repoByName(fullName: string) {
    this.spend()
    const repo = this.byName(fullName)
    return repo ? this.strip(repo) : null
  }

  async languages(fullName: string) {
    this.spend()
    return { ...(this.byName(fullName)?.languages ?? {}) }
  }

  async commitsBy(fullName: string, login: string, pages: number) {
    const repo = this.byName(fullName)
    const user = this.userByLogin(login)
    const all = repo && user ? newestFirst(this.commitsOf(repo.id).filter((commit) => commit.authorId === user.id), (commit) => commit.authoredAt) : []
    this.spend(pagesFor(all.length, pages))
    return all.slice(0, pages * PER_PAGE).map(({ files: _files, ...commit }) => commit)
  }

  async commit(fullName: string, sha: string) {
    this.spend()
    const repo = this.byName(fullName)
    const found = repo ? this.commitsOf(repo.id).find((commit) => commit.sha === sha) : undefined
    return found ? { ...found, files: found.files.map((file) => ({ ...file })) } : null
  }

  async contributors(fullName: string) {
    this.spend()
    const repo = this.byName(fullName)
    if (!repo) return []
    const given = this.fixtures.contributors?.[repo.id]
    if (given) return given.map((entry) => ({ ...entry }))
    const counts = new Map<string, number>()
    for (const commit of this.commitsOf(repo.id)) if (commit.authorId) counts.set(commit.authorId, (counts.get(commit.authorId) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, contributions]) => ({ id, contributions }))
  }

  async pulls(fullName: string, pages: number) {
    const repo = this.byName(fullName)
    const all = repo ? newestFirst(this.fixtures.pulls?.[repo.id] ?? [], (pull) => pull.mergedAt) : []
    this.spend(pagesFor(all.length, pages))
    return all.slice(0, pages * PER_PAGE).map((pull) => ({ ...pull, mergedById: null }))
  }

  async pull(fullName: string, number: number) {
    this.spend()
    const repo = this.byName(fullName)
    const found = repo ? (this.fixtures.pulls?.[repo.id] ?? []).find((pull) => pull.number === number) : undefined
    return found ? { ...found } : null
  }

  async releases(fullName: string) {
    this.spend()
    const repo = this.byName(fullName)
    return repo ? newestFirst(this.fixtures.releases?.[repo.id] ?? [], (release) => release.publishedAt).slice(0, PER_PAGE).map((release) => ({ ...release })) : []
  }

  async reviewCount(fullName: string, login: string) {
    this.spend()
    const repo = this.byName(fullName)
    const user = this.userByLogin(login)
    if (!repo || !user) return 0
    return (this.fixtures.reviews?.[repo.id] ?? []).filter((review) => review.reviewerId === user.id && review.authorId !== user.id).length
  }

  async mergedPullsElsewhere(login: string, limit: number) {
    this.spend()
    const user = this.userByLogin(login)
    if (!user) return []
    const found = this.live()
      .filter((repo) => repo.owner.id !== user.id && !repo.private)
      .flatMap((repo) => (this.fixtures.pulls?.[repo.id] ?? []).filter((pull) => pull.authorId === user.id && pull.mergedAt).map((pull) => ({ repoFullName: repo.fullName, number: pull.number, mergedAt: pull.mergedAt })))
    return newestFirst(found, (ref) => ref.mergedAt)
      .slice(0, Math.min(PER_PAGE, limit))
      .map(({ repoFullName, number }) => ({ repoFullName, number }))
  }
}

const loaded = new Map<string, { mtimeMs: number; fixtures: GitHubFixtures }>()

/** Reads a fixture file, again only when it changed. */
export function loadFixtureFile(file: string): GitHubFixtures {
  const { mtimeMs } = fs.statSync(file)
  const hit = loaded.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.fixtures
  const fixtures = JSON.parse(fs.readFileSync(file, 'utf8')) as GitHubFixtures
  loaded.set(file, { mtimeMs, fixtures })
  return fixtures
}
