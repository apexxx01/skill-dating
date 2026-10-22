import { env } from '@/lib/env'

export const DEV_BASE_URL = 'http://localhost:3000'

/** The address of the app, without a trailing slash: APP_URL, or the local development address when it is not set. */
export function appBaseUrl(): string {
  return (env.APP_URL ?? DEV_BASE_URL).replace(/\/+$/, '')
}
