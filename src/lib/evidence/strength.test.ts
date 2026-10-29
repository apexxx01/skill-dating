import { describe, it, expect } from 'vitest'
import { classifyCommit, dayHistogram, emptyKinds, MAX_DAYS, meaningfulAdditions, type RepoFacts } from './facts'
import { dampenDay, evidenceWeight, externalPullStrength, repoStrength } from './strength'
import { DEFAULT_STRENGTH_CONFIG, DEFAULT_STRENGTH_SETTING, strengthConfigFrom, strengthSettingSchema } from './strength-config'

const DAY = 24 * 60 * 60 * 1000
const START = Date.UTC(2025, 0, 6)

/** Days as [date, commits], one entry per active day, `gap` days apart. */
const spread = (activeDays: number, perDay: number, gap = 1): [string, number][] => Array.from({ length: activeDays }, (_, i) => [new Date(START + i * gap * DAY).toISOString().slice(0, 10), perDay])

function facts(over: { repo?: Partial<RepoFacts['repo']>; commits?: Partial<RepoFacts['commits']>; pulls?: Partial<RepoFacts['pulls']>; reviews?: number; releases?: number } = {}): RepoFacts {
  const days = over.commits?.days ?? spread(10, 2)
  const authored = over.commits?.authored ?? days.reduce((sum, [, n]) => sum + n, 0)
  const kinds = over.commits?.kinds ?? { ...emptyKinds(), code: 4, modification: 3, tests: 1 }
  return {
    v: 1,
    kind: 'repo',
    repo: { id: '1', fullName: 'a/b', createdAt: '2024-12-01T00:00:00Z', fork: false, template: false, stars: 0, languages: ['TypeScript'], topics: [], ...over.repo },
    author: { githubId: '42' },
    commits: {
      authored,
      credit: authored,
      coauthored: 0,
      afterOrigin: authored,
      kinds,
      sampled: Object.values(kinds).reduce((sum, n) => sum + n, 0),
      firstCommitShare: 0.1,
      days,
      first: days.length ? `${days[0][0]}T10:00:00Z` : null,
      last: days.length ? `${days[days.length - 1][0]}T10:00:00Z` : null,
      ...over.commits,
    },
    pulls: { mergedByOthers: 0, selfMerged: 0, ...over.pulls },
    reviews: over.reviews ?? 0,
    releases: over.releases ?? 0,
    contributors: { authored, total: authored },
  }
}

// The adversarial fixtures of docs/PROOF.md, with an honest repository to compare them with. Their scores are pinned loosely (ranges), so a tuning change
// that keeps the model's intent passes and one that breaks it does not.
const FIXTURES = {
  honest: facts({ commits: { days: spread(34, 1, 3) }, pulls: { mergedByOthers: 6 } }),
  forkWithoutCommits: facts({ repo: { fork: true, stars: 40 }, commits: { afterOrigin: 0 } }),
  forkWithRealWork: facts({ repo: { fork: true }, commits: { days: spread(15, 2, 2), afterOrigin: 30 } }),
  burst500OneNight: facts({ commits: { days: [['2026-01-10', 500]], kinds: { ...emptyKinds(), code: 8 } } }),
  lockfileOnly: facts({ commits: { days: spread(12, 3), kinds: { ...emptyKinds(), trivial: 8 } } }),
  templateUntouched: facts({ repo: { template: true }, commits: { days: spread(1, 1), afterOrigin: 0 } }),
  templateBuiltOn: facts({ repo: { template: true }, commits: { days: spread(8, 2, 2), afterOrigin: 15 } }),
  hugeInitialImport: facts({ commits: { days: spread(2, 1), firstCommitShare: 0.97, kinds: { ...emptyKinds(), code: 2 } } }),
  coauthoredHalf: facts({ commits: { days: spread(10, 2), coauthored: 20, credit: 10 } }),
  coauthoredNone: facts({ commits: { days: spread(10, 2) } }),
  selfMerged6: facts({ pulls: { selfMerged: 6 } }),
  externallyMerged6: facts({ pulls: { mergedByOthers: 6 } }),
  tinyBeginner: facts({ commits: { days: spread(3, 2), kinds: { ...emptyKinds(), code: 3, modification: 2, docs: 1 } } }),
  starFarm: facts({ repo: { stars: 50_000 }, commits: { days: spread(1, 1), kinds: { ...emptyKinds(), docs: 1 } } }),
}

export const ADVERSARIAL_SCORES = Object.fromEntries(Object.entries(FIXTURES).map(([name, f]) => [name, repoStrength(f).score]))

