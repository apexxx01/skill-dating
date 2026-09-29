import { z } from 'zod'

export const MAX_MILESTONES_PER_PROJECT = 100

export const milestoneSelect = {
  id: true,
  projectId: true,
  title: true,
  description: true,
  dueDate: true,
  completedAt: true,
  order: true,
  createdAt: true,
  updatedAt: true,
} as const

export function milestoneResponse<T extends { completedAt: Date | null }>(milestone: T) {
  return { ...milestone, completed: milestone.completedAt !== null }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

// An ISO date (2026-03-01) or ISO datetime (validated as a string; callers
// convert with new Date(value), because validateBody needs input === output). Deliberately
// not Date.parse-lenient (which would read "1" as the year 2001) and bounded
// to sane years.
export const dueDateSchema = z
  .string()
  .max(40)
  .refine((value) => {
    const isIsoDateTime = z.string().datetime({ offset: true }).safeParse(value).success
    if (!DATE_ONLY.test(value) && !isIsoDateTime) return false
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return false
    const year = parsed.getUTCFullYear()
    return year >= 1970 && year <= 2200
  }, { message: 'dueDate must be an ISO date or datetime' })
