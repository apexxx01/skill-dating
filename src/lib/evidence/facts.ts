// The minimal facts the evidence engine keeps about one person's work in one repository, and how a commit's files are sorted into kinds. Pure.
//
// Minimal on purpose: counts, dates and GitHub numeric ids of the person and the repository. Never a raw payload, a commit message, a file name, an email,
// or anything about another contributor beyond the repository's total commit count. A receipt signs exactly these facts (docs/PROOF.md), so they are also
// what anybody holding a receipt can see.

export const FACTS_VERSION = 1

export type CommitKind = 'code' | 'modification' | 'tests' | 'docs' | 'trivial'
export const COMMIT_KINDS: readonly CommitKind[] = ['code', 'modification', 'tests', 'docs', 'trivial']

export interface RepoFacts {
  v: 1
  kind: 'repo'
  repo: {
    id: string
    fullName: string
    createdAt: string
    fork: boolean
    /** Made from a template repository. */
    template: boolean
    /** At capture: a weak signal, never a main weight. */
    stars: number
    languages: string[]
    topics: string[]
  }
  author: { githubId: string }
  commits: {
    /** Commits by the person (matched by GitHub id), merge commits left out. */
    authored: number
    /** The same, each commit with N co-author trailers counted as 1/(N+1). Two decimals. */
    credit: number
    coauthored: number
    /** Authored after the repository's origin: after the fork was made, or after the initial commit of a template. Equal to `authored` otherwise. */
    afterOrigin: number
    /** Of the commits whose files were looked at (`sampled`), how many of each kind. */
    kinds: Record<CommitKind, number>
    sampled: number
    /** The share (0 to 1) of the person's added lines that their first commit holds, among the commits looked at. 0 when unknown. */
    firstCommitShare: number
    /** Authored commits per UTC day, oldest first, the most recent MAX_DAYS active days. */
    days: [string, number][]
    first: string | null
    last: string | null
  }
  pulls: { mergedByOthers: number; selfMerged: number }
  reviews: number
  releases: number
  /** The person's commits and everybody's, from the repository's contributor list. */
  contributors: { authored: number; total: number }
}

export interface ExternalPullFacts {
  v: 1
  kind: 'external-pull'
  repo: { id: string; fullName: string; ownerId: string; createdAt: string }
  author: { githubId: string }
  pull: { number: number; mergedAt: string; mergedByOther: true }
}

export const MAX_DAYS = 400

// --- Sorting a commit's files ---------------------------------------------------------------------------------------

const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|go\.sum|mix\.lock|pubspec\.lock|Podfile\.lock|packages\.lock\.json|flake\.lock|uv\.lock)$/i
const VENDORED = /(^|\/)(vendor|node_modules|third[_-]?party|bower_components|Pods|\.yarn)\//i
const GENERATED = /(^|\/)(dist|build|out|coverage|\.next|target|__generated__|generated)\/|\.(min\.(js|css)|map|pb\.go|g\.dart|snap)$|(_pb2\.py|\.generated\.[a-z]+|\.lock)$/i
const DOCS = /(^|\/)(docs?|documentation)\/|\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)(README|CHANGELOG|LICENSE|LICENCE|CONTRIBUTING|AUTHORS|NOTICE)(\.[a-z]+)?$/i
const TESTS = /(^|\/)(tests?|__tests__|spec|specs|e2e|testdata)\/|[._-](test|spec)\.[a-z0-9]+$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$/i

export interface FileChange {
  filename: string
  status: string
  additions: number
  deletions: number
  whitespaceOnly: boolean
}

export function isTrivialFile(file: FileChange): boolean {
  return LOCKFILES.test(file.filename) || VENDORED.test(file.filename) || GENERATED.test(file.filename) || file.whitespaceOnly
}

/**
 * What kind of work a commit is, from its files: `trivial` when every file is a lockfile, vendored, generated, minified or changed only in whitespace;
 * `docs` when every remaining file is documentation; `tests` when any remaining file is a test; `code` when it mostly adds (new files, or at least twice as
 * many lines added as removed); `modification` otherwise. A commit with no files is trivial.
 */
export function classifyCommit(files: readonly FileChange[]): CommitKind {
  const real = files.filter((file) => !isTrivialFile(file))
  if (real.length === 0) return 'trivial'
  if (real.every((file) => DOCS.test(file.filename))) return 'docs'
  const code = real.filter((file) => !DOCS.test(file.filename))
  if (code.some((file) => TESTS.test(file.filename))) return 'tests'
  const added = code.reduce((sum, file) => sum + file.additions, 0)
  const removed = code.reduce((sum, file) => sum + file.deletions, 0)
  if (code.some((file) => file.status === 'added') || added >= 2 * Math.max(1, removed)) return 'code'
  return 'modification'
}

/** Lines a commit adds to files that are not trivial. */
export function meaningfulAdditions(files: readonly FileChange[]): number {
  return files.filter((file) => !isTrivialFile(file)).reduce((sum, file) => sum + file.additions, 0)
}

export const emptyKinds = (): Record<CommitKind, number> => ({ code: 0, modification: 0, tests: 0, docs: 0, trivial: 0 })

/** Commits per UTC day, oldest first, at most MAX_DAYS days (the most recent). */
export function dayHistogram(dates: readonly string[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const date of dates) {
    const day = new Date(date).toISOString().slice(0, 10)
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => a[0].localeCompare(b[0])).slice(-MAX_DAYS)
}
