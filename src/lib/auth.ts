import NextAuth from 'next-auth'
import { PrismaAdapter } from '@auth/prisma-adapter'
import Credentials from 'next-auth/providers/credentials'
import GitHub from 'next-auth/providers/github'
import Google from 'next-auth/providers/google'
import Discord from 'next-auth/providers/discord'
import { prisma } from '@/lib/prisma'
import { compare } from 'bcryptjs'
import { z } from 'zod'

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    // Matches the actual route-group paths (/(auth)/signin -> /signin, etc).
    signIn: '/signin',
    error: '/error',
    newUser: '/onboarding',
  },
  providers: [
    GitHub({
      clientId: process.env.GITHUB_ID,
      clientSecret: process.env.GITHUB_SECRET,
    }),
    Google({
      clientId: process.env.GOOGLE_ID,
      clientSecret: process.env.GOOGLE_SECRET,
    }),
    Discord({
      clientId: process.env.DISCORD_ID,
      clientSecret: process.env.DISCORD_SECRET,
    }),
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: async (credentials) => {
        const parsed = z
          .object({ email: z.string().email(), password: z.string().min(8) })
          .safeParse(credentials)
        
        if (!parsed.success) return null
        
        const { email, password } = parsed.data
        const user = await prisma.user.findUnique({ where: { email } })
        
        if (!user || !user.passwordHash) return null
        
        const isValid = await compare(password, user.passwordHash)
        if (!isValid) return null
        
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id
        token.role = (user as any).role
      }
      if (trigger === 'update' && session) {
        token.name = session.name
        token.image = session.image
      }
      return token
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string
        session.user.role = token.role as string
      }
      return session
    },
  },
  events: {
    async createUser({ user }) {
      await prisma.auditEvent.create({
        data: {
          userId: user.id,
          action: 'USER_CREATED',
          targetType: 'USER',
          targetId: user.id,
        },
      })
    },
    async signIn({ user, account, isNewUser }) {
      if (!isNewUser) {
        await prisma.user.update({
          where: { id: user.id },
          data: { lastActiveAt: new Date() },
        })
      }

      if (account?.provider === 'github' && user.id) {
        const userId: string = user.id
        const VERIFICATION_LEVEL_RANK: Record<string, number> = {
          NONE: 0,
          EMAIL: 1,
          PHONE: 2,
          GITHUB: 3,
          PORTFOLIO: 4,
          ORGANIZATION: 5,
          IDENTITY: 6,
        }

        await prisma.$transaction(async (tx) => {
          const existing = await tx.verification.findFirst({
            where: { userId, type: 'GITHUB' },
          })

          if (!existing) {
            await tx.verification.create({
              data: {
                userId,
                type: 'GITHUB',
                status: 'VERIFIED',
                provider: 'github',
                verifiedAt: new Date(),
              },
            })
          } else if (existing.status !== 'VERIFIED') {
            await tx.verification.update({
              where: { id: existing.id },
              data: { status: 'VERIFIED', verifiedAt: new Date() },
            })
          }

          const currentUser = await tx.user.findUnique({
            where: { id: userId },
            select: { verificationLevel: true },
          })

          if (
            currentUser &&
            VERIFICATION_LEVEL_RANK[currentUser.verificationLevel] <
              VERIFICATION_LEVEL_RANK.GITHUB
          ) {
            await tx.user.update({
              where: { id: userId },
              data: { verificationLevel: 'GITHUB' },
            })
          }
        })
      }
    },
  },
})

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      name?: string | null
      email?: string | null
      image?: string | null
      role: string
    }
  }
  
  interface User {
    role: string
  }
}

declare module 'next-auth' {
  interface JWT {
    id: string
    role: string
  }
}