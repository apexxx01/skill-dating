// The frozen frontend still reads `useSession().data.user` from next-auth/react,
// which is answered by GET /api/auth/session (see docs/AUTH_MIGRATION.md). This
// keeps the session shape it was written against; `id` is the LOCAL user id.
import 'next-auth'

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
