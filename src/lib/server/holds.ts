import 'server-only'
import type { Prisma } from '@/generated/prisma/client'

/**
 * Capacity holds.
 *
 * The mechanism the whole inventory design turns on. A single conditional
 * UPDATE under READ COMMITTED, relying on Postgres re-evaluating the WHERE
 * clause against the freshly-locked row (EvalPlanQual) when a concurrent
 * write forces a re-read. No SERIALIZABLE, no advisory locks, no retry loop,
 * and nothing that misbehaves behind a connection pooler.
 *
 * The invariant is `soldCount + heldCount <= Event.capacity`, which spans two
 * tables — so capacity is JOINed inside the statement rather than passed in.
 * A caller-supplied capacity is a value read before the transaction opened,
 * and an admin lowering capacity in that window would let the hold succeed
 * against a number that is no longer true.
 *
 * Known limitation, deliberately not fixed here: this assumes one active
 * TicketType per Event, which `createEvent` enforces at insert time but the
 * schema does not. Adding a second type would let each row independently
 * reach Event.capacity. The fix is to SUM the counters across active types in
 * the predicate; `@@unique([eventId])` is NOT the fix, because
 * `plan/00-decisions.md:11` keeps one-row-per-event specifically so a reduced
 * price can be added later without a migration.
 */

export class InsufficientCapacityError extends Error {
  constructor(
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Requested ${requested} tickets, only ${available} available`)
    this.name = 'InsufficientCapacityError'
  }
}

export class InvalidQuantityError extends Error {
  constructor(readonly quantity: number) {
    super(`Quantity must be positive, got ${quantity}`)
    this.name = 'InvalidQuantityError'
  }
}

export class HeldCountUnderflow extends Error {
  constructor(readonly ticketTypeId: string) {
    super(`heldCount would go negative for ticket type ${ticketTypeId}`)
    this.name = 'HeldCountUnderflow'
  }
}

export async function holdCapacity(params: {
  ticketTypeId: string
  eventId: string
  quantity: number
  client: Prisma.TransactionClient
}): Promise<void> {
  // A caller bug, not a sold-out concert. Distinct type so the action layer
  // does not render "not enough seats" for what is actually a broken request.
  if (params.quantity <= 0) throw new InvalidQuantityError(params.quantity)

  // Step A. Lock the Event row for the rest of this transaction.
  //
  // Postgres's EvalPlanQual recheck re-reads the UPDATE's *target* tuple
  // (TicketType) when a concurrent write forces a re-read, but the join side
  // stays on the transaction's original snapshot. Without this lock, an
  // updateEvent lowering capacity can commit between our snapshot and our
  // UPDATE, and the UPDATE would evaluate against the older capacity.
  //
  // It also serialises against updateEvent, which takes the same lock before
  // changing capacity or status — so a hold in flight blocks an admin's
  // capacity change, and vice versa.
  await params.client.$executeRawUnsafe(`SELECT id FROM "Event" WHERE id = $1 FOR UPDATE`, params.eventId)

  // Step B. The critical statement. Row-locks the TicketType at UPDATE time
  // and re-evaluates the predicate against the locked row, reading
  // Event.capacity through the lock taken above. Returns zero rows — rather
  // than erroring — when the predicate fails, which is how a sold-out
  // concert is distinguished from a broken one.
  const rows = await params.client.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "TicketType" tt
        SET "heldCount" = tt."heldCount" + $1,
            "updatedAt" = now()
       FROM "Event" e
      WHERE tt.id = $2
        AND e.id = tt."eventId"
        AND tt.active
        AND tt."soldCount" + tt."heldCount" + $1 <= e.capacity
    RETURNING tt.id`,
    params.quantity,
    params.ticketTypeId,
  )

  if (rows.length === 0) {
    // Work out what IS available, for the error and for the UI. One row by
    // primary key. Read through the same client so it sees our own
    // uncommitted state rather than a stale snapshot.
    const ticketType = await params.client.ticketType.findUnique({
      where: { id: params.ticketTypeId },
      select: {
        soldCount: true,
        heldCount: true,
        active: true,
        event: { select: { capacity: true } },
      },
    })

    // An inactive type has no availability to report, and an unknown id has
    // none either — both are zero rather than a negative or a throw.
    const available = ticketType?.active
      ? Math.max(0, ticketType.event.capacity - ticketType.soldCount - ticketType.heldCount)
      : 0

    throw new InsufficientCapacityError(params.quantity, available)
  }
}

export async function releaseCapacity(params: {
  ticketTypeId: string
  quantity: number
  client: Prisma.TransactionClient
}): Promise<void> {
  // Deliberately no GREATEST("heldCount" - $1, 0) clamp. A double-decrement
  // is a real bug, and the CHECK constraint added in Task 2 is how we hear
  // about it. Clamping would silently manufacture capacity nobody paid for,
  // and drift is the one failure on this plan's list that does not heal
  // itself within the 30-minute hold window.
  try {
    await params.client.$executeRawUnsafe(
      `UPDATE "TicketType"
          SET "heldCount" = "heldCount" - $1,
              "updatedAt" = now()
        WHERE id = $2`,
      params.quantity,
      params.ticketTypeId,
    )
  } catch (e) {
    if (e instanceof Error && String(e.message).includes('TicketType_heldCount_nonneg')) {
      throw new HeldCountUnderflow(params.ticketTypeId)
    }
    throw e
  }
}
