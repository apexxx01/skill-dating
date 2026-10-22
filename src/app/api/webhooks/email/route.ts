import { NextRequest, NextResponse } from 'next/server'
import { Webhook } from 'svix'
import { env } from '@/lib/env'
import { errorResponse } from '@/lib/api/errors'
import { log } from '@/lib/log'
import { prisma } from '@/lib/prisma'
import { processEmailEvent, type EmailEvent } from '@/lib/notify/webhook'

// Bounces and complaints from the email provider (Resend, which signs its webhooks with Svix). Unauthenticated by design: the only credential is the Svix
// signature over the raw body, made with RESEND_WEBHOOK_SECRET. Without the secret the route refuses everything (503). A bounced or complained address is suppressed:
// no email is sent to it again (src/lib/notify/webhook.ts).

const MAX_BODY_BYTES = 1_000_000

export async function POST(request: NextRequest) {
  const secret = env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    log.error('RESEND_WEBHOOK_SECRET is not set: refusing webhook deliveries')
    return errorResponse('WEBHOOK_NOT_CONFIGURED')
  }
  const id = request.headers.get('svix-id')
  const timestamp = request.headers.get('svix-timestamp')
  const signature = request.headers.get('svix-signature')
  if (!id || !timestamp || !signature) return errorResponse('WEBHOOK_SIGNATURE_MISSING')

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) return errorResponse('PAYLOAD_TOO_LARGE')
  // The raw text, not parsed JSON: the signature covers the exact bytes.
  const body = await request.text()
  if (body.length > MAX_BODY_BYTES) return errorResponse('PAYLOAD_TOO_LARGE')

  let event: unknown
  try {
    event = new Webhook(secret).verify(body, { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature })
  } catch {
    return errorResponse('WEBHOOK_SIGNATURE_INVALID')
  }
  if (!event || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') return NextResponse.json({ handled: 'IGNORED', reason: 'not an event' })

  try {
    return NextResponse.json(await processEmailEvent(prisma, event as EmailEvent))
  } catch (error) {
    // A non-2xx makes the provider retry, which is what we want for a transient failure.
    log.error('email webhook failed', { error })
    return errorResponse('WEBHOOK_PROCESSING_FAILED')
  }
}
