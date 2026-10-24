import { z } from 'zod'
import { boundedJson } from '@/lib/api/limits'

// The request schemas of admin/jobs/[...name], in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// POST /api/admin/jobs/{area}/{action}  body: { data?: {...} }
//
// Admin only. Runs one of the background jobs (src/lib/infra/jobs.ts) right now, in this request, and
// answers with what it returned: how an operator triggers the nightly leaderboard rebuild or the
// season rollover outside their schedule, and how a deploy without the job queue (a preview, a
// laptop) runs them. The job runs exactly as the queue would run it, payload validated by its schema.
export const bodySchema = z.object({ data: boundedJson(16_384).optional() })
