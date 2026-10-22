import { Prisma, type PrismaClient } from '@prisma/client'

export type Db = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>

/** One measured number: what, for what (a cohort week, a channel, a place; empty when it is one number for everybody), and the counts it was divided from. */
export interface MetricRow {
  key: string
  dimension: string
  value: number
  detail?: Record<string, number | string | null>
}

/**
 * Narrows every metric to a set of people. Production never passes it; the tests do, so that numbers about a database shared with other tests can be checked exactly.
 * It applies to the person each number is about (the user who was active, the author, the recipient, a participant, the owner of a crew, the reported person).
 */
export interface MetricsScope {
  userIds?: readonly string[]
}

/** The condition that `alias`."id" is in scope. */
export function inScope(scope: MetricsScope | undefined, alias: string): Prisma.Sql {
  if (!scope?.userIds) return Prisma.sql`TRUE`
  return Prisma.sql`${Prisma.raw(`${alias}."id"`)} = ANY(${[...scope.userIds]}::text[])`
}

/** The same for a column that holds a user id. */
export function columnInScope(scope: MetricsScope | undefined, column: string): Prisma.Sql {
  if (!scope?.userIds) return Prisma.sql`TRUE`
  return Prisma.sql`${Prisma.raw(column)} = ANY(${[...scope.userIds]}::text[])`
}

export const num = (value: bigint | number | string | null | undefined): number => Number(value ?? 0)

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

export const row = (key: string, value: number | null, detail?: MetricRow['detail'], dimension = ''): MetricRow[] => (value === null || !Number.isFinite(value) ? [] : [{ key, dimension, value, ...(detail ? { detail } : {}) }])
