import { NextRequest, NextResponse } from 'next/server'
import { clerkClient } from '@clerk/nextjs/server'
import { Webhook } from 'svix'
import { processClerkEvent } from '@/lib/clerk-webhook'
import { syncClerkUser, tombstoneClerkUser } from '@/lib/user-sync'

// Unauthenticated by design: the only credential is the Svix signature over the
// raw body, made with CLERK_WEBHOOK_SECRET. Without the secret the route refuses
// everything (503) rather than processing unsigned input. Svix also rejects
// timestamps outside a five minute window.

const MAX_BODY_BYTES = 1_000_000

export async function POST(request: NextRequest) {
  const secret = process.env.CLERK_WEBHOOK_SECRET
  if (!secret) {
    console.error('CLERK_WEBHOOK_SECRET is not set: refusing webhook deliveries')
    return NextResponse.json({ error: 'Webhook is not configured' }, { status: 503 })
  }

  const id = request.headers.get('svix-id')
  const timestamp = request.headers.get('svix-timestamp')
  const signature = request.headers.get('svix-signature')
  if (!id || !timestamp || !signature) {
    return NextResponse.json({ error: 'Missing signature headers' }, { status: 400 })
  }

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })

  // The raw text, not parsed JSON: the signature covers the exact bytes.
  const body = await request.text()
  if (body.length > MAX_BODY_BYTES) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })

  let event: unknown
  try {
    event = new Webhook(secret).verify(body, {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signature,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    const client = await clerkClient()
    const result = await processClerkEvent(event as { type?: unknown; data?: { id?: unknown } }, {
      fetchUser: (clerkId) => client.users.getUser(clerkId),
      sync: (user) => syncClerkUser(user),
      tombstone: (clerkId) => tombstoneClerkUser(clerkId),
    })
    return NextResponse.json(result)
  } catch (error) {
    // A non-2xx makes Clerk retry, which is what we want for transient failures.
    console.error('clerk webhook failed:', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}
