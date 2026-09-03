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
   * the seats go back on sale. Plan 05 cancels the Stripe PaymentIntent here:
   * cancel-then-release, because the reverse leaves a window in which the
   * seats are resold while Stripe would still accept the charge. Throwing
   * rolls the whole expiry back, so the next sweep tick retries.
   */
  beforeRelease?: (client: AnyClient) => Promise<void> | void
}

export async function expireOrderWith(
  client: AnyClient,
  orderId: string,
  opts?: ExpireOptions,
): Promise<ReleaseResult> {
  // Claim the transition FIRST. Running beforeRelease before this would fire
  // the hook — and so cancel a Stripe payment — for an order this call cannot
  // actually expire.
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
      meta: { reference: order.reference },
    },
  })

  return { released }
}

export type SweepResult = { expired: number; released: number }

export async function sweepExpiredHoldsWith(
  client: AnyClient,
  expireOne: (orderId: string) => Promise<ReleaseResult>,
  now = new Date(),
): Promise<SweepResult> {
  const take = 500
  let expired = 0
  let released = 0

  for (;;) {
    const candidates = await client.order.findMany({
      where: {
        status: 'PENDING',
        holdExpiresAt: { lt: now },
        // Never expire an order that is mid-payment through an asynchronous
        // method. Przelewy24, Klarna and SEPA sit in `processing` for minutes
        // to days; Plan 05 sets this field, and until then it is always null.
        stripePaymentIntentId: null,
      },
      // Oldest first, so a backlog drains in the order buyers abandoned.
      orderBy: { holdExpiresAt: 'asc' },
      select: { id: true },
      take,
    })

    if (candidates.length === 0) break

    for (const { id } of candidates) {
      const result = await expireOne(id)
      if ('released' in result) {
        expired += 1
        released += result.released
      }
    }

    // A short page means we have caught up. A full one means keep draining —
    // without this loop a bad night silently leaves the remainder held.
    if (candidates.length < take) break
  }

  return { expired, released }
}
