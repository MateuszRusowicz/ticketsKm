import { randomBytes } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'
// argon2 is called directly rather than through lib/server/password.ts, for
// the same reason as scripts/create-admin.ts: that module starts with
// `import 'server-only'`, which throws under tsx. The PARAMETERS are shared,
// so a password set here and one set through the app hash identically.
import { hash } from '@node-rs/argon2'
import { ARGON2_OPTIONS } from '../src/lib/shared/password-options'

const db = new PrismaClient({
  adapter: new PrismaPg({
    // DIRECT_URL first: this is a one-off CLI run, not the application, so
    // there is no reason to go through the pooler.
    connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  }),
})

async function main() {
  const [rawEmail] = process.argv.slice(2)

  if (!rawEmail) {
    console.error('Usage: pnpm admin:reset-password <email>')
    process.exit(1)
  }

  // Lowercased to match create-admin.ts, which lowercases on write. The
  // unique index is case-sensitive, so without this a reset typed in the
  // wrong case reports "no account" for an address that plainly exists.
  const email = rawEmail.trim().toLowerCase()

  const existing = await db.adminUser.findUnique({ where: { email } })
  if (!existing) {
    // Checked up front so the operator gets this instead of a raw P2025.
    console.error(`No admin account for ${email}.`)
    process.exit(1)
  }

  // Generated rather than prompted, so a weak password is never chosen and
  // never appears in shell history.
  const password = randomBytes(12).toString('base64url')

  await db.$transaction(async (tx) => {
    await tx.adminUser.update({
      where: { email },
      data: {
        passwordHash: await hash(password, ARGON2_OPTIONS),
        // Both fields, not just the counter. Clearing failedLoginCount alone
        // leaves lockedUntil in the future, so the account stays locked with
        // a password the operator has just been told is valid — the exact
        // situation a reset is meant to resolve.
        failedLoginCount: 0,
        lockedUntil: null,
      },
    })

    // A reset is what you do when a credential may be compromised. Leaving
    // live sessions alone would let whoever holds a stolen cookie keep the
    // access the reset was supposed to take away.
    await tx.adminSession.deleteMany({ where: { adminUserId: existing.id } })
  })

  console.log(`Reset ${existing.role} ${email}`)
  console.log(`Password: ${password}`)
  console.log('Record this now — it is not stored anywhere in recoverable form.')
  console.log('Any existing session for this account has been signed out.')

  if (!existing.active) {
    console.warn('Note: this account is INACTIVE, so the new password will not log in.')
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
