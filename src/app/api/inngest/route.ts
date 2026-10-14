import type { NextRequest } from 'next/server'
import { serve } from 'inngest/next'
import { getInngest, inngestFunctions } from '@/lib/infra/jobs'

// Inngest calls this route to discover and run the jobs declared in
// src/lib/infra/jobs.ts. It is not behind withAuth: its credential is the
// request signature, which the Inngest handler checks against INNGEST_SIGNING_KEY
// (required in production, see src/lib/env.ts). The handlers are built on first
// use so that `next build` does not need Inngest credentials.

export const dynamic = 'force-dynamic'

let handlers: ReturnType<typeof serve> | undefined

function inngest() {
  handlers ??= serve({ client: getInngest(), functions: inngestFunctions() })
  return handlers
}

export const GET = (request: NextRequest, context: unknown) => inngest().GET(request, context)
export const POST = (request: NextRequest, context: unknown) => inngest().POST(request, context)
export const PUT = (request: NextRequest, context: unknown) => inngest().PUT(request, context)
