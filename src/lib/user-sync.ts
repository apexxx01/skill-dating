import { Prisma, type PrismaClient } from '@prisma/client'
import type { User as ClerkUser } from '@clerk/nextjs/server'
import { prisma } from '@/lib/prisma'
import { isCurrentUsernameFor, resolveUsername } from '@/lib/username'
import { applyVerification } from '@/lib/verification'

// Keeps the local User row in step with the Clerk account. Two entry points use
// this: the first authenticated request (lazy upsert) and the Clerk webhook.
// Rules, in short (the reasoning is in docs/AUTH_MIGRATION.md):
//  - a row is found by clerkId first; only if there is none is it linked by
//    email, and only when Clerk says that email is verified;
//  - an email that belongs to a row already bound to another Clerk account is
//    never taken over (AccountConflictError);
//  - the username is copied from Clerk, with a deterministic suffix on collision;
//  - verification only ever moves up.

export const SELECTED_USER_FIELDS = {
  id: true,
  email: true,
  name: true,
  username: true,
  image: true,
  role: true,
  deletedAt: true,
} satisfies Prisma.UserSelect

export type LocalUser = Prisma.UserGetPayload<{ select: typeof SELECTED_USER_FIELDS }>

/** The email is verified, but belongs to a local account bound to a different Clerk user. */
export class AccountConflictError extends Error {
  constructor(message = 'This email belongs to a different account') {
    super(message)
    this.name = 'AccountConflictError'
  }
}

export interface ClerkFacts {
  clerkId: string
  /** Lowercased primary email, or null when the account has none. */
  email: string | null
  /** True only when Clerk reports the primary email as verified. */
  emailVerified: boolean
  githubConnected: boolean
  username: string | null
  name: string | null
  image: string | null
}

export function extractClerkFacts(cu: ClerkUser): ClerkFacts {
  const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId) ?? null
  const email = primary?.emailAddress?.trim().toLowerCase() || null
  const name = [cu.firstName, cu.lastName].filter(Boolean).join(' ').trim()
  return {
    clerkId: cu.id,
    email,
    emailVerified: Boolean(email) && primary?.verification?.status === 'verified',
    githubConnected: cu.externalAccounts.some(
      (a) => /github/i.test(String(a.provider)) && a.verification?.status === 'verified'
    ),
    username: cu.username ?? null,
    name: name || cu.username || null,
    image: cu.hasImage ? cu.imageUrl : null,
  }
}

/** An address that cannot receive mail and cannot collide with a real one. */
export function placeholderEmail(clerkId: string): string {
  return `clerk_${clerkId.toLowerCase().replace(/[^a-z0-9]/g, '')}@no-email.invalid`
}

type Tx = Prisma.TransactionClient

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

async function usernameHolder(tx: Tx, username: string): Promise<string | null> {
  const row = await tx.user.findUnique({ where: { username }, select: { id: true } })
  return row?.id ?? null
}

/**
 * The username to store, or null to leave the current one alone: Clerk has no
 * username for the account, or the current name is already one this account
 * would be given (so an earlier collision suffix is kept while it is valid).
 */
async function chosenUsername(tx: Tx, facts: ClerkFacts, current: string, ownerId: string): Promise<string | null> {
  if (!facts.username) return null
  if (isCurrentUsernameFor(current, facts.username, facts.clerkId)) return null
  return resolveUsername(facts.username, facts.clerkId, (u) => usernameHolder(tx, u), ownerId)
}

async function findLegacyRowByEmail(tx: Tx, email: string) {
  return tx.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, clerkId: true, username: true },
  })
}

async function syncInTransaction(tx: Tx, facts: ClerkFacts): Promise<LocalUser> {
  // One writer per Clerk account at a time: a second concurrent first request
  // waits here, then finds the row the first one created.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'clerk-sync:' + facts.clerkId}, 0))`

  const existing = await tx.user.findUnique({ where: { clerkId: facts.clerkId }, select: { id: true, username: true } })
  let userId: string

  if (existing) {
    userId = existing.id
    await updateExisting(tx, existing, facts)
  } else {
    const linkable = facts.emailVerified && facts.email ? await findLegacyRowByEmail(tx, facts.email) : null

    if (linkable) {
      if (linkable.clerkId !== null) throw new AccountConflictError()
      userId = linkable.id
      const username = await chosenUsername(tx, facts, linkable.username, userId)
      // Whoever proves this address through Clerk now owns the account. Anything that
      // could still let the previous claimant in (a password nobody verified the
      // address for, OAuth accounts linked to it) is removed, so a pre-registered
      // squatter cannot keep access to a victim's account after the victim links it.
      await tx.user.update({
        where: { id: userId },
        data: { clerkId: facts.clerkId, ...(username ? { username } : {}), lastActiveAt: new Date(), passwordHash: null },
      })
      await tx.account.deleteMany({ where: { userId } })
      await tx.session.deleteMany({ where: { userId } })
      await tx.auditEvent.create({
        data: { userId, action: 'USER_LINKED', targetType: 'USER', targetId: userId, newValue: { clerkId: facts.clerkId } },
      })
    } else {
      const created = await createRow(tx, facts)
      userId = created.id
    }
  }

  await applyVerification(tx, userId, { emailVerified: facts.emailVerified, githubConnected: facts.githubConnected })
  return tx.user.findUniqueOrThrow({ where: { id: userId }, select: SELECTED_USER_FIELDS })
}

