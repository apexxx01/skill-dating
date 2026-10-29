import type { PrismaClient } from '@prisma/client'
import type { ErrorCode } from '@/lib/api/errors'
import { loadFlags } from '@/lib/flags'
import type { Cache } from '@/lib/infra/cache'
import { log } from '@/lib/log'
import { ROMANCE_KILL_FLAG } from '@/lib/romance/launch-keys'

// Kill switches: a feature flag per thing that may have to be stopped at once, for everyone, without a deploy (an abuse wave, a legal request, a bug that
// leaks data). A switch is ON when its flag exists and is enabled; then the feature answers its error code everywhere it is checked, on the server. The
// flags are created OFF by the migration 20261021000600_kill_switches and changed with PATCH /api/admin/flags/{key}. Owners are in docs/DEPLOY.md.

export const KILL_SWITCHES = {
  signups: { flag: 'kill.signups', code: 'SIGNUPS_PAUSED', owner: 'Engineering on-call' },
  romance: { flag: ROMANCE_KILL_FLAG, code: 'ROMANCE_PAUSED', owner: 'Trust & Safety lead' },
  messaging: { flag: 'kill.messaging', code: 'MESSAGING_PAUSED', owner: 'Trust & Safety lead' },
  posting: { flag: 'kill.posting', code: 'POSTING_PAUSED', owner: 'Trust & Safety lead' },
  external_hackathons: { flag: 'kill.external-hackathons', code: 'EXTERNAL_HACKATHONS_PAUSED', owner: 'Squads product owner' },
  squad_autoform: { flag: 'kill.squad-autoform', code: null, owner: 'Squads product owner' },
  notification_delivery: { flag: 'kill.notification-delivery', code: null, owner: 'Engineering on-call' },
  // The evidence engine (docs/PROOF.md): its write routes answer 503 and its jobs skip. Created OFF by 20261029000200_kill_evidence_engine.
  evidence_engine: { flag: 'kill.evidence-engine', code: 'EVIDENCE_ENGINE_PAUSED', owner: 'Trust & Safety lead' },
  // Public receipt pages answer 503; the key set stays up, so copies of receipts can still be verified.
  receipts_public: { flag: 'kill.receipts-public', code: 'RECEIPTS_PAUSED', owner: 'Trust & Safety lead' },
} as const satisfies Record<string, { flag: string; code: ErrorCode | null; owner: string }>

export type KillSwitch = keyof typeof KILL_SWITCHES

/** Whether the switch is on. A switch whose flags cannot be read is treated as off (failing open keeps the product up; the switch is for emergencies). */
export async function isKilled(db: Pick<PrismaClient, 'featureFlag'>, name: KillSwitch, cache?: Cache): Promise<boolean> {
  try {
    const flags = await loadFlags(db, cache)
    return flags.some((flag) => flag.key === KILL_SWITCHES[name].flag && flag.enabled)
  } catch (error) {
    log.warn('could not read the kill switches', { error, name })
    return false
  }
}
