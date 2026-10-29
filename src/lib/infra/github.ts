import { createHash } from 'node:crypto'
import { env } from '@/lib/env'
import { log } from '@/lib/log'
import { getCache, type Cache } from './cache'
import { loadFixtureFile, MemoryGitHub } from './github.memory'

// GitHub, for the evidence engine (src/lib/evidence, docs/PROOF.md). An adapter like the others: `GitHubApi` is what callers use, `HttpGitHub` reaches
// api.github.com, `MemoryGitHub` (github.memory.ts) answers from fixtures, and github.contract.ts is the behaviour both must have. Nothing in a test or in
// CI reaches GitHub.
//
//   reads only     public repositories, by their numeric ids where there is one, so a rename on GitHub breaks nothing. Every request is a GET to
//                  api.github.com built from parsed parts (owner, name, sha, number), never a URL somebody typed, and redirects are refused unless they
//                  stay on api.github.com: there is nothing here a user can point at the server's network (docs/SECURITY.md, "Outbound requests").
//   auth           one GitHubAuth per run, from the first source that has one (resolveGitHubAuth): the person's own GitHub sign-in token from Clerk,
//                  fetched for the run and never stored; then GITHUB_TOKEN; then none. A GitHub App installation token (Stage 1K) is one more source in
//                  the list, and no caller changes. The token is only ever put in the Authorization header: never logged, never in an error.
//   budget         every request spends one call from the run's GitHubBudget, which throws when it is spent. A 304 is refunded (a conditional request
//                  GitHub answers from its cache costs nothing of the rate limit either), up to a hard ceiling of twice the budget.
//   conditional    every answer's ETag is kept in the Cache adapter with its body (minimal fields only); the next request sends If-None-Match.
//   rate limits    x-ratelimit-remaining is read on every answer: below RATE_LIMIT_RESERVE the client stops before GitHub has to refuse it, and a 403
//                  or 429 that says so (or carries Retry-After) is a GitHubRateLimitedError with the reset time, which the job records and backs off on.

export type GitHubAuthMode = 'user-oauth' | 'server-token' | 'anonymous' | 'app-installation'

export interface GitHubAuth {
  mode: GitHubAuthMode
  /** The bearer token, or null for anonymous. Never logged. */
  token: string | null
  /** Separates cached answers by who asked (an anonymous answer is not reused for a token, nor one person's for another's). Not secret. */
  scope: string
}

export interface GhUser {
  id: string
  login: string
}

export interface GhRepo {
  id: string
  fullName: string
  owner: GhUser
  htmlUrl: string
  private: boolean
  fork: boolean
  /** Made from a template repository. */
  fromTemplate: boolean
  createdAt: string
  pushedAt: string | null
  stars: number
  topics: string[]
  defaultBranch: string
}

export interface GhCommit {
  sha: string
  /** The GitHub account the commit's author is linked to, or null when the author's email belongs to no account. */
  authorId: string | null
  /** The author date. */
  authoredAt: string
  /** Co-authored-by trailers in the message: a count only, never who. */
  coAuthors: number
  parents: number
}

export interface GhCommitFile {
  filename: string
  status: string
  additions: number
  deletions: number
  /** Whether every changed line differs from a line it replaced only in whitespace (from the patch; false when GitHub sent none). */
  whitespaceOnly: boolean
}

export interface GhCommitDetail extends GhCommit {
  files: GhCommitFile[]
}

export interface GhPull {
  number: number
  authorId: string | null
  mergedAt: string | null
  /** Only on a single pull request (pull()); null on a list. */
  mergedById: string | null
}

export interface GhRelease {
  id: string
  authorId: string | null
  publishedAt: string | null
}

export interface GhContributor {
  id: string
  contributions: number
}

export interface GhPullRef {
  repoFullName: string
  number: number
}

