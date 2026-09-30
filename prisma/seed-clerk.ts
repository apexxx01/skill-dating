/**
 * Opt-in: makes the seeded demo accounts usable through Clerk.
 *
 * Run with: npm run db:seed:clerk   (after npm run db:seed)
 *
 * The seed inserts demo users as legacy rows (clerkId null). This creates the
 * matching Clerk users on the development instance with the Backend API, using the
 * documented demo password, and stores each Clerk id on its local row, so the demo
 * accounts can sign in through Clerk.
 *
 * Clerk refuses the reserved .test TLD the seed uses, so the Clerk account for
 * demo1@demo.skilldating.test signs in with demo1@demo.skilldating.example.com
 * (example.com is reserved, so it can never be a real mailbox). The local row keeps
 * its seeded email until Clerk next reports a change for the account, after which
 * the local email follows Clerk's, like any other account.
 *
 * Clerk usernames allow only letters, digits, - and _, so a seeded name such as
 * fatima.pm becomes fatimapm in Clerk; the local username is left as seeded.
 *
 * Safe to re-run: a row that already has a clerkId is skipped, and a Clerk user
 * that already exists for the email is reused instead of created twice.
 * Refuses to run against anything but a development (sk_test_) key.
 * The secret key is read from CLERK_SECRET_KEY or .env.local and is never printed.
 */

import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { sanitizeUsername } from '../src/lib/username'

const DEMO_DOMAIN = 'demo.skilldating.test'
const CLERK_DEMO_DOMAIN = 'demo.skilldating.example.com'
const DEMO_PASSWORD = 'DemoPass123!'
const API = 'https://api.clerk.com/v1'

function secretKey(): string {
  let key = process.env.CLERK_SECRET_KEY
  if (!key) {
    const file = path.resolve(__dirname, '../.env.local')
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        const m = line.match(/^\s*CLERK_SECRET_KEY\s*=\s*(.*)$/)
        if (m) key = m[1].trim().replace(/^["']|["']$/g, '')
      }
    }
  }
  if (!key) throw new Error('CLERK_SECRET_KEY is not set (environment or .env.local)')
  if (!key.startsWith('sk_test_')) throw new Error('Refusing to run: CLERK_SECRET_KEY is not a development (sk_test_) key')
  return key
}

async function clerk(method: string, route: string, body?: unknown): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API + route, {
      method,
      headers: { Authorization: `Bearer ${secretKey()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await new Promise((r) => setTimeout(r, 500 * attempt))
      continue
    }
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const codes = Array.isArray(data?.errors) ? data.errors.map((e: any) => `${e.code}: ${e.long_message ?? e.message}`).join('; ') : ''
      throw new Error(`Clerk ${method} ${route} failed with ${res.status}${codes ? ` (${codes})` : ''}`)
    }
    return data
  }
}

async function main() {
  secretKey() // fail before touching anything
  const prisma = new PrismaClient()
  try {
    const rows = await prisma.user.findMany({
      where: { email: { endsWith: `@${DEMO_DOMAIN}` }, deletedAt: null },
      select: { id: true, email: true, username: true, name: true, clerkId: true },
      orderBy: { email: 'asc' },
    })

    let created = 0
    let reused = 0
    let skipped = 0
    for (const row of rows) {
      if (row.clerkId) {
        skipped += 1
        continue
      }
      const clerkEmail = row.email.replace(new RegExp(`@${DEMO_DOMAIN.replace(/\./g, '\\.')}$`), `@${CLERK_DEMO_DOMAIN}`)
      const existing = await clerk('GET', `/users?email_address=${encodeURIComponent(clerkEmail)}&limit=1`)
      let clerkId: string
      if (Array.isArray(existing) && existing.length > 0) {
        clerkId = existing[0].id
        reused += 1
      } else {
        const user = await clerk('POST', '/users', {
          email_address: [clerkEmail],
          username: sanitizeUsername(row.username),
          first_name: row.name ?? row.username,
          password: DEMO_PASSWORD,
          // A well-known demo password would fail Clerk's breach check.
          skip_password_checks: true,
        })
        clerkId = user.id
        created += 1
      }
      await prisma.user.update({ where: { id: row.id }, data: { clerkId } })
    }
    console.log(`Demo accounts: ${rows.length} found, ${created} created in Clerk, ${reused} reused, ${skipped} already linked.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
