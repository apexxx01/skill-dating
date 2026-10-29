import type { Prisma, PrismaClient } from '@prisma/client'
import { CURRENT_VERSIONS, loadConsentStates } from '@/lib/privacy/consent'
import { evidenceFreshnessSetting } from '@/lib/settings'
import { freshnessView, type Freshness } from './freshness'
import { evidenceWeight } from './strength'

// What the passport shows about a skill's proof, and the hook matching will read from Stage 1L (it does not change any score now): the strongest engine
// evidence behind the skill (its strength and weight), how many repositories and receipts back it, and the skill's freshness. Engine evidence counts only
// while its owner's GITHUB_SYNC consent is in force, and never when it is UNSUPPORTED or hidden by a moderator.

type Db = PrismaClient | Prisma.TransactionClient

export interface SkillProof {
  /** The strongest engine evidence behind the skill, 0 to 100 (0 when there is none). */
  strength: number
  /** Its weight, 0 to 1 (strength, the source still being there, integrity). */
  weight: number
  repos: number
  receipts: number
}

export const NO_PROOF: SkillProof = { strength: 0, weight: 0, repos: 0, receipts: 0 }

/** For each of these people, the proof behind each of their skills. People whose consent is not in force get none. */
export async function skillProofs(db: Db, userIds: readonly string[]): Promise<Map<string, Map<string, SkillProof>>> {
  const out = new Map<string, Map<string, SkillProof>>()
  if (userIds.length === 0) return out
  // The latest GITHUB_SYNC record of each person decides (consent.ts): in force when it is not withdrawn and is for the current version.
  const records = await db.consentRecord.findMany({ where: { userId: { in: [...userIds] }, type: 'GITHUB_SYNC' }, orderBy: { grantedAt: 'desc' }, select: { userId: true, withdrawnAt: true, version: true } })
  const latest = new Map<string, (typeof records)[number]>()
  for (const record of records) if (!latest.has(record.userId)) latest.set(record.userId, record)
  const visible = new Set([...latest.values()].filter((record) => !record.withdrawnAt && record.version >= CURRENT_VERSIONS.GITHUB_SYNC).map((record) => record.userId))
  if (visible.size === 0) return out
  const rows = await db.skillEvidence.findMany({
    where: { userId: { in: [...visible] }, repoEvidenceId: { not: null }, support: 'SUPPORTED' },
    select: { userId: true, skillId: true, integrityWeight: true, repoEvidence: { select: { strength: true, sourceWeight: true, support: true, moderatedAt: true, _count: { select: { receipts: { where: { status: { not: 'REVOKED' } } } } } } } },
  })
  for (const row of rows) {
    const repo = row.repoEvidence
    if (!repo || repo.moderatedAt || repo.support !== 'SUPPORTED') continue
    const weight = evidenceWeight({ strength: repo.strength, support: repo.support, sourceWeight: repo.sourceWeight, moderated: false, integrityWeight: row.integrityWeight })
    const perUser = out.get(row.userId) ?? new Map<string, SkillProof>()
    const current = perUser.get(row.skillId) ?? { ...NO_PROOF }
    perUser.set(row.skillId, { strength: Math.max(current.strength, repo.strength), weight: Math.max(current.weight, weight), repos: current.repos + 1, receipts: current.receipts + repo._count.receipts })
    out.set(row.userId, perUser)
  }
  return out
}

/** The matching feature hook (Stage 1L): per person and skill, the evidence weight and freshness. Exposed for the scorer; nothing reads it yet. */
export async function evidenceSignals(db: Db, userIds: readonly string[], now: Date = new Date()): Promise<Map<string, Map<string, { weight: number; freshness: number | null }>>> {
  const [proofs, skills, setting] = await Promise.all([skillProofs(db, userIds), db.userSkill.findMany({ where: { userId: { in: [...userIds] } }, select: { userId: true, skillId: true, lastEvidencedAt: true } }), evidenceFreshnessSetting(db as PrismaClient)])
  const out = new Map<string, Map<string, { weight: number; freshness: number | null }>>()
  for (const skill of skills) {
    const perUser = out.get(skill.userId) ?? new Map()
    perUser.set(skill.skillId, { weight: proofs.get(skill.userId)?.get(skill.skillId)?.weight ?? 0, freshness: freshnessView(skill.lastEvidencedAt, now, setting).freshness })
    out.set(skill.userId, perUser)
  }
  return out
}

export interface SkillProofView extends SkillProof {
  freshness: Freshness
}

export interface PassportProof {
  /** False while the GITHUB_SYNC consent is withdrawn (or was never given): nothing below is shown or counted then. */
  visible: boolean
  repos: number
  receipts: number
  /** Pull requests merged by other maintainers into repositories the person does not own. */
  upstream: number
  /** The strongest repositories, for the passport's proof section; each with its newest receipt for the verify link. */
  strongest: { fullName: string; url: string; strength: number; receiptId: string | null }[]
}

/** The passport's proof section (GET /api/users/{id}). UNSUPPORTED and moderator-hidden claims are left out; the owner sees theirs on GET /api/github. */
export async function passportProof(db: Db, userId: string): Promise<PassportProof> {
  const visible = (await loadConsentStates(db, userId)).GITHUB_SYNC.current
  if (!visible) return { visible: false, repos: 0, receipts: 0, upstream: 0, strongest: [] }
  const [repos, receipts, upstream, strongest] = await Promise.all([
    db.githubRepoEvidence.count({ where: { userId, support: 'SUPPORTED', moderatedAt: null } }),
    db.evidenceReceipt.count({ where: { userId, status: { not: 'REVOKED' }, OR: [{ repoEvidenceId: null }, { repoEvidence: { support: 'SUPPORTED', moderatedAt: null } }] } }),
    db.evidenceReceipt.count({ where: { userId, repoEvidenceId: null, status: { not: 'REVOKED' } } }),
    db.githubRepoEvidence.findMany({
      where: { userId, support: 'SUPPORTED', moderatedAt: null },
      orderBy: [{ strength: 'desc' }, { fullName: 'asc' }],
      take: 3,
      select: { fullName: true, url: true, strength: true, receipts: { where: { status: { not: 'REVOKED' } }, orderBy: { capturedAt: 'desc' }, take: 1, select: { id: true } } },
    }),
  ])
  return { visible: true, repos, receipts, upstream, strongest: strongest.map((row) => ({ fullName: row.fullName, url: row.url, strength: row.strength, receiptId: row.receipts[0]?.id ?? null })) }
}
