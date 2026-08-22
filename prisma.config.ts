import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // The CLI (migrate, introspect) must use a DIRECT connection. Prisma 7
    // removed `directUrl` from the schema; the split now lives here — the
    // CLI reads DIRECT_URL, while the application connects through a driver
    // adapter pointed at the pooled DATABASE_URL. On Neon, migrations
    // cannot run through the connection pooler.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
})
