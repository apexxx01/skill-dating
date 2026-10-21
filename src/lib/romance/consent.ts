import type { PrismaClient } from '@prisma/client'
import { getStorage } from '@/lib/infra/storage'
import { withdrawConsent } from '@/lib/privacy/consent'
import { purgeRomance, removeObjects } from './lifecycle'

// Withdrawing consent to the romance mode (DELETE /api/users/me/consents/ROMANCE_MODE): the mode is turned off AND what it holds is deleted: the profile
// with its private filters, the photos and their objects, the drops, pending sparks, and the reveal state; open romance matches end silently
// (lifecycle.ts purgeRomance, the same path as leaving the mode). Kept: only what moderation or the law needs (reports and their snapshots, actions,
// the audit trail), as docs/PRIVACY.md says.
export async function withdrawRomanceConsent(db: PrismaClient, userId: string, now: Date = new Date()): Promise<boolean> {
  let objectKeys: string[] = []
  const withdrawn = await db.$transaction(async (tx) => {
    const had = await withdrawConsent(tx, userId, 'ROMANCE_MODE', now)
    objectKeys = (await purgeRomance(tx, userId, now)).objectKeys
    await tx.auditEvent.create({ data: { userId, action: 'CONSENT_WITHDRAWN', targetType: 'USER', targetId: userId, newValue: { type: 'ROMANCE_MODE', dataDeleted: true } } })
    return had
  })
  if (objectKeys.length > 0) await removeObjects(getStorage(), objectKeys)
  return withdrawn
}
