import { randomBytes } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'
// argon2 is called directly rather than through lib/server/password.ts:
// that module starts with `import 'server-only'`, which throws under tsx.
// The PARAMETERS are shared, which is what actually matters — an admin
// created here and one created through the app hash identically.
import { hash } from '@node-rs/argon2'
import { ARGON2_OPTIONS } from '../src/lib/shared/password-options'

const db = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  }),
})

async function main() {
  const [email, name, role = 'SCANNER'] = process.argv.slice(2)

  if (!email || !name) {
    console.error('Usage: pnpm admin:create <email> <name> [ADMIN|SCANNER]')
    process.exit(1)
  }
  if (role !== 'ADMIN' && role !== 'SCANNER') {
    console.error(`Invalid role "${role}". Use ADMIN or SCANNER.`)
    process.exit(1)
  }

  // Generated rather than prompted, so a weak password is never chosen and
  // never appears in shell history.
  const password = randomBytes(12).toString('base64url')

  await db.adminUser.create({
    data: {
      // Lowercased on write because the unique index is case-sensitive:
      // Admin@… and admin@… would otherwise both be creatable, and only one
      // of them reachable through the login path.
      email: email.trim().toLowerCase(),
      name,
      role,
      passwordHash: await hash(password, ARGON2_OPTIONS),
    },
  })

  console.log(`Created ${role} ${email.trim().toLowerCase()}`)
  console.log(`Password: ${password}`)
  console.log('Record this now — it is not stored anywhere in recoverable form.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
