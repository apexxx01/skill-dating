import { sentryOptions } from '@/lib/observability/config'

// Error reporting in the browser (Next loads this file before the app). Nothing is loaded without a DSN: the SDK is imported only inside the branch, and the build removes
// the branch when NEXT_PUBLIC_SENTRY_DSN is empty. Session replay is not enabled. No visual change: this file renders nothing.
const options = sentryOptions(
  {
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_RELEASE: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
    NODE_ENV: process.env.NODE_ENV,
  },
  'client'
)

if (process.env.NEXT_PUBLIC_SENTRY_DSN && options) {
  void import('@sentry/nextjs').then((Sentry) => Sentry.init(options as unknown as Parameters<typeof Sentry.init>[0]))
}
