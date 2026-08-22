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
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })

  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

// Next.js hot-reloads modules in development, which would otherwise open a
// new pool on every edit until Postgres refuses connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const db = globalForPrisma.prisma ?? createClient()

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = db
