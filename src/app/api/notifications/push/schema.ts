import { z } from 'zod'

// The request schemas of notifications/push, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// Web push devices (docs/NOTIFICATIONS.md): the browsers that agreed to receive a push for this account. The body of POST is what PushManager.subscribe() gives,
// as JSON (subscription.toJSON()). GET also hands out the public key to subscribe with, so the page needs no configuration of its own.
export const base64url = z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Base64url text')

export const subscribeSchema = z
  .object({
    endpoint: z.string().url().max(1000),
    keys: z.object({ p256dh: base64url, auth: base64url }).strict(),
    // A short name for the device in settings; the page may send navigator.userAgent trimmed, or its own.
    label: z.string().max(80).optional(),
    expirationTime: z.number().nullable().optional(),
  })
  .strict()

export const unsubscribeSchema = z.object({ endpoint: z.string().url().max(1000) }).strict()
