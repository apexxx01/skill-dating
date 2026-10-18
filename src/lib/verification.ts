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
 * primary email means at least EMAIL, a verified phone number means at least
 * PHONE (plus the Verification row), a connected GitHub account means at least
 * GITHUB (plus the Verification row). Nothing here can lower a level or switch a
 * verified flag back off: a person who removes a number in Clerk keeps what that
 * number proved, the same as for GitHub. Phone numbers are optional in Clerk (the
 * instance may have them disabled), in which case `phoneVerified` is simply false.
 */
export async function applyVerification(
  tx: Prisma.TransactionClient,
  userId: string,
  signals: { emailVerified: boolean; githubConnected: boolean; phoneVerified?: boolean }
): Promise<void> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { verificationLevel: true, isEmailVerified: true, isPhoneVerified: true, githubConnected: true },
  })
  if (!user) return

  let level = user.verificationLevel
  if (signals.emailVerified) level = atLeast(level, 'EMAIL')
  if (signals.phoneVerified) level = atLeast(level, 'PHONE')
  if (signals.githubConnected) level = atLeast(level, 'GITHUB')

  const data: Prisma.UserUpdateInput = {}
  if (level !== user.verificationLevel) data.verificationLevel = level
  if (signals.emailVerified && !user.isEmailVerified) {
    data.isEmailVerified = true
    data.emailVerified = new Date()
  }
  if (signals.phoneVerified && !user.isPhoneVerified) data.isPhoneVerified = true
  if (signals.githubConnected && !user.githubConnected) data.githubConnected = true
  if (Object.keys(data).length > 0) await tx.user.update({ where: { id: userId }, data })

  if (signals.phoneVerified) {
    const existing = await tx.verification.findFirst({ where: { userId, type: 'PHONE' } })
    if (!existing) {
      await tx.verification.create({ data: { userId, type: 'PHONE', status: 'VERIFIED', provider: 'clerk', verifiedAt: new Date() } })
    } else if (existing.status !== 'VERIFIED') {
      await tx.verification.update({ where: { id: existing.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } })
    }
  }

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
