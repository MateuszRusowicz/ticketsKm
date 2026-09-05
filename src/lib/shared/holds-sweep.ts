/**
 * The expired-hold sweep, and the single implementation of the
 * `PENDING → EXPIRED` transition.
 *
 * Lives in shared/ because it runs from two places that cannot share code
 * otherwise: the application (through a thin `server-only` wrapper) and
 * `scripts/sweep-holds.ts`, which must not import from `src/lib/server/*`.
 * Duplicating the transition into the CLI was the alternative, and two copies
 * of a transactional state change diverge.
 */
import type { AnyClient } from './holds-release'
import { releaseCapacityWith } from './holds-release'

export type SkipReason = 'alreadyTerminal' | 'notYetExpired'
export type ReleaseResult = { released: number } | { skipped: SkipReason }

export type ExpireOptions = {
  /**
   * Runs inside the transaction, after the transition is claimed and before
   * the seats go back on sale. Throwing rolls the whole expiry back, so the
   * next sweep tick retries.
   *
   * Plan 05 does not use `beforeRelease`. The 4 September 2026 decision is
   * that hold expiry does not call Stripe (see `plan/00-decisions.md`
   * "Hold expiry does not call Stripe"). The hook stays available for
   * future plans.
   */
  beforeRelease?: (client: AnyClient) => Promise<void> | void
  /**
   * Written into the audit log meta when set. The secondary sweep passes
   * `'sepa_hard_timeout'` for SEPA Debit orders that exceed the 5-day cap.
   */
  trigger?: string
}

