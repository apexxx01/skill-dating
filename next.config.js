const { SECURITY_HEADERS, API_CSP } = require('./src/lib/security/static-headers.js')

// Error reporting (docs/DEPLOY.md, "Error reporting with Sentry") is on only when SENTRY_DSN is set when the app is built. The browser SDK cannot read the server's
// environment, so its settings are copied into NEXT_PUBLIC_ variables here; src/instrumentation-client.ts loads nothing when the DSN is empty.
const sentryDsn = process.env.SENTRY_DSN

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_SENTRY_DSN: sentryDsn || '',
    NEXT_PUBLIC_SENTRY_RELEASE: process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || '',
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.VERCEL_ENV || '',
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE || '',
  },
  // The integration suite builds into its own directory (tests/integration/global-setup.ts), so a test build never
  // overwrites the .next of a dev server running in the same checkout.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Security headers on every response (docs/SECURITY.md). Pages get their Content-Security-Policy from src/middleware.ts, which needs a nonce per request.
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      { source: '/api/:path*', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
    ]
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  images: {
    // No code uses next/image. Serving images as they are leaves no /_next/image optimizer to attack.
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
}

// Source maps are uploaded (and removed from the deployed files) only when the build has an auth token; without one errors are reported with minified stacks.
module.exports = sentryDsn
  ? require('@sentry/nextjs/config').withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: true,
      telemetry: false,
      widenClientFileUpload: true,
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN, filesToDeleteAfterUpload: ['**/*.map'] },
      release: { name: process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || undefined },
      bundleSizeOptimizations: { excludeDebugStatements: true, excludeReplayIframe: true, excludeReplayShadowDom: true, excludeReplayWorker: true },
    })
  : nextConfig