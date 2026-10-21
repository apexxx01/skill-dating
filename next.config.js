const { SECURITY_HEADERS, API_CSP } = require('./src/lib/security/static-headers.js')

/** @type {import('next').NextConfig} */
const nextConfig = {
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

module.exports = nextConfig