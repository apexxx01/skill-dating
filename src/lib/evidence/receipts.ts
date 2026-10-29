import { Prisma, type EvidenceReceipt, type PrismaClient, type ReceiptStatus } from '@prisma/client'
import { createHash } from 'node:crypto'
import { cardsAllowed } from '@/lib/age-policy'
import { anonymousSource, GitHubBudget, GitHubBudgetExceededError, GitHubRateLimitedError, openGitHub, resolveGitHubAuth, serverTokenSource, type GitHubApi } from '@/lib/infra/github'
import { log } from '@/lib/log'
import { accountState } from '@/lib/moderation/restrictions'
import { isKilled } from '@/lib/ops/kill-switches'
import { loadConsentStates } from '@/lib/privacy/consent'
import { visibilityOf } from '@/lib/privacy/settings'
import { canonicalHash } from './canonical'
import { getKeySet } from './keys'
import { newReceiptId } from './receipt-id'
import { signEnvelope, type KeySet, type ReceiptEnvelope } from './signing'
import { SOURCE_WEIGHT } from './strength'

// Evidence receipts (docs/PROOF.md): issuing one for a piece of engine evidence, signing what was left unsigned, rechecking that the source still shows
// what a receipt says, and the public view of one. A receipt's facts never change after it is issued: new facts are a new receipt. A recheck changes only
// its status, and lowers (never zeroes, never deletes) the weight of the evidence it backs.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export const RECEIPT_SOURCE_LABEL = { GITHUB: 'github' } as const

export function envelopeOf(receipt: Pick<EvidenceReceipt, 'id' | 'userId' | 'source' | 'sourceRef' | 'sourceUrl' | 'factsVersion' | 'facts' | 'payloadHash' | 'capturedAt'>, kid: string): ReceiptEnvelope {
  return {
    v: 1,
    id: receipt.id,
    subject: { platform: 'skill-dating', userId: receipt.userId },
    source: RECEIPT_SOURCE_LABEL[receipt.source],
    sourceRef: receipt.sourceRef,
    sourceUrl: receipt.sourceUrl,
    factsVersion: receipt.factsVersion,
    facts: receipt.facts as Record<string, unknown>,
    payloadHash: receipt.payloadHash,
    capturedAt: receipt.capturedAt.toISOString(),
    kid,
  }
}

export interface IssueInput {
  userId: string
  repoEvidenceId: string | null
  /** What the facts are about: `repo:<id>@commit:<sha>` or `repo:<id>@pr:<number>`. The facts' hash is appended, so new facts make a new receipt. */
  sourceRef: string
  sourceUrl: string
  factsVersion: number
  facts: Record<string, unknown>
  capturedAt: Date
}

/** The receipt for these facts: the one already issued for exactly them, or a new one, signed when a key may sign. */
export async function issueReceipt(tx: Tx, input: IssueInput, keys: KeySet = getKeySet()): Promise<{ receipt: EvidenceReceipt; created: boolean }> {
  const payloadHash = canonicalHash(input.facts)
  const sourceRef = `${input.sourceRef}/facts:${payloadHash.slice(0, 16)}`
  const existing = await tx.evidenceReceipt.findUnique({ where: { userId_source_sourceRef: { userId: input.userId, source: 'GITHUB', sourceRef } } })
  if (existing) {
    if (existing.repoEvidenceId !== input.repoEvidenceId && input.repoEvidenceId) await tx.evidenceReceipt.update({ where: { id: existing.id }, data: { repoEvidenceId: input.repoEvidenceId } })
    return { receipt: existing, created: false }
  }
  const draft = { id: newReceiptId(), userId: input.userId, source: 'GITHUB' as const, sourceRef, sourceUrl: input.sourceUrl, factsVersion: input.factsVersion, facts: input.facts as Prisma.InputJsonValue, payloadHash, capturedAt: input.capturedAt }
  const key = keys.active
  const signature = key ? signEnvelope(envelopeOf({ ...draft, facts: input.facts as Prisma.JsonValue }, key.kid), key) : null
  const receipt = await tx.evidenceReceipt.create({
    data: { ...draft, repoEvidenceId: input.repoEvidenceId, kid: key?.kid ?? null, signature, signedAt: key ? input.capturedAt : null, lastCheckedAt: input.capturedAt },
  })
  return { receipt, created: true }
}

