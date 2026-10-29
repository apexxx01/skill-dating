import { createHash } from 'node:crypto'
import { GitHubBudget } from './github'
import { MemoryGitHub, type GitHubFixtures } from './github.memory'

// A stand-in for api.github.com for tests: a `fetch` that answers the REST endpoints HttpGitHub calls, in GitHub's own JSON shapes, from the same fixtures
// the in-memory GitHub reads. It sends ETags and answers 304 to a matching If-None-Match, and its rate-limit headers can be set, so HttpGitHub's
// parsing, paging, conditional requests and back-off are all exercised offline. Test support only.

export interface RestFixtureOptions {
  /** x-ratelimit-remaining on every answer (default 5000). */
  remaining?: () => number
  /** Answer this status (with these headers) instead, for a path matching the pattern. */
  fail?: { pattern: RegExp; status: number; headers?: Record<string, string> }
  /** Every request that reached it, with its headers. */
  seen?: { url: string; headers: Record<string, string> }[]
}

const num = (id: string | null) => (id === null ? null : /^\d+$/.test(id) ? Number(id) : id)

export function restFixture(fixtures: GitHubFixtures, options: RestFixtureOptions = {}) {
  const memory = () => new MemoryGitHub(fixtures, { budget: new GitHubBudget(1_000_000) })
  const rawRepo = (repo: Awaited<ReturnType<MemoryGitHub['repoById']>>, withTemplate: boolean) =>
    repo && {
      id: num(repo.id),
      full_name: repo.fullName,
      owner: { id: num(repo.owner.id), login: repo.owner.login },
      html_url: repo.htmlUrl,
      private: repo.private,
      fork: repo.fork,
      ...(withTemplate ? { template_repository: repo.fromTemplate ? { id: 1 } : null } : {}),
      created_at: repo.createdAt,
      pushed_at: repo.pushedAt,
      stargazers_count: repo.stars,
      topics: repo.topics,
      default_branch: repo.defaultBranch,
    }
  const login = (id: string | null) => (id ? fixtures.users.find((user) => user.id === id)?.login ?? null : null)
  const rawUser = (id: string | null) => (id ? { id: num(id), login: login(id) } : null)
  const message = (coAuthors: number) => ['A change', '', ...Array.from({ length: coAuthors }, (_, i) => `Co-authored-by: Person ${i} <p${i}@example.invalid>`)].join('\n')

  async function answer(path: string, query: URLSearchParams): Promise<unknown> {
    const gh = memory()
    const page = Number(query.get('page') ?? 1)
    const perPage = Number(query.get('per_page') ?? 30)
    const paged = <T>(items: T[]) => items.slice((page - 1) * perPage, page * perPage)
    let m: RegExpExecArray | null
    if ((m = /^\/user\/(\d+)$/.exec(path))) return gh.userById(m[1])
    if ((m = /^\/users\/([^/]+)\/repos$/.exec(path))) return (await gh.ownedRepos(decodeURIComponent(m[1]), perPage)).map((repo) => rawRepo(repo, false))
    if ((m = /^\/repositories\/(\d+)$/.exec(path))) return rawRepo(await gh.repoById(m[1]), true)
    if ((m = /^\/search\/issues$/.exec(path))) {
      const q = query.get('q') ?? ''
      const reviewed = /^repo:(\S+) type:pr reviewed-by:(\S+) -author:\S+$/.exec(q)
      if (reviewed) return { total_count: await gh.reviewCount(reviewed[1], reviewed[2]), items: [] }
      const merged = /^type:pr author:(\S+) is:merged -user:\S+$/.exec(q)
      if (merged) return { total_count: 0, items: (await gh.mergedPullsElsewhere(merged[1], perPage)).map((ref) => ({ number: ref.number, repository_url: `https://api.github.com/repos/${ref.repoFullName}` })) }
      return { total_count: 0, items: [] }
    }
    if (!(m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path))) return undefined
    const fullName = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`
    const rest = m[3] ?? ''
    if (!(await gh.repoByName(fullName))) return undefined
    if (rest === '') return rawRepo(await gh.repoByName(fullName), true)
    if (rest === '/languages') return gh.languages(fullName)
    if (rest === '/commits') {
      return paged(await gh.commitsBy(fullName, query.get('author') ?? '', 1000)).map((commit) => ({
        sha: commit.sha,
        author: rawUser(commit.authorId),
        commit: { author: { date: commit.authoredAt }, message: message(commit.coAuthors) },
        parents: Array.from({ length: commit.parents }, (_, i) => ({ sha: `p${i}` })),
      }))
    }
    if ((m = /^\/commits\/([0-9a-f]+)$/i.exec(rest))) {
      const commit = await gh.commit(fullName, m[1])
      return (
        commit && {
          sha: commit.sha,
          author: rawUser(commit.authorId),
          commit: { author: { date: commit.authoredAt }, message: message(commit.coAuthors) },
          parents: Array.from({ length: commit.parents }, (_, i) => ({ sha: `p${i}` })),
          files: commit.files.map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, patch: file.whitespaceOnly ? '-a = 1\n+a  =  1' : '+let x = 1' })),
        }
      )
    }
    if (rest === '/contributors') return paged(await gh.contributors(fullName)).map((entry) => ({ id: num(entry.id), contributions: entry.contributions }))
    if (rest === '/pulls') return paged(await gh.pulls(fullName, 1000)).map((pull) => ({ number: pull.number, user: rawUser(pull.authorId), merged_at: pull.mergedAt }))
    if ((m = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pull = await gh.pull(fullName, Number(m[1]))
      return pull && { number: pull.number, user: rawUser(pull.authorId), merged_at: pull.mergedAt, merged_by: rawUser(pull.mergedById) }
    }
    if (rest === '/releases') return paged(await gh.releases(fullName)).map((release) => ({ id: num(release.id), author: rawUser(release.authorId), published_at: release.publishedAt }))
    return undefined
  }

  return async (url: string, init: { headers: Record<string, string> }): Promise<Response> => {
    const parsed = new URL(url)
    options.seen?.push({ url, headers: { ...init.headers } })
    const remaining = String(options.remaining?.() ?? 5000)
    const limits = { 'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) }
    if (options.fail && options.fail.pattern.test(parsed.pathname)) return new Response('{}', { status: options.fail.status, headers: { ...limits, ...options.fail.headers } })
    const body = await answer(parsed.pathname, parsed.searchParams)
    if (body === undefined || body === null) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: limits })
    const text = JSON.stringify(body)
    const etag = `"${createHash('sha1').update(text).digest('hex')}"`
    if (init.headers['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { ...limits, etag } })
    return new Response(text, { status: 200, headers: { ...limits, etag, 'content-type': 'application/json' } })
  }
}
