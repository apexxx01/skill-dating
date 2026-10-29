import { describe, it, expect } from 'vitest'
import { MemoryCache } from './cache.memory'
import { githubContract, CONTRACT_FIXTURES } from './github.contract'
import {
  countCoAuthors,
  GitHubBudget,
  GitHubBudgetExceededError,
  GitHubRateLimitedError,
  GitHubUnavailableError,
  HttpGitHub,
  isWhitespaceOnlyPatch,
  parseRepoUrl,
  RATE_LIMIT_RESERVE,
  resolveGitHubAuth,
  type GitHubAuth,
  type GitHubAuthSource,
} from './github'
import { MemoryGitHub } from './github.memory'
import { restFixture, type RestFixtureOptions } from './github.rest-fixture'

const anonymous: GitHubAuth = { mode: 'anonymous', token: null, scope: 'anonymous' }
const withToken: GitHubAuth = { mode: 'server-token', token: 'ghp_SECRET_TOKEN_VALUE', scope: 'server-token' }

githubContract('MemoryGitHub', (fixtures, budget) => new MemoryGitHub(fixtures, { budget }))
githubContract('HttpGitHub', (fixtures, budget) => new HttpGitHub({ auth: anonymous, budget, cache: new MemoryCache(), fetch: restFixture(fixtures) as never }))

function http(options: RestFixtureOptions = {}, auth: GitHubAuth = anonymous, budget = new GitHubBudget(100), cache = new MemoryCache()) {
  return { budget, gh: new HttpGitHub({ auth, budget, cache, fetch: restFixture(CONTRACT_FIXTURES, options) as never }) }
}

describe('HttpGitHub: conditional requests', () => {
  it('sends the ETag it kept and answers a 304 from its cache, refunding the call', async () => {
    const seen: RestFixtureOptions['seen'] = []
    const cache = new MemoryCache()
    const first = http({ seen }, anonymous, new GitHubBudget(100), cache)
    const repo = await first.gh.repoById('9001')
    expect(first.budget.used).toBe(1)
    const second = http({ seen }, anonymous, new GitHubBudget(100), cache)
    expect(await second.gh.repoById('9001')).toEqual(repo)
    expect(seen[1].headers['If-None-Match']).toMatch(/^"[0-9a-f]+"$/)
    // The 304 cost nothing.
    expect(second.budget.used).toBe(0)
  })

  it('keeps one person’s cached answers apart from another’s', async () => {
    const seen: RestFixtureOptions['seen'] = []
    const cache = new MemoryCache()
    await http({ seen }, anonymous, new GitHubBudget(100), cache).gh.repoById('9001')
    await http({ seen }, withToken, new GitHubBudget(100), cache).gh.repoById('9001')
    expect(seen[1].headers['If-None-Match']).toBeUndefined()
  })

  it('cannot refund its way past twice the budget', () => {
    const budget = new GitHubBudget(2)
    for (let i = 0; i < 4; i++) {
      budget.spend()
      budget.refund()
    }
    expect(() => budget.spend()).toThrow(GitHubBudgetExceededError)
    expect(budget.used).toBe(0)
    expect(budget.remaining).toBe(2)
  })
})