async function createRow(tx: Tx, facts: ClerkFacts) {
  // An email that is not verified is never used to look anything up, and if a
  // row already has it we must not squat it: use the placeholder instead.
  let email = facts.email
  if (!facts.emailVerified || !email) {
    email = placeholderEmail(facts.clerkId)
  } else if (await findLegacyRowByEmail(tx, email)) {
    // Linking looked for this address a moment ago and found nothing; a row
    // appearing since then belongs to someone else and must not be taken over.
    throw new AccountConflictError()
  }
  const username = await resolveUsername(facts.username, facts.clerkId, (u) => usernameHolder(tx, u))
  const created = await tx.user.create({
    data: {
      clerkId: facts.clerkId,
      email,
      username,
      name: facts.name,
      image: facts.image,
    },
    select: { id: true },
  })
  await tx.auditEvent.create({
    data: { userId: created.id, action: 'USER_CREATED', targetType: 'USER', targetId: created.id },
  })
  return created
}

async function updateExisting(tx: Tx, existing: { id: string; username: string }, facts: ClerkFacts) {
  const data: Prisma.UserUpdateInput = { lastActiveAt: new Date() }

  // The username is owned by Clerk; a change there is applied through the same collision rule.
  const username = await chosenUsername(tx, facts, existing.username, existing.id)
  if (username && username !== existing.username) data.username = username

  // Email follows Clerk once it is verified, unless another row already holds it.
  if (facts.emailVerified && facts.email) {
    const holder = await findLegacyRowByEmail(tx, facts.email)
    if (!holder) data.email = facts.email
  }

  // Profile fields people can edit locally are only filled in when empty.
  const current = await tx.user.findUnique({ where: { id: existing.id }, select: { name: true, image: true } })
  if (current && !current.name && facts.name) data.name = facts.name
  if (current && !current.image && facts.image) data.image = facts.image

  await tx.user.update({ where: { id: existing.id }, data })
}

/** Written outside the sync transaction, which the conflict rolls back. Never blocks the answer. */
async function recordConflict(db: PrismaClient, clerkId: string): Promise<void> {
  try {
    await db.auditEvent.create({
      data: { action: 'ACCOUNT_LINK_CONFLICT', targetType: 'USER', targetId: clerkId, newValue: { clerkId } },
    })
  } catch (error) {
    console.error('could not record account conflict:', error instanceof Error ? error.message : error)
  }
}

/**
 * Creates, links or updates the local row for a Clerk account and returns it.
 * Safe to call concurrently for the same account. Retries only when a unique
 * constraint was lost to a different account that raced for the same username.
 */
export async function syncClerkUser(cu: ClerkUser, db: PrismaClient = prisma): Promise<LocalUser> {
  const facts = extractClerkFacts(cu)
  const attempts = 5
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction((tx) => syncInTransaction(tx, facts), { timeout: 15_000 })
    } catch (error) {
      if (attempt < attempts && isUniqueViolation(error)) continue
      if (error instanceof AccountConflictError) await recordConflict(db, facts.clerkId)
      throw error
    }
  }
}

/**
 * Handles a deleted Clerk account: the row is anonymised and detached, not
 * deleted (57 relations cascade from User, so a delete would remove the
 * person's projects, teams, messages and endorsements for everyone else).
 * Returns false when there is no local row for that Clerk id.
 */
export async function tombstoneClerkUser(clerkId: string, db: PrismaClient = prisma): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'clerk-sync:' + clerkId}, 0))`
    const row = await tx.user.findUnique({ where: { clerkId }, select: { id: true } })
    if (!row) return false

    const tag = row.id.toLowerCase().replace(/[^a-z0-9]/g, '')
    // The tail of a cuid is its random part, so the shortened name stays unique.
    const shortTag = tag.slice(-20)
    await tx.user.update({
      where: { id: row.id },
      data: {
        deletedAt: new Date(),
        clerkId: null,
        email: `deleted_${tag}@deleted.invalid`,
        username: `deleted_${shortTag}`,
        passwordHash: null,
        name: null,
        image: null,
        bio: null,
        headline: null,
        location: null,
        timezone: null,
        availability: null,
        builderRole: null,
        website: null,
        githubUsername: null,
        twitterUsername: null,
        linkedinUrl: null,
        isEmailVerified: false,
        emailVerified: null,
        githubConnected: false,
      },
    })
    await tx.account.deleteMany({ where: { userId: row.id } })
    await tx.session.deleteMany({ where: { userId: row.id } })
    await tx.profile.deleteMany({ where: { userId: row.id } })
    await tx.verification.deleteMany({ where: { userId: row.id } })
    await tx.auditEvent.create({
      data: { userId: row.id, action: 'USER_DELETED', targetType: 'USER', targetId: row.id },
    })
    return true
  })
}
