import type { Prisma, VerificationLevel } from '@prisma/client'

export const VERIFICATION_LEVEL_RANK: Record<VerificationLevel, number> = {
  NONE: 0,
  EMAIL: 1,
  PHONE: 2,
  GITHUB: 3,
  PORTFOLIO: 4,
  ORGANIZATION: 5,
  IDENTITY: 6,
}

/** The higher of two levels; a level is only ever raised, never lowered. */
export function atLeast(current: VerificationLevel, minimum: VerificationLevel): VerificationLevel {
  return VERIFICATION_LEVEL_RANK[current] >= VERIFICATION_LEVEL_RANK[minimum] ? current : minimum
}

/**
 * Brings a user's verification state up to what Clerk reports: a verified
 * primary email means at least EMAIL, a connected GitHub account means at least
 * GITHUB (plus the Verification row). Nothing here can lower a level.
 */
export async function applyVerification(
  tx: Prisma.TransactionClient,
  userId: string,
  signals: { emailVerified: boolean; githubConnected: boolean }
): Promise<void> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { verificationLevel: true, isEmailVerified: true, githubConnected: true },
  })
  if (!user) return

  let level = user.verificationLevel
  if (signals.emailVerified) level = atLeast(level, 'EMAIL')
  if (signals.githubConnected) level = atLeast(level, 'GITHUB')

  const data: Prisma.UserUpdateInput = {}
  if (level !== user.verificationLevel) data.verificationLevel = level
  if (signals.emailVerified && !user.isEmailVerified) {
    data.isEmailVerified = true
    data.emailVerified = new Date()
  }
  if (signals.githubConnected && !user.githubConnected) data.githubConnected = true
  if (Object.keys(data).length > 0) await tx.user.update({ where: { id: userId }, data })

  if (signals.githubConnected) {
    const existing = await tx.verification.findFirst({ where: { userId, type: 'GITHUB' } })
    if (!existing) {
      await tx.verification.create({
        data: { userId, type: 'GITHUB', status: 'VERIFIED', provider: 'github', verifiedAt: new Date() },
      })
    } else if (existing.status !== 'VERIFIED') {
      await tx.verification.update({
        where: { id: existing.id },
        data: { status: 'VERIFIED', verifiedAt: new Date() },
      })
    }
  }
}
