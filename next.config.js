/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Runs src/instrumentation.ts when the server starts (it validates the environment).
    instrumentationHook: true,
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
}

module.exports = nextConfig