export interface GitHubApi {
  readonly kind: 'http' | 'memory'
  readonly authMode: GitHubAuthMode
  userById(id: string): Promise<GhUser | null>
  /** The person's own public repositories, most recently pushed first. */
  ownedRepos(login: string, limit: number): Promise<GhRepo[]>
  repoById(id: string): Promise<GhRepo | null>
  repoByName(fullName: string): Promise<GhRepo | null>
  languages(fullName: string): Promise<Record<string, number>>
  /** Commits GitHub attributes to `login`, newest first, up to `pages` pages of 100. The caller keeps only those whose authorId is the person's id. */
  commitsBy(fullName: string, login: string, pages: number): Promise<GhCommit[]>
  commit(fullName: string, sha: string): Promise<GhCommitDetail | null>
  contributors(fullName: string): Promise<GhContributor[]>
  /** Closed pull requests, newest first, up to `pages` pages of 100. */
  pulls(fullName: string, pages: number): Promise<GhPull[]>
  pull(fullName: string, number: number): Promise<GhPull | null>
  releases(fullName: string): Promise<GhRelease[]>
  /** Pull requests in the repository that `login` reviewed and did not write. */
  reviewCount(fullName: string, login: string): Promise<number>
  /** Merged pull requests by `login` to repositories `login` does not own, newest first. */
  mergedPullsElsewhere(login: string, limit: number): Promise<GhPullRef[]>
}

// --- Errors and the budget ---------------------------------------------------------------------------------------

export class GitHubBudgetExceededError extends Error {
  constructor() {
    super('the GitHub call budget of this run is spent')
    this.name = 'GitHubBudgetExceededError'
  }
}

export class GitHubRateLimitedError extends Error {
  constructor(readonly resetAt: Date | null) {
    super('GitHub rate limit reached')
    this.name = 'GitHubRateLimitedError'
  }
}

export class GitHubUnavailableError extends Error {
  constructor(readonly status: number | null, path: string) {
    super(`GitHub answered ${status ?? 'nothing'} for ${path}`)
    this.name = 'GitHubUnavailableError'
  }
}

/** How many calls a run may make. Pure apart from its own counter. */
export class GitHubBudget {
  private spent = 0
  private requests = 0

  constructor(readonly limit: number) {}

  /** Takes one call, or throws GitHubBudgetExceededError. */
  spend(): void {
    if (this.spent >= this.limit || this.requests >= this.limit * 2) throw new GitHubBudgetExceededError()
    this.spent += 1
    this.requests += 1
  }

  /** Gives back the call a 304 cost. Requests still count towards the hard ceiling of twice the budget. */
  refund(): void {
    if (this.spent > 0) this.spent -= 1
  }

  get used(): number {
    return this.spent
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.spent)
  }
}

// --- Parsing what people typed --------------------------------------------------------------------------------------

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/

/** owner/name from a github.com repository link, or null. Only https://github.com (or www.) and the two first path segments are read. */
export function parseRepoUrl(raw: string | null | undefined): { owner: string; name: string; fullName: string } | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return null
  const [owner, rawName] = url.pathname.split('/').filter(Boolean)
  const name = rawName?.replace(/\.git$/i, '')
  if (!owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return null
  return { owner, name, fullName: `${owner}/${name}` }
}

/** Co-authored-by trailers in a commit message (counted, never kept). */
export function countCoAuthors(message: string): number {
  return (message.match(/^co-authored-by:\s*\S.*$/gim) ?? []).length
}

/** Whether a unified diff changes only whitespace: every removed line, with whitespace taken out, is matched by an added one. */
export function isWhitespaceOnlyPatch(patch: string | undefined | null): boolean {
  if (!patch) return false
  const removed: string[] = []
  const added: string[] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('-')) removed.push(line.slice(1).replace(/\s+/g, ''))
    else if (line.startsWith('+')) added.push(line.slice(1).replace(/\s+/g, ''))
  }
  if (removed.length === 0 && added.length === 0) return false
  const left = removed.filter(Boolean).sort()
  const right = added.filter(Boolean).sort()
  return left.length === right.length && left.every((line, index) => line === right[index])
}

// --- Auth ---------------------------------------------------------------------------------------------------------

export interface AuthSubject {
  userId: string
  clerkId: string | null
}

export interface GitHubAuthSource {
  readonly mode: GitHubAuthMode
  /** A token for this person, or null to try the next source. Must not throw for "not available". */
  resolve(subject: AuthSubject): Promise<GitHubAuth | null>
}

const scopeOf = (mode: GitHubAuthMode, id: string) => `${mode}:${createHash('sha256').update(id).digest('hex').slice(0, 16)}`

