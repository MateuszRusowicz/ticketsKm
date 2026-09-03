/**
 * The capacity-release primitive, in shared/ rather than server/.
 *
 * CLI scripts cannot import from `src/lib/server/*` — those modules start
 * with `import 'server-only'`, which throws under tsx. The expired-hold sweep
 * runs both in the app and from a CLI, so the statement it depends on has to
 * live somewhere both can reach. See the trap list in /CLAUDE.md.
 */
import type { Prisma, PrismaClient } from '@/generated/prisma/client'

export type AnyClient = PrismaClient | Prisma.TransactionClient

export class HeldCountUnderflow extends Error {
  constructor(readonly ticketTypeId: string) {
    super(`heldCount would go negative for ticket type ${ticketTypeId}`)
    this.name = 'HeldCountUnderflow'
  }
}

export async function releaseCapacityWith(
  client: AnyClient,
  ticketTypeId: string,
  quantity: number,
): Promise<void> {
  // Deliberately no GREATEST(x - n, 0) clamp: a double-decrement is a real
  // bug, and the CHECK constraint is how we hear about it. Clamping would
  // silently manufacture capacity nobody paid for.
  try {
    await client.$executeRawUnsafe(
      `UPDATE "TicketType"
          SET "heldCount" = "heldCount" - $1,
              "updatedAt" = now()
        WHERE id = $2`,
      quantity,
      ticketTypeId,
    )
  } catch (e) {
    if (e instanceof Error && String(e.message).includes('TicketType_heldCount_nonneg')) {
      throw new HeldCountUnderflow(ticketTypeId)
    }
    throw e
  }
}
