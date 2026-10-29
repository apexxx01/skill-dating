import { describe, it, expect } from 'vitest'
import { GitHubBudget, GitHubBudgetExceededError, type GitHubApi } from './github'
import type { GitHubFixtures } from './github.memory'

// Behaviour every GitHubApi must have. github.test.ts runs it against MemoryGitHub and against HttpGitHub over a stand-in for api.github.com that serves
// the same fixtures (github.rest-fixture.ts), so the in-memory twin cannot drift from what the real client does, page counts and budget included.

const repo = (id: string, fullName: string, ownerId: string, over: Record<string, unknown> = {}) => ({
  id,
  fullName,
  owner: { id: ownerId, login: fullName.split('/')[0] },
  htmlUrl: `https://github.com/${fullName}`,
  private: false,
  fork: false,
  fromTemplate: false,
  createdAt: '2024-01-01T00:00:00Z',
  pushedAt: '2026-01-01T00:00:00Z',
  stars: 3,
  topics: ['cli'],
  defaultBranch: 'main',
  ...over,
})

const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 3_600_000).toISOString().replace('.000', '')

/** A small world: ada (renamed from "ada-old"), bob, and a stranger whose commits are not ada's even though they share a name. */
export const CONTRACT_FIXTURES: GitHubFixtures = {
  users: [
    { id: '101', login: 'ada' },
    { id: '102', login: 'bob' },
    { id: '103', login: 'ada-old' },
  ],
  repos: [
    { ...repo('9001', 'ada/engine', '101', { pushedAt: '2026-02-01T00:00:00Z' }), languages: { TypeScript: 9000, CSS: 100 } },
    repo('9002', 'ada/notes', '101', { pushedAt: '2026-03-01T00:00:00Z', fromTemplate: true }),
    repo('9003', 'bob/lib', '102'),
    { ...repo('9004', 'ada/old', '101'), gone: true },
    repo('9005', 'ada/secret', '101', { private: true }),
  ],
  commits: {
    '9001': [
      ...Array.from({ length: 250 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, 'a'), authorId: '101', authoredAt: day(i), files: [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, whitespaceOnly: false }] })),
      { sha: 'b'.repeat(40), authorId: '101', authoredAt: day(300), coAuthors: 2, files: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 1, whitespaceOnly: true }] },
      { sha: 'c'.repeat(40), authorId: '102', authoredAt: day(301), files: [] },
    ],
    '9003': [{ sha: 'd'.repeat(40), authorId: '102', authoredAt: day(5), files: [] }],
  },
  pulls: {
    '9001': [{ number: 7, authorId: '102', mergedAt: '2025-06-01T00:00:00Z', mergedById: '101' }],
    '9003': [
      { number: 1, authorId: '101', mergedAt: '2025-05-01T00:00:00Z', mergedById: '102' },
      { number: 2, authorId: '101', mergedAt: null, mergedById: null },
      { number: 3, authorId: '101', mergedAt: '2025-07-01T00:00:00Z', mergedById: '102' },
    ],
  },
  releases: { '9001': [{ id: '55', authorId: '101', publishedAt: '2025-08-01T00:00:00Z' }] },
  reviews: { '9003': [{ reviewerId: '101', authorId: '102' }, { reviewerId: '101', authorId: '102' }, { reviewerId: '101', authorId: '101' }] },
}

