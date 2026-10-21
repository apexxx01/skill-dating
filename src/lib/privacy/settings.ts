import type { MessagePermission, Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'

// Privacy settings, in one place (GET/PATCH /api/users/me/privacy). Most live on Profile; pausing matching lives on the matching profile.
//
//   fieldVisibility     who sees each passport field: PUBLIC (everyone signed in), CONNECTIONS (people they are connected or matched with, or share a
//                       crew or project with), PRIVATE (only them). Applied on GET /api/users/{id} (applyFieldVisibility).
//   hideFromLeaderboards off every board and every rank others can see (moves their entries with a job).
//   hideFromRecruiters   out of any recruiter surface (none exists yet; recruiterVisible in src/lib/age-policy.ts is where one must ask).
//   matchingPaused       no daily drops, and not shown in anyone else's.
//   invisibleMode        left out of people search and discovery lists.
//   whoCanMessage        EVERYONE, CONNECTIONS or NOBODY may start a direct conversation (src/lib/privacy/messaging.ts).
//   showActivity         whether others see the contribution heatmap and streak.

type Db = PrismaClient

export const PASSPORT_FIELDS = ['bio', 'headline', 'location', 'website', 'githubUsername', 'twitterUsername', 'linkedinUrl', 'availability', 'builderRole', 'timezone'] as const
export type PassportField = (typeof PASSPORT_FIELDS)[number]
export const VISIBILITY_LEVELS = ['PUBLIC', 'CONNECTIONS', 'PRIVATE'] as const
export type Visibility = (typeof VISIBILITY_LEVELS)[number]

export const privacySchema = z
  .object({
    fieldVisibility: z.object(Object.fromEntries(PASSPORT_FIELDS.map((field) => [field, z.enum(VISIBILITY_LEVELS)])) as Record<PassportField, z.ZodEnum<['PUBLIC', 'CONNECTIONS', 'PRIVATE']>>).partial().strict(),
    hideFromLeaderboards: z.boolean(),
    hideFromRecruiters: z.boolean(),
    matchingPaused: z.boolean(),
    invisibleMode: z.boolean(),
    whoCanMessage: z.enum(['EVERYONE', 'CONNECTIONS', 'NOBODY']),
    showActivity: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one setting')

export type PrivacyInput = z.infer<typeof privacySchema>

export interface PrivacySettings {
  fieldVisibility: Record<PassportField, Visibility>
  hideFromLeaderboards: boolean
  hideFromRecruiters: boolean
  matchingPaused: boolean
  invisibleMode: boolean
  whoCanMessage: MessagePermission
  showActivity: boolean
}

/** Pure: every passport field with its level, PUBLIC when not set. */
export function visibilityOf(stored: unknown): Record<PassportField, Visibility> {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  return Object.fromEntries(PASSPORT_FIELDS.map((field) => [field, (VISIBILITY_LEVELS as readonly unknown[]).includes(raw[field]) ? (raw[field] as Visibility) : 'PUBLIC'])) as Record<PassportField, Visibility>
}

/** Pure: the profile with the fields this viewer may not see set to null. */
export function applyFieldVisibility<T extends Partial<Record<PassportField, unknown>>>(profile: T, visibility: Record<PassportField, Visibility>, viewer: { isOwner: boolean; connected: boolean }): T {
  if (viewer.isOwner) return profile
  const out = { ...profile }
  for (const field of PASSPORT_FIELDS) {
    if (!(field in out)) continue
    const level = visibility[field]
    if (level === 'PRIVATE' || (level === 'CONNECTIONS' && !viewer.connected)) (out as Record<string, unknown>)[field] = null
  }
  return out
}

export async function readPrivacy(db: Db, userId: string): Promise<PrivacySettings> {
  const [profile, matching] = await Promise.all([
    db.profile.findUnique({ where: { userId }, select: { fieldVisibility: true, hideFromLeaderboards: true, hideFromRecruiters: true, invisibleMode: true, whoCanMessage: true, showActivity: true } }),
    db.matchingProfile.findUnique({ where: { userId }, select: { paused: true } }),
  ])
  return {
    fieldVisibility: visibilityOf(profile?.fieldVisibility),
    hideFromLeaderboards: profile?.hideFromLeaderboards ?? false,
    hideFromRecruiters: profile?.hideFromRecruiters ?? false,
    matchingPaused: matching?.paused ?? false,
    invisibleMode: profile?.invisibleMode ?? false,
    whoCanMessage: profile?.whoCanMessage ?? 'EVERYONE',
    showActivity: profile?.showActivity ?? true,
  }
}

/** Saves the settings sent; the others keep what they were. Returns whether the leaderboard opt-out changed (the caller moves the entries). */
export async function savePrivacy(db: Db, userId: string, input: PrivacyInput): Promise<{ leaderboardChanged: boolean }> {
  const before = await readPrivacy(db, userId)
  const columns: Prisma.ProfileUncheckedUpdateInput = {}
  if (input.fieldVisibility) columns.fieldVisibility = { ...before.fieldVisibility, ...input.fieldVisibility }
  for (const key of ['hideFromLeaderboards', 'hideFromRecruiters', 'invisibleMode', 'whoCanMessage', 'showActivity'] as const) if (input[key] !== undefined) (columns as Record<string, unknown>)[key] = input[key]
  await db.$transaction(async (tx) => {
    if (Object.keys(columns).length > 0) await tx.profile.upsert({ where: { userId }, create: { ...(columns as Prisma.ProfileUncheckedCreateInput), userId }, update: columns })
    if (input.matchingPaused !== undefined) await tx.matchingProfile.updateMany({ where: { userId }, data: { paused: input.matchingPaused } })
    await tx.auditEvent.create({ data: { userId, action: 'PRIVACY_SETTINGS_CHANGED', targetType: 'USER', targetId: userId, newValue: input as Prisma.InputJsonValue } })
  })
  return { leaderboardChanged: input.hideFromLeaderboards !== undefined && input.hideFromLeaderboards !== before.hideFromLeaderboards }
}