export async function expireOrderWith(
  client: AnyClient,
  orderId: string,
  opts?: ExpireOptions,
): Promise<ReleaseResult> {
  // Claim the transition FIRST. Running beforeRelease before this would fire
  // the hook for an order this call cannot actually expire.
  const claimed = await client.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "Order" SET status = 'EXPIRED'
      WHERE id = $1 AND status = 'PENDING' AND "holdExpiresAt" < now()
    RETURNING id`,
    orderId,
  )

  if (claimed.length === 0) {
    const current = await client.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    })
    return { skipped: current?.status === 'PENDING' ? 'notYetExpired' : 'alreadyTerminal' }
  }

  if (opts?.beforeRelease) await opts.beforeRelease(client)

  const items = await client.orderItem.findMany({
    where: { orderId },
    select: { ticketTypeId: true, quantity: true },
  })

  let released = 0
  for (const item of items) {
    await releaseCapacityWith(client, item.ticketTypeId, item.quantity)
    released += item.quantity
  }

  const order = await client.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { reference: true },
  })

  await client.auditLog.create({
    data: {
      actorId: null,
      action: 'order.expire',
      entityType: 'Order',
      entityId: orderId,
      meta: {
        reference: order.reference,
        ...(opts?.trigger ? { trigger: opts.trigger } : {}),
      },
    },
  })

  return { released }
}

export type SweepResult = { expired: number; released: number; failed: number }

// The set of paymentIntentStatus values that indicate a payment is actively
// in-flight. Orders in these states must not be expired by the primary sweep —
// the buyer is mid-3DS, mid-BLIK, or waiting for an async bank transfer.
//
// Expressed as a raw-SQL IN list because Prisma's { notIn: [...] } emits
// `WHERE col NOT IN (...)` with no OR IS NULL branch. Under SQL three-valued
// logic, `NULL NOT IN (...)` is UNKNOWN, so the Prisma form silently excludes
// orders that have no paymentIntentStatus at all — meaning a plain abandoned
// cart (the most common case) is never swept. Recorded in 00-decisions.md.
const IN_FLIGHT_STATUSES = `'processing','requires_action','requires_capture','requires_confirmation','succeeded'`

/**
 * Primary sweep: expires holds whose window has lapsed and whose payment is
 * not actively in-flight.
 *
 * **Predicate**: raw SQL so OR IS NULL is included.
 * **Pagination**: keyset on (holdExpiresAt, id) — a stuck order that cannot
 *   be expired does not block newer expirations on the same tick.
 * **Per-order try/catch**: one bad order increments `failed`; the loop
 *   continues and the cursor advances past it.
 *
 * Emits `SWEEP-PRIMARY expired=… released=… failed=…` on stderr.
 */
type PrimaryRow = { id: string; holdExpiresAt: Date }

export async function sweepExpiredHoldsWith(
  client: AnyClient,
  expireOne: (orderId: string) => Promise<ReleaseResult>,
): Promise<SweepResult> {
  const take = 500
  let expired = 0
  let released = 0
  let failed = 0
  let lastExpiresAt: Date | null = null
  let lastId: string | null = null

  for (;;) {
    const candidates = (await client.$queryRawUnsafe(
      `SELECT id, "holdExpiresAt"
         FROM "Order"
        WHERE status = 'PENDING'
          AND "holdExpiresAt" < now()
          AND (
            "paymentIntentStatus" IS NULL
            OR "paymentIntentStatus" NOT IN (${IN_FLIGHT_STATUSES})
          )
          AND (
            $1::timestamptz IS NULL
            OR "holdExpiresAt" > $1
            OR ("holdExpiresAt" = $1 AND id > $2)
          )
        ORDER BY "holdExpiresAt" ASC, id ASC
        LIMIT $3`,
      lastExpiresAt,
      lastId,
      take,
    )) as PrimaryRow[]

    if (candidates.length === 0) break

    for (const row of candidates) {
      // Advance cursor before attempting expiry. A failed attempt still moves
      // the cursor past this row so the next page does not re-select it and
      // spin forever.
      lastExpiresAt = row.holdExpiresAt
      lastId = row.id

      try {
        const result = await expireOne(row.id)
        if ('released' in result) {
          expired += 1
          released += result.released
        }
      } catch {
        failed += 1
      }
    }

    if (candidates.length < take) break
  }

  console.error(`SWEEP-PRIMARY expired=${expired} released=${released} failed=${failed}`)
  return { expired, released, failed }
}

/**
 * Secondary sweep: expires holds that are actively in-flight but have
 * exceeded their respective hard timeouts.
 *
 * | Payment method | Timeout | Source |
 * |---|---|---|
 * | SEPA Debit | `sepaHardTimeoutDays` (default 5) | business-day ceiling |
 * | All others | `asyncPaymentTimeoutSecs` (default 6 h) | env `ASYNC_PAYMENT_TIMEOUT_MS` |
 *
 * Cutoffs are computed by Postgres using `now() - interval` so the sweep
 * clock is always the database, never a JS Date passed in from the caller.
 *
 * Same keyset pagination and per-order try/catch as the primary sweep.
 * Emits `SWEEP-ASYNC expired=… released=… failed=…` on stderr.
 */
export async function sweepAsyncExpiredHoldsWith(
  client: AnyClient,
  opts: { sepaHardTimeoutDays: number; asyncPaymentTimeoutSecs: number },
  expireOne: (orderId: string, isSepa: boolean) => Promise<ReleaseResult>,
): Promise<SweepResult> {
  type AsyncRow = { id: string; holdExpiresAt: Date; paymentMethodType: string | null }
  const take = 500
  let expired = 0
  let released = 0
  let failed = 0
  let lastExpiresAt: Date | null = null
  let lastId: string | null = null

  for (;;) {
    const candidates = (await client.$queryRawUnsafe(
      `SELECT id, "holdExpiresAt", "paymentMethodType"
         FROM "Order"
        WHERE status = 'PENDING'
          AND "paymentIntentStatus" IN ('processing','requires_action','requires_capture')
          AND (
            (
              "paymentMethodType" = 'sepa_debit'
              AND "holdExpiresAt" < now() - ($1::int * INTERVAL '1 day')
            )
            OR (
              "paymentMethodType" IS DISTINCT FROM 'sepa_debit'
              AND "holdExpiresAt" < now() - ($2::int * INTERVAL '1 second')
            )
          )
          AND (
            $3::timestamptz IS NULL
            OR "holdExpiresAt" > $3
            OR ("holdExpiresAt" = $3 AND id > $4)
          )
        ORDER BY "holdExpiresAt" ASC, id ASC
        LIMIT $5`,
      opts.sepaHardTimeoutDays,
      opts.asyncPaymentTimeoutSecs,
      lastExpiresAt,
      lastId,
      take,
    )) as AsyncRow[]

    if (candidates.length === 0) break

    for (const row of candidates) {
      lastExpiresAt = row.holdExpiresAt
      lastId = row.id

      const isSepa = row.paymentMethodType === 'sepa_debit'
      try {
        const result = await expireOne(row.id, isSepa)
        if ('released' in result) {
          expired += 1
          released += result.released
        }
      } catch {
        failed += 1
      }
    }

    if (candidates.length < take) break
  }

  console.error(`SWEEP-ASYNC expired=${expired} released=${released} failed=${failed}`)
  return { expired, released, failed }
}