/**
 * Signs the receipts a deployment issued while it had no signing key (production without RECEIPT_SIGNING_KEYS). The signature covers the facts and the
 * moment they were captured, which are unchanged, so signing later states exactly what signing then would have. Run after setting the key.
 */
export async function signBacklog(db: Db, limit = 1000, keys: KeySet = getKeySet()): Promise<{ signed: number; mode: KeySet['mode'] }> {
  const key = keys.active
  if (!key) return { signed: 0, mode: keys.mode }
  const rows = await db.evidenceReceipt.findMany({ where: { signature: null, status: { not: 'REVOKED' } }, orderBy: { createdAt: 'asc' }, take: limit })
  let signed = 0
  for (const row of rows) {
    const signature = signEnvelope(envelopeOf(row, key.kid), key)
    const { count } = await db.evidenceReceipt.updateMany({ where: { id: row.id, signature: null }, data: { kid: key.kid, signature, signedAt: new Date() } })
    signed += count
  }
  return { signed, mode: keys.mode }
}

// --- Rechecking ------------------------------------------------------------------------------------------------------

const REF = /^repo:(\d{1,20})@(?:commit:([0-9a-f]{7,40})|pr:(\d{1,10}))(?:\/|$)/

export function parseSourceRef(ref: string): { repoId: string; sha: string | null; pull: number | null } | null {
  const m = REF.exec(ref)
  return m ? { repoId: m[1], sha: m[2] ?? null, pull: m[3] ? Number(m[3]) : null } : null
}

/** What the source shows now: VALID, SOURCE_CHANGED (it exists but no longer shows it) or SOURCE_GONE (gone or no longer public). */
export async function checkSource(api: GitHubApi, receipt: Pick<EvidenceReceipt, 'sourceRef' | 'facts'>): Promise<ReceiptStatus> {
  const ref = parseSourceRef(receipt.sourceRef)
  if (!ref) return 'SOURCE_CHANGED'
  const repo = await api.repoById(ref.repoId)
  if (!repo || repo.private) return 'SOURCE_GONE'
  const authorId = ((receipt.facts as { author?: { githubId?: string } } | null)?.author?.githubId ?? null) as string | null
  if (ref.sha) {
    const commit = await api.commit(repo.fullName, ref.sha)
    return commit && commit.authorId === authorId ? 'VALID' : 'SOURCE_CHANGED'
  }
  if (ref.pull !== null) {
    const pull = await api.pull(repo.fullName, ref.pull)
    return pull && pull.mergedAt && pull.authorId === authorId ? 'VALID' : 'SOURCE_CHANGED'
  }
  return 'SOURCE_CHANGED'
}

/** Records a recheck: the receipt's status, and the weight of the evidence it backs (from its newest receipt). Never deletes. */
export async function applyRecheck(db: Db | Tx, receipt: Pick<EvidenceReceipt, 'id' | 'repoEvidenceId'>, status: ReceiptStatus, now: Date): Promise<void> {
  await db.evidenceReceipt.update({ where: { id: receipt.id }, data: { status, lastCheckedAt: now } })
  if (!receipt.repoEvidenceId) return
  const newest = await db.evidenceReceipt.findFirst({ where: { repoEvidenceId: receipt.repoEvidenceId, status: { not: 'REVOKED' } }, orderBy: { capturedAt: 'desc' }, select: { id: true, status: true } })
  if (newest?.id === receipt.id) await db.githubRepoEvidence.update({ where: { id: receipt.repoEvidenceId }, data: { sourceWeight: SOURCE_WEIGHT[status] } })
}

/** Receipts looked at per nightly run, and the GitHub calls the run may make. */
export const RECHECK_BATCH = 60
export const RECHECK_CALLS = 150

/**
 * The nightly recheck (job receipts/recheck): the receipts checked longest ago, with the server's own GitHub access (public data needs nobody's token).
 * Budgeted and idempotent: running it twice only checks the next-oldest ones. A source that is gone lowers the evidence's weight; nothing is deleted and
 * nobody is penalised.
 */
