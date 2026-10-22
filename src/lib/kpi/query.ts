import type { MetricsSnapshot, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { csvRow } from '@/lib/squads/organizer'
import { addDays, DAY_MS, formatDay, isDay, yesterday } from './days'
import { METRIC_DEFINITIONS, METRIC_KEYS, type MetricDefinition } from './definitions'

// Reading the snapshots back (GET /api/admin/metrics and its CSV): a range of days, optionally some keys, never more than a bounded number of rows.

export const MAX_RANGE_DAYS = 366
export const MAX_ROWS = 50_000
const DEFAULT_RANGE_DAYS = 30

export const metricsQuerySchema = z.object({
  from: z.string().max(10).refine(isDay, 'A day such as 2026-10-01').optional(),
  to: z.string().max(10).refine(isDay, 'A day such as 2026-10-31').optional(),
  keys: z.string().max(2000).optional(),
})

export type MetricsQueryInput = z.infer<typeof metricsQuerySchema>

export type ParsedRange = { ok: true; from: string; to: string; keys: string[] | null } | { ok: false; field: 'from' | 'to' | 'keys'; message: string }

export function parseRange(input: MetricsQueryInput, now: Date = new Date()): ParsedRange {
  const to = input.to ?? yesterday(now)
  const from = input.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1))
  if (from > to) return { ok: false, field: 'from', message: 'from must not be after to' }
  if ((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS >= MAX_RANGE_DAYS) return { ok: false, field: 'to', message: `At most ${MAX_RANGE_DAYS} days` }
  let keys: string[] | null = null
  if (input.keys !== undefined && input.keys.trim() !== '') {
    keys = [...new Set(input.keys.split(',').map((key) => key.trim()).filter(Boolean))]
    const unknown = keys.filter((key) => !METRIC_KEYS.includes(key))
    if (keys.length === 0 || unknown.length > 0) return { ok: false, field: 'keys', message: `Unknown metric${unknown.length === 1 ? '' : 's'}: ${unknown.slice(0, 5).join(', ') || '(none given)'}` }
  }
  return { ok: true, from, to, keys }
}

export interface SnapshotRow {
  day: string
  key: string
  dimension: string
  value: number
  detail: Record<string, unknown> | null
}

const toRow = (row: MetricsSnapshot): SnapshotRow => ({ day: formatDay(row.day), key: row.key, dimension: row.dimension, value: row.value, detail: (row.detail as Record<string, unknown> | null) ?? null })

export async function readSnapshots(db: Pick<PrismaClient, 'metricsSnapshot'>, range: { from: string; to: string; keys: string[] | null }): Promise<{ rows: SnapshotRow[]; truncated: boolean; computedThrough: string | null }> {
  const found = await db.metricsSnapshot.findMany({
    where: { day: { gte: new Date(`${range.from}T00:00:00Z`), lte: new Date(`${range.to}T00:00:00Z`) }, ...(range.keys ? { key: { in: range.keys } } : {}) },
    orderBy: [{ key: 'asc' }, { dimension: 'asc' }, { day: 'asc' }],
    take: MAX_ROWS + 1,
  })
  const latest = await db.metricsSnapshot.aggregate({ _max: { day: true } })
  return { rows: found.slice(0, MAX_ROWS).map(toRow), truncated: found.length > MAX_ROWS, computedThrough: latest._max.day ? formatDay(latest._max.day) : null }
}

export function definitionsFor(keys: string[] | null): MetricDefinition[] {
  return keys ? METRIC_DEFINITIONS.filter((definition) => keys.includes(definition.key)) : [...METRIC_DEFINITIONS]
}

/** The rows as CSV: one line per day, metric and dimension. Cells go through csvCell, which guards against formulas in a spreadsheet. */
export function snapshotsCsv(rows: readonly SnapshotRow[]): string {
  const lines = [csvRow(['day', 'key', 'dimension', 'value', 'detail'])]
  for (const entry of rows) lines.push(csvRow([entry.day, entry.key, entry.dimension, entry.value, entry.detail ? JSON.stringify(entry.detail) : '']))
  return lines.join('\r\n') + '\r\n'
}
