import 'server-only'
import type { Prisma } from '@/generated/prisma/client'
import type { PrismaClient } from '@/generated/prisma/client'
import { formatOrderReference } from '@/lib/shared/order-reference'

/**
 * Draws the next order reference from `order_reference_seq`.
 *
 * `nextval` is atomic: two concurrent transactions cannot receive the same
 * number, even without a row lock. That is the whole reason for a sequence
 * rather than `SELECT MAX(...) + 1`, and it is why there is no retry loop and
 * no unique-violation branch here — a P2002 retry would in any case be dead
 * code, since a failed statement aborts the enclosing Postgres transaction.
 *
 * `client` is required rather than defaulting to the `db` singleton. Calling
 * this with the singleton from inside a `$transaction` pins a second pool
 * connection while already holding one, which deadlocks the pool under
 * concurrency — measured at 100 failures out of 100. Requiring the parameter
 * puts that constraint in the type system.
 */
export async function generateOrderReference(
  now: Date,
  client: Prisma.TransactionClient | PrismaClient,
): Promise<string> {
  const rows = await client.$queryRawUnsafe<Array<{ nextval: bigint }>>(
    `SELECT nextval('order_reference_seq') AS nextval`,
  )

  return formatOrderReference(Number(rows[0].nextval), now.getUTCFullYear())
}
