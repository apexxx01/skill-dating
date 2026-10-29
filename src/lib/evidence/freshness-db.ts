import type { Prisma, PrismaClient } from '@prisma/client'
import { loadConsentStates } from '@/lib/privacy/consent'

// UserSkill.lastEvidencedAt: the newest evidence behind each of a person's skills, which skill freshness decays from (freshness.ts). Evidence the person
// added counts from when it was verified (or added); the engine's GitHub evidence from the person's last authored commit there. What counts for nothing
// does not count here either: endorsements, UNSUPPORTED claims, claims hidden by a moderator, and engine evidence while the GITHUB_SYNC consent is withdrawn.

type Db = PrismaClient | Prisma.TransactionClient

export async function refreshLastEvidenced(db: Db, userId: string): Promise<void> {
  const engineVisible = (await loadConsentStates(db, userId)).GITHUB_SYNC.current
  const [skills, evidence] = await Promise.all([
    db.userSkill.findMany({ where: { userId }, select: { id: true, skillId: true, lastEvidencedAt: true } }),
    db.skillEvidence.findMany({
      where: { userId, type: { not: 'PEER_ENDORSEMENT' }, OR: [{ support: null }, { support: 'SUPPORTED' }] },
      select: { skillId: true, type: true, verifiedAt: true, createdAt: true, repoEvidence: { select: { lastAuthoredAt: true, moderatedAt: true, support: true } } },
    }),
  ])
  const newest = new Map<string, Date>()
  for (const row of evidence) {
    let at: Date | null
    if (row.repoEvidence) {
      if (!engineVisible || row.repoEvidence.moderatedAt || row.repoEvidence.support !== 'SUPPORTED') continue
      at = row.repoEvidence.lastAuthoredAt
    } else {
      at = row.verifiedAt ?? row.createdAt
    }
    if (at && (!newest.has(row.skillId) || newest.get(row.skillId)!.getTime() < at.getTime())) newest.set(row.skillId, at)
  }
  for (const skill of skills) {
    const at = newest.get(skill.skillId) ?? null
    if ((skill.lastEvidencedAt?.getTime() ?? null) !== (at?.getTime() ?? null)) await db.userSkill.update({ where: { id: skill.id }, data: { lastEvidencedAt: at } })
  }
}
