import { describe, it, expect } from 'vitest'
import { GitHubBudget, GitHubBudgetExceededError, type GhRepo } from '@/lib/infra/github'
import { MemoryGitHub, type FixtureCommit, type GitHubFixtures } from '@/lib/infra/github.memory'
import { collaborationPairs } from './coauthorship'
import { collectRepoFacts, collectUpstreamPulls, spreadPick } from './collect'
import { repoStrength } from './strength'
import { DEFAULT_BUDGET } from './strength-config'

const HOUR = 60 * 60 * 1000
const at = (base: string, hours: number) => new Date(new Date(base).getTime() + hours * HOUR).toISOString()
const repo = (id: string, fullName: string, ownerId: string, over: Partial<GhRepo> = {}): GhRepo => ({
  id,
  fullName,
  owner: { id: ownerId, login: fullName.split('/')[0] },
  htmlUrl: `https://github.com/${fullName}`,
  private: false,
  fork: false,
  fromTemplate: false,
  createdAt: '2025-01-01T00:00:00Z',
  pushedAt: '2026-01-01T00:00:00Z',
  stars: 2,
  topics: ['react'],
  defaultBranch: 'main',
  ...over,
})
const code = [{ filename: 'src/app.ts', status: 'added', additions: 40, deletions: 0, whitespaceOnly: false }]
const commits = (authorId: string, base: string, count: number, everyHours = 24, over: Partial<FixtureCommit> = {}): FixtureCommit[] =>
  Array.from({ length: count }, (_, i) => ({ sha: `${authorId}${base.slice(0, 4)}${i}`.replace(/[^0-9a-f]/g, 'a').padEnd(40, 'b'), authorId, authoredAt: at(base, i * everyHours), files: code, ...over }))

/** "neo" is GitHub user 7, who was called "trinity" before a rename; "smith" (8) is somebody else who once used the old name in an email. */
function world(): GitHubFixtures {
  return {
    users: [
      { id: '7', login: 'neo' },
      { id: '8', login: 'smith' },
    ],
    repos: [
      { ...repo('100', 'neo/matrix', '7'), languages: { TypeScript: 100 } },
      repo('101', 'neo/fork-of-lib', '7', { fork: true, createdAt: '2025-06-01T00:00:00Z' }),
      repo('102', 'neo/from-template', '7', { fromTemplate: true, createdAt: '2025-03-01T00:00:00Z' }),
      repo('200', 'smith/agency', '8', { createdAt: '2020-01-01T00:00:00Z' }),
      repo('201', 'smith/new-thing', '8', { createdAt: '2025-12-20T00:00:00Z' }),
    ],
    commits: {
      '100': [...commits('7', '2025-02-01T09:00:00Z', 12), ...commits('8', '2025-02-01T10:00:00Z', 5), { ...commits('7', '2025-04-01T09:00:00Z', 1)[0], sha: 'f'.repeat(40), coAuthors: 1 }],
      // Commits before the fork was made are upstream history, not the fork's.
      '101': [...commits('7', '2025-01-01T00:00:00Z', 4), ...commits('7', '2025-07-01T00:00:00Z', 3).map((c, i) => ({ ...c, sha: `e${i}`.padEnd(40, 'e') }))],
      // The first commit is the template's, made with the repository.
      '102': [{ sha: 'c'.repeat(40), authorId: '7', authoredAt: '2025-03-01T00:01:00Z', files: code }, ...commits('7', '2025-03-05T00:00:00Z', 2).map((c, i) => ({ ...c, sha: `d${i}`.padEnd(40, 'd') }))],
    },
    pulls: {
      '100': [
        { number: 1, authorId: '7', mergedAt: '2025-03-01T00:00:00Z', mergedById: '8' },
        { number: 2, authorId: '7', mergedAt: '2025-03-02T00:00:00Z', mergedById: '7' },
        { number: 3, authorId: '8', mergedAt: '2025-03-03T00:00:00Z', mergedById: '7' },
      ],
      '200': [{ number: 9, authorId: '7', mergedAt: '2025-05-01T00:00:00Z', mergedById: '8' }],
      '201': [{ number: 4, authorId: '7', mergedAt: '2026-01-02T00:00:00Z', mergedById: '8' }],
    },
    releases: { '100': [{ id: '1', authorId: '7', publishedAt: '2025-04-02T00:00:00Z' }, { id: '2', authorId: '8', publishedAt: '2025-04-03T00:00:00Z' }] },
    reviews: { '100': [{ reviewerId: '7', authorId: '8' }] },
  }
}