describe('commit kinds', () => {
  const file = (filename: string, over: Partial<{ status: string; additions: number; deletions: number; whitespaceOnly: boolean }> = {}) => ({ filename, status: 'modified', additions: 10, deletions: 2, whitespaceOnly: false, ...over })

  it('calls lockfile, vendored, generated, minified and whitespace-only commits trivial', () => {
    for (const name of ['package-lock.json', 'web/yarn.lock', 'Cargo.lock', 'go.sum', 'vendor/x/y.go', 'node_modules/a/index.js', 'dist/app.js', 'public/app.min.js', 'app.js.map', 'api/user.pb.go']) {
      expect(classifyCommit([file(name)]), name).toBe('trivial')
    }
    expect(classifyCommit([file('src/a.ts', { whitespaceOnly: true })])).toBe('trivial')
    expect(classifyCommit([])).toBe('trivial')
  })

  it('tells docs, tests, new code and modifications apart', () => {
    expect(classifyCommit([file('README.md'), file('docs/guide.txt'), file('yarn.lock')])).toBe('docs')
    expect(classifyCommit([file('src/a.ts'), file('src/a.test.ts')])).toBe('tests')
    expect(classifyCommit([file('pkg/x_test.go')])).toBe('tests')
    expect(classifyCommit([file('src/new.ts', { status: 'added' })])).toBe('code')
    expect(classifyCommit([file('src/a.ts', { additions: 30, deletions: 5 })])).toBe('code')
    expect(classifyCommit([file('src/a.ts', { additions: 5, deletions: 5 })])).toBe('modification')
    expect(meaningfulAdditions([file('src/a.ts', { additions: 7 }), file('package-lock.json', { additions: 9000 })])).toBe(7)
  })

  it('counts commits per UTC day, oldest first, and keeps the most recent days only', () => {
    expect(dayHistogram(['2026-01-02T23:30:00Z', '2026-01-01T10:00:00Z', '2026-01-02T01:00:00Z'])).toEqual([['2026-01-01', 1], ['2026-01-02', 2]])
    const many = Array.from({ length: MAX_DAYS + 20 }, (_, i) => new Date(START + i * DAY).toISOString())
    const kept = dayHistogram(many)
    expect(kept).toHaveLength(MAX_DAYS)
    expect(kept[0][0]).toBe(new Date(START + 20 * DAY).toISOString().slice(0, 10))
  })
})