export function githubContract(name: string, make: (fixtures: GitHubFixtures, budget: GitHubBudget) => GitHubApi) {
  const fresh = (limit = 1000) => {
    const budget = new GitHubBudget(limit)
    return { budget, gh: make(CONTRACT_FIXTURES, budget) }
  }

  describe(`${name}: people and repositories`, () => {
    it('finds a person by their numeric id with their current login', async () => {
      const { gh } = fresh()
      expect(await gh.userById('101')).toEqual({ id: '101', login: 'ada' })
      expect(await gh.userById('999')).toBeNull()
    })

    it('finds repositories by id and by name, and misses one that is gone', async () => {
      const { gh } = fresh()
      const byId = await gh.repoById('9001')
      expect(byId).toMatchObject({ id: '9001', fullName: 'ada/engine', owner: { id: '101', login: 'ada' }, fork: false, fromTemplate: false, stars: 3, topics: ['cli'] })
      expect(await gh.repoByName('ADA/Engine')).toEqual(byId)
      expect((await gh.repoById('9002'))?.fromTemplate).toBe(true)
      expect(await gh.repoById('9004')).toBeNull()
      expect(await gh.repoByName('nobody/nothing')).toBeNull()
    })

    it('lists a person’s own public repositories, most recently pushed first, without template information', async () => {
      const { gh } = fresh()
      const repos = await gh.ownedRepos('ada', 10)
      expect(repos.map((r) => r.fullName)).toEqual(['ada/notes', 'ada/engine'])
      expect(repos.every((r) => r.fromTemplate === false)).toBe(true)
      expect(await gh.languages('ada/engine')).toEqual({ TypeScript: 9000, CSS: 100 })
    })
  })

  describe(`${name}: commits`, () => {
    it('lists the commits GitHub attributes to a login, newest first, with authors as ids and co-authors counted', async () => {
      const { gh } = fresh()
      const commits = await gh.commitsBy('ada/engine', 'ada', 3)
      expect(commits).toHaveLength(251)
      expect(commits.every((commit) => commit.authorId === '101')).toBe(true)
      expect(commits[0]).toMatchObject({ sha: 'b'.repeat(40), coAuthors: 2, parents: 1 })
      expect(commits[0].authoredAt.startsWith('2025-01-13')).toBe(true)
      // Another account's commits are not listed for this login.
      expect(await gh.commitsBy('ada/engine', 'ada-old', 3)).toEqual([])
    })

    it('spends one call per page it reads, and stops at the pages asked for', async () => {
      const three = fresh()
      await three.gh.commitsBy('ada/engine', 'ada', 3)
      expect(three.budget.used).toBe(3)
      const two = fresh()
      expect(await two.gh.commitsBy('ada/engine', 'ada', 2)).toHaveLength(200)
      expect(two.budget.used).toBe(2)
    })

    it('reads one commit with its files, and says when a change is whitespace only', async () => {
      const { gh } = fresh()
      const detail = await gh.commit('ada/engine', 'b'.repeat(40))
      expect(detail?.files).toEqual([{ filename: 'README.md', status: 'modified', additions: 1, deletions: 1, whitespaceOnly: true }])
      expect((await gh.commit('ada/engine', '1'.padStart(40, 'a')))?.files[0].whitespaceOnly).toBe(false)
      expect(await gh.commit('ada/engine', 'e'.repeat(40))).toBeNull()
    })

    it('lists contributors by id with their counts', async () => {
      const { gh } = fresh()
      expect(await gh.contributors('ada/engine')).toEqual([
        { id: '101', contributions: 251 },
        { id: '102', contributions: 1 },
      ])
    })
  })

  describe(`${name}: pull requests, releases and reviews`, () => {
    it('lists closed pull requests without who merged them, and reads one with it', async () => {
      const { gh } = fresh()
      expect(await gh.pulls('bob/lib', 1)).toEqual([
        { number: 3, authorId: '101', mergedAt: '2025-07-01T00:00:00Z', mergedById: null },
        { number: 1, authorId: '101', mergedAt: '2025-05-01T00:00:00Z', mergedById: null },
        { number: 2, authorId: '101', mergedAt: null, mergedById: null },
      ])
      expect(await gh.pull('bob/lib', 1)).toEqual({ number: 1, authorId: '101', mergedAt: '2025-05-01T00:00:00Z', mergedById: '102' })
      expect(await gh.pull('bob/lib', 99)).toBeNull()
    })

    it('finds a person’s merged pull requests to repositories they do not own', async () => {
      const { gh } = fresh()
      expect(await gh.mergedPullsElsewhere('ada', 10)).toEqual([
        { repoFullName: 'bob/lib', number: 3 },
        { repoFullName: 'bob/lib', number: 1 },
      ])
      expect(await gh.mergedPullsElsewhere('bob', 10)).toEqual([{ repoFullName: 'ada/engine', number: 7 }])
    })

    it('counts reviews of other people’s pull requests and lists releases', async () => {
      const { gh } = fresh()
      expect(await gh.reviewCount('bob/lib', 'ada')).toBe(2)
      expect(await gh.reviewCount('ada/engine', 'ada')).toBe(0)
      expect(await gh.releases('ada/engine')).toEqual([{ id: '55', authorId: '101', publishedAt: '2025-08-01T00:00:00Z' }])
    })
  })

  describe(`${name}: the budget`, () => {
    it('refuses the call that would go over it', async () => {
      const { gh, budget } = fresh(2)
      await gh.userById('101')
      await gh.repoById('9001')
      await expect(gh.languages('ada/engine')).rejects.toBeInstanceOf(GitHubBudgetExceededError)
      expect(budget.used).toBe(2)
    })
  })
}
