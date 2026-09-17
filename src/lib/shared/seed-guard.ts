/**
 * Decides whether `prisma/seed.ts` may create its two admin accounts.
 *
 * Those accounts share the password `DevPassword123!`, which is published in
 * this repository's README and CLAUDE.md. On a local Docker database that is a
 * convenience; on anything reachable from the internet it is an unauthenticated
 * admin login. `CLAUDE.md` and `HANDOFF.md` both say "never run `pnpm db:seed`
 * against production", but that instruction is only as good as the memory of
 * whoever types the command — and the mistake is silent and immediate.
 *
 * So the rule is enforced here rather than documented: admin seeding is allowed
 * only against a local database. A remote target must pass SEED_SKIP_ADMINS=1
 * to say "content only, I know what this is"; without it the seed refuses to
 * run at all rather than guessing.
 *
 * Lives in `shared/` because `prisma/seed.ts` runs under tsx, where anything
 * importing `server-only` throws.
 */

export type AdminSeedDecision =
  | { action: 'seed' }
  | { action: 'skip' }
  | { action: 'refuse'; reason: string }

/**
 * True when the connection string points at this machine. Covers the Docker
 * Compose database (`localhost`), the CI service container (`127.0.0.1`), and
 * the IPv6 loopback. Anything else — Neon, RDS, a tunnel — is remote.
 */
export function isLocalDatabase(connectionString: string): boolean {
  let host: string
  try {
    host = new URL(connectionString).hostname
  } catch {
    // An unparseable string is not demonstrably local, so treat it as remote:
    // the failure mode of a false "remote" is an error message, and the
    // failure mode of a false "local" is public admin credentials.
    return false
  }

  // A bracketed IPv6 literal keeps its brackets in URL.hostname.
  const bare = host.replace(/^\[|\]$/g, '')
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1'
}

export function adminSeedDecision(input: {
  connectionString: string | undefined
  skipAdmins: boolean
}): AdminSeedDecision {
  if (input.skipAdmins) return { action: 'skip' }

  if (!input.connectionString) {
    return {
      action: 'refuse',
      reason: 'No DATABASE_URL or DIRECT_URL is set, so the seed target cannot be identified.',
    }
  }

  if (isLocalDatabase(input.connectionString)) return { action: 'seed' }

  return {
    action: 'refuse',
    reason:
      'Refusing to seed admin accounts into a non-local database. The seeded accounts share ' +
      'the password published in this repository, so creating them on a database behind a ' +
      'public URL hands anyone an admin login. Re-run with SEED_SKIP_ADMINS=1 to seed content ' +
      'only, then create real accounts with `pnpm admin:create`.',
  }
}