export async function runRecheckJob(db: Db, now: Date = new Date(), options: { batch?: number; calls?: number } = {}): Promise<{ checked: number; changed: number; stopped: string | null }> {
  if (await isKilled(db, 'evidence_engine')) return { checked: 0, changed: 0, stopped: 'paused' }
  const auth = await resolveGitHubAuth({ userId: 'recheck', clerkId: null }, [serverTokenSource, anonymousSource])
  const { api } = openGitHub(auth, new GitHubBudget(options.calls ?? RECHECK_CALLS))
  const due = await db.evidenceReceipt.findMany({ where: { status: { in: ['VALID', 'SOURCE_CHANGED', 'SOURCE_GONE'] } }, orderBy: { lastCheckedAt: 'asc' }, take: options.batch ?? RECHECK_BATCH, select: { id: true, sourceRef: true, facts: true, status: true, repoEvidenceId: true } })
  let checked = 0
  let changed = 0
  for (const receipt of due) {
    let status: ReceiptStatus
    try {
      status = await checkSource(api, receipt)
    } catch (error) {
      if (error instanceof GitHubBudgetExceededError || error instanceof GitHubRateLimitedError) return { checked, changed, stopped: error instanceof GitHubBudgetExceededError ? 'budget' : 'rate-limited' }
      log.warn('could not recheck a receipt', { error, receiptId: receipt.id })
      continue
    }
    await applyRecheck(db, receipt, status, now)
    checked += 1
    if (status !== receipt.status) changed += 1
  }
  return { checked, changed, stopped: null }
}

// --- The public view ---------------------------------------------------------------------------------------------------

export interface PublicReceipt {
  receipt: {
    id: string
    status: ReceiptStatus
    lastCheckedAt: string
    signed: boolean
    /** Exactly what was signed: canonicalise it (RFC 8785) and verify the signature with the key its kid names. Null kid and signature while unsigned. */
    envelope: ReceiptEnvelope | Omit<ReceiptEnvelope, 'kid'> & { kid: null }
    signature: string | null
  }
  owner: { username: string; name: string | null }
  verify: { keys: string; algorithm: 'Ed25519'; canonicalization: 'RFC 8785 (JCS)' }
}

export type PublicReceiptOutcome = { kind: 'ok'; body: PublicReceipt; etag: string } | { kind: 'not-found' } | { kind: 'gone' }

/**
 * A receipt as anybody may see it, signed in or not (GET /api/receipts/{id}). The same 404 whether it never existed or may not be shown, so the address
 * cannot be used to learn which:
 *   404  the owner is closed for their age, suspended, banned or in invisible mode; their GitHub handle is not PUBLIC on their passport; they withdrew the
 *        GITHUB_SYNC consent; the claim was hidden by a moderator; or they are not known to be an adult (the share-card rule: a minor's work is not put on
 *        the open web, and an account with no date of birth is not known to be an adult);
 *   410  the receipt was revoked or the account deleted.
 */
export async function publicReceipt(db: Db, id: string, now: Date = new Date()): Promise<PublicReceiptOutcome> {
  const row = await db.evidenceReceipt.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, username: true, name: true, deletedAt: true, birthDate: true, birthDateRefusedAt: true, profile: { select: { invisibleMode: true, fieldVisibility: true } } } },
      repoEvidence: { select: { moderatedAt: true } },
    },
  })
  if (!row) return { kind: 'not-found' }
  if (row.status === 'REVOKED' || row.user.deletedAt) return { kind: 'gone' }
  const user = row.user
  if (user.birthDateRefusedAt || user.profile?.invisibleMode || !cardsAllowed(user.birthDate, now)) return { kind: 'not-found' }
  if (visibilityOf(user.profile?.fieldVisibility).githubUsername !== 'PUBLIC') return { kind: 'not-found' }
  if (row.repoEvidence?.moderatedAt) return { kind: 'not-found' }
  const state = await accountState(db as never, user.id, undefined, now)
  if (state.banned || state.suspendedUntil) return { kind: 'not-found' }
  if (!(await loadConsentStates(db, user.id)).GITHUB_SYNC.current) return { kind: 'not-found' }

  const envelope = row.kid ? envelopeOf(row, row.kid) : { ...envelopeOf(row, ''), kid: null }
  const body: PublicReceipt = {
    receipt: { id: row.id, status: row.status, lastCheckedAt: row.lastCheckedAt.toISOString(), signed: row.signature !== null, envelope, signature: row.signature },
    owner: { username: user.username, name: user.name },
    verify: { keys: '/api/receipts/keys', algorithm: 'Ed25519', canonicalization: 'RFC 8785 (JCS)' },
  }
  return { kind: 'ok', body, etag: `"rc-${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24)}"` }
}