describe('HttpGitHub: rate limits', () => {
  it('turns a 403 with no calls left into a rate-limit error with the reset time, and stops calling', async () => {
    const seen: RestFixtureOptions['seen'] = []
    const { gh } = http({ seen, fail: { pattern: /^\/repositories\//, status: 403, headers: { 'x-ratelimit-remaining': '0' } } })
    const error = await gh.repoById('9001').catch((e) => e)
    expect(error).toBeInstanceOf(GitHubRateLimitedError)
    expect((error as GitHubRateLimitedError).resetAt).toBeInstanceOf(Date)
    await expect(gh.userById('101')).rejects.toBeInstanceOf(GitHubRateLimitedError)
    expect(seen).toHaveLength(1)
  })

  it('honours Retry-After on a 429', async () => {
    const { gh } = http({ fail: { pattern: /^\/user\//, status: 429, headers: { 'retry-after': '60' } } })
    const error = (await gh.userById('101').catch((e) => e)) as GitHubRateLimitedError
    expect(error).toBeInstanceOf(GitHubRateLimitedError)
    expect(error.resetAt!.getTime() - Date.now()).toBeGreaterThan(50_000)
  })

  it('backs off by itself once GitHub says fewer than the reserve are left', async () => {
    const seen: RestFixtureOptions['seen'] = []
    const { gh } = http({ seen, remaining: () => RATE_LIMIT_RESERVE - 1 })
    expect(await gh.userById('101')).toEqual({ id: '101', login: 'ada' })
    await expect(gh.repoById('9001')).rejects.toBeInstanceOf(GitHubRateLimitedError)
    expect(seen).toHaveLength(1)
  })

  it('reports another failure without the token in it', async () => {
    const { gh } = http({ fail: { pattern: /^\/user\//, status: 500 } }, withToken)
    const error = (await gh.userById('101').catch((e) => e)) as Error
    expect(error).toBeInstanceOf(GitHubUnavailableError)
    expect(`${error.message} ${error.stack}`).not.toContain('ghp_SECRET_TOKEN_VALUE')
  })
})

describe('HttpGitHub: requests', () => {
  it('sends the token only in the Authorization header, and only to api.github.com', async () => {
    const seen: RestFixtureOptions['seen'] = []
    await http({ seen }, withToken).gh.userById('101')
    expect(seen[0].url.startsWith('https://api.github.com/user/101')).toBe(true)
    expect(seen[0].headers.Authorization).toBe('Bearer ghp_SECRET_TOKEN_VALUE')
    expect(seen[0].url).not.toContain('ghp_')
    const anon: RestFixtureOptions['seen'] = []
    await http({ seen: anon }).gh.userById('101')
    expect(anon[0].headers.Authorization).toBeUndefined()
  })

  it('builds paths from encoded parts and refuses a sha that is not one', async () => {
    const seen: RestFixtureOptions['seen'] = []
    const { gh } = http({ seen })
    expect(await gh.commit('ada/engine', '../../admin')).toBeNull()
    await gh.repoByName('a b/c?d')
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(['/repos/a%20b/c%3Fd'])
  })

  it('does not follow a redirect off the API host', async () => {
    const budget = new GitHubBudget(10)
    const gh = new HttpGitHub({ auth: anonymous, budget, cache: new MemoryCache(), fetch: (async () => new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest' } })) as never })
    expect(await gh.repoById('9001')).toBeNull()
    expect(budget.used).toBe(1)
  })
})

describe('parsing', () => {
  it('reads owner/name from a GitHub link and nothing else', () => {
    expect(parseRepoUrl('https://github.com/ada/engine')).toEqual({ owner: 'ada', name: 'engine', fullName: 'ada/engine' })
    expect(parseRepoUrl('https://www.github.com/ada/engine.git')).toMatchObject({ fullName: 'ada/engine' })
    expect(parseRepoUrl('https://github.com/ada/engine/tree/main/src?x=1')).toMatchObject({ fullName: 'ada/engine' })
    for (const bad of ['https://gitlab.com/ada/engine', 'https://github.com/ada', 'https://github.com.evil.io/ada/x', 'https://user:pw@github.com/a/b', 'https://github.com:8443/a/b', 'ftp://github.com/a/b', 'https://github.com/-bad/x', 'https://github.com/a/..', 'not a url', '', null]) {
      expect(parseRepoUrl(bad), String(bad)).toBeNull()
    }
  })

  it('counts co-author trailers', () => {
    expect(countCoAuthors('Fix\n\nCo-authored-by: A <a@x>\nco-authored-by: B <b@x>')).toBe(2)
    expect(countCoAuthors('Mention co-authored-by: inline is not a trailer')).toBe(0)
  })

  it('tells a whitespace-only patch from a real one', () => {
    expect(isWhitespaceOnlyPatch('@@ -1 +1 @@\n-const a = 1\n+const  a =  1')).toBe(true)
    expect(isWhitespaceOnlyPatch('@@ -1 +1 @@\n-const a = 1\n+const a = 2')).toBe(false)
    expect(isWhitespaceOnlyPatch('+new line')).toBe(false)
    expect(isWhitespaceOnlyPatch(undefined)).toBe(false)
  })
})

describe('auth', () => {
  const source = (mode: GitHubAuthSource['mode'], token: string | null): GitHubAuthSource => ({ mode, resolve: async () => (token ? { mode, token, scope: mode } : null) })

  it('takes the first source that has a token, in order', async () => {
    const subject = { userId: 'u1', clerkId: 'c1' }
    expect((await resolveGitHubAuth(subject, [source('user-oauth', 'a'), source('server-token', 'b')])).mode).toBe('user-oauth')
    expect((await resolveGitHubAuth(subject, [source('user-oauth', null), source('server-token', 'b')])).mode).toBe('server-token')
    expect(await resolveGitHubAuth(subject, [source('user-oauth', null)])).toEqual({ mode: 'anonymous', token: null, scope: 'anonymous' })
  })

  it('lets a new source (a GitHub App installation) go first without changing callers', async () => {
    const subject = { userId: 'u1', clerkId: 'c1' }
    expect((await resolveGitHubAuth(subject, [source('app-installation', 'i'), source('user-oauth', 'a')])).mode).toBe('app-installation')
  })
})
