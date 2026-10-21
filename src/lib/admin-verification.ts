import type { Prisma, PrismaClient, VerificationLevel } from '@prisma/client'
import { atLeast } from '@/lib/verification'

// What only an admin can grant (docs/SECURITY.md, "Authorization"): the verified-organisation mark, a verified portfolio, a verified identity. Granting raises
// the person's verification level; taking one back lowers the level to what is still proven. Every change is audited with the old and the new state.

type Db = PrismaClient

export const ADMIN_MARKS = ['organizationVerified', 'portfolioVerified', 'identityVerified'] as const
export type AdminMark = (typeof ADMIN_MARKS)[number]

/** Pure: the level a person's flags prove. */
export function levelFromFlags(flags: { isEmailVerified: boolean; isPhoneVerified: boolean; githubConnected: boolean; portfolioVerified: boolean; organizationVerified: boolean; identityVerified: boolean }): VerificationLevel {
  let level: VerificationLevel = 'NONE'
  if (flags.isEmailVerified) level = atLeast(level, 'EMAIL')
  if (flags.isPhoneVerified) level = atLeast(level, 'PHONE')
  if (flags.githubConnected) level = atLeast(level, 'GITHUB')
  if (flags.portfolioVerified) level = atLeast(level, 'PORTFOLIO')
  if (flags.organizationVerified) level = atLeast(level, 'ORGANIZATION')
  if (flags.identityVerified) level = atLeast(level, 'IDENTITY')
  return level
}

const flagsSelect = { isEmailVerified: true, isPhoneVerified: true, githubConnected: true, portfolioVerified: true, organizationVerified: true, identityVerified: true, verificationLevel: true } as const

export async function setAdminMarks(db: Db, input: { userId: string; adminId: string; marks: Partial<Record<AdminMark, boolean>>; reason: string }) {
  return db.$transaction(async (tx) => {
    const before = await tx.user.findUnique({ where: { id: input.userId }, select: flagsSelect })
    if (!before) return null
    const next = { ...before, ...input.marks }
    const data: Prisma.UserUpdateInput = { ...input.marks, verificationLevel: levelFromFlags(next) }
    const after = await tx.user.update({ where: { id: input.userId }, data, select: flagsSelect })
    await tx.auditEvent.create({ data: { userId: input.adminId, action: 'VERIFICATION_CHANGED', targetType: 'USER', targetId: input.userId, oldValue: before, newValue: { ...after, reason: input.reason } } })
    return after
  })
}
