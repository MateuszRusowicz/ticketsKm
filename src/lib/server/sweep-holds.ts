import 'server-only'
import {
  expireOrderWith,
  sweepExpiredHoldsWith,
  sweepAsyncExpiredHoldsWith,
  type SweepResult,
} from '@/lib/shared/holds-sweep'
import { env } from './env'
import { db } from './db'

/** The application-side binding for the primary sweep. The CLI passes its own
 *  client instead. */
export function sweepExpiredHolds(): Promise<SweepResult> {
  return sweepExpiredHoldsWith(db, (orderId) =>
    db.$transaction((tx) => expireOrderWith(tx, orderId)),
  )
}

/** The application-side binding for the secondary (SEPA-aware) sweep.
 *  Timeout values come from env; the shared function receives plain numbers. */
export function sweepAsyncExpiredHolds(): Promise<SweepResult> {
  return sweepAsyncExpiredHoldsWith(
    db,
    {
      sepaHardTimeoutDays: env.SEPA_HARD_TIMEOUT_DAYS,
      asyncPaymentTimeoutSecs: Math.floor(env.ASYNC_PAYMENT_TIMEOUT_MS / 1000),
    },
    (orderId, isSepa) =>
      db.$transaction((tx) =>
        expireOrderWith(tx, orderId, isSepa ? { trigger: 'sepa_hard_timeout' } : undefined),
      ),
  )
}
