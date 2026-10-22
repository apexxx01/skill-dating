import * as Sentry from '@sentry/nextjs'
import { sentryOptions } from '@/lib/observability/config'

// Error reporting for the Node server (started by src/instrumentation.ts, only when SENTRY_DSN is set). Options and the removal of personal data are in
// src/lib/observability; docs/DEPLOY.md has the setup.
const options = sentryOptions(process.env, 'server')
if (options) Sentry.init(options as unknown as Parameters<typeof Sentry.init>[0])
