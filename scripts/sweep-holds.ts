/**
 * Releases capacity held by orders whose 30-minute window has lapsed.
 *
 * Plan 05 wires this to a route handler on a 5-minute cron. Until then it is
 * run by hand, and the demo runbook says so — nothing releases abandoned
 * holds automatically yet.
 *
 * Imports NOTHING from src/lib/server/*: those modules start with
 * `import 'server-only'`, which throws under tsx. Everything shared with the
 * application lives in src/lib/shared/.
 */
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'
import { expireOrderWith, sweepExpiredHoldsWith } from '../src/lib/shared/holds-sweep'

// No top-level await: tsx compiles to CJS here, which rejects it.
async function main() {
  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL must be set')

  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    transactionOptions: { maxWait: 15_000, timeout: 30_000 },
  })

  try {
    const result = await sweepExpiredHoldsWith(client, (orderId) =>
      client.$transaction((tx) => expireOrderWith(tx, orderId)),
    )
    console.log(JSON.stringify(result))
  } finally {
    await client.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
