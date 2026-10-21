import type { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { parseBirthDate } from '@/lib/age'
import { ageBandOf, type AgeBand } from '@/lib/age-policy'
import { clearMinorLocation } from '@/lib/birth-date'

// The correction of a locked date of birth: the only way a date changes once it is set (a person asks through the report flow with the reason
// BIRTHDATE_CORRECTION; an admin decides here). Always with a reason, always audited with the old and the new date. The response never carries a date.

export const correctBirthDateSchema = z
  .object({
    birthDate: z.string().max(32).refine((value) => parseBirthDate(value) !== null, 'A real date in the past such as 1995-06-15'),
    reason: z.string().trim().min(10, 'Say why, in at least 10 characters').max(1000),
  })
  .strict()

export type CorrectBirthDateInput = z.infer<typeof correctBirthDateSchema>

export type CorrectionResult =
  | { kind: 'NOT_FOUND' }
  | { kind: 'UNDER_MINIMUM' }
  | { kind: 'CORRECTED'; band: Exclude<AgeBand, 'UNDER_MINIMUM'>; changed: boolean }

/**
 * Sets a person's date of birth to `input.birthDate`, whatever it was (or was not) before, and clears an earlier refusal. A date that would put them under the
 * platform's minimum is NOT applied (a correction cannot be used to admit a child); the admin deals with that account through moderation. A correction
 * to 16 or 17 clears the place they have given down to nothing finer than a country. `onMinor` lets the romance mode remove itself from the account (it
 * is 18+), in the same transaction.
 */
export async function correctBirthDate(
  db: PrismaClient,
  adminId: string,
  userId: string,
  input: CorrectBirthDateInput,
  hooks: { onMinor?: (tx: Prisma.TransactionClient, userId: string) => Promise<void> } = {},
  now: Date = new Date()
): Promise<CorrectionResult> {
  const birthDate = parseBirthDate(input.birthDate, now)
  if (!birthDate) return { kind: 'NOT_FOUND' }
  const band = ageBandOf(birthDate, now)

  return db.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true, birthDate: true, deletedAt: true } })
    if (!target || target.deletedAt) return { kind: 'NOT_FOUND' as const }
    if (band === 'UNDER_MINIMUM') return { kind: 'UNDER_MINIMUM' as const }

    const changed = !target.birthDate || target.birthDate.getTime() !== birthDate.getTime()
    await tx.user.update({ where: { id: userId }, data: { birthDate, birthDateRefusedAt: null } })
    if (band === 'MINOR') {
      await clearMinorLocation(tx, userId)
      await hooks.onMinor?.(tx, userId)
    }
    // Both dates are kept in the audit trail (an admin-only table; no route reads it), because a correction that cannot be traced is worth nothing.
    await tx.auditEvent.create({
      data: {
        userId: adminId,
        action: 'BIRTH_DATE_CORRECTED',
        targetType: 'USER',
        targetId: userId,
        oldValue: { birthDate: target.birthDate ? target.birthDate.toISOString().slice(0, 10) : null },
        newValue: { birthDate: input.birthDate, band, reason: input.reason },
      },
    })
    return { kind: 'CORRECTED' as const, band, changed }
  })
}
