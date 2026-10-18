import type { PrismaClient } from '@prisma/client'
import { blockedPeerIds } from '@/lib/blocks'
import { track } from '@/lib/infra/analytics'
import type { Storage } from '@/lib/infra/storage'
import { mediaUrl } from '@/lib/media-assets'
import { datingBlockers } from '@/lib/matching/dating'
import { datingFactsSelect } from '@/lib/matching/profile'
import { loadPersonSummaries } from '@/lib/matching/summary'
import { utcTimestamp } from '@/lib/sql'
import { addDaysToDateKey, localDateKey, localDateStart, localWeekKey, mondayOfDateKey } from '@/lib/time'
import type { DropStatus } from '@prisma/client'
import { ROMANCE_CONFIG, ROMANCE_MODE_LABEL } from './config'
import { toPublicProfile, type PublicRomanceProfile, type StoredRomanceProfile } from './profile'

// What the romance drop routes answer with: the one person of the week, as much of them as a stranger may see. NEVER a photo (only a placeholder with the blur hash, if
// they gave one), never the avatar (it is a photo too), never anything private (gender, age, place, filters, inbox gate).

type Db = PrismaClient

/** A photo of a person the viewer may not see yet: the place where it will be. */
export interface PhotoPlaceholder {
  id: string
  position: number
  blurHash: string | null
  revealed: false
}

/** A photo the viewer may see: only after both people agreed to a reveal and while the match is open. `url` is signed and short-lived. */
export interface RevealedPhoto {
  id: string
  position: number
  blurHash: string | null
  revealed: true
  url: string
  width: number
  height: number
}

export interface RomanceCandidateView {
  id: string
  name: string | null
  username: string
  headline: string | null
  builderRole: string | null
  level: number
  tier: string
  skills: { slug: string; name: string; level: number }[]
  proof: { verifiedEvidence: number; shipped: number }
  profile: PublicRomanceProfile
  photos: (PhotoPlaceholder | RevealedPhoto)[]
  /** Their avatar: a photo too, so it is here only once the photos are. */
  image?: string | null
}

export interface RomanceDropView {
  id: string
  score: number
  reasons: string[]
  status: DropStatus
  expiresAt: string
  candidate: RomanceCandidateView
}

export interface RomanceDropResponse {
  modeLabel: string
  weekKey: string
  /** Whether the caller has joined the mode, is not paused and may use it. */
  active: boolean
  drop: RomanceDropView | null
  /** When the next drop is made, or null while there is nothing to wait for (paused, not joined, or one is due within the hour). */
  nextDropAt: string | null
}

/** The instant a "HH:MM" on a calendar day happens in a zone. */
function localInstant(dateKey: string, clock: string, timeZone: string | null): Date {
  const [hours, minutes] = clock.split(':').map(Number)
  return new Date(localDateStart(dateKey, timeZone).getTime() + (hours * 60 + minutes) * 60_000)
}

export async function toCandidateView(db: Db, candidateId: string, profile: StoredRomanceProfile, reveal?: { storage: Pick<Storage, 'publicUrl' | 'signedReadUrl'> }): Promise<RomanceCandidateView | null> {
  const person = (await loadPersonSummaries(db, [candidateId])).get(candidateId)
  if (!person) return null
  const photos = await db.romancePhoto.findMany({ where: { profileId: profile.id }, orderBy: { position: 'asc' }, select: { id: true, position: true, blurHash: true, asset: { select: { key: true, width: true, height: true } } } })
  const shown: (PhotoPlaceholder | RevealedPhoto)[] = []
  for (const photo of photos) {
    shown.push(
      reveal
        ? { id: photo.id, position: photo.position, blurHash: photo.blurHash, revealed: true, url: await mediaUrl(reveal.storage as Storage, photo.asset.key), width: photo.asset.width, height: photo.asset.height }
        : { id: photo.id, position: photo.position, blurHash: photo.blurHash, revealed: false }
    )
  }
  return {
    id: person.id,
    name: person.name,
    username: person.username,
    headline: person.headline,
    builderRole: person.builderRole,
    level: person.level,
    tier: person.tier,
    skills: person.skills,
    proof: person.proof,
    profile: toPublicProfile(profile),
    photos: shown,
    ...(reveal ? { image: person.image } : {}),
  }
}

export async function loadRomanceDrop(db: Db, userId: string, now: Date = new Date()): Promise<RomanceDropResponse> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { timezone: true, ...datingFactsSelect, romanceProfile: { select: { paused: true, lastDropWeek: true } } } })
  const timezone = user?.timezone ?? null
  const weekKey = localWeekKey(now, timezone)
  const joined = user?.romanceProfile ?? null
  const active = Boolean(joined && !joined.paused && user && datingBlockers(user, now).length === 0)
  const base: RomanceDropResponse = { modeLabel: ROMANCE_MODE_LABEL, weekKey, active, drop: null, nextDropAt: null }
  if (!active || !joined) return base

  // Next: Monday's drop time of the next week if this week's is made, this Monday's if it is still to come.
  const monday = mondayOfDateKey(localDateKey(now, timezone))
  const thisMonday = localInstant(monday, ROMANCE_CONFIG.drop.timeLocal, timezone)
  const nextMonday = localInstant(addDaysToDateKey(monday, 7), ROMANCE_CONFIG.drop.timeLocal, timezone)
  base.nextDropAt = (joined.lastDropWeek === weekKey ? nextMonday : thisMonday.getTime() > now.getTime() ? thisMonday : null)?.toISOString() ?? null

  const row = await db.romanceDrop.findUnique({ where: { userId_weekKey: { userId, weekKey } } })
  if (!row) return base
  const [hidden, candidateProfile] = await Promise.all([blockedPeerIds(db, userId), db.romanceProfile.findUnique({ where: { userId: row.candidateId } })])
  // Someone who blocked the viewer since, who left the mode or whose account is gone is simply not there.
  if (hidden.includes(row.candidateId) || !candidateProfile) return base
  const candidate = await toCandidateView(db, row.candidateId, candidateProfile as unknown as StoredRomanceProfile)
  if (!candidate) return base

  // First sight: stamped once, and counted once even if two requests race (the database says which rows it changed).
  if (row.status === 'NEW' && row.viewedAt === null) {
    const seen = await db.$queryRaw<{ id: string }[]>`
      UPDATE "RomanceDrop" SET "viewedAt" = ${utcTimestamp(now)} WHERE "id" = ${row.id} AND "viewedAt" IS NULL RETURNING "id"
    `
    if (seen.length > 0) await track(userId, 'romance_drop_viewed', { dropId: row.id, score: row.score })
  }
  return {
    ...base,
    drop: { id: row.id, score: row.score, reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [], status: row.status, expiresAt: row.expiresAt.toISOString(), candidate },
  }
}
