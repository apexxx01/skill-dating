import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { hasMarketingConsent, isSuppressed, loadChannelChoices, loadSettings, saveSettings, setChannelChoice, channelViews, settingsView, type SettingsChanges } from '@/lib/notify/settings'
import { channelPolicy, switchableKinds, type DeliveryKind } from '@/lib/notify/policy'
import { parseClock } from '@/lib/notify/quiet'
import { getPush } from '@/lib/infra/push'
import type { prisma as prismaClient } from '@/lib/prisma'

// How notifications reach the caller outside the app (docs/NOTIFICATIONS.md): the email and push switches, quiet hours, the digests, and for every kind of
// notification whether it comes by email and by push. In-app notifications have their own switches (GET/PUT /api/notifications/preferences) and are always shown.

const clock = z.string().max(5).regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time such as 22:00')

const kindChoice = z.object({ email: z.boolean().optional(), push: z.boolean().optional() }).strict()

const bodySchema = z
  .object({
    settings: z
      .object({
        emailEnabled: z.boolean().optional(),
        pushEnabled: z.boolean().optional(),
        quietHours: z.object({ enabled: z.boolean().optional(), start: clock.optional(), end: clock.optional() }).strict().optional(),
        dailyDigest: z.boolean().optional(),
        weeklyDigest: z.boolean().optional(),
      })
      .strict()
      .optional(),
    kinds: z
      .object(Object.fromEntries(switchableKinds().map((kind) => [kind, kindChoice.optional()])) as Record<string, z.ZodOptional<typeof kindChoice>>)
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.settings !== undefined || value.kinds !== undefined, 'Send settings, kinds or both')

async function view(prisma: typeof prismaClient, userId: string) {
  const [settings, choices, marketing, devices, account] = await Promise.all([
    loadSettings(prisma, userId),
    loadChannelChoices(prisma, userId),
    hasMarketingConsent(prisma, userId),
    prisma.pushSubscription.count({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, isEmailVerified: true } }),
  ])
  const undeliverable = account?.email ? await isSuppressed(prisma, account.email) : false
  return {
    settings: settingsView(settings),
    kinds: channelViews(choices),
    // Digests are mail the platform starts itself, so they need this consent (GET/POST /api/users/me/consents).
    marketingConsent: marketing,
    push: { devices, configured: getPush().kind === 'webpush' },
    // false when mail to the address bounced or was reported as spam: nothing is sent until it is changed (account notices included).
    email: { verified: Boolean(account?.isEmailVerified), undeliverable },
  }
}

export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await view(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'notifications:channels-get' } })

export const PUT = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  const { settings, kinds } = body.data

  const changes: SettingsChanges = {}
  if (settings) {
    if (settings.emailEnabled !== undefined) changes.emailEnabled = settings.emailEnabled
    if (settings.pushEnabled !== undefined) changes.pushEnabled = settings.pushEnabled
    if (settings.dailyDigest !== undefined) changes.dailyDigest = settings.dailyDigest
    if (settings.weeklyDigest !== undefined) changes.weeklyDigest = settings.weeklyDigest
    if (settings.quietHours?.enabled !== undefined) changes.quietEnabled = settings.quietHours.enabled
    if (settings.quietHours?.start !== undefined) changes.quietStart = parseClock(settings.quietHours.start)!
    if (settings.quietHours?.end !== undefined) changes.quietEnd = parseClock(settings.quietHours.end)!
  }
  // A channel a kind does not use cannot be switched on (a digest by push).
  for (const [kind, choice] of Object.entries(kinds ?? {})) {
    if (choice?.push !== undefined && channelPolicy(kind as DeliveryKind, 'PUSH').unavailable) return createApiError('VALIDATION_FAILED', { details: { kinds: [`${kind} is not sent by push`] } })
    if (choice?.email !== undefined && channelPolicy(kind as DeliveryKind, 'EMAIL').unavailable) return createApiError('VALIDATION_FAILED', { details: { kinds: [`${kind} is not sent by email`] } })
  }

  await prisma.$transaction(async (tx) => {
    if (Object.keys(changes).length > 0) await saveSettings(tx, user.id, changes)
    for (const [kind, choice] of Object.entries(kinds ?? {})) {
      if (choice?.email !== undefined) await setChannelChoice(tx, user.id, kind as DeliveryKind, 'EMAIL', choice.email)
      if (choice?.push !== undefined) await setChannelChoice(tx, user.id, kind as DeliveryKind, 'PUSH', choice.push)
    }
  })
  return createApiResponse(await view(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'notifications:channels-put' } })