/** The person's own GitHub sign-in, through Clerk (`users.getUserOauthAccessToken(userId, 'github')` in @clerk/backend 2). Fetched per run, never stored. */
export const clerkOAuthSource: GitHubAuthSource = {
  mode: 'user-oauth',
  async resolve(subject) {
    if (!subject.clerkId) return null
    try {
      const { clerkClient } = await import('@clerk/nextjs/server')
      const tokens = await (await clerkClient()).users.getUserOauthAccessToken(subject.clerkId, 'github')
      const token = tokens.data[0]?.token
      return token ? { mode: 'user-oauth', token, scope: scopeOf('user-oauth', subject.userId) } : null
    } catch (error) {
      // No GitHub sign-in on the account, or Clerk unreachable: the next source. Only the status is logged, never what came back.
      log.info('no GitHub token from Clerk for this run', { userId: subject.userId, status: (error as { status?: number }).status ?? null })
      return null
    }
  },
}

export const serverTokenSource: GitHubAuthSource = {
  mode: 'server-token',
  async resolve() {
    return env.GITHUB_TOKEN ? { mode: 'server-token', token: env.GITHUB_TOKEN, scope: 'server-token' } : null
  },
}

export const anonymousSource: GitHubAuthSource = {
  mode: 'anonymous',
  async resolve() {
    return { mode: 'anonymous', token: null, scope: 'anonymous' }
  },
}

/** In order. Stage 1K puts the GitHub App installation source first. */
export const DEFAULT_AUTH_SOURCES: readonly GitHubAuthSource[] = [clerkOAuthSource, serverTokenSource, anonymousSource]

export async function resolveGitHubAuth(subject: AuthSubject, sources: readonly GitHubAuthSource[] = DEFAULT_AUTH_SOURCES): Promise<GitHubAuth> {
  for (const source of sources) {
    const auth = await source.resolve(subject)
    if (auth) return auth
  }
  return { mode: 'anonymous', token: null, scope: 'anonymous' }
}

/** What /api/health says about GitHub: the mode a run without a person's token would use. Never a value. */
export function serverAuthMode(): 'server-token' | 'anonymous' {
  return env.GITHUB_TOKEN ? 'server-token' : 'anonymous'
}

// --- The HTTP client ------------------------------------------------------------------------------------------------

export const GITHUB_API = 'https://api.github.com'
/** Calls left on GitHub's own limit below which the client stops by itself. */
export const RATE_LIMIT_RESERVE = 10
const PER_PAGE = 100
const ETAG_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TIMEOUT_MS = 10_000

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; redirect: 'manual'; signal?: AbortSignal }) => Promise<Response>

interface Raw {
  [key: string]: unknown
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null)
const idOf = (value: unknown): string | null => (value && typeof value === 'object' ? str((value as Raw).id) : null)

export function repoOf(raw: Raw): GhRepo {
  const owner = (raw.owner ?? {}) as Raw
  return {
    id: str(raw.id) ?? '',
    fullName: str(raw.full_name) ?? '',
    owner: { id: str(owner.id) ?? '', login: str(owner.login) ?? '' },
    htmlUrl: str(raw.html_url) ?? '',
    private: raw.private === true,
    fork: raw.fork === true,
    fromTemplate: raw.template_repository !== undefined && raw.template_repository !== null,
    createdAt: str(raw.created_at) ?? new Date(0).toISOString(),
    pushedAt: str(raw.pushed_at),
    stars: typeof raw.stargazers_count === 'number' ? raw.stargazers_count : 0,
    topics: Array.isArray(raw.topics) ? raw.topics.filter((topic): topic is string => typeof topic === 'string') : [],
    defaultBranch: str(raw.default_branch) ?? 'main',
  }
}

export function commitOf(raw: Raw): GhCommit {
  const commit = (raw.commit ?? {}) as Raw
  const author = (commit.author ?? {}) as Raw
  return {
    sha: str(raw.sha) ?? '',
    authorId: idOf(raw.author),
    authoredAt: str(author.date) ?? new Date(0).toISOString(),
    coAuthors: countCoAuthors(str(commit.message) ?? ''),
    parents: Array.isArray(raw.parents) ? raw.parents.length : 1,
  }
}

export function pullOf(raw: Raw): GhPull {
  return { number: typeof raw.number === 'number' ? raw.number : 0, authorId: idOf(raw.user), mergedAt: str(raw.merged_at), mergedById: idOf(raw.merged_by) }
}

export interface HttpGitHubOptions {
  auth: GitHubAuth
  budget: GitHubBudget
  cache?: Cache
  fetch?: FetchLike
}

