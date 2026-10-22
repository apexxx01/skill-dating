import * as Sentry from '@sentry/nextjs'
import { sentryOptions } from '@/lib/observability/config'

// Error reporting for the Edge runtime (the middleware), started by src/instrumentation.ts only when SENTRY_DSN is set.
const options = sentryOptions(process.env, 'edge')
if (options) Sentry.init(options as unknown as Parameters<typeof Sentry.init>[0])