const neo = { githubId: '7', login: 'neo' }

describe('collecting facts', () => {
  it('matches commits, pull requests and releases by GitHub id, never by name', async () => {
    const fixtures = world()
    const gh = new MemoryGitHub(fixtures, { budget: new GitHubBudget(500) })
    const { facts, headSha } = await collectRepoFacts(gh, fixtures.repos[0], neo, DEFAULT_BUDGET)
    expect(facts.commits.authored).toBe(13)
    expect(facts.commits.coauthored).toBe(1)
    expect(facts.commits.credit).toBe(12.5)
    expect(facts.pulls).toEqual({ mergedByOthers: 1, selfMerged: 1 })
    expect(facts.releases).toBe(1)
    expect(facts.reviews).toBe(1)
    expect(facts.contributors).toEqual({ authored: 13, total: 18 })
    expect(facts.repo.languages).toEqual(['TypeScript'])
    expect(headSha).toBe('f'.repeat(40))
    expect(facts.author).toEqual({ githubId: '7' })
    // Nothing about anybody else is kept: no logins, no emails, no messages.
    expect(JSON.stringify(facts)).not.toMatch(/smith|@|Co-authored/)
  })

  it('keeps the evidence across a rename: the id is looked up for today’s login, and the old name finds nothing', async () => {
    const fixtures = world()
    const before = await collectRepoFacts(new MemoryGitHub(fixtures, { budget: new GitHubBudget(500) }), fixtures.repos[0], neo, DEFAULT_BUDGET)
    fixtures.users[0] = { id: '7', login: 'the-one' }
    const after = await collectRepoFacts(new MemoryGitHub(fixtures, { budget: new GitHubBudget(500) }), fixtures.repos[0], { githubId: '7', login: 'the-one' }, DEFAULT_BUDGET)
    expect(after.facts).toEqual(before.facts)
    // Somebody who takes the old login over gets none of it: their id is not the author of those commits.
    fixtures.users.push({ id: '9', login: 'neo' })
    const squatter = await collectRepoFacts(new MemoryGitHub(fixtures, { budget: new GitHubBudget(500) }), fixtures.repos[0], { githubId: '9', login: 'neo' }, DEFAULT_BUDGET)
    expect(squatter.facts.commits.authored).toBe(0)
    // Claiming another person's id with your own login finds nothing either.
    const impostor = await collectRepoFacts(new MemoryGitHub(fixtures, { budget: new GitHubBudget(500) }), fixtures.repos[0], { githubId: '7', login: 'smith' }, DEFAULT_BUDGET)
    expect(impostor.facts.commits.authored).toBe(0)
  })

  it('counts only commits after the fork point in a fork, and none of a template’s initial commit', async () => {
    const fixtures = world()
    const gh = () => new MemoryGitHub(fixtures, { budget: new GitHubBudget(500) })
    const fork = await collectRepoFacts(gh(), fixtures.repos[1], neo, DEFAULT_BUDGET)
    expect(fork.facts.repo.fork).toBe(true)
    expect(fork.facts.commits.authored).toBe(7)
    expect(fork.facts.commits.afterOrigin).toBe(3)
    const template = await collectRepoFacts(gh(), fixtures.repos[2], neo, DEFAULT_BUDGET)
    expect(template.facts.commits.authored).toBe(3)
    expect(template.facts.commits.afterOrigin).toBe(2)
    expect(repoStrength(template.facts).flags.template).toBe(true)
  })

  it('looks at the files of a few commits only, the first always among them', async () => {
    const fixtures = world()
    const budget = new GitHubBudget(500)
    const { facts } = await collectRepoFacts(new MemoryGitHub(fixtures, { budget }), fixtures.repos[0], neo, { ...DEFAULT_BUDGET, sampledCommits: 3 })
    expect(facts.commits.sampled).toBe(3)
    expect(facts.commits.kinds.code).toBe(3)
    expect(facts.commits.firstCommitShare).toBeCloseTo(1 / 3, 2)
    expect(spreadPick([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([1, 4, 7])
    expect(spreadPick([1, 2], 5)).toEqual([1, 2])
    expect(spreadPick([1, 2, 3], 0)).toEqual([])
  })

  it('stops with the budget instead of going over it', async () => {
    const fixtures = world()
    const budget = new GitHubBudget(4)
    await expect(collectRepoFacts(new MemoryGitHub(fixtures, { budget }), fixtures.repos[0], neo, DEFAULT_BUDGET)).rejects.toBeInstanceOf(GitHubBudgetExceededError)
    expect(budget.used).toBe(4)
  })

  it('accounts every call: a repository costs its pages, its sampled commits, its pull request details and one call for each other list', async () => {
    const fixtures = world()
    const budget = new GitHubBudget(500)
    await collectRepoFacts(new MemoryGitHub(fixtures, { budget }), fixtures.repos[0], neo, { ...DEFAULT_BUDGET, sampledCommits: 4, pullDetails: 1 })
    // languages, commits (1 page), 4 commit details, contributors, pulls (1 page), 1 pull detail, reviews, releases
    expect(budget.used).toBe(1 + 1 + 4 + 1 + 1 + 1 + 1 + 1)
  })

  it('finds pull requests merged by other maintainers elsewhere, and marks whether the repository was established', async () => {
    const fixtures = world()
    const found = await collectUpstreamPulls(new MemoryGitHub(fixtures, { budget: new GitHubBudget(500) }), neo, DEFAULT_BUDGET)
    expect(found.map((pull) => [pull.facts.repo.fullName, pull.facts.pull.number, pull.established])).toEqual([
      ['smith/new-thing', 4, false],
      ['smith/agency', 9, true],
    ])
    expect(await collectUpstreamPulls(new MemoryGitHub(fixtures, { budget: new GitHubBudget(500) }), neo, { ...DEFAULT_BUDGET, externalPulls: 0 })).toEqual([])
  })
})

describe('co-authorship', () => {
  const d = (iso: string) => new Date(iso)

  it('pairs every two claimants with authored work, with shares and the period both were active', () => {
    const pairs = collaborationPairs([
      { userId: 'b', authored: 30, total: 100, first: d('2025-01-01'), last: d('2025-06-01'), receiptId: 'rb' },
      { userId: 'a', authored: 60, total: 90, first: d('2025-03-01'), last: d('2025-09-01'), receiptId: 'ra' },
      { userId: 'c', authored: 0, total: 100, first: null, last: null, receiptId: null },
    ])
    expect(pairs).toEqual([{ userAId: 'a', userBId: 'b', shareA: 0.6, shareB: 0.3, overlapStart: d('2025-03-01'), overlapEnd: d('2025-06-01'), receiptIds: ['ra', 'rb'] }])
  })

  it('gives no overlap to people who were never active at the same time, and no pair to a lone author', () => {
    const [pair] = collaborationPairs([
      { userId: 'a', authored: 5, total: 10, first: d('2024-01-01'), last: d('2024-02-01'), receiptId: null },
      { userId: 'b', authored: 5, total: 10, first: d('2025-01-01'), last: d('2025-02-01'), receiptId: 'rb' },
    ])
    expect(pair).toMatchObject({ overlapStart: null, overlapEnd: null, receiptIds: ['rb'] })
    expect(collaborationPairs([{ userId: 'a', authored: 5, total: 5, first: null, last: null, receiptId: null }])).toEqual([])
  })
})