export class HttpGitHub implements GitHubApi {
  readonly kind = 'http' as const
  private readonly cache: Cache
  private readonly fetcher: FetchLike
  private stopped: Date | null | undefined

  constructor(private readonly options: HttpGitHubOptions) {
    this.cache = options.cache ?? getCache()
    this.fetcher = options.fetch ?? (fetch as unknown as FetchLike)
  }

  get authMode(): GitHubAuthMode {
    return this.options.auth.mode
  }

  /** One GET. Null for 404, 409 (an empty repository), 410 and 451. */
  private async get<T>(path: string, reduce: (body: unknown) => T): Promise<T | null> {
    if (this.stopped !== undefined) throw new GitHubRateLimitedError(this.stopped)
    this.options.budget.spend()
    const url = `${GITHUB_API}${path}`
    const key = `github:etag:${createHash('sha256').update(`${this.options.auth.scope}|${url}`).digest('hex')}`
    let cached: { etag: string; body: T } | null = null
    try {
      const hit = await this.cache.get(key)
      if (hit) cached = JSON.parse(hit) as { etag: string; body: T }
    } catch {
      cached = null
    }
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'SkillDating-Evidence/1.0' }
    if (this.options.auth.token) headers.Authorization = `Bearer ${this.options.auth.token}`
    if (cached) headers['If-None-Match'] = cached.etag

    let response: Response
    try {
      response = await this.fetcher(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      throw new GitHubUnavailableError(null, path)
    }

    const remaining = Number(response.headers.get('x-ratelimit-remaining'))
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null
    if ((response.status === 403 || response.status === 429) && (response.headers.get('retry-after') || remaining === 0)) {
      const retryAfter = Number(response.headers.get('retry-after'))
      this.stopped = Number.isFinite(retryAfter) && retryAfter > 0 ? new Date(Date.now() + retryAfter * 1000) : resetAt
      throw new GitHubRateLimitedError(this.stopped)
    }
    // Stop before GitHub has to refuse: the rest of the run waits for the reset.
    if (response.headers.has('x-ratelimit-remaining') && remaining < RATE_LIMIT_RESERVE) this.stopped = resetAt

    if (response.status === 304 && cached) {
      this.options.budget.refund()
      return cached.body
    }
    if (response.status >= 300 && response.status < 400) {
      // A renamed or moved resource. Only followed when it stays on the API host, and as a fresh request.
      const location = response.headers.get('location')
      if (location && new URL(location, GITHUB_API).origin === GITHUB_API) return this.get(new URL(location, GITHUB_API).pathname + new URL(location, GITHUB_API).search, reduce)
      return null
    }
    if ([404, 409, 410, 451].includes(response.status)) return null
    if (!response.ok) throw new GitHubUnavailableError(response.status, path)

    const body = reduce(await response.json())
    const etag = response.headers.get('etag')
    if (etag) await this.cache.set(key, JSON.stringify({ etag, body }), { ttlMs: ETAG_TTL_MS }).catch(() => undefined)
    return body
  }

