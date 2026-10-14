import type { Metadata, Viewport } from 'next'
import { ClerkProvider } from '@clerk/nextjs'
import localFont from 'next/font/local'
import { Providers } from '@/components/providers'
import '../styles/globals.css'

// Self-hosted (latin subset, SIL Open Font License, texts alongside the files) so a
// build or a deploy never needs the network to fetch fonts.
const inter = localFont({
  src: [
    { path: './fonts/Inter-300.woff2', weight: '300', style: 'normal' },
    { path: './fonts/Inter-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/Inter-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/Inter-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/Inter-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-inter',
  display: 'swap',
  adjustFontFallback: 'Arial',
})

const jetbrainsMono = localFont({
  src: [
    { path: './fonts/JetBrainsMono-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/JetBrainsMono-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/JetBrainsMono-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/JetBrainsMono-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-jetbrains-mono',
  display: 'swap',
})

const spaceGrotesk = localFont({
  src: [
    { path: './fonts/SpaceGrotesk-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/SpaceGrotesk-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/SpaceGrotesk-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/SpaceGrotesk-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-space-grotesk',
  display: 'swap',
  adjustFontFallback: 'Arial',
})

export const metadata: Metadata = {
  title: 'Skill Dating - Where Builders Find Builders',
  description: 'The builder-first social network for hackathons, team formation, and collaboration. Find the right people. Build together. Ship things.',
  keywords: ['hackathon', 'developers', 'team formation', 'builder network', 'collaboration', 'projects'],
  authors: [{ name: 'Skill Dating Team' }],
  creator: 'Skill Dating',
  publisher: 'Skill Dating',
  robots: 'index, follow',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://skilldating.app',
    title: 'Skill Dating - Where Builders Find Builders',
    description: 'The builder-first social network for hackathons, team formation, and collaboration.',
    siteName: 'Skill Dating',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Skill Dating - Where Builders Find Builders',
    description: 'The builder-first social network for hackathons, team formation, and collaboration.',
  },
  verification: {
    google: 'google-site-verification-code',
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0a09' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ClerkProvider signInUrl="/signin" signUpUrl="/signup">
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} ${spaceGrotesk.variable} scroll-smooth`} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
    </ClerkProvider>
  )
}