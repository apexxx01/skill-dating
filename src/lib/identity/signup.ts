import disposable from '@/config/disposable-email-domains.json'

// Sign-up abuse. Two checks run when a Clerk account is seen for the first time and a local account would be created for it (src/lib/session.ts):
//   - a throwaway e-mail domain (the list is config: src/config/disposable-email-domains.json; a subdomain of a listed domain counts) is refused with
//     403 SIGNUP_EMAIL_REJECTED;
//   - too many new accounts from one client address is refused with 429 SIGNUP_RATE_LIMITED (SIGNUP_LIMIT, counted in the Cache adapter, so every
//     instance shares the count).
// Neither affects an account that already exists locally, and both are checked before the local row is created, so a refused sign-up leaves nothing
// behind. The `signups` kill switch (src/lib/ops/kill-switches.ts) stops every new account the same way, with 503 SIGNUPS_PAUSED.

const DOMAINS = new Set(disposable.domains.map((domain) => domain.toLowerCase()))

/** New accounts a single client address may open. */
export const SIGNUP_LIMIT = { windowMs: 60 * 60 * 1000, maxRequests: 5 } as const

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1) return null
  return email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '')
}

/** Whether the address is at a throwaway domain, or a subdomain of one. */
export function isDisposableEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const domain = emailDomain(email)
  if (!domain) return false
  const labels = domain.split('.')
  for (let i = 0; i < labels.length - 1; i++) if (DOMAINS.has(labels.slice(i).join('.'))) return true
  return false
}
