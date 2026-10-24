/**
 * tsx scripts/perf/report.ts [before after]   Prints the before/after table of two docs/perf/*.json files as Markdown (what docs/PERFORMANCE.md quotes).
 */
import fs from 'fs'
import path from 'path'

const [beforeLabel = 'before', afterLabel = 'after'] = process.argv.slice(2)
const read = (label: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/perf', `${label}.json`), 'utf-8')) as { scenarios: Record<string, { group: string; stats: { p50: number; p95: number; p99: number }; ok: number }> }
const before = read(beforeLabel)
const after = read(afterLabel)
const nameOf = (name: string) => (name.startsWith('leaderboard: campus') ? 'leaderboard: campus' : name)
const beforeByName = new Map(Object.entries(before.scenarios).map(([name, value]) => [nameOf(name), value]))
const fmt = (value: number | undefined) => (value === undefined || Number.isNaN(value) ? 'n/a' : String(value))

console.log('| Scenario | p50 before | p50 after | p95 before | p95 after | p99 after |')
console.log('|---|---:|---:|---:|---:|---:|')
for (const [name, now] of Object.entries(after.scenarios)) {
  const was = beforeByName.get(nameOf(name))
  const wasOk = was && was.ok > 0
  console.log(`| ${nameOf(name)} | ${wasOk ? fmt(was!.stats.p50) : 'n/a'} | ${fmt(now.stats.p50)} | ${wasOk ? fmt(was!.stats.p95) : 'n/a'} | ${fmt(now.stats.p95)} | ${fmt(now.stats.p99)} |`)
}
