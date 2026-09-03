/**
 * Reconciles TicketType.heldCount against the orders that justify it.
 *
 * Counter drift is the one failure mode in the inventory design that does not
 * heal itself: every other problem resolves when the 30-minute hold lapses,
 * but a heldCount that has drifted upward permanently removes capacity that
 * nobody paid for, and nothing in the application would ever notice.
 *
 * Run with --fix to correct it. Imports nothing from src/lib/server/*.
 */
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'

type Row = { ticketTypeId: string; slug: string; actual: number; expected: number }

async function main() {
  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL must be set')

  const fix = process.argv.includes('--fix')
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

  try {
    const rows = await client.$queryRawUnsafe<Row[]>(`
      SELECT tt.id            AS "ticketTypeId",
             e.slug           AS slug,
             tt."heldCount"   AS actual,
             COALESCE(SUM(oi.quantity) FILTER (WHERE o.status = 'PENDING'), 0)::int AS expected
        FROM "TicketType" tt
        JOIN "Event" e       ON e.id = tt."eventId"
        LEFT JOIN "OrderItem" oi ON oi."ticketTypeId" = tt.id
        LEFT JOIN "Order" o      ON o.id = oi."orderId"
       GROUP BY tt.id, e.slug, tt."heldCount"
       ORDER BY e.slug
    `)

    const drifted = rows.filter((r) => r.actual !== r.expected)

    for (const row of drifted) {
      const drift = row.actual - row.expected
      console.log(
        `${row.slug}: heldCount=${row.actual} expected=${row.expected} drift=${drift > 0 ? '+' : ''}${drift}`,
      )

      if (fix) {
        await client.$transaction(async (tx) => {
          await tx.ticketType.update({
            where: { id: row.ticketTypeId },
            data: { heldCount: row.expected },
          })
          await tx.auditLog.create({
            data: {
              actorId: null,
              action: 'holds.reconcile',
              entityType: 'TicketType',
              entityId: row.ticketTypeId,
              meta: { before: row.actual, after: row.expected, drift },
            },
          })
        })
      }
    }

    if (drifted.length === 0) {
      console.log(`OK: ${rows.length} ticket types, no drift`)
      return
    }

    if (fix) {
      console.log(`Fixed ${drifted.length} ticket type(s)`)
      return
    }

    process.exitCode = 1
  } finally {
    await client.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