  private async pages<T>(path: string, pages: number, reduce: (item: Raw) => T): Promise<T[]> {
    const out: T[] = []
    const join = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= pages; page++) {
      const items = await this.get(`${path}${join}per_page=${PER_PAGE}&page=${page}`, (body) => (Array.isArray(body) ? (body as Raw[]).map(reduce) : []))
      if (!items) break
      out.push(...items)
      if (items.length < PER_PAGE) break
    }
    return out
  }

  private repoPath(fullName: string): string {
    const [owner, name] = fullName.split('/')
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  }

  async userById(id: string) {
    return this.get(`/user/${encodeURIComponent(id)}`, (body) => ({ id: str((body as Raw).id) ?? id, login: str((body as Raw).login) ?? '' }))
  }

  async ownedRepos(login: string, limit: number) {
    const repos = await this.get(`/users/${encodeURIComponent(login)}/repos?type=owner&sort=pushed&per_page=${Math.min(PER_PAGE, limit)}`, (body) => (Array.isArray(body) ? (body as Raw[]).map(repoOf) : []))
    return repos ?? []
  }

  async repoById(id: string) {
    return this.get(`/repositories/${encodeURIComponent(id)}`, (body) => repoOf(body as Raw))
  }

  async repoByName(fullName: string) {
    return this.get(this.repoPath(fullName), (body) => repoOf(body as Raw))
  }

  async languages(fullName: string) {
    const languages = await this.get(`${this.repoPath(fullName)}/languages`, (body) =>
      Object.fromEntries(Object.entries((body ?? {}) as Raw).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
    )
    return languages ?? {}
  }

  async commitsBy(fullName: string, login: string, pages: number) {
    return this.pages(`${this.repoPath(fullName)}/commits?author=${encodeURIComponent(login)}`, pages, commitOf)
  }

  async commit(fullName: string, sha: string) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null
    return this.get(`${this.repoPath(fullName)}/commits/${sha}`, (body) => {
      const raw = body as Raw
      const files = Array.isArray(raw.files) ? (raw.files as Raw[]) : []
      return {
        ...commitOf(raw),
        files: files.map((file) => ({
          filename: str(file.filename) ?? '',
          status: str(file.status) ?? 'modified',
          additions: typeof file.additions === 'number' ? file.additions : 0,
          deletions: typeof file.deletions === 'number' ? file.deletions : 0,
          whitespaceOnly: isWhitespaceOnlyPatch(str(file.patch)),
        })),
      }
    })
  }

  async contributors(fullName: string) {
    return this.pages(`${this.repoPath(fullName)}/contributors`, 1, (item) => ({ id: str(item.id) ?? '', contributions: typeof item.contributions === 'number' ? item.contributions : 0 }))
  }

  async pulls(fullName: string, pages: number) {
    return this.pages(`${this.repoPath(fullName)}/pulls?state=closed&sort=updated&direction=desc`, pages, pullOf)
  }

  async pull(fullName: string, number: number) {
    return this.get(`${this.repoPath(fullName)}/pulls/${Math.trunc(number)}`, (body) => pullOf(body as Raw))
  }

  async releases(fullName: string) {
    return this.pages(`${this.repoPath(fullName)}/releases`, 1, (item) => ({ id: str(item.id) ?? '', authorId: idOf(item.author), publishedAt: str(item.published_at) }))
  }

  async reviewCount(fullName: string, login: string) {
    const q = encodeURIComponent(`repo:${fullName} type:pr reviewed-by:${login} -author:${login}`)
    return (await this.get(`/search/issues?q=${q}&per_page=1`, (body) => (typeof (body as Raw).total_count === 'number' ? ((body as Raw).total_count as number) : 0))) ?? 0
  }

  async mergedPullsElsewhere(login: string, limit: number) {
    const q = encodeURIComponent(`type:pr author:${login} is:merged -user:${login}`)
    const found = await this.get(`/search/issues?q=${q}&sort=updated&order=desc&per_page=${Math.min(PER_PAGE, limit)}`, (body) => {
      const items = Array.isArray((body as Raw).items) ? ((body as Raw).items as Raw[]) : []
      return items.flatMap((item) => {
        const repo = /\/repos\/([^/]+\/[^/]+)$/.exec(str(item.repository_url) ?? '')
        return repo && typeof item.number === 'number' ? [{ repoFullName: repo[1], number: item.number }] : []
      })
    })
    return found ?? []
  }
}

// --- Selection ------------------------------------------------------------------------------------------------------

export interface GitHubSession {
  api: GitHubApi
  budget: GitHubBudget
}

/** Makes the client for one run. Tests and the integration server swap it (setGitHubFactory). */
export type GitHubFactory = (auth: GitHubAuth, budget: GitHubBudget) => GitHubApi

const globalForGitHub = globalThis as unknown as { __githubFactory?: GitHubFactory }

function defaultFactory(): GitHubFactory {
  // The integration server answers from a fixture file (never in production: src/lib/env.ts refuses the setting there).
  if (env.GITHUB_FIXTURES_FILE) {
    const file = env.GITHUB_FIXTURES_FILE
    return (auth, budget) => new MemoryGitHub(loadFixtureFile(file), { budget, authMode: auth.mode })
  }
  return (auth, budget) => new HttpGitHub({ auth, budget })
}

export function getGitHubFactory(): GitHubFactory {
  globalForGitHub.__githubFactory ??= defaultFactory()
  return globalForGitHub.__githubFactory
}

/** Replaces the process-wide factory (tests). */
export function setGitHubFactory(factory: GitHubFactory | undefined) {
  globalForGitHub.__githubFactory = factory
}

export function openGitHub(auth: GitHubAuth, budget: GitHubBudget): GitHubSession {
  return { api: getGitHubFactory()(auth, budget), budget }
}
