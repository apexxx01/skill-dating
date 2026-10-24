// Shared by the performance scripts: statistics, the Postgres plan log reader and a few small helpers. No application code is imported.

import fs from 'fs'

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

export interface Stats {
  n: number
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
}

export function statsOf(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)
  const round = (value: number) => Math.round(value * 10) / 10
  return { n: sorted.length, p50: round(percentile(sorted, 50)), p95: round(percentile(sorted, 95)), p99: round(percentile(sorted, 99)), max: round(sorted[sorted.length - 1] ?? NaN), mean: round(mean) }
}

export interface PlanEntry {
  normalized: string
  count: number
  totalMs: number
  maxMs: number
  query: string
  plan: string
}

/** Replaces literals in a statement so two runs of the same query count as one. */
export function normalizeQuery(query: string): string {
  return query
    .replace(/\s+/g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/\b\d+(\.\d+)?\b/g, '?')
    .replace(/\(\?(, ?\?)+\)/g, '(?...)')
    .trim()
}

/**
 * Reads the plans that auto_explain wrote to the server log from `offset` on (the log's size when the run started): each is "LOG:  duration: 123.4 ms  plan:" then
 * "Query Text: ..." then the plan, until the next log line. Grouped by normalised query text, slowest in total first.
 */
export function readPlans(logFile: string, offset: number): PlanEntry[] {
  if (!fs.existsSync(logFile)) return []
  const fd = fs.openSync(logFile, 'r')
  const size = fs.fstatSync(fd).size
  const buffer = Buffer.alloc(Math.max(0, size - offset))
  fs.readSync(fd, buffer, 0, buffer.length, offset)
  fs.closeSync(fd)
  const lines = buffer.toString('utf-8').split('\n')
  const entries = new Map<string, PlanEntry>()
  let current: { ms: number; text: string[] } | null = null
  const flush = () => {
    if (!current) return
    const block = current.text.join('\n')
    const queryMatch = /Query Text: ([\s\S]*?)\n\s*(?:Limit|Aggregate|Sort|Seq Scan|Index|Bitmap|Nested|Hash|Merge|Gather|Subquery|Result|Append|WindowAgg|GroupAggregate|HashAggregate|CTE|Unique|Insert|Update|Delete|ProjectSet|Materialize|Function Scan|Values Scan|LockRows|Group)/.exec(block)
    const query = (queryMatch?.[1] ?? block.split('\n')[0] ?? '').trim()
    const key = normalizeQuery(query).slice(0, 400)
    const existing = entries.get(key)
    if (!existing) entries.set(key, { normalized: key, count: 1, totalMs: current.ms, maxMs: current.ms, query, plan: block })
    else {
      existing.count += 1
      existing.totalMs += current.ms
      if (current.ms > existing.maxMs) {
        existing.maxMs = current.ms
        existing.plan = block
        existing.query = query
      }
    }
    current = null
  }
  for (const line of lines) {
    const start = /duration: ([\d.]+) ms\s+plan:/.exec(line)
    if (start && /LOG:/.test(line)) {
      flush()
      current = { ms: Number(start[1]), text: [] }
      continue
    }
    if (current) {
      // The next log line (a timestamp prefix) ends the plan.
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(line)) flush()
      else current.text.push(line)
    }
  }
  flush()
  return [...entries.values()].sort((a, b) => b.totalMs - a.totalMs)
}
