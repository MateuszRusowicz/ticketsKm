import 'server-only'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'
import { env } from './env'

// Prisma 7 requires a driver adapter — the bundled query engine is gone.
// PrismaPg speaks plain TCP Postgres, which serves both the local Docker
// container and Neon's pooled endpoint, so local and production use the
// same code path. Migrations do NOT go through here: the CLI reads
// DIRECT_URL from prisma.config.ts, because Neon's pooler cannot run them.
function createClient(): PrismaClient {
  // max: 10 — Neon's pooled endpoint allows ~10k connections across all
  // clients. Ten per Vercel instance stays well under budget even at 1000
  // concurrent instances, which is far beyond festival scale. Raising this
  // buys throughput per instance at the cost of headroom across them.
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: 10 })

  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    // Prisma's defaults (maxWait 2s, timeout 5s) are too tight for this
    // workload in two distinct ways, both of which surface as P2028
    // "Unable to start a transaction in the given time" — which reads to a
    // buyer as an outage rather than a sell-out.
    //   maxWait 15s: Neon scale-to-zero cold starts alone can exceed 2s on
    //     the first checkout after an idle period.
    //   timeout 30s: at an on-sale rush every hold serialises on one
    //     TicketType row, so the queue drains far slower than 5s.
    transactionOptions: { maxWait: 15_000, timeout: 30_000 },
  })
}

// Next.js hot-reloads modules in development, which would otherwise open a
// new pool on every edit until Postgres refuses connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const db = globalForPrisma.prisma ?? createClient()

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = db