describe('strength: the adversarial fixtures', () => {
  const s = (name: keyof typeof FIXTURES) => repoStrength(FIXTURES[name])

  it('scores a genuine, collaborative repository well, and explains it with counts', () => {
    const honest = s('honest')
    expect(honest.score).toBeGreaterThanOrEqual(55)
    expect(honest.reasons[0]).toBe('Counts: 34 authored commits over 34 active days, 6 PRs merged by other maintainers')
    for (const component of honest.components) expect(component.points).toBeLessThanOrEqual(component.max)
  })

  it('gives a fork without commits after the fork point nothing for authored work', () => {
    const fork = s('forkWithoutCommits')
    expect(fork.flags.forkWithoutWork).toBe(true)
    for (const key of ['work', 'days', 'span', 'tests'] as const) expect(fork.components.find((c) => c.key === key)!.points).toBe(0)
    expect(fork.score).toBeLessThanOrEqual(2)
    expect(fork.reasons.join(' ')).toMatch(/fork with no commits of yours/)
  })

  it('counts a fork with real work after the fork point', () => {
    expect(s('forkWithRealWork').score).toBeGreaterThan(30)
  })

  it('collapses 500 commits in one night to almost nothing', () => {
    const burst = s('burst500OneNight')
    expect(burst.flags.burst).toBe(true)
    expect(burst.score).toBeLessThanOrEqual(12)
    expect(burst.score).toBeLessThan(s('tinyBeginner').score)
    expect(dampenDay(500, 4)).toBeLessThan(14)
    expect(dampenDay(3, 4)).toBe(3)
  })

  it('gives lockfile-only work next to nothing', () => {
    const lock = s('lockfileOnly')
    expect(lock.flags.trivial).toBe(true)
    expect(lock.flags.floor).toBe(false)
    expect(lock.score).toBeLessThanOrEqual(3)
  })

  it('treats a template like a fork: the initial commit does not count', () => {
    expect(s('templateUntouched').score).toBe(0)
    expect(s('templateBuiltOn').score).toBeGreaterThan(20)
    expect(s('templateBuiltOn').reasons.join(' ')).toMatch(/template's initial commit/)
  })

  it('counts a huge initial import with little history after it as low, and gives it no floor', () => {
    const imported = s('hugeInitialImport')
    expect(imported.flags.import).toBe(true)
    expect(imported.flags.floor).toBe(false)
    expect(imported.score).toBeLessThan(DEFAULT_STRENGTH_CONFIG.beginnerFloor.score)
  })

  it('counts co-authored commits in part', () => {
    expect(s('coauthoredHalf').score).toBeLessThan(s('coauthoredNone').score)
    expect(s('coauthoredHalf').reasons.join(' ')).toMatch(/20 commits shared with co-authors/)
  })

  it('weighs pull requests merged by other maintainers far above self-merged ones', () => {
    const self = s('selfMerged6').components.find((c) => c.key === 'selfMerged')!.points
    const external = s('externallyMerged6').components.find((c) => c.key === 'mergedByOthers')!.points
    expect(external).toBeGreaterThan(4 * self)
    expect(s('externallyMerged6').score).toBeGreaterThan(s('selfMerged6').score)
  })

  it('never lets an honest beginner read as zero: a tiny genuine project reaches the floor', () => {
    const tiny = s('tinyBeginner')
    expect(tiny.score).toBeGreaterThanOrEqual(DEFAULT_STRENGTH_CONFIG.beginnerFloor.score)
    // One commit on one day is not yet a project: no floor.
    expect(repoStrength(facts({ commits: { days: spread(1, 1) } })).flags.floor).toBe(false)
  })

  it('keeps stars a weak signal', () => {
    const farm = s('starFarm')
    expect(farm.components.find((c) => c.key === 'stars')!.points).toBe(2)
    expect(farm.score).toBeLessThan(15)
  })

  it('is deterministic and stays within 0 to 100', () => {
    const maxed = facts({ commits: { days: spread(400, 4) }, pulls: { mergedByOthers: 400, selfMerged: 400 }, reviews: 400, releases: 400, repo: { stars: 1e9 } })
    expect(repoStrength(maxed).score).toBeLessThanOrEqual(100)
    expect(repoStrength(maxed)).toEqual(repoStrength(maxed))
    expect(repoStrength(facts({ commits: { days: [], authored: 0 } })).score).toBe(0)
  })
})

describe('strength: config', () => {
  it('reads the tunable part from a setting and keeps the rest', () => {
    expect(strengthSettingSchema.parse(DEFAULT_STRENGTH_SETTING)).toEqual(DEFAULT_STRENGTH_SETTING)
    const config = strengthConfigFrom({ ...DEFAULT_STRENGTH_SETTING, burstPerDay: 1, beginnerFloor: { score: 30, minCommits: 3, minDays: 2 } })
    expect(config.components).toEqual(DEFAULT_STRENGTH_CONFIG.components)
    expect(repoStrength(FIXTURES.tinyBeginner, config).score).toBeGreaterThanOrEqual(30)
    expect(strengthSettingSchema.safeParse({ ...DEFAULT_STRENGTH_SETTING, burstPerDay: 0 }).success).toBe(false)
  })

  it('scores an external pull request merged by another maintainer as its own evidence', () => {
    const result = externalPullStrength({ v: 1, kind: 'external-pull', repo: { id: '9', fullName: 'big/lib', ownerId: '7', createdAt: '2020-01-01T00:00:00Z' }, author: { githubId: '42' }, pull: { number: 12, mergedAt: '2026-01-01T00:00:00Z', mergedByOther: true } })
    expect(result.score).toBe(DEFAULT_STRENGTH_CONFIG.externalPullScore)
    expect(result.reasons[0]).toMatch(/PR #12 to big\/lib, merged by another maintainer/)
  })
})

describe('evidence weight', () => {
  it('is strength times the source being there times integrity, and nothing for an unsupported or moderated claim', () => {
    expect(evidenceWeight({ strength: 60, support: 'SUPPORTED', sourceWeight: 1, moderated: false })).toBe(0.6)
    expect(evidenceWeight({ strength: 60, support: 'SUPPORTED', sourceWeight: 0.3, moderated: false })).toBe(0.18)
    expect(evidenceWeight({ strength: 60, support: 'SUPPORTED', sourceWeight: 1, moderated: false, integrityWeight: 0.5 })).toBe(0.3)
    expect(evidenceWeight({ strength: 60, support: 'UNSUPPORTED', sourceWeight: 1, moderated: false })).toBe(0)
    expect(evidenceWeight({ strength: 60, support: 'SUPPORTED', sourceWeight: 1, moderated: true })).toBe(0)
  })
})

describe('the table in docs/PROOF.md', () => {
  it('matches the scores the fixtures get', () => {
    expect(ADVERSARIAL_SCORES).toMatchInlineSnapshot(`
      {
        "burst500OneNight": 10,
        "coauthoredHalf": 36,
        "coauthoredNone": 43,
        "externallyMerged6": 55,
        "forkWithRealWork": 55,
        "forkWithoutCommits": 2,
        "honest": 77,
        "hugeInitialImport": 8,
        "lockfileOnly": 0,
        "selfMerged6": 46,
        "starFarm": 9,
        "templateBuiltOn": 39,
        "templateUntouched": 0,
        "tinyBeginner": 21,
      }
    `)
  })
})